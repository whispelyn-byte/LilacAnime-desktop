// Korean machine translation of subtitles ("cloud": the translation API picked in 설정 — Gemini, OpenAI, DeepL or Qwen,
// as in the Android app — with the user's own key; "local": a GGUF model run by llama.cpp on this PC, see local-ai.cjs;
// chosen per request). Cues are read from the VTT the player already uses; only their text is sent (to the API in
// numbered batches, to the local model line by line), and the answers are written back with the original timings.
// Results are cached per source file and model.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLocalAi, promptVersion } = require('./local-ai.cjs');
const { characterTerms } = require('./anime-glossary.cjs');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const PROMPT_VERSION = 'prompt-3', LOCAL_PROMPT_VERSION = 'local-4';
// The translation APIs (with the Korean particles their names take) and how each is fed: Gemini gets a whole episode
// (a few hundred short lines) in one request where possible, since its free tier allows only a few requests a minute
// and a few dozen a day; OpenAI and Qwen answer shorter batches faster and stay within their output limits; DeepL takes
// at most 50 texts a request.
const CLOUDS = {
  gemini: { name: 'Gemini', eul: '를', ro: '로', lines: 600, chars: 30000, parallel: 2 },
  openai: { name: 'OpenAI', eul: '를', ro: '로', lines: 150, chars: 9000, parallel: 4 },
  deepl: { name: 'DeepL', eul: '을', ro: '로', lines: 50, chars: 20000, parallel: 2 },
  qwen: { name: 'Qwen', eul: '을', ro: '으로', lines: 100, chars: 6000, parallel: 4 }
};
const LOCAL_ENGINE = { name: '로컬 AI', eul: '를', ro: '로' };
const QWEN_API = { international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', china: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createTranslator(userData) {
  const settingsFile = path.join(userData, 'translation.json'), cacheDir = path.join(userData, 'subtitles', 'translated');
  // Kept as gemini.json while Gemini was the only API: moved once, under the name that says what it holds.
  const oldSettingsFile = path.join(userData, 'gemini.json');
  if (!fs.existsSync(settingsFile) && fs.existsSync(oldSettingsFile)) try { fs.renameSync(oldSettingsFile, settingsFile); } catch { /* read from the old name below */ }
  const local = createLocalAi(userData);
  // The picked model, or the first one on disk when the picked one is not (never downloaded, or deleted).
  const installedModel = id => { const models = local.models(); return models.some(model => model.id === id && model.installed) ? id : models.find(model => model.installed)?.id || id; };
  const read = () => {
    let value = {}; try { value = JSON.parse(fs.readFileSync(fs.existsSync(settingsFile) ? settingsFile : oldSettingsFile, 'utf8')) || {}; } catch { /* defaults */ }
    const text = name => String(value[name] || '').trim(), list = name => Array.isArray(value[name]) ? value[name] : [];
    return { key: text('key'), model: text('model'), models: list('models'), translateDownloads: value.translateDownloadsChosen ? value.translateDownloads === true : true, translateDownloadsChosen: Boolean(value.translateDownloadsChosen),
      // The API the 번역 API buttons use, and each API's key (and model, for OpenAI and Qwen; Qwen's region too).
      cloud: Object.hasOwn(CLOUDS, value.cloud) ? value.cloud : 'gemini',
      openaiKey: text('openaiKey'), openaiModel: text('openaiModel'), openaiModels: list('openaiModels'),
      deeplKey: text('deeplKey'),
      qwenKey: text('qwenKey'), qwenModel: text('qwenModel'), qwenModels: list('qwenModels'), qwenRegion: value.qwenRegion === 'china' ? 'china' : 'international',
      localModel: installedModel(String(value.localModel || 'gemma-4-e4b')),
      // How a picked Jimaku file is translated by itself: 'off', 'cloud' or 'local' ('gemini' before the other APIs came;
      // older settings still: on = whichever is set up).
      jimakuTranslate: value.jimakuTranslate === 'gemini' ? 'cloud' : ['off', 'cloud', 'local'].includes(value.jimakuTranslate) ? value.jimakuTranslate : value.autoJimaku === false ? 'off' : 'cloud' };
  };
  const keyOf = (value, api) => ({ gemini: value.key, openai: value.openaiKey, deepl: value.deeplKey, qwen: value.qwenKey })[api];
  // The API side is ready when any API has a key: the picked one is asked first, the others take over.
  const cloudKey = value => keyOf(value, value.cloud) || Object.keys(CLOUDS).map(api => keyOf(value, api)).find(Boolean);
  // With the local AI the installed model list is part of the settings the page shows, and the player needs to know
  // whether the picked API has its key (and what to call it on its buttons).
  const settings = () => { const value = read(); return { ...value, cloudReady: Boolean(cloudKey(value)), cloudName: CLOUDS[value.cloud].name, cloudRo: CLOUDS[value.cloud].ro, localModels: local.models() }; };
  // The player has a button for each provider. Translations nobody asks for (downloads) use the API when its key is
  // set, otherwise the local AI when its model is on disk; either way the other one takes over when it stops.
  const providerOf = provider => provider === 'gemini' ? 'cloud' : provider;
  const ready = provider => { const value = read(); provider = providerOf(provider); return provider === 'local' ? local.models().some(model => model.id === value.localModel && model.installed) : provider === 'cloud' ? Boolean(cloudKey(value)) : Boolean(autoProvider()); };
  const autoProvider = () => ready('cloud') ? 'cloud' : ready('local') ? 'local' : null;
  const write = value => { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(value), 'utf8'); return value; };

  async function api(pathname, key, init = {}) {
    const timeout = AbortSignal.timeout(init.body ? 180000 : 20000);
    const response = await fetch(`${GEMINI_API}${pathname}`, { ...init, signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout, headers: { 'x-goog-api-key': key, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
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

  // OpenAI, DeepL and Qwen over plain HTTP: the API's own error message, the status, and how long a rate limit asks to
  // wait. Busy (429 without the quota gone, 5xx) and timed-out requests are tried again a few times.
  async function http(name, url, { headers = {}, body, signal } = {}) {
    const timeout = AbortSignal.timeout(body ? 180000 : 20000);
    const response = await fetch(url, { method: body ? 'POST' : 'GET', signal: signal ? AbortSignal.any([timeout, signal]) : timeout, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const root = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = root?.error?.message || root?.message || '';
      const error = new Error(`${name} HTTP ${response.status}${message ? `: ${message}` : ''}`);
      error.status = response.status; error.retryAfter = Number(response.headers.get('retry-after')) || 0; throw error;
    }
    return root;
  }
  async function retried(run) {
    for (let attempt = 0; ; attempt++) {
      try { return await run(); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        const busy = (error.status === 429 && !/quota|billing|insufficient|exceeded your current/i.test(error.message)) || error.status >= 500 || error.name === 'TimeoutError';
        if (!busy || attempt >= 3) throw error;
        await sleep(Math.min(60000, (error.retryAfter || 2.5 * 2 ** attempt) * 1000));
      }
    }
  }
  const versionOf = name => Number(String(name).match(/(\d+(?:\.\d+)?)/)?.[1] || 0);
  // Chat models a key can use, newest first (audio, image, realtime, embedding and similar ones left out), and the
  // default: OpenAI's newest mini model, Qwen's qwen-plus (Android's choices).
  async function openaiModels(key) {
    const root = await http('OpenAI', 'https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    return (root.data || []).map(item => String(item.id)).filter(id => /^(gpt-\d|o\d)/.test(id) && !/audio|realtime|image|tts|transcribe|search|embedding|moderation|codex|instruct|oss|-\d{4}-\d{2}-\d{2}$/i.test(id))
      .sort((a, b) => versionOf(b) - versionOf(a) || a.length - b.length || a.localeCompare(b));
  }
  async function qwenModels(key, region) {
    const root = await http('Qwen', `${QWEN_API[region]}/models`, { headers: { Authorization: `Bearer ${key}` } });
    return (root.data || []).map(item => String(item.id)).filter(id => /^qw/i.test(id) && !/vl|audio|omni|tts|asr|coder|math|embedding|image|-mt-|ocr|realtime|deep-research/i.test(id)).sort();
  }
  async function checkDeepl(key) { await http('DeepL', `${deeplApi(key)}/usage`, { headers: { Authorization: `DeepL-Auth-Key ${key}` } }); }
  // Free API keys end in ":fx" and have their own server.
  const deeplApi = key => /:fx$/i.test(key) ? 'https://api-free.deepl.com/v2' : 'https://api.deepl.com/v2';

  // Only the fields given change; a new key is checked by listing its models.
  async function saveSettings(change = {}) {
    const current = read(), next = { ...current };
    // On until turned off in 설정 (translateDownloadsChosen: someone chose, so an old saved value is not taken as one).
    if ('translateDownloads' in change) Object.assign(next, { translateDownloads: change.translateDownloads === true, translateDownloadsChosen: true });
    if ('jimakuTranslate' in change && ['off', 'cloud', 'local'].includes(change.jimakuTranslate)) next.jimakuTranslate = change.jimakuTranslate;
    if ('cloud' in change && Object.hasOwn(CLOUDS, change.cloud)) next.cloud = change.cloud;
    if ('qwenRegion' in change && ['international', 'china'].includes(change.qwenRegion)) next.qwenRegion = change.qwenRegion;
    if ('openaiModel' in change && next.openaiModels.includes(change.openaiModel)) next.openaiModel = change.openaiModel;
    if ('qwenModel' in change && (next.qwenModels.includes(change.qwenModel) || !next.qwenModels.length)) next.qwenModel = String(change.qwenModel || '').trim();
    // A new key is checked before it is kept: OpenAI and Qwen by listing the models it can use, DeepL by its usage.
    if ('openaiKey' in change && String(change.openaiKey || '').trim() !== current.openaiKey) {
      next.openaiKey = String(change.openaiKey || '').trim(); next.openaiModels = []; next.openaiModel = '';
      if (next.openaiKey) {
        const models = await openaiModels(next.openaiKey);
        if (!models.length) throw new Error('이 키로 쓸 수 있는 OpenAI 모델이 없습니다.');
        Object.assign(next, { openaiModels: models, openaiModel: models.find(id => /mini$/.test(id)) || models[0] });
      }
    }
    if ('deeplKey' in change && String(change.deeplKey || '').trim() !== current.deeplKey) {
      next.deeplKey = String(change.deeplKey || '').trim();
      if (next.deeplKey) await checkDeepl(next.deeplKey);
    }
    if (('qwenKey' in change && String(change.qwenKey || '').trim() !== current.qwenKey) || ('qwenRegion' in change && next.qwenRegion !== current.qwenRegion && next.qwenKey)) {
      if ('qwenKey' in change) next.qwenKey = String(change.qwenKey || '').trim();
      next.qwenModels = []; next.qwenModel = '';
      if (next.qwenKey) {
        // A key belongs to one region (Singapore or Beijing): a 401 there means a wrong key or region.
        let models = [];
        try { models = await qwenModels(next.qwenKey, next.qwenRegion); } catch (error) { if (error.status === 401 || error.status === 403) throw new Error(`Qwen API 키를 확인하지 못했습니다. 키와 지역(${next.qwenRegion === 'china' ? '중국' : '국제'})을 확인해 주세요.`); }
        Object.assign(next, { qwenModels: models, qwenModel: models.includes('qwen-plus') ? 'qwen-plus' : models.find(id => /plus/.test(id)) || models[0] || 'qwen-plus' });
      }
    }
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
  async function generate(key, model, system, text, signal) {
    const schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { i: { type: 'INTEGER' }, t: { type: 'STRING' } }, required: ['i', 't'] } };
    const thinking = /^gemini-2\.5/.test(model) ? { thinkingBudget: /pro/.test(model) ? 128 : 0 } : { thinkingLevel: 'low' };
    const configs = [{ responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3, thinkingConfig: thinking }, { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3 }, { responseMimeType: 'application/json' }];
    let last = null;
    for (let index = workingConfig.get(model) || 0; index < configs.length; index++) {
      const generationConfig = configs[index];
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const root = await api(`/models/${encodeURIComponent(model)}:generateContent`, key, { method: 'POST', signal, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig }) });
          const output = (root.candidates?.[0]?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('');
          if (output) { workingConfig.set(model, index); return output; }
          last = new Error(`Gemini가 빈 응답을 보냈습니다 (${root.candidates?.[0]?.finishReason || root.promptFeedback?.blockReason || 'unknown'}).`); break;
        } catch (error) {
          last = error;
          if (error.name === 'AbortError' || error.status === 401 || error.status === 403 || error.status === 404 || /api key/i.test(error.message)) throw error;
          if (error.status === 429) {
            // The daily allowance is gone: no retry helps until it resets. A per-minute limit says how long to wait.
            const quotas = (error.details || []).flatMap(detail => detail.violations || []).map(item => String(item.quotaId || ''));
            if (quotas.some(id => /PerDay/i.test(id))) throw Object.assign(new Error(`Gemini 무료 사용량을 오늘 다 썼습니다 (${model}). 내일 다시 번역하거나 로컬 AI 번역을 쓰세요.`), { status: 429, daily: true });
            const wait = Number(String((error.details || []).find(detail => detail.retryDelay)?.retryDelay || '').replace(/s$/, '')) || Number(error.message.match(/retry in ([\d.]+)\s*s/i)?.[1]) || 2.5 * 2 ** attempt;
            if (wait > 120) throw error;
            await new Promise(resolve => setTimeout(resolve, (wait + 1) * 1000)); continue;
          }
          // Busy (503 "high demand"): asked once more, then another Flash model takes over (translateCloud).
          if (error.status >= 500 || error.name === 'TimeoutError') { if (attempt) throw error; await new Promise(resolve => setTimeout(resolve, 2500)); continue; }
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
  // ASS override tags in SRT / VTT text ({\an8} on Jimaku captions): the engines get the words alone (a model may drop
  // or mangle a tag), and the line's position tag is put back on the translation for the player.
  const untagged = text => text.replace(/\{\\[^}]*\}/g, '').replace(/^[ \t]+|[ \t]+$/gm, '').trim();
  const positionTag = text => text.match(/\{\\an[1-9]\}/)?.[0] || '';
  const escapeCue = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n{2,}/g, '\n').replace(/-->/g, '→');

  // Written like a Korean fansub team's style guide: the work, what the answer must look like, then how to translate.
  // context: {title (as shown in the app, usually Korean), originalTitle, genres, synopsis, characters: [{name, native,
  // first, last, gender}] from AniList}. Names come with a Korean spelling (anime-glossary) so every batch agrees.
  const system = (context = {}, wrapped = false) => {
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
      wrapped ? '- Input: a JSON object {"lines": [{i, t}, …]}, one subtitle line each, in playback order. The source is usually Japanese, sometimes English.' : '- Input: a JSON array of {i, t}, one subtitle line each, in playback order. The source is usually Japanese, sometimes English.',
      wrapped ? '- Output: only a JSON object {"lines": [...]} with exactly one {i, t} for every input item, the same i, t = the Korean subtitle. Never merge, split, skip or reorder lines; no notes or explanations.' : '- Output: only a JSON array with exactly one {i, t} for every input item, the same i, t = the Korean subtitle. Never merge, split, skip or reorder lines; no notes or explanations.',
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

  // An LLM's answer: the {i, t} items, as a bare array or wrapped in {"lines": […]}, maybe inside a code fence.
  const answerItems = text => { const answer = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, '')); return Array.isArray(answer) ? answer : Array.isArray(answer?.lines) ? answer.lines : []; };
  // OpenAI's Responses API and Qwen's OpenAI-style chat API. Each asks for structured JSON first and drops what a model
  // does not take (a JSON schema, a reasoning effort, the thinking switch), remembering what worked for the model.
  const workingRequest = new Map();
  async function askOpenai(settings, model, instructions, input, signal) {
    const schema = { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, t: { type: 'string' } }, required: ['i', 't'], additionalProperties: false } } }, required: ['lines'], additionalProperties: false };
    const reasoning = /^(o\d|gpt-5)/.test(model) ? { reasoning: { effort: 'low' } } : {};
    const shapes = [{ text: { format: { type: 'json_schema', name: 'subtitles', strict: true, schema } }, ...reasoning }, { text: { format: { type: 'json_object' } } }, {}];
    return askWithShapes(`openai:${model}`, shapes, async shape => {
      const root = await http('OpenAI', 'https://api.openai.com/v1/responses', { signal, headers: { Authorization: `Bearer ${settings.openaiKey}` }, body: { model, store: false, instructions, input, ...shape } });
      return (root.output || []).flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('');
    });
  }
  async function askQwen(settings, model, instructions, input, signal) {
    const shapes = [{ response_format: { type: 'json_object' }, enable_thinking: false }, { response_format: { type: 'json_object' } }, {}];
    return askWithShapes(`qwen:${model}`, shapes, async shape => {
      const root = await http('Qwen', `${QWEN_API[settings.qwenRegion]}/chat/completions`, { signal, headers: { Authorization: `Bearer ${settings.qwenKey}` }, body: { model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }], temperature: 0.3, ...shape } });
      return root.choices?.[0]?.message?.content || '';
    });
  }
  async function askWithShapes(id, shapes, run) {
    let last = null;
    for (let index = workingRequest.get(id) || 0; index < shapes.length; index++) {
      try { const text = await retried(() => run(shapes[index])); if (text) { workingRequest.set(id, index); return text; } last = new Error('API가 빈 응답을 보냈습니다.'); }
      catch (error) { last = error; if (error.name === 'AbortError' || error.status !== 400) throw error; }
    }
    throw last;
  }
  // DeepL translates the texts as they are, one answer for each, in order; the source language is detected (tracks can
  // be English). The anime's title goes along as context, which DeepL reads but does not translate.
  async function askDeepl(settings, texts, context, signal) {
    const root = await retried(() => http('DeepL', `${deeplApi(settings.deeplKey)}/translate`, { signal, headers: { Authorization: `DeepL-Auth-Key ${settings.deeplKey}` }, body: { text: texts, target_lang: 'KO', preserve_formatting: true, ...(context.title ? { context: `Anime subtitles: ${context.title}` } : {}) } }));
    const list = root.translations || [];
    if (list.length !== texts.length) throw new Error(`DeepL 응답 줄 수가 맞지 않습니다 (${texts.length}줄 중 ${list.length}줄).`);
    return list.map(item => String(item.text || '').trim());
  }

  // A model whose allowance is used up (or that the API no longer has) hands over to the API's other models of the same
  // kind, as Gemini's free tier counts each model apart, and OpenAI's daily token limits and Qwen's free quota are per
  // model too. Only models of the picked one's price class, so a paid key is not moved to a dearer model: Gemini's Flash
  // and Flash-Lite, OpenAI's mini and nano, Qwen's plus, flash and turbo. An OpenAI key out of credit (billing) has no
  // model left, so the next API or the local AI takes over as before. A used-up model is passed over until Gemini's
  // allowance resets (midnight Pacific time; a per-minute limit that asks for a long wait, five minutes), or for an hour
  // on the others. A model the API is too busy to answer (503, "high demand", seen on Gemini's free tier) hands over too,
  // and is passed over for five minutes.
  const spent = new Map(); // `${api}:${model}` -> until
  const usedUp = (api, error) => error.status === 404 || (error.status === 429 && !(api === 'openai' && /insufficient_quota|billing|exceeded your current quota/i.test(error.message))) || (api === 'qwen' && error.status === 403 && /quota|free ?tier/i.test(error.message));
  const busy = error => error.status >= 500 || error.name === 'TimeoutError';
  const spentUntil = (api, error) => {
    if (busy(error) || (api === 'gemini' && error.status === 429 && !error.daily)) return Date.now() + 300000;
    if (api !== 'gemini') return Date.now() + 3600000;
    const pacific = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    return Date.now() + (86400 - (pacific.getHours() * 3600 + pacific.getMinutes() * 60 + pacific.getSeconds())) * 1000;
  };
  const isSpent = (api, model) => (spent.get(`${api}:${model}`) || 0) > Date.now();
  function modelChain(settings, api, model) {
    const ranked = (list, rank) => list.map((name, index) => ({ name, index, rank: rank(name) })).filter(item => item.rank >= 0).sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.name);
    const others = api === 'gemini' ? ranked(settings.models, name => !/flash/.test(name) || /transcribe|customtools|image|tts|live|audio/.test(name) ? -1 : (/lite/.test(name) ? 2 : 0) + (/preview/.test(name) ? 1 : 0))
      : api === 'openai' ? ranked(settings.openaiModels, name => /mini/.test(name) ? 0 : /nano/.test(name) ? 1 : -1)
      : api === 'qwen' ? ranked(settings.qwenModels, name => { const kind = /plus/.test(name) ? 0 : /flash/.test(name) ? 2 : /turbo/.test(name) ? 4 : -1; return kind < 0 ? -1 : kind + (/\d{4}-?\d{2}-?\d{2}|\d{4}$/.test(name) ? 1 : 0); })
      : [];
    const chain = [model, ...others.filter(name => name !== model)].filter(name => !isSpent(api, name));
    return chain.length ? chain : [model];
  }

  // The picked API, batch by batch, into translated (by line id). Stops at an error every batch would hit (a bad key,
  // the allowance of every model used up) and throws it, keeping what was translated before. saved(model, ids) hears
  // which model answered which lines after each batch, onSwitch(from, to, busy) when another of the API's models takes
  // over. A batch is made when it is sent, of the lines left in order(lines) (from where the episode is playing): the
  // first small (40 lines, about two minutes of an episode), so those come back in seconds and are on screen while the
  // rest goes in as few batches as the API takes (Gemini's free tier allows 20 requests a model a day, so an episode
  // takes two). control.jump() (the episode jumped elsewhere) makes the next one small again and sends it at once beside
  // the batches on their way, so the new place does not wait for them.
  async function translateCloud(settings, api, model, lines, translated, context, { progress = () => {}, saved = () => {}, signal = null, onSwitch = () => {}, order = list => list, near = () => true, control = {} } = {}) {
    // left: lines not sent yet; sent: lines on their way (batch: the size of the batch each went in). rush: a jump landed
    // in a big batch on its way, so the next batch is made of the lines on their way from the new place (the batch
    // answering first is the one used).
    const cloud = CLOUDS[api], chain = modelChain(settings, api, model), left = new Set(lines), sent = new Set(), batch = new Map();
    let at = 0, small = 0, rush = false;
    const take = () => {
      const pool = rush ? [...sent].filter(line => !translated.has(line.i)) : [...left];
      const group = []; let size = 0; const most = Math.min(cloud.lines, small ? Infinity : 40);
      for (const line of order(pool)) { if (group.length && (group.length >= most || size + line.text.length > cloud.chars)) break; group.push(line); size += line.text.length; }
      for (const line of group) { left.delete(line); sent.add(line); batch.set(line, group.length); }
      if (group.length) small++;
      rush = false;
      return group;
    };
    // (Said after a tick: a run that starts on another model gets here before translate() has added its caller.)
    if (chain[0] !== model) { await null; onSwitch(model, chain[0]); }
    const ask = async (group, model) => {
      if (api === 'deepl') { const texts = await askDeepl(settings, group.map(line => line.text), context, signal); return group.map((line, index) => ({ i: line.i, t: texts[index] })); }
      if (api === 'gemini') return answerItems(await generate(settings.key, model, system(context), JSON.stringify(group.map(line => ({ i: line.i, t: line.text }))), signal));
      const input = JSON.stringify({ lines: group.map(line => ({ i: line.i, t: line.text })) }), instructions = system(context, true);
      return answerItems(api === 'openai' ? await askOpenai(settings, model, instructions, input, signal) : await askQwen(settings, model, instructions, input, signal));
    };
    let fatal = null, active = 0;
    progress(0, lines.length);
    const worker = async () => {
      active++;
      try { await work(); } finally { active--; }
    };
    const work = async () => {
      while ((left.size || rush) && !fatal && !signal?.aborted) {
        const group = take(), ids = new Set(group.map(line => line.i));
        if (!group.length) break;
        for (let attempt = 0; attempt < 2 && !fatal;) {
          const asked = chain[at];
          try {
            const answer = await ask(group, asked);
            // Only this batch's lines, and only lines not translated yet (a line sent twice after a jump keeps the first
            // answer, the one on screen): a stray id must not overwrite another batch's translation.
            const got = [];
            for (const item of answer) if (ids.has(item?.i) && !translated.has(item.i) && typeof item.t === 'string' && item.t.trim()) { translated.set(item.i, item.t.trim()); got.push(item.i); }
            saved(asked, got);
            if (group.every(line => translated.has(line.i)) || attempt) break;
            attempt++;
          } catch (error) {
            // The model's allowance used up: the next model asks for this batch again (another batch may have moved on
            // already). With none left, or a bad key, every batch would fail the same way; a cancel stops them all.
            if (error.name !== 'AbortError' && api !== 'deepl' && (usedUp(api, error) || busy(error))) {
              spent.set(`${api}:${asked}`, spentUntil(api, error));
              if (chain[at] === asked && at + 1 < chain.length) { at++; onSwitch(asked, chain[at], busy(error)); }
              if (chain[at] !== asked) continue;
            }
            if (error.name === 'AbortError' || error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404 || error.status === 429) { fatal = error; break; }
            if (attempt) break;
            attempt++;
          }
        }
        for (const line of group) sent.delete(line);
        progress(lines.filter(line => translated.has(line.i)).length, lines.length);
      }
    };
    const workers = Array.from({ length: cloud.parallel }, () => worker());
    // A jump asks for more only when the new place would wait: its first line not translated yet comes within a minute
    // (near) and is still to be sent (a small batch from there goes at once) or on its way in a big batch (a small one
    // goes beside it). A jump the app makes by itself (skipping the opening, the resume point) to lines done or on their
    // way in a small batch costs no request.
    control.jump = () => {
      if (fatal) return;
      const first = order(lines.filter(line => !translated.has(line.i)))[0];
      if (!first || !near(first) || !(left.has(first) || (sent.has(first) && batch.get(first) > 40))) return;
      small = 0; rush = !left.has(first);
      if (active <= cloud.parallel) workers.push(worker());
    };
    for (let count = 0; count !== workers.length;) { count = workers.length; await Promise.all(workers); }
    control.jump = () => {};
    if (fatal) throw fatal;
    if (signal?.aborted) throw cancelled();
    if (!lines.some(line => translated.has(line.i))) throw new Error(`${cloud.name} 번역 결과를 받지 못했습니다.`);
  }

  // provider: the one asked for ('cloud' = the API picked in 설정, or 'local'), otherwise the API when one has a key,
  // else the local AI. When it is not set up or stops (no key, the allowance used up, no model, llama.cpp not starting)
  // the next one takes over and translates the lines still left: the picked API, then any other API with a key, then
  // the local AI (the local AI first when it was asked for). progress(done, total) is called after each batch (local:
  // each line); status(text) while the local model starts or another one takes over.
  // One run per file and provider: asking again while it runs (the episode opened again, a download's track) waits for
  // the same run and gets its progress from then on.
  // A caller can leave with cancel(id) (the player when its episode changes, or its button pressed again); the run
  // stops once nobody waits for it any more, keeping the lines it had (the next run goes on from them).
  const running = new Map();
  const cancelled = () => Object.assign(new Error('번역을 취소했습니다.'), { name: 'AbortError', cancelled: true });
  async function translate({ progress = () => {}, status = () => {}, lines = () => {}, id = null, ...options }) {
    options.provider = providerOf(options.provider || '');
    // A run is known by what it translates, not by where the file is: a site track is saved under a new name each time
    // it is fetched, so the next episode made ready ahead (main's subtitle:prepare) is joined when it is opened.
    let content = options.file; try { content = crypto.createHash('sha1').update(fs.readFileSync(options.file)).digest('hex'); } catch { /* reported by the run */ }
    const key = `${content}\n${options.provider}`;
    let job = running.get(key), joined = true;
    // A run being cancelled is not joined: a new one starts (and goes on from the lines it kept).
    if (!job || job.abort.signal.aborted) {
      const abort = new AbortController(), created = { listeners: new Set(), abort, control: {} }; joined = false;
      job = created;
      job.promise = translateOnce({ ...options, control: created.control, signal: abort.signal, progress: (...args) => created.listeners.forEach(listener => listener.progress(...args)), status: text => created.listeners.forEach(listener => listener.status(text)), onLines: items => created.listeners.forEach(listener => listener.lines(items)) })
        .finally(() => { if (running.get(key) === created) running.delete(key); });
      job.promise.catch(() => { /* every caller may have left: the end of a cancelled run goes unheard */ });
      running.set(key, job);
    }
    let leave;
    const listener = { id, progress, status, lines, left: new Promise((_, reject) => { leave = () => reject(cancelled()); }) };
    listener.leave = leave; listener.left.catch(() => {});
    job.listeners.add(listener);
    // One who joins a run (the next episode opened while it is made ready) gets the lines done so far at once, and the
    // run goes on from where this one is playing.
    const done = job.control.done?.() || [];
    if (done.length) lines(done);
    if (joined && options.playing) job.control.jump?.(options.playing);
    try { return await Promise.race([job.promise, listener.left]); } finally { job.listeners.delete(listener); }
  }
  // The player jumped (seconds): its run translates from there next.
  function jump(id, seconds) {
    for (const job of running.values()) if ([...job.listeners].some(listener => listener.id !== null && listener.id === id)) job.control.jump?.(seconds);
  }
  function cancel(id) {
    for (const job of running.values()) for (const listener of job.listeners) if (listener.id !== null && listener.id === id) {
      job.listeners.delete(listener); listener.leave();
      if (!job.listeners.size) job.abort.abort();
    }
  }
  // playing: the time (seconds) the episode is at: the lines from there are translated first, the ones before it
  // last; control.jump(seconds) moves it while the run goes on. onLines([{raw, text}]) hears the lines translated so far
  // (the cue's text in the file, the translated cue's), a few at a time, so the player can show them before the rest is
  // done; control.done() gives all of them.
  async function translateOnce({ file, title = '', provider = '', context = {}, signal = null, progress = () => {}, status = () => {}, playing = 0, onLines = () => {}, control = {} }) {
    const settings = read(), wanted = provider || autoProvider() || 'cloud';
    // The engines in the order they are tried: an API's name, or 'local'.
    const apis = [settings.cloud, ...Object.keys(CLOUDS).filter(api => api !== settings.cloud)].filter(api => keyOf(settings, api));
    const order = (wanted === 'local' ? ['local', ...apis] : [...apis, 'local']).filter(name => name !== 'local' || ready('local'));
    if (!order.length) throw new Error(wanted === 'local' ? '설정 > 자막 자동 번역에서 로컬 AI 모델을 먼저 받아 주세요.' : `설정 > 자막 자동 번역에서 ${CLOUDS[settings.cloud].name} API 키를 넣어 주세요.`);
    const localModel = local.models().find(item => item.id === settings.localModel);
    // A Gemini model is named as before (so translations made then are still found); the other APIs by their name.
    const modelFor = api => ({ gemini: settings.model || defaultModel(settings.models) || 'gemini-flash-latest', openai: settings.openaiModel, deepl: '', qwen: settings.qwenModel || 'qwen-plus' })[api];
    const modelOf = name => name === 'local' ? `local:${localModel.file || localModel.label}` : name === 'gemini' ? modelFor(name) : `${name}${modelFor(name) ? `:${modelFor(name)}` : ''}`;
    const engineOf = name => name === 'local' ? LOCAL_ENGINE : CLOUDS[name];
    // The prompt version is part of the cache key, so a better prompt is not hidden behind older results.
    const source = fs.readFileSync(file, 'utf8');
    const hashOf = name => crypto.createHash('sha1').update(`${modelOf(name)}\n${name === 'local' ? LOCAL_PROMPT_VERSION + promptVersion(localModel) : PROMPT_VERSION}\n${source}`).digest('hex').slice(0, 20);
    // Kept translations are taken from the side that translates now only: the local AI's for the local AI, the APIs'
    // (the picked one's first, then one another API made when it could not be used) for the API, so the two stay apart.
    // The side is the first one set up: the API asked for without any key is the local AI's side.
    const side = order[0] === 'local', sameSide = name => (name === 'local') === side;
    for (const name of order.filter(sameSide)) {
      const out = path.join(cacheDir, `${hashOf(name)}.vtt`);
      if (!fs.existsSync(out)) continue;
      const models = modelsIn(out);
      progress(1, 1); return { path: out, model: Object.keys(models)[0] || modelOf(name), models, engine: engineOf(name).name, failed: 0, cached: true };
    }

    const parsed = parseVtt(source);
    if (!parsed.length) throw new Error('번역할 자막 줄이 없습니다.');
    const seconds = timing => { const parts = timing.trim().split(/\s/)[0].replace(',', '.').split(':').map(Number); return parts.reduce((sum, part) => sum * 60 + part, 0); };
    // A bilingual file (Jimaku's CHS+JPN ASS files: a Chinese line beside each Japanese one) is translated from its
    // Japanese lines, or every line came out twice in Korean: a line of Chinese characters without kana that is on screen
    // with a line with kana is left out of the translation and of the translated file (and hidden while it runs), when the
    // file has many such pairs (a Japanese line of kanji alone, 先生, is not taken for Chinese elsewhere).
    const kana = /[぀-ヿ]/, chinese = text => /[一-鿿]/.test(text) && !kana.test(text);
    const spans = parsed.map(cue => { const [from, to] = cue.timing.split('-->'); return { cue, from: seconds(from), to: seconds(to), text: plain(cue.text) }; });
    const japanese = spans.filter(span => kana.test(span.text));
    const paired = spans.filter(span => chinese(span.text) && japanese.some(other => other.from < span.to && span.from < other.to));
    const bilingual = paired.length >= 20 && paired.length >= japanese.length / 3, dropped = new Set(bilingual ? paired.map(span => span.cue) : []);
    const cues = parsed.filter(cue => !dropped.has(cue));
    const blanks = [...new Set(paired.filter(span => dropped.has(span.cue)).map(span => span.text))].filter(raw => !cues.some(cue => plain(cue.text) === raw)).map(raw => ({ raw, text: '' }));
    // Identical lines (repeated cues, karaoke layers) are translated once. raw: the cue's text as it is (with its tags).
    const unique = [...new Set(cues.map(cue => plain(cue.text)).filter(text => /\p{L}/u.test(untagged(text))))].map((raw, i) => ({ i, raw, text: untagged(raw) }));
    // Where each line is first heard, and the order to translate them in: from a few seconds before where the episode is
    // playing to the end, then the beginning (in time order). A jump moves that place for the lines still left.
    const start = new Map(); for (const cue of cues) { const raw = plain(cue.text); if (!start.has(raw)) start.set(raw, seconds(cue.timing)); }
    let playFrom = Math.max(0, Number(playing) || 0) - 5;
    const passed = line => (start.get(line.raw) ?? 0) < playFrom;
    const playingFirst = lines => [...lines.filter(line => !passed(line)), ...lines.filter(passed)];
    const near = line => !passed(line) && (start.get(line.raw) ?? 0) < playFrom + 65;
    // The local AI asks for one line at a time: the first one left from where the episode is.
    const sooner = (a, b) => passed(a) !== passed(b) ? !passed(a) : (start.get(a.raw) ?? 0) < (start.get(b.raw) ?? 0);
    const nextLine = left => { let best = null; for (const line of left) if (!best || sooner(line, best)) best = line; return best; };
    const engine = {};
    control.jump = seconds => { playFrom = Math.max(0, Number(seconds) || 0) - 5; engine.jump?.(); };
    // Lines are also kept one by one per engine as they come in (every few seconds), so a run that stopped part-way
    // (lines that failed, the episode or the app closed, the allowance gone) goes on from where it was: only the
    // missing lines are translated again.
    // by: the engine of each line; lineModel: the model that translated it (kept lines: the engine's picked model).
    const translated = new Map(), by = new Map(), lineModel = new Map(), linesFile = name => path.join(cacheDir, `${hashOf(name)}.lines.json`);
    for (const name of order.filter(sameSide)) {
      let kept = {}; try { kept = JSON.parse(fs.readFileSync(linesFile(name), 'utf8')) || {}; } catch { continue; }
      for (const line of unique) if (!translated.has(line.i) && typeof kept[line.text] === 'string') { translated.set(line.i, kept[line.text]); by.set(line.i, name); lineModel.set(line.i, modelOf(name)); }
    }
    // The translated lines go to the player together every 0.7 s (the local AI writes a few a second).
    const pending = new Set(); let flushTimer = null;
    const item = i => ({ raw: unique[i].raw, text: escapeCue(positionTag(unique[i].raw) + translated.get(i)) });
    // The Chinese lines of a bilingual file go with the first ones, as blanks (the player leaves them out).
    let blanksSent = !blanks.length;
    const flush = () => { clearTimeout(flushTimer); flushTimer = null; if (!pending.size) return; onLines([...(blanksSent ? [] : blanks), ...[...pending].map(item)]); blanksSent = true; pending.clear(); };
    control.done = () => [...blanks, ...[...translated.keys()].map(item)];
    const shown = ids => { for (const i of ids) pending.add(i); flushTimer ||= setTimeout(flush, 700); };
    shown(translated.keys());
    let saveTimer = null;
    const keep = name => {
      for (const i of translated.keys()) if (!by.has(i)) by.set(i, name);
      const lines = Object.fromEntries(unique.filter(line => by.get(line.i) === name).map(line => [line.text, translated.get(line.i)]));
      if (!Object.keys(lines).length) return;
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(linesFile(name), JSON.stringify(lines), 'utf8'); } catch { /* kept in memory for this run */ }
    };
    const keepSoon = name => { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; keep(name); }, 5000); };
    let lastError = null, fallbackReason = '', tried = null, switched = null;
    // Another of the API's models taking over (the picked one's allowance used up): said while it runs and at the end.
    const onSwitch = (from, to, busy = false) => { const why = busy ? '서버가 바빠' : '사용량을 다 써서'; switched = { from: switched?.from || from, to, why: switched?.why || why }; status(`${from} ${why} ${to} 모델로 번역하는 중`); };
    for (const name of order) {
      const lines = unique.filter(line => !translated.has(line.i));
      if (!lines.length || signal?.aborted) break;
      if (tried) { fallbackReason = lastError?.message || ''; status(`${engineOf(tried).name}${engineOf(tried).eul} 쓸 수 없어 ${engineOf(name).name}${engineOf(name).ro} 번역하는 중`); }
      tried = name;
      try {
        // The local AI gets the lines in time order (each with the ones before it) and takes the next one from where the
        // episode is each time a slot frees up; the API's batches are made the same way as they are sent.
        if (name === 'local') {
          const position = new Map(lines.map((line, index) => [line, index])), left = new Set(lines);
          const pick = () => { const line = nextLine(left); if (!line) return undefined; left.delete(line); return position.get(line); };
          engine.jump = null;
          await local.translateLines(lines.map(line => line.text), { modelId: localModel.id, progress, status, context, signal, pick, onLine: (index, text) => { translated.set(lines[index].i, text); lineModel.set(lines[index].i, modelOf(name)); shown([lines[index].i]); keepSoon(name); } });
        } else await translateCloud(settings, name, modelFor(name), lines, translated, { title, ...context }, { progress, signal, onSwitch, order: playingFirst, near, control: engine, saved: (model, ids) => { for (const i of ids) lineModel.set(i, name === 'gemini' ? model : `${name}${model ? `:${model}` : ''}`); shown(ids); keepSoon(name); } });
        lastError = null;
      } catch (error) { lastError = error; }
      clearTimeout(saveTimer); saveTimer = null; keep(name); flush();
      if (signal?.aborted) throw cancelled();
      if (!lastError && unique.every(line => translated.has(line.i))) break;
    }
    if (!translated.size) throw lastError || new Error('번역 결과를 받지 못했습니다.');
    // The engine that did most of the lines names the result. A finished translation is cached under its name (found
    // again whichever engine is asked first) and its kept lines go; an unfinished one is kept only for this time.
    const count = name => [...by.values()].filter(value => value === name).length;
    const used = order.filter(name => count(name)), main = [...used].sort((a, b) => count(b) - count(a))[0];
    // The models that did the lines, most first, are written into the file (the cache is named by the picked model, so
    // the file says which one it really was) and given with the result.
    const models = {};
    for (const i of translated.keys()) { const model = lineModel.get(i) || modelOf(by.get(i) || main); models[model] = (models[model] || 0) + 1; }
    const ranked = Object.fromEntries(Object.entries(models).sort((a, b) => b[1] - a[1]));
    const written = writeResult(cues, unique, translated, hashOf(main), ranked);
    if (!written.failed) for (const name of used) try { fs.unlinkSync(linesFile(name)); } catch { /* none kept */ }
    const result = { ...written, engine: engineOf(main).name };
    // Said when the one asked for (the button's API or the local AI) did not do it all.
    const intended = wanted === 'local' ? 'local' : settings.cloud, from = engineOf(intended), others = used.filter(name => name !== intended);
    if (!others.length) return switched ? { ...result, fallbackNote: `${switched.from} ${switched.why} ${switched.to} 모델로 번역했습니다` } : result;
    if (used.includes(intended)) return { ...result, fallbackNote: `${others.reduce((sum, name) => sum + count(name), 0)}줄은 ${engineOf(others[others.length - 1]).name}${engineOf(others[others.length - 1]).ro} 번역했습니다`, fallbackReason: fallbackReason || '' };
    const to = engineOf(others[others.length - 1]);
    return { ...result, fallbackNote: `${from.name}${from.eul} 쓸 수 없어 ${to.name}${to.ro} 번역했습니다`, fallbackReason: fallbackReason || (!order.includes(intended) ? (intended === 'local' ? '로컬 AI 모델이 없습니다.' : `${from.name} API 키가 없습니다.`) : '') };
  }
  // NOTE: a WebVTT comment, which players skip ("translated-by: gemini-3.6-flash=1290; gemini-3.8-flash=10").
  const modelsIn = file => {
    let head = ''; try { const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024); head = buffer.subarray(0, fs.readSync(fd, buffer, 0, 1024, 0)).toString('utf8'); fs.closeSync(fd); } catch { /* no models then */ }
    const list = head.match(/^translated-by: (.+)$/m)?.[1] || '';
    return Object.fromEntries(list.split('; ').map(item => item.match(/^(.+)=(\d+)$/)).filter(Boolean).map(match => [match[1], Number(match[2])]));
  };
  function writeResult(cues, unique, translated, hash, models) {
    if (!translated.size) throw new Error('번역 결과를 받지 못했습니다.');
    const out = path.join(cacheDir, `${hash}.vtt`), failed = unique.length - translated.size;
    const byText = new Map(unique.filter(line => translated.has(line.i)).map(line => [line.raw, positionTag(line.raw) + translated.get(line.i)]));
    // Cues with the same timing (an ASS file's separate lines) become one cue, or the player draws them on top of
    // each other; a top line ({\an8}) and a bottom one are kept apart, so each stays where it belongs.
    const merged = new Map();
    for (const cue of cues) { const raw = plain(cue.text), text = escapeCue(byText.get(raw) || raw), key = `${cue.timing}\n${/\{\\an[789]\}/.test(raw) ? 'top' : ''}`; merged.set(key, merged.has(key) ? `${merged.get(key)}\n${text}` : text); }
    const body = [...merged].map(([key, text]) => `${key.split('\n')[0]}\n${text}`).join('\n\n');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Unfinished results are not cached, so a later try can fill the gaps.
    const target = failed ? path.join(cacheDir, `${hash}-partial-${Date.now()}.vtt`) : out;
    const note = Object.entries(models).map(([model, lines]) => `${model}=${lines}`).join('; ');
    fs.writeFileSync(target, `WEBVTT\n\n${note ? `NOTE\ntranslated-by: ${note}\n\n` : ''}${body}\n`, 'utf8');
    return { path: target, model: Object.keys(models)[0] || '', models, failed, cached: false };
  }

  return { settings, saveSettings, translate, cancel, jump, ready, local, clouds: CLOUDS };
}

module.exports = { createTranslator };
