const path = require('path');

function communityEpisodes(text = '') {
  const value = String(text).normalize('NFKC'), list = [], ranges = [];
  const number = '\\d+(?:\\.\\d+)?';
  // "1~3화" and "1화~3화" are ranges; "1, 5화", "1+5화" and "1·5화" are lists.
  const range = new RegExp(`(?<![\\d.])(${number})\\s*(?:화|회|편)?\\s*[~∼〜～–—-]\\s*(${number})\\s*(?:화|회|편)`, 'g');
  const remaining = value.replace(range, (_, first, last) => { if (Number(first) <= Number(last)) ranges.push([Number(first), Number(last)]); return ' '; });
  for (const match of remaining.matchAll(new RegExp(`(?<![\\d.])((?:${number}\\s*[,、&/+·・]\\s*)*${number})\\s*(?:화|회|편)`, 'g'))) {
    list.push(...match[1].split(/[,、&/+·・]/).map(Number));
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
  // "S02E05", and "Show S2 - 04SubsPlease" as one maker's series post names its second season's files.
  const season = name.match(/(?:^|[^a-z0-9])s(\d{1,2})(?:[ ._-]*e|\s+-\s*)(\d+(?:\.\d+)?)/i);
  if (season) return { episode: Number(season[2]), season: Number(season[1]) };
  const explicit = name.match(/(?:^|[^a-z])(?:episode|ep|e)[ ._-]*(\d+(?:\.\d+)?)(?![\d.])/i);
  if (explicit) return { episode: Number(explicit[1]), season: null };
  const korean = communityEpisodes(name);
  if (korean.list.length === 1) return { episode: korean.list[0], season: null };
  // Tags in brackets or parentheses go ("[SubsPlease] Show - 02 (1080p) [CRC]", "Show - 01 (BS11 1280x720 x264
  // AAC)"), except a bare number ("Show [01]").
  const tail = name.replace(/\((?:끝|완|完|end|fin)\)/gi, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, tag => /^[[(]\s*\d+(?:\.\d+)?(?:v\d+)?\s*[\])]$/i.test(tag) ? tag : ' ').replace(/\s+/g, ' ').trim();
  if (/\b(?:no|vol|volume|part|cour|season|movie|level|lv)[\s.]*\d+$/i.test(tail)) return { episode: null, season: null };
  const bare = tail
    .match(/(?:^|[\s_.\-[\](])(\d+(?:\.\d+)?)(?:v\d+)?[\s\])]*$/i);
  if (bare) return { episode: Number(bare[1]), season: null };
  // "Show - 01SubsPlease", "Show 01_ToonsHub": the release group glued after the number (a capital, so "Show - 2nd"
  // stays unnumbered).
  const glued = tail.match(/(?:^|[\s_.-])(\d+(?:\.\d+)?)(?:v\d+)?_?[A-Z][A-Za-z0-9-]*$/);
  if (glued) return { episode: Number(glued[1]), season: null };
  // A Korean title with the number glued on ("약사의 혼잣말03"); two digits, as "그대들에게2" is a season.
  const hangul = tail.match(/[가-힣](\d{2,3})$/);
  return { episode: hangul ? Number(hangul[1]) : null, season: null };
}

// Episodes a download link's text names. Besides "3화" and "1~12화", makers label links with bare ranges and file
// names ("1-12 SubsPlease", "sekamajo 01~02.zip 6.3MB", "Kanata kara - 03Subsplease.smi").
function communityLinkEpisodes(label = '') {
  const text = String(label).normalize('NFKC').replace(/\d+(?:\.\d+)?\s*[KMG]B\b/gi, ' ').trim()
    .replace(/\.(?:zip|7z|rar|ass|ssa|srt|vtt|smi)$/i, ''), marked = communityEpisodes(text);
  if (marked.any) return marked;
  const range = text.match(/(?<![\d.]|(?:^|[^a-z])[se])(\d{1,3})\s*[~∼〜～–—-]\s*(\d{1,3})(?![\d.])/i);
  if (range && Number(range[1]) < Number(range[2])) return communityEpisodes(`${Number(range[1])}~${Number(range[2])}화`);
  const file = communityFileEpisode(text).episode;
  return file == null ? communityEpisodes('') : communityEpisodes(`${file}화`);
}

// The order a post's subtitle links are tried in for an episode, as tiers: links named for it alone, links whose
// range covers it, then links naming no episode ("통합", "자막 다운로드"). A link naming only other episodes is left
// out (unless the post is titled for this episode alone), and so is a post titled for other episodes unless it is a finished series' last post (完, 끝: its links often
// bundle every episode) or one of its links covers the episode. Link texts are a hint only: the files inside decide
// (pickCommunityFile).
const COMMUNITY_FONT = /폰트|font/i;
const COMMUNITY_FINAL = /完|終|끝|완결|전체|통합|\b(?:end|fin|complete)\b/i;
// Some makers put every episode so far into each new post's archive ("무리무리 10화" → "무리무리.zip 0.17MB",
// "2화 [이전 화 포함].zip"). Tistory shows a file's size in its link: one episode's subtitles are 15-60 KB, so an
// archive of 90 KB or more in a later episode's post may hold earlier ones, and is tried last.
const COMMUNITY_CUMULATIVE = /포함|누적|전체|통합/;
function declaredSize(label) {
  const size = String(label).match(/(\d+(?:\.\d+)?)\s*([KMG])B\b/i);
  return size ? Number(size[1]) * { K: 1e3, M: 1e6, G: 1e9 }[size[2].toUpperCase()] : 0;
}
// A season a link text names ("2기 1-12", "S2 03-04", "Season 3").
function linkSeason(label) {
  const found = String(label).normalize('NFKC').match(/(\d+)\s*기(?![가-힣])|(?:^|[^a-z0-9])s(\d{1,2})(?![\d.])(?!\s*[~∼〜～–—-]\s*\d)|season\s*(\d+)/i);
  return found ? Number(found[1] || found[2] || found[3]) : null;
}
function planCommunityLinks(title, titleEpisodes, anchors, episode, { season = null } = {}) {
  // A series post may list every season's archives ("자판기 3기 1-2", "자판기 2기 1-12", "자판기 1-12"): those named for
  // another season are left out. When some are named for this one, the unnamed ones are the first season's: tried
  // after them for the first season, and not at all for a later one.
  if (season) {
    const own = anchors.filter(a => linkSeason(a.label) === season);
    if (own.length && own.length < anchors.length) {
      const named = planCommunityLinks(title, titleEpisodes, own, episode);
      if (season > 1) return named;
      const rest = planCommunityLinks(title, titleEpisodes, anchors.filter(a => linkSeason(a.label) == null), episode);
      return { tiers: [...named.tiers, ...rest.tiers], fonts: [...named.fonts, ...rest.fonts] };
    }
    anchors = anchors.filter(a => (linkSeason(a.label) ?? season) === season);
  }
  const number = Number(episode), tiers = [[], [], []], fonts = anchors.filter(a => COMMUNITY_FONT.test(a.label));
  const titleNames = titleEpisodes.any, titleHas = titleEpisodes.has(number);
  const titleOnly = titleHas && titleEpisodes.list.length === 1 && !titleEpisodes.ranges.length;
  const lastPost = titleNames && !titleHas && COMMUNITY_FINAL.test(title) && number <= Math.max(...titleEpisodes.list, ...titleEpisodes.ranges.map(r => r[1]));
  const laterPost = titleNames && !titleHas && titleEpisodes.list.length === 1 && !titleEpisodes.ranges.length && number < titleEpisodes.list[0];
  const cumulative = anchor => laterPost && (declaredSize(anchor.label) >= 90e3 || COMMUNITY_CUMULATIVE.test(anchor.label));
  for (const anchor of anchors.filter(a => !fonts.includes(a))) {
    const named = communityLinkEpisodes(anchor.label);
    if (named.any) {
      // In a post titled for this episode alone, a link naming another number is still its file under the maker's
      // own numbering ("골든카무이 5기 13화" → "Golden Kamuy - 62.zip"), tried after the links that agree.
      if (!named.has(number)) {
        if (titleOnly) tiers[1].push({ ...anchor, exact: named.list.length === 1 && !named.ranges.length });
        else if (cumulative(anchor) && named.list.length === 1 && named.list[0] === titleEpisodes.list[0]) tiers[2].push({ ...anchor, exact: false });
        continue;
      }
      const alone = named.list.length === 1 && !named.ranges.length;
      tiers[alone ? 0 : 1].push({ ...anchor, exact: alone });
    } else if (!titleNames || titleHas || lastPost) tiers[titleOnly ? 0 : 2].push({ ...anchor, exact: titleOnly });
    else if (cumulative(anchor)) tiers[2].push({ ...anchor, exact: false });
  }
  return { tiers: tiers.filter(tier => tier.length), fonts };
}

// The file for an episode among one tier's downloaded files: its numbered file, or, from links named for that
// episode alone, whatever single episode they hold (makers number a later season on: "골든카무이 5기 13화" holds
// "Golden Kamuy - 62"). Otherwise the old rules for unnumbered files (strict / bundle).
function pickCommunityFile(files, { episode, exact = false, strict = true, bundle = false, season = null } = {}) {
  const found = selectCommunityFile(files, { episode, strict: true, bundle: true, season });
  if (found) return found;
  if (exact) {
    const numbers = new Set(numberedPool(files, season).map(item => item.parsed.episode)), [only] = numbers;
    if (numbers.size === 1) return selectCommunityFile(files, { episode: only ?? episode, season });
  }
  return selectCommunityFile(files, { episode, strict, bundle, season });
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
// Subtitle files with their episode numbers (extras such as NCOP and other seasons' files left out).
function numberedPool(files, season) {
  const pool = files.map(file => typeof file === 'string' ? { file, name: path.basename(file) } : file)
    .filter(item => !COMMUNITY_EXTRA.test(item.name))
    .map(item => ({ ...item, parsed: communityFileEpisode(item.name) }))
    .filter(item => !season || !item.parsed.season || item.parsed.season === season);
  for (const [item, number] of seriesEpisodes(pool.filter(item => item.parsed.episode == null))) item.parsed = { ...item.parsed, episode: number };
  return pool;
}
function selectCommunityFile(files, { episode, strict = false, bundle = false, season = null } = {}) {
  const pool = numberedPool(files, season);
  const quality = item => ({ ass: 50, ssa: 40, srt: 30, vtt: 20, smi: 10 }[path.extname(item.name).slice(1).toLowerCase()] || 0) +
    Math.min(9, Number(item.name.match(/(?:\d|[ _.-])v(\d+)(?=[ ._\]-]|$)/i)?.[1]) || 0);
  // A file marked with the season asked for beats an unmarked one of the same number; with no season asked for, a
  // first-season or unmarked file beats a later season's.
  const marked = item => season ? Number(item.parsed.season === season) : -Number((item.parsed.season || 1) > 1);
  const rank = list => list.sort((a, b) => marked(b) - marked(a) || quality(b) - quality(a) || (b.size || 0) - (a.size || 0))[0];
  const exact = pool.filter(item => item.parsed.episode === Number(episode));
  if (exact.length) return rank(exact);
  const unnumbered = pool.filter(item => item.parsed.episode == null);
  // A numbered bundle never falls back to an unrelated episode or arbitrary unnumbered file.
  if (!strict || !bundle && Number(episode) === 1 && unnumbered.length === pool.length) return rank(unnumbered);
  return null;
}

module.exports = { communityEpisodes, communityFileEpisode, communityLinkEpisodes, planCommunityLinks, pickCommunityFile, selectCommunityFile, COMMUNITY_EXTRA, COMMUNITY_FONT };
