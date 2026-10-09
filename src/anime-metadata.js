(function (root) {
  const seasons = { WINTER: 1, SPRING: 4, SUMMER: 7, FALL: 10 };
  const count = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
  function releaseDate(item) {
    const date = String(item.aired || item.startedOn || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (date) return Number(date[1]) * 10000 + Number(date[2]) * 100 + Number(date[3] || 1);
    return Number(item.year || 0) * 10000 + (seasons[String(item.season || '').toUpperCase()] || 0) * 100 + 1;
  }
  function compareRelease(a, b) { return releaseDate(b) - releaseDate(a); }
  function episodeLabel(item) {
    let available = count(item.availableEpisodes), total = count(item.totalEpisodes);
    if (available == null && item.provider === 'reanime' && (item.subbed != null || item.dubbed != null)) available = Math.max(count(item.subbed) || 0, count(item.dubbed) || 0);
    if (item.totalEpisodes === undefined && (!item.provider || ['reanime', 'miruro', 'jikan'].includes(item.provider))) total = count(item.episodes) || null;
    if (available == null && ['ohli24', 'linkani'].includes(item.provider)) available = count(item.episodes);
    if (available != null) return `업로드 ${available}화${total ? ` / 총 ${total}화` : ''}`;
    return total ? `총 ${total}화` : '';
  }
  const api = { releaseDate, compareRelease, episodeLabel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LilacAnimeMeta = api;
})(typeof globalThis === 'object' ? globalThis : this);
