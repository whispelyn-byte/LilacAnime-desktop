const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function tmdbError(code, status = 0, retryAfterMs = 0) {
  const messages = {
    auth: 'TMDB API 키가 올바르지 않거나 사용할 권한이 없습니다.',
    'rate-limit': 'TMDB 요청이 많아 잠시 기다려야 합니다.',
    timeout: 'TMDB 응답 시간이 초과됐습니다.',
    network: 'TMDB에 연결하지 못했습니다.',
    response: 'TMDB 응답을 읽지 못했습니다.',
    http: `TMDB HTTP ${status}`
  };
  return Object.assign(new Error(messages[code]), { code, status, retryAfterMs });
}

// All callers share request spacing and a 429 cooldown, including foreground searches.
function createTmdbClient({ fetch = globalThis.fetch, now = Date.now, sleep = wait, interval = 150 } = {}) {
  let gate = Promise.resolve(), nextRequestAt = 0, blockedUntil = 0;
  async function takeTurn() {
    const previous = gate; let release;
    gate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      while (Math.max(nextRequestAt, blockedUntil) > now()) {
        const delay = Math.max(nextRequestAt, blockedUntil) - now();
        // Long server cooldowns are handed back to the catalog scheduler, not held open here.
        if (blockedUntil - now() > 30000) throw tmdbError('rate-limit', 429, blockedUntil - now());
        await sleep(delay);
      }
      nextRequestAt = now() + interval;
    } finally { release(); }
  }
  return async function request(pathname, params = {}, key = '') {
    if (!key) throw tmdbError('auth');
    const url = new URL(`https://api.themoviedb.org/3${pathname}`), bearer = key.includes('.');
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    if (!bearer) url.searchParams.set('api_key', key);
    for (let attempt = 0; ; attempt++) {
      await takeTurn();
      let failure;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: {
          Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {})
        } });
        if (response.ok) {
          try { return await response.json(); } catch { failure = tmdbError('response'); }
        } else {
          const status = response.status;
          const retryAfter = response.headers?.get('retry-after');
          const retryAfterMs = retryAfter == null ? 0 : Math.max(0, /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : (Date.parse(retryAfter) || 0) - now());
          failure = tmdbError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : 'http', status, retryAfterMs);
          if (response.body) await response.body.cancel().catch(() => {});
        }
      } catch (error) {
        failure = tmdbError(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'network');
      }
      const delay = Math.max(failure.retryAfterMs, 1000 * 2 ** attempt);
      if (failure.status === 429) blockedUntil = Math.max(blockedUntil, now() + delay);
      const transient = !failure.status || failure.status === 408 || failure.status === 429 || failure.status >= 500;
      if (!transient || attempt >= 2 || delay > 30000) throw failure;
      if (failure.status !== 429) await sleep(delay);
    }
  };
}

module.exports = { createTmdbClient };
