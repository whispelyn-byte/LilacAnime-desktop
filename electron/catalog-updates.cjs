const cheerio = require('cheerio');

// Decode Svelte's JSON reference table; never evaluate the site's inline scripts.
function decodeData(values) {
  const seen = new Map();
  function resolve(index) {
    if (index < 0) return undefined;
    if (seen.has(index)) return seen.get(index);
    const value = values[index];
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value) && value[0] === 'Date') return value[1];
    const result = Array.isArray(value) ? [] : Object.create(null); seen.set(index, result);
    if (Array.isArray(value)) value.forEach(ref => result.push(resolve(ref)));
    else for (const [key, ref] of Object.entries(value)) if (!['__proto__', 'constructor', 'prototype'].includes(key)) result[key] = resolve(ref);
    return result;
  }
  return resolve(0);
}

function createCatalogUpdates(deps) {
  const cache = new Map(), supported = ['reanime', 'miruro', 'animenosub', 'ohli24', 'linkani'];
  async function snapshot(provider) {
    const key = `${provider}:snapshot`, previous = cache.get(key);
    if (previous && Date.now() - previous.time < 5 * 60 * 1000) return previous.promise;
    const promise = loadSnapshot(provider), entry = { time: Date.now(), promise }; cache.set(key, entry);
    try { return await promise; } catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
  }
  async function loadSnapshot(provider) {
    if (provider === 'reanime') {
      const root = await deps.reanimeFetch(`${deps.reanimeBase}/__data.json`);
      const node = root.nodes?.find(node => Array.isArray(node.data) && node.data[0]?.latestAired != null);
      const list = node ? decodeData(node.data).latestAired : null;
      if (!Array.isArray(list)) throw new Error('RE:Anime의 회차 업데이트 목록을 불러오지 못했습니다.');
      return deps.reanimeItems(list).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }
    if (provider === 'miruro') {
      const now = new Date(), from = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10), to = now.toISOString().slice(0, 10);
      let cursor; const rows = [];
      do {
        const root = await deps.miruroApi('schedule', { from, to, track: 'raw,sub', limit: 10000, cursor });
        rows.push(...(root.data || [])); const next = root.has_more ? root.next_cursor : null;
        if (!next || next === cursor) break; cursor = next;
      } while (rows.length < 30000);
      const latest = new Map();
      for (const row of rows) {
        const aired = Date.parse(row.air_at);
        if (!Number.isFinite(aired) || aired > now.getTime() - 75 * 60000) continue;
        if (!latest.has(row.anime_id) || aired > Date.parse(latest.get(row.anime_id).air_at)) latest.set(row.anime_id, row);
      }
      const ids = [...latest.keys()], data = [];
      for (let at = 0; at < ids.length; at += 200) {
        const root = await deps.miruroApi('anime', { id_in: ids.slice(at, at + 200).join(','), limit: 200 });
        for (const raw of root.data || []) {
          if (!Object.values(raw.episode_counts || {}).some(value => Number(value) > 0)) continue;
          data.push({ ...deps.miruroItem(raw), updatedAt: latest.get(raw.id)?.air_at || '' });
        }
      }
      return data.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }
    throw new Error('회차 업데이트 목록을 제공하지 않는 소스입니다.');
  }
  async function page(provider, offset = 0) {
    if (!supported.includes(provider)) throw new Error('이 소스는 회차 업데이트순을 제공하지 않습니다.');
    const at = Math.max(0, Number(offset) || 0);
    if (['reanime', 'miruro'].includes(provider)) {
      const all = await snapshot(provider), data = all.slice(at, at + 36);
      return { data, nextOffset: at + 36, total: all.length, done: at + 36 >= all.length, note: provider === 'miruro' ? '최근 2주간 방영된 회차 기준입니다.' : '소스의 최근 회차 업데이트 목록입니다.' };
    }
    const number = Math.max(1, at), key = `${provider}:${number}`, previous = cache.get(key);
    if (previous && Date.now() - previous.time < 5 * 60000) return previous.promise;
    const promise = (async () => {
      let data;
      if (provider === 'animenosub') {
        const $ = cheerio.load(await deps.animenosubFetch(`${deps.animenosubBase}/anime/?order=update&page=${number}`));
        data = deps.animenosubItems($('article.bs').map((_, node) => $.html(node)).get().join(''));
      } else if (provider === 'linkani') data = deps.linkaniItems(await deps.linkaniFetch(`${deps.linkaniBase}/list/2/${number > 1 ? `page/${number}/` : ''}`));
      else data = await deps.ohliAiring();
      return { data, nextOffset: number + 1, done: provider === 'ohli24' || !data.length, note: '소스의 최근 회차 업데이트 목록입니다.' };
    })();
    const entry = { time: Date.now(), promise }; cache.set(key, entry);
    try { return await promise; } catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
  }
  return { page, snapshot, supported };
}
module.exports = { createCatalogUpdates, decodeData };
