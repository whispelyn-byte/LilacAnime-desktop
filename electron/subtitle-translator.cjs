// Korean machine translation of subtitles ("gemini": the Gemini API with the user's own key; "local": a GGUF model run
// by llama.cpp on this PC, see local-ai.cjs; chosen per request). Cues are read from the VTT the player already uses; only their
// text is sent (to Gemini in numbered batches, to the local model line by line), and the answers are written back with
// the original timings. Results are cached per source file and model.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLocalAi } = require('./local-ai.cjs');
const { characterTerms } = require('./anime-glossary.cjs');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
// A whole episode (a few hundred short lines) fits one request, and the free tier allows only a few requests a minute
// and a few dozen a day, so episodes go in one batch where possible, two at most at a time.
const BATCH_LINES = 600, BATCH_CHARS = 30000, PARALLEL = 2, PROMPT_VERSION = 'prompt-3', LOCAL_PROMPT_VERSION = 'local-2';

function createTranslator(userData) {
  const settingsFile = path.join(userData, 'gemini.json'), cacheDir = path.join(userData, 'subtitles', 'translated');
  const local = createLocalAi(userData);
  // The picked model, or the first one on disk when the picked one is not (never downloaded, or deleted).
  const installedModel = id => { const models = local.models(); return models.some(model => model.id === id && model.installed) ? id : models.find(model => model.installed)?.id || id; };
  const read = () => {
    let value = {}; try { value = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch { /* defaults */ }
    return { key: String(value.key || '').trim(), model: String(value.model || '').trim(), models: Array.isArray(value.models) ? value.models : [], translateDownloads: Boolean(value.translateDownloadsChosen) && value.translateDownloads === true, translateDownloadsChosen: Boolean(value.translateDownloadsChosen),
      localModel: installedModel(String(value.localModel || 'hy-mt-1.8b')),
      // How a picked Jimaku file is translated by itself: 'off', 'gemini' or 'local' (older settings: on = whichever is set up).
      jimakuTranslate: ['off', 'gemini', 'local'].includes(value.jimakuTranslate) ? value.jimakuTranslate : value.autoJimaku === false ? 'off' : 'gemini' };
  };
  // With the local AI the installed model list is part of the settings the page shows.
  const settings = () => { const value = read(); return { ...value, localModels: local.models() }; };
  // The player has a button for each provider. Translations nobody asks for (downloads) use Gemini when a key is set,
  // otherwise the local AI when its model is on disk; either way the other one takes over when it stops.
  const ready = provider => { const value = read(); return provider === 'local' ? local.models().some(model => model.id === value.localModel && model.installed) : provider === 'gemini' ? Boolean(value.key) : Boolean(autoProvider()); };
  const autoProvider = () => ready('gemini') ? 'gemini' : ready('local') ? 'local' : null;
  const write = value => { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(value), 'utf8'); return value; };

  async function api(pathname, key, init = {}) {
    const response = await fetch(`${GEMINI_API}${pathname}`, { ...init, signal: AbortSignal.timeout(init.body ? 180000 : 20000), headers: { 'x-goog-api-key': key, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    const root = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(root?.error?.message || `Gemini HTTP ${response.status}`); error.status = response.status; error.details = root?.error?.details || []; throw error; }
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

  // Only the fields given change; a new key is checked by listing its models.
  async function saveSettings(change = {}) {
    const current = read(), next = { ...current };
    // Off unless turned on in 설정 (older settings saved it on without anyone choosing, so they start off once).
    if ('translateDownloads' in change) Object.assign(next, { translateDownloads: change.translateDownloads === true, translateDownloadsChosen: true });
    if ('jimakuTranslate' in change && ['off', 'gemini', 'local'].includes(change.jimakuTranslate)) next.jimakuTranslate = change.jimakuTranslate;
    if ('localModel' in change) next.localModel = String(change.localModel || current.localModel);
    if ('model' in change && next.models.includes(change.model)) next.model = change.model;
    if ('key' in change && String(change.key || '').trim() !== current.key) {
      next.key = String(change.key || '').trim();
      if (!next.key) Object.assign(next, { model: '', models: [] });
      else {
        const models = await listModels(next.key);
        if (!models.length) throw new Error('이 키로 쓸 수 있는 Gemini 모델이 없습니다.');
        Object.assign(next, { models, model: models.includes(change.model) ? change.model : defaultModel(models) });
      }
    }
    write(next); return settings();
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
          if (error.status === 429) {
            // The daily allowance is gone: no retry helps until it resets. A per-minute limit says how long to wait.
            const quotas = (error.details || []).flatMap(detail => detail.violations || []).map(item => String(item.quotaId || ''));
            if (quotas.some(id => /PerDay/i.test(id))) { const daily = new Error('Gemini 무료 사용량을 오늘 다 썼습니다. 내일 다시 번역하거나 로컬 AI 번역을 쓰세요.'); daily.status = 429; throw daily; }
            const wait = Number(String((error.details || []).find(detail => detail.retryDelay)?.retryDelay || '').replace(/s$/, '')) || Number(error.message.match(/retry in ([\d.]+)\s*s/i)?.[1]) || 2.5 * 2 ** attempt;
            if (wait > 120) throw error;
            await new Promise(resolve => setTimeout(resolve, (wait + 1) * 1000)); continue;
          }
          if (error.status >= 500 || error.name === 'TimeoutError') { await new Promise(resolve => setTimeout(resolve, Math.min(30000, 2500 * 2 ** attempt))); continue; }
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

  // Written like a Korean fansub team's style guide: the work, what the answer must look like, then how to translate.
  // context: {title (as shown in the app, usually Korean), originalTitle, genres, synopsis, characters: [{name, native,
  // first, last, gender}] from AniList}. Names come with a Korean spelling (anime-glossary) so every batch agrees.
  const system = (context = {}) => {
    const characters = (context.characters || []).filter(item => item.name || item.native).slice(0, 30);
    const korean = new Map(characterTerms(characters).map(term => [term.ja, term.ko]));
    const gender = item => item.gender === 'Female' ? 'female' : item.gender === 'Male' ? 'male' : '';
    const characterLine = item => `- ${[item.native, item.name].filter(Boolean).join(' / ')}${korean.get(item.native) ? ` → ${korean.get(item.native)}` : ''}${gender(item) ? ` (${gender(item)})` : ''}`;
    return [
      'You are an experienced Korean subtitle translator for anime, working to the standard of a good Korean fansub team.',
      context.title || context.originalTitle ? `Anime: ${[context.title, context.originalTitle].filter(Boolean).join(' / ')}` : '',
      context.genres?.length ? `Genres: ${context.genres.join(', ')}` : '',
      context.synopsis ? `Story: ${context.synopsis}` : '',
      characters.length ? `Main characters (original / romanized → Korean spelling, gender). Use these spellings every time; family name first, and a given name used alone is the last part:\n${characters.map(characterLine).join('\n')}` : '',
      '',
      'FORMAT',
      '- Input: a JSON array of {i, t}, one subtitle line each, in playback order. The source is usually Japanese, sometimes English.',
      '- Output: only a JSON array with exactly one {i, t} for every input item, the same i, t = the Korean subtitle. Never merge, split, skip or reorder lines; no notes or explanations.',
      '- A sentence can run over several lines: translate it so the lines read naturally one after another, but keep each part on its own line.',
      '',
      'TRANSLATION',
      '- Read the lines as a scene: work out from the flow who is speaking to whom, and translate each line for that speaker and listener.',
      '- Translate the meaning faithfully. Do not add, explain, soften or censor anything, and do not invent what is not said.',
      '- Write natural spoken Korean, as short as a subtitle should be. Avoid translationese (needless 그녀/그, 당신, ~하는 것이다, literal idioms).',
      '- Choose 반말 or 존댓말 from the relationship (friends, family, classmates: 반말; strangers, superiors, polite characters: 존댓말) and keep each character\'s voice the same throughout: rough or gentle, old-fashioned or childish speech, verbal tics and catchphrases.',
      '- Words for people follow the speaker: お兄ちゃん / 兄さん → 오빠 from a girl, 형 from a boy; お姉ちゃん / 姉さん → 언니 from a girl, 누나 from a boy; 先輩 → 선배, 先生 → 선생님.',
      '- Other Japanese names in Hangul by the usual Korean fan spelling (e.g. 마히루, 아마네, 츠카사, 쇼타; つ is 츠, not 쓰). Keep the original name order.',
      '- Honorifics: -san → 씨 or nothing, -kun / -chan → nothing (or 군 / 짱 where it matters), -sama → 님.',
      '- Set phrases as Koreans say them: いただきます → 잘 먹겠습니다, ごちそうさま → 잘 먹었습니다, ただいま → 다녀왔어, おかえり → 어서 와, いってきます → 다녀올게, お疲れ様 → 수고했어, よろしく → 잘 부탁해.',
      '- Stammers and cut-off words stay stammers (べ、別に → 벼, 별로); interjections become Korean ones (えっ → 어?, はぁ? → 하아?, よし → 좋아, まあ → 뭐).',
      '- Jokes and wordplay: keep the effect in Korean rather than the literal words. Song lyrics: translate as lyrics. Attack and spell names: as the fandom would say them, usually translated.',
      '- Lines that are only sounds, music marks or symbols stay as they are. Keep caption labels in their brackets, translated: (男の子) → (남자아이), [ため息] → [한숨].',
      '- Keep a line break (\\n) where the original has one if it still reads well.'
    ].filter(line => line !== null && line !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // Gemini, batch by batch, into translated (by line id). Stops at an error every batch would hit (a bad key, the
  // day's allowance used up) and throws it, keeping what was translated before.
  async function translateGemini(settings, model, lines, translated, context, progress) {
    const groups = batches(lines);
    let done = 0, next = 0, fatal = null;
    progress(0, groups.length);
    await Promise.all(Array.from({ length: Math.min(PARALLEL, groups.length) }, async () => {
      while (next < groups.length && !fatal) {
        const group = groups[next++];
        const input = JSON.stringify(group.map(line => ({ i: line.i, t: line.text }))), ids = new Set(group.map(line => line.i));
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const answer = JSON.parse((await generate(settings.key, model, system(context), input)).replace(/^```(?:json)?\s*|\s*```$/g, ''));
            // Only this batch's lines: a stray id must not overwrite another batch's translation.
            for (const item of Array.isArray(answer) ? answer : []) if (ids.has(item?.i) && typeof item.t === 'string' && item.t.trim()) translated.set(item.i, item.t.trim());
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
    if (fatal) throw fatal;
    if (!lines.some(line => translated.has(line.i))) throw new Error('Gemini 번역 결과를 받지 못했습니다.');
  }

  // provider: the one asked for, otherwise Gemini when its key is set, else the local AI. When it is not set up or
  // stops (no key, the day's free allowance used up, no model, llama.cpp not starting) the other one takes over if it
  // is set up, and translates the lines still left. progress(done, total) is called after each batch (local: each
  // line); status(text) while the local model starts or the other one takes over.
  async function translate({ file, title = '', provider = '', context = {}, progress = () => {}, status = () => {} }) {
    const settings = read(), wanted = provider || autoProvider() || 'gemini';
    const order = [wanted, wanted === 'local' ? 'gemini' : 'local'].filter(name => ready(name));
    if (!order.length) throw new Error(wanted === 'local' ? '설정 > 자막 자동 번역에서 로컬 AI 모델을 먼저 받아 주세요.' : '설정 > 자막 자동 번역에서 Gemini API 키를 넣어 주세요.');
    const localModel = local.models().find(item => item.id === settings.localModel);
    const modelOf = name => name === 'local' ? `local:${localModel.file || localModel.label}` : settings.model || defaultModel(settings.models) || 'gemini-flash-latest';
    // The prompt version is part of the cache key, so a better prompt is not hidden behind older results.
    const source = fs.readFileSync(file, 'utf8');
    const hashOf = name => crypto.createHash('sha1').update(`${modelOf(name)}\n${name === 'local' ? LOCAL_PROMPT_VERSION : PROMPT_VERSION}\n${source}`).digest('hex').slice(0, 20);
    const out = path.join(cacheDir, `${hashOf(order[0])}.vtt`);
    if (fs.existsSync(out)) { progress(1, 1); return { path: out, model: modelOf(order[0]), failed: 0, cached: true }; }

    const cues = parseVtt(source);
    if (!cues.length) throw new Error('번역할 자막 줄이 없습니다.');
    // Identical lines (repeated cues, karaoke layers) are translated once.
    const unique = [...new Set(cues.map(cue => plain(cue.text)).filter(text => /\p{L}/u.test(text)))].map((text, i) => ({ i, text }));
    const translated = new Map(), used = [];
    let lastError = null, fallbackReason = '';
    for (const [index, name] of order.entries()) {
      const lines = unique.filter(line => !translated.has(line.i));
      if (!lines.length) break;
      if (index) { fallbackReason = lastError?.message || ''; status(name === 'local' ? 'Gemini를 쓸 수 없어 로컬 AI로 번역하는 중' : '로컬 AI를 쓸 수 없어 Gemini로 번역하는 중'); }
      const before = translated.size;
      try {
        if (name === 'local') {
          const { translations } = await local.translateLines(lines.map(line => line.text), { modelId: localModel.id, progress, status, context });
          lines.forEach((line, index) => { if (translations.has(index)) translated.set(line.i, translations.get(index)); });
        } else await translateGemini(settings, modelOf(name), lines, translated, { title, ...context }, progress);
        lastError = null;
      } catch (error) { lastError = error; }
      if (translated.size > before) used.push(name);
      if (!lastError) break;
    }
    if (!translated.size) throw lastError || new Error('번역 결과를 받지 못했습니다.');
    const last = used[used.length - 1];
    // A translation made by one is cached under its name; one put together from both is kept only for this time.
    const result = writeResult(cues, unique, translated, hashOf(last), modelOf(last), used.length === 1);
    if (used.every(name => name === wanted)) return result;
    return { ...result, fallbackFrom: wanted, fallbackReason: fallbackReason || (wanted === 'local' ? '로컬 AI 모델이 없습니다.' : 'Gemini API 키가 없습니다.') };
  }
  function writeResult(cues, unique, translated, hash, model, cache = true) {
    if (!translated.size) throw new Error('번역 결과를 받지 못했습니다.');
    const out = path.join(cacheDir, `${hash}.vtt`), failed = unique.length - translated.size;
    const byText = new Map(unique.map(line => [line.text, translated.get(line.i)]));
    // Cues with the same timing (an ASS file's separate lines) become one cue, or the player draws them on top of
    // each other.
    const merged = new Map();
    for (const cue of cues) { const text = escapeCue(byText.get(plain(cue.text)) || plain(cue.text)); merged.set(cue.timing, merged.has(cue.timing) ? `${merged.get(cue.timing)}\n${text}` : text); }
    const body = [...merged].map(([timing, text]) => `${timing}\n${text}`).join('\n\n');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Partial results are not cached, so a later try can fill the gaps (nor are ones put together from both).
    const target = failed || !cache ? path.join(cacheDir, `${hash}-partial-${Date.now()}.vtt`) : out;
    fs.writeFileSync(target, `WEBVTT\n\n${body}\n`, 'utf8');
    return { path: target, model, failed, cached: false };
  }

  return { settings, saveSettings, translate, ready, local };
}

module.exports = { createTranslator };
