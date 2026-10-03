// Saved subtitles per episode and source (mirrors Android SubtitleStore): every subtitle the
// player applies is remembered so it can be reused offline, switched, or deleted later.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SOURCES = ['linkkf', 'reanime', 'kairan', 'csora', 'anissia', 'jimaku', 'user', 'provider', 'download', 'gemini'];

class SubtitleStore {
  constructor({ app }) {
    this.file = path.join(app.getPath('userData'), 'subtitle-store.json');
    this.managedRoot = path.join(app.getPath('userData'), 'subtitles');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { this.data = {}; }
  }

  write() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8'); }

  withUrls(entry) {
    return { ...entry, url: pathToFileURL(entry.path).href, assUrl: entry.assPath && fs.existsSync(entry.assPath) ? pathToFileURL(entry.assPath).href : null };
  }

  list(key) {
    const entries = (this.data[key] || []).filter(entry => entry.path && fs.existsSync(entry.path));
    if (entries.length !== (this.data[key] || []).length) { this.data[key] = entries; this.write(); }
    return entries.map(entry => this.withUrls(entry));
  }

  save(key, entry = {}) {
    if (!key || !entry.path || !fs.existsSync(entry.path)) return null;
    const source = SOURCES.includes(entry.source) ? entry.source : 'user';
    // One machine translation per episode and engine ("Gemini 번역 (Jimaku)", "로컬 AI 번역 (Jimaku)"): the newest (a
    // finished one after a partial one) takes the place of the older one by the same engine, so translations by
    // different engines stay side by side; the file it replaces stays for the translation cache until it is cleaned.
    const engine = item => String(item.label || '').split(' 번역')[0];
    const list = (this.data[key] || []).filter(item => !(item.source === source && (item.path === entry.path || (source === 'gemini' && engine(item) === engine(entry)))));
    const saved = { id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, source, label: String(entry.label || source), path: entry.path, assPath: entry.assPath || null, fonts: Array.isArray(entry.fonts) ? entry.fonts : [], saved: Date.now() };
    // behind: made in the background beside the subtitle on screen, so it does not come first when the episode opens.
    this.data[key] = (entry.behind ? [...list.slice(0, 19), saved] : [saved, ...list]).slice(0, 20);
    this.write();
    return this.withUrls(saved);
  }

  remove(key, id) {
    const list = this.data[key] || [], entry = list.find(item => item.id === id);
    if (!entry) return false;
    this.data[key] = list.filter(item => item.id !== id);
    if (!this.data[key].length) delete this.data[key];
    this.write();
    // Only delete files the app downloaded itself; user-picked files stay where they are.
    const stillUsed = file => Object.values(this.data).some(items => items.some(item => item.path === file || item.assPath === file));
    for (const file of [entry.path, entry.assPath]) {
      if (file && path.resolve(file).startsWith(path.resolve(this.managedRoot)) && !stillUsed(file)) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
    }
    return true;
  }

  // The files under subtitles/ that no saved subtitle uses: translations and their kept lines, Jimaku and blog
  // downloads, partial results. A saved ASS subtitle keeps its whole folder (its fonts sit next to it); a file changed
  // within the hour may belong to a translation still running.
  unused({ olderThan = 0 } = {}) {
    const used = new Set(), folders = new Set(), now = Date.now(), files = [];
    for (const items of Object.values(this.data)) for (const item of items) for (const file of [item.path, item.assPath]) if (file) { used.add(path.resolve(file)); if (/\.(ass|ssa)$/i.test(file)) folders.add(path.dirname(path.resolve(file))); }
    const walk = dir => { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        let stat; try { stat = fs.statSync(file); } catch { continue; }
        const age = now - stat.mtimeMs;
        files.push({ file, size: stat.size, unused: !used.has(file) && !folders.has(dir) && age > Math.max(olderThan, 60 * 60 * 1000) });
      } };
    walk(path.resolve(this.managedRoot));
    return files;
  }
  usage() { const files = this.unused(); return { total: files.reduce((sum, item) => sum + item.size, 0), removable: files.filter(item => item.unused).reduce((sum, item) => sum + item.size, 0) }; }
  clean(options = {}) {
    let removed = 0, bytes = 0;
    for (const item of this.unused(options).filter(entry => entry.unused)) { try { fs.unlinkSync(item.file); removed++; bytes += item.size; } catch { /* in use */ } }
    // Folders left empty go too.
    const prune = dir => { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) if (entry.isDirectory()) prune(path.join(dir, entry.name));
      if (dir !== path.resolve(this.managedRoot)) try { fs.rmdirSync(dir); } catch { /* not empty */ } };
    prune(path.resolve(this.managedRoot));
    return { removed, bytes };
  }
}

module.exports = { SubtitleStore };
