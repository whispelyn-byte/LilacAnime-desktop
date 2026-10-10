// 기기 동기화: 내 목록 and 시청 기록 kept in step with the phone through the owner's own LilacAnime server (a Vercel
// deployment, see lilacanimeserver). The server keeps each item whole and the change made last wins; this side works
// out what changed here since the last sync (against a snapshot of hashes), sends that, then takes in what changed
// elsewhere (everything after the last revision it saw).
(function (root) {
  const COLLECTIONS = ['library', 'history'], HISTORY_LIMIT = 300, BATCH = 500;
  // Entries of what played from this computer only (a file, a local proxy) mean nothing on another device.
  const LOCAL_ONLY = /^(?:file:|blob:|https?:\/\/(?:127\.0\.0\.1|localhost)[:/])/i;
  const idOf = (collection, item) => collection === 'library' ? (item?.mal_id == null ? '' : String(item.mal_id)) : String(item?.key || item?.src || '');
  const syncable = (collection, item) => { const id = idOf(collection, item); return Boolean(id) && !(collection === 'history' && LOCAL_ONLY.test(id)); };
  // FNV-1a of the item's JSON: whether it changed, without keeping a copy of it.
  function hash(item) { const text = JSON.stringify(item ?? null); let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
  function byId(collection, list) { const map = new Map(); for (const item of list || []) if (syncable(collection, item)) map.set(idOf(collection, item), item); return map; }
  function hashes(local) { return Object.fromEntries(COLLECTIONS.map(collection => [collection, Object.fromEntries([...byId(collection, local[collection])].map(([id, item]) => [id, hash(item)]))])); }

  // What to send: items added or changed since the snapshot, and removals. A history entry carries its own time of
  // change; an anime in 내 목록 is changed now, unless it was never synced (then it counts as old as when it was saved,
  // so a removal made on another device in the meantime wins over it).
  function plan(local, snapshot = {}, now = Date.now()) {
    const items = [];
    for (const collection of COLLECTIONS) {
      const before = snapshot[collection] || {}, current = byId(collection, local[collection]);
      for (const [id, item] of current) {
        if (before[id] === hash(item)) continue;
        const updated = collection === 'history' ? Number(item.updated) || now : id in before ? now : Number(item.savedAt) || 1;
        items.push({ collection, id, updated, data: item });
      }
      for (const id of Object.keys(before)) if (!current.has(id)) items.push({ collection, id, updated: now, deleted: true });
    }
    return items;
  }

  // Takes the server's items into the lists. known: per collection, the hash of each item as the server has it from
  // here (the snapshot with what was just sent). An item that no longer matches it was changed here while the sync ran
  // (a history entry still playing, an anime added or removed meanwhile): it is kept, unless the server's is a newer
  // history entry, and goes out with the next sync. Returns the lists and the new snapshot.
  function merge(local, incoming, known) {
    const result = {}, snapshot = {};
    for (const collection of COLLECTIONS) {
      const list = (local[collection] || []).slice(), next = { ...(known[collection] || {}) }, position = new Map(), added = new Map(), removed = new Set();
      list.forEach((item, at) => { if (syncable(collection, item)) position.set(idOf(collection, item), at); });
      for (const item of incoming) {
        if (item.collection !== collection) continue;
        const at = position.get(item.id), mine = added.has(item.id) ? added.get(item.id) : at === undefined || removed.has(at) ? undefined : list[at];
        const changedHere = (mine === undefined ? undefined : hash(mine)) !== next[item.id];
        if (changedHere && !(collection === 'history' && mine && (Number(mine.updated) || 0) < item.updated)) continue;
        if (item.deleted) { added.delete(item.id); if (at !== undefined) removed.add(at); delete next[item.id]; continue; }
        next[item.id] = hash(item.data);
        if (at !== undefined) { removed.delete(at); list[at] = item.data; } else added.set(item.id, item.data);
      }
      let merged = list.filter((_, at) => !removed.has(at));
      if (collection === 'history') {
        const sorted = [...added.values(), ...merged].sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
        // Entries past the limit are let go here only: not a removal to send to the other devices.
        for (const item of sorted.slice(HISTORY_LIMIT)) if (syncable(collection, item)) delete next[idOf(collection, item)];
        merged = sorted.slice(0, HISTORY_LIMIT);
      } else merged = [...[...added.values()].sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0)), ...merged];
      result[collection] = merged; snapshot[collection] = next;
    }
    return { local: result, snapshot };
  }

  // api: {push(items) → {rev, current}, pull(since) → {rev, items, more}}; read() / write(local) reach the app's lists;
  // state: {get(), set(value)} keeps {server, rev, snapshot}; status(info) shows how it went.
  function createSync({ api, read, write, state, status = () => {}, now = () => Date.now() }) {
    let running = null, again = false, timer = null;
    async function run() {
      if (running) { again = true; return running; }
      running = (async () => {
        status({ state: 'syncing' });
        try {
          const saved = state.get() || {}, local = read(), planned = hashes(local), outgoing = plan(local, saved.snapshot, now());
          const incoming = [];
          for (let i = 0; i < outgoing.length; i += BATCH) incoming.push(...((await api.push(outgoing.slice(i, i + BATCH))).current || []));
          let since = Number(saved.rev) || 0, more = true;
          while (more) { const page = await api.pull(since); incoming.push(...page.items); since = page.rev; more = page.more; }
          // What was sent stands for the snapshot, so the server's own echo of it changes nothing here.
          const sent = Object.fromEntries(COLLECTIONS.map(collection => [collection, { ...(saved.snapshot?.[collection] || {}) }]));
          for (const item of outgoing) { if (item.deleted) delete sent[item.collection][item.id]; else sent[item.collection][item.id] = planned[item.collection][item.id]; }
          const fresh = read(), merged = merge(fresh, incoming, sent);
          if (COLLECTIONS.some(collection => hash(merged.local[collection]) !== hash(fresh[collection]))) write(merged.local);
          state.set({ ...saved, rev: since, snapshot: merged.snapshot, at: now() });
          status({ state: 'done', at: now(), sent: outgoing.length, received: incoming.length });
        } catch (error) { status({ state: 'error', error }); }
      })();
      try { await running; } finally { running = null; if (again) { again = false; schedule(0); } }
    }
    function schedule(delay = 15000) { clearTimeout(timer); timer = setTimeout(run, delay); }
    return { run, schedule, get running() { return Boolean(running); } };
  }

  const api = { COLLECTIONS, idOf, hash, hashes, plan, merge, createSync };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LilacSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
