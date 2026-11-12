// One door to AniList's GraphQL API for the whole app. AniList allows only so many requests a minute (30 while its
// limit is lowered, 90 otherwise) and answers 429 past that; before this, nine places asked on their own, most of them
// reading a 429 as "nothing found" (and some keeping that miss for a week).
// - Requests are spaced by `interval`, and held back while the server says none are left (X-RateLimit-Remaining /
//   X-RateLimit-Reset) or after a 429 (Retry-After).
// - A request that would wait longer than `maxWait` fails at once with code 'rate-limit', so nothing on screen hangs.
// - The same question asked again while it runs shares that request; an answer is kept for `cacheTtl`.
// - A failure always throws (code: 'rate-limit' | 'timeout' | 'network' | 'http' | 'response' | 'graphql'): a caller
//   can tell "AniList has none" (a null in the data) from "AniList did not answer".
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function anilistError(code, status = 0, retryAfterMs = 0) {
  const messages = {
    'rate-limit': 'AniList 요청이 많아 잠시 기다려야 합니다.',
    timeout: 'AniList 응답 시간이 초과됐습니다.',
    network: 'AniList에 연결하지 못했습니다.',
    response: 'AniList 응답을 읽지 못했습니다.',
    graphql: 'AniList가 요청을 처리하지 못했습니다.',
    http: `AniList HTTP ${status}`
  };
  return Object.assign(new Error(messages[code] || messages.http), { code, status, retryAfterMs });
}

function createAnilistClient({ fetch = globalThis.fetch, now = Date.now, sleep = wait, userAgent = 'LilacAnime-Desktop',
  endpoint = 'https://graphql.anilist.co', interval = 150, maxWait = 20000, timeout = 20000,
  cacheTtl = 10 * 60 * 1000, cacheSize = 400 } = {}) {
  const inflight = new Map(), cache = new Map();
  let lastStart = -Infinity, blockedUntil = 0, chain = Promise.resolve();

  // Turns are taken one after another (the spacing and the server's cooldown apply to all of them).
  function takeTurn(limit) {
    const turn = chain.then(async () => {
      const ready = Math.max(lastStart + interval, blockedUntil), delay = ready - now();
      if (delay > limit) throw anilistError('rate-limit', 429, delay);
      if (delay > 0) await sleep(delay);
      lastStart = now();
    });
    chain = turn.catch(() => {});
    return turn;
  }
  function noteLimits(response) {
    const remaining = Number(response.headers?.get?.('x-ratelimit-remaining')), reset = Number(response.headers?.get?.('x-ratelimit-reset'));
    // None left in this minute: wait for the reset the server names (a unix time in seconds).
    if (Number.isFinite(remaining) && response.headers?.get?.('x-ratelimit-remaining') != null && remaining <= 0 && reset > 0)
      blockedUntil = Math.max(blockedUntil, reset * 1000 + 250);
  }
  async function send(body, limit) {
    for (let attempt = 0; ; attempt++) {
      await takeTurn(limit);
      let failure;
      try {
        const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(timeout),
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent }, body });
        noteLimits(response);
        if (response.ok) {
          let root = null;
          try { root = await response.json(); } catch { failure = anilistError('response'); }
          if (root) {
            // "Not Found" is an answer (no such entry): the data's null says so. Other errors without data are failures.
            const errors = Array.isArray(root.errors) ? root.errors : [];
            if (root.data && typeof root.data === 'object') return root.data;
            if (errors.some(error => Number(error?.status) === 404)) return {};
            failure = anilistError('graphql');
          }
        } else {
          const status = response.status, header = response.headers?.get?.('retry-after');
          const retryAfterMs = header == null ? 0 : Math.max(0, /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : (Date.parse(header) || 0) - now());
          // AniList answers "Not Found" with HTTP 404 and a JSON body.
          if (status === 404) { try { await response.body?.cancel?.(); } catch {} return {}; }
          failure = anilistError(status === 429 ? 'rate-limit' : 'http', status, retryAfterMs);
          try { await response.body?.cancel?.(); } catch {}
        }
      } catch (error) {
        failure = anilistError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network');
      }
      if (failure.status === 429) blockedUntil = Math.max(blockedUntil, now() + Math.max(failure.retryAfterMs, 5000));
      const transient = failure.status === 429 || failure.status >= 500 || failure.code === 'network';
      if (!transient || attempt >= 2) throw failure;
      if (failure.status !== 429) await sleep(600 * (attempt + 1));
    }
  }
  // data of the answer (never null: {} when AniList has no such entry).
  function request(query, variables = {}, { cache: keep = true, maxWait: limit = maxWait } = {}) {
    const body = JSON.stringify({ query, variables }), cached = cache.get(body);
    if (cached && now() - cached.time < cacheTtl) return Promise.resolve(cached.value);
    if (cached) cache.delete(body);
    const running = inflight.get(body);
    if (running) return running;
    const promise = send(body, limit).then(value => {
      if (keep) { cache.set(body, { value, time: now() }); if (cache.size > cacheSize) cache.delete(cache.keys().next().value); }
      return value;
    }).finally(() => inflight.delete(body));
    inflight.set(body, promise);
    return promise;
  }
  return request;
}

module.exports = { createAnilistClient, anilistError };
