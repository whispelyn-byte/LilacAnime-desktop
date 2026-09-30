// Korean machine translation of subtitle tracks with the Gemini API (the user's own key).
// Cues are read from the VTT the player already uses; only their text is sent, in numbered batches, and the
// answers are written back with the original timings. Results are cached per source file and model.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const BATCH_LINES = 120, BATCH_CHARS = 7000, PARALLEL = 3;

function createTranslator(userData) {
  const settingsFile = path.join(userData, 'gemini.json'), cacheDir = path.join(userData, 'subtitles', 'translated');
  const read = () => { try { const value = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); return { key: String(value.key || '').trim(), model: String(value.model || '').trim(), models: Array.isArray(value.models) ? value.models : [], translateDownloads: value.translateDownloads !== false }; } catch { return { key: '', model: '', models: [], translateDownloads: true }; } };
  const write = value => { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(value), 'utf8'); return value; };

  async function api(pathname, key, init = {}) {
    const response = await fetch(`${GEMINI_API}${pathname}`, { ...init, signal: AbortSignal.timeout(init.body ? 180000 : 20000), headers: { 'x-goog-api-key': key, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    const root = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(root?.error?.message || `Gemini HTTP ${response.status}`); error.status = response.status; throw error; }
    return root;
  }
  // Text models that can generate content, newest first; image, audio, live and embedding models are left out.
  async function listModels(key) {
    const names = []; let token = '';
    do {
      const root = await api(`/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, key);
      for (const model of root.models || []) if ((model.supportedGenerationMethods || []).includes('generateContent')) names.push(String(model.name).replace(/^models\//, ''));
      token = root.nextPageToken || '';
    } while (token);
    const version = name => Number(name.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
    return [...new Set(names)].filter(name => /^gemini-\d/.test(name) && !/image|tts|audio|live|embedding|robotics|computer-use|native|exp/i.test(name)).sort((a, b) => version(b) - version(a) || a.length - b.length || a.localeCompare(b));
  }
  // The newest stable Flash model: quick, cheap and good enough for dialogue.
  function defaultModel(models) {
    return models.find(name => /flash/.test(name) && !/lite|preview/.test(name)) || models.find(name => /flash/.test(name)) || models[0] || '';
  }

  async function saveSettings({ key, model, translateDownloads = true } = {}) {
    key = String(key || '').trim(); translateDownloads = translateDownloads !== false;
    if (!key) return write({ key: '', model: '', models: [], translateDownloads });
    const models = await listModels(key);
    if (!models.length) throw new Error('이 키로 쓸 수 있는 Gemini 모델이 없습니다.');
    return write({ key, models, model: models.includes(model) ? model : defaultModel(models), translateDownloads });
  }

  // Gemini 2.5 takes a thinking budget, later models a thinking level; subtitles need little of either.
  // Each simpler configuration is tried when a model rejects the previous one.
  const workingConfig = new Map();
  async function generate(key, model, system, text) {
    const schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { i: { type: 'INTEGER' }, t: { type: 'STRING' } }, required: ['i', 't'] } };
    const thinking = /^gemini-2\.5/.test(model) ? { thinkingBudget: /pro/.test(model) ? 128 : 0 } : { thinkingLevel: 'low' };
    const configs = [{ responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3, thinkingConfig: thinking }, { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3 }, { responseMimeType: 'application/json' }];
    let last = null;
    for (let index = workingConfig.get(model) || 0; index < configs.length; index++) {
      const generationConfig = configs[index];
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const root = await api(`/models/${encodeURIComponent(model)}:generateContent`, key, { method: 'POST', body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig }) });
          const output = (root.candidates?.[0]?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('');
          if (output) { workingConfig.set(model, index); return output; }
          last = new Error(`Gemini가 빈 응답을 보냈습니다 (${root.candidates?.[0]?.finishReason || root.promptFeedback?.blockReason || 'unknown'}).`); break;
        } catch (error) {
          last = error;
          if (error.status === 401 || error.status === 403 || /api key/i.test(error.message)) throw error;
          if (error.status === 429 || error.status >= 500 || error.name === 'TimeoutError') { await new Promise(resolve => setTimeout(resolve, Math.min(30000, 2500 * 2 ** attempt))); continue; }
          break;
        }
      }
      // Still busy or out of quota after the retries: a simpler request would not help.
      if (last?.status === 429 || last?.status >= 500) throw last;
    }
    throw last || new Error('Gemini 번역에 실패했습니다.');
  }

  function parseVtt(text) {
    const cues = [];
    for (const block of text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n'), at = lines.findIndex(line => line.includes('-->'));
      if (at >= 0) cues.push({ timing: lines[at], text: lines.slice(at + 1).join('\n') });
    }
    return cues;
  }
  const plain = text => text.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  const escapeCue = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n{2,}/g, '\n').replace(/-->/g, '→');

  function batches(lines) {
    const list = []; let current = [], size = 0;
    for (const line of lines) {
      if (current.length && (current.length >= BATCH_LINES || size + line.text.length > BATCH_CHARS)) { list.push(current); current = []; size = 0; }
      current.push(line); size += line.text.length;
    }
    if (current.length) list.push(current);
    return list;
  }

  const system = title => [
    'You translate anime subtitles into natural Korean for Korean viewers.',
    title ? `Anime: ${title}` : '',
    'Input is a JSON array of {i, t} subtitle lines in playback order. Return a JSON array with exactly one {i, t} per input line, same i, t translated into Korean.',
    'Write the way Korean fansubs do: natural spoken Korean that fits each speaker and the scene, not a literal translation. Keep one character\'s speech style consistent.',
    'Use the Korean names common in Korean fandom for characters, places and terms, and keep them consistent. Keep honorific nuance (senpai 선배, -san 씨 or omitted when natural).',
    'Keep a line break (\\n) where the original has one if it still reads well. Translate song lyrics too. Leave lines that are only sounds, symbols or names as they are.',
    'Never merge, split, skip or reorder lines, and add no notes.'
  ].filter(Boolean).join('\n');

  // progress(done, total) is called after each batch.
  async function translate({ file, title = '', progress = () => {} }) {
    const settings = read();
    if (!settings.key) throw new Error('설정 > 자막 자동 번역에서 Gemini API 키를 넣어 주세요.');
    const model = settings.model || defaultModel(settings.models) || 'gemini-flash-latest';
    const source = fs.readFileSync(file, 'utf8'), hash = crypto.createHash('sha1').update(`${model}\n${source}`).digest('hex').slice(0, 20);
    const out = path.join(cacheDir, `${hash}.vtt`);
    if (fs.existsSync(out)) { progress(1, 1); return { path: out, model, failed: 0, cached: true }; }

    const cues = parseVtt(source);
    if (!cues.length) throw new Error('번역할 자막 줄이 없습니다.');
    // Identical lines (repeated cues, karaoke layers) are translated once.
    const unique = [...new Set(cues.map(cue => plain(cue.text)).filter(text => /\p{L}/u.test(text)))].map((text, i) => ({ i, text }));
    const translated = new Map(), groups = batches(unique);
    let done = 0, next = 0, fatal = null;
    progress(0, groups.length);
    await Promise.all(Array.from({ length: Math.min(PARALLEL, groups.length) }, async () => {
      while (next < groups.length && !fatal) {
        const group = groups[next++];
        const input = JSON.stringify(group.map(line => ({ i: line.i, t: line.text })));
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const answer = JSON.parse((await generate(settings.key, model, system(title), input)).replace(/^```(?:json)?\s*|\s*```$/g, ''));
            for (const item of Array.isArray(answer) ? answer : []) if (Number.isInteger(item?.i) && typeof item.t === 'string' && item.t.trim()) translated.set(item.i, item.t.trim());
            if (group.every(line => translated.has(line.i)) || attempt) break;
          } catch (error) {
            // A bad key or an exhausted quota fails every batch the same way.
            if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404 || error.status === 429) { fatal = error; break; }
            if (attempt) break;
          }
        }
        progress(++done, groups.length);
      }
    }));
    if (fatal && !translated.size) throw fatal;
    if (!translated.size) throw new Error('Gemini 번역 결과를 받지 못했습니다.');
    const failed = unique.length - translated.size;
    const byText = new Map(unique.map(line => [line.text, translated.get(line.i)]));
    const body = cues.map(cue => `${cue.timing}\n${escapeCue(byText.get(plain(cue.text)) || plain(cue.text))}`).join('\n\n');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Partial results are not cached, so a later try can fill the gaps.
    const target = failed ? path.join(cacheDir, `${hash}-partial-${Date.now()}.vtt`) : out;
    fs.writeFileSync(target, `WEBVTT\n\n${body}\n`, 'utf8');
    return { path: target, model, failed, cached: false };
  }

  return { settings: read, saveSettings, translate };
}

module.exports = { createTranslator };
