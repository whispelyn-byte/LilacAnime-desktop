const path = require('path');

function communityEpisodes(text = '') {
  const value = String(text).normalize('NFKC'), list = [], ranges = [];
  const number = '\\d+(?:\\.\\d+)?';
  const range = new RegExp(`(?<![\\d.])(${number})\\s*[~∼〜～–—-]\\s*(${number})\\s*(?:화|회|편)`, 'g');
  const remaining = value.replace(range, (_, first, last) => { if (Number(first) <= Number(last)) ranges.push([Number(first), Number(last)]); return ' '; });
  for (const match of remaining.matchAll(new RegExp(`(?<![\\d.])((?:${number}\\s*[,、&/]\\s*)*${number})\\s*(?:화|회|편)`, 'g'))) {
    list.push(...match[1].split(/[,、&/]/).map(Number));
  }
  for (const match of value.matchAll(new RegExp(`\\bep(?:isode)?\\s*\\.?\\s*(${number})(?![\\d.])`, 'gi'))) list.push(Number(match[1]));
  return { list: [...new Set(list)], ranges, has: episode => list.includes(Number(episode)) || ranges.some(([a, b]) => Number(episode) >= a && Number(episode) <= b), any: list.length + ranges.length > 0 };
}

// Only episode-shaped numbers count: title digits, years, resolution, codec, and CRC are not loose matches.
function communityFileEpisode(file) {
  const name = path.basename(String(file).replace(/\\/g, '/')).normalize('NFKC').replace(/\.[a-z0-9]+$/i, '')
    .replace(/\[[0-9a-f]{8}\]/gi, ' ')
    .replace(/(?<![a-z0-9])(?:\d{3,4}[pi]|[xh]\.?26[45]|(?:19|20)\d{2})(?![a-z0-9])/gi, ' ')
    .replace(/\d+\s*기/g, ' ').replace(/[ ._-]+$/g, '').trim();
  const season = name.match(/(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d+(?:\.\d+)?)/i);
  if (season) return { episode: Number(season[2]), season: Number(season[1]) };
  const explicit = name.match(/(?:^|[^a-z])(?:episode|ep|e)[ ._-]*(\d+(?:\.\d+)?)(?![\d.])/i);
  if (explicit) return { episode: Number(explicit[1]), season: null };
  const korean = communityEpisodes(name);
  if (korean.list.length === 1) return { episode: korean.list[0], season: null };
  const tail = name.replace(/\[[^\]]*\]/g, tag => /^\[\s*\d+(?:\.\d+)?(?:v\d+)?\s*\]$/i.test(tag) ? tag : ' ')
    .replace(/\((?:끝|완|完|end|fin)\)/gi, '').trim();
  if (/\b(?:no|vol|volume|part|cour|season|movie|level|lv)[\s.]*\d+$/i.test(tail)) return { episode: null, season: null };
  const bare = tail
    .match(/(?:^|[\s_.\-[\](])(\d+(?:\.\d+)?)(?:v\d+)?[\s\])]*$/i);
  if (bare) return { episode: Number(bare[1]), season: null };
  // "Show - 01SubsPlease": the release group glued after the number (a capital, so "Show - 2nd" stays unnumbered).
  const glued = tail.match(/\s-\s*(\d+(?:\.\d+)?)(?:v\d+)?[A-Z][A-Za-z0-9]*[\s\])]*$/);
  return { episode: glued ? Number(glued[1]) : null, season: null };
}

// Files named alike but for one number ("A 01 x.smi" … "A 09 x.smi", whatever the shape around it) are an episode
// set numbered by it: names the parser does not read are numbered this way, so the set is never taken as unnumbered
// (and any one of its files given to every episode).
function seriesEpisodes(items) {
  const number = /\d+(?:\.\d+)?/g, groups = new Map(), found = new Map();
  for (const item of items) {
    const base = item.name.normalize('NFKC').replace(/\.[a-z0-9]+$/i, ''), key = base.replace(number, '#').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, numbers: base.match(number) || [] });
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const varying = list[0].numbers.map((_, index) => index).filter(index => new Set(list.map(entry => Number(entry.numbers[index]))).size > 1);
    if (varying.length === 1) for (const { item, numbers } of list) found.set(item, Number(numbers[varying[0]]));
  }
  return found;
}

const COMMUNITY_EXTRA = /non-?telop|textless|(?:^|[^a-z0-9])(?:NC(?:OP|ED)|PV|CM)(?=$|[^a-z0-9])|tokuten|preview|trailer|논텔롭|예고편|특전/i;
function selectCommunityFile(files, { episode, strict = false, bundle = false, season = null } = {}) {
  const pool = files.map(file => typeof file === 'string' ? { file, name: path.basename(file) } : file)
    .filter(item => !COMMUNITY_EXTRA.test(item.name))
    .map(item => ({ ...item, parsed: communityFileEpisode(item.name) }))
    .filter(item => !season || !item.parsed.season || item.parsed.season === season);
  for (const [item, number] of seriesEpisodes(pool.filter(item => item.parsed.episode == null))) item.parsed = { ...item.parsed, episode: number };
  const quality = item => ({ ass: 50, ssa: 40, srt: 30, vtt: 20, smi: 10 }[path.extname(item.name).slice(1).toLowerCase()] || 0) +
    Math.min(9, Number(item.name.match(/(?:\d|[ _.-])v(\d+)(?=[ ._\]-]|$)/i)?.[1]) || 0);
  const rank = list => list.sort((a, b) => quality(b) - quality(a) || (b.size || 0) - (a.size || 0))[0];
  const exact = pool.filter(item => item.parsed.episode === Number(episode));
  if (exact.length) return rank(exact);
  const unnumbered = pool.filter(item => item.parsed.episode == null);
  // A numbered bundle never falls back to an unrelated episode or arbitrary unnumbered file.
  if (!strict || !bundle && Number(episode) === 1 && unnumbered.length === pool.length) return rank(unnumbered);
  return null;
}

module.exports = { communityEpisodes, communityFileEpisode, selectCommunityFile, COMMUNITY_EXTRA };
