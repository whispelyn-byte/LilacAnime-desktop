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
    const list = (this.data[key] || []).filter(item => !(item.source === source && item.path === entry.path));
    const saved = { id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, source, label: String(entry.label || source), path: entry.path, assPath: entry.assPath || null, fonts: Array.isArray(entry.fonts) ? entry.fonts : [], saved: Date.now() };
    this.data[key] = [saved, ...list].slice(0, 20);
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
}

module.exports = { SubtitleStore };
