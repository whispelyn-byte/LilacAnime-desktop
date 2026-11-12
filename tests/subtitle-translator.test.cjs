const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.resolve(__dirname, '../electron/subtitle-translator.cjs');
const source = fs.readFileSync(filename, 'utf8');
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// A streamed Messages API answer (the SDK streams Claude's requests): one text block, then the stop reason.
const claudeStream = (text, stopReason = 'end_turn', stopDetails = null) => new Response([
  ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: 1 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
function setup(t, fetch, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-ai-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'translation.json'), JSON.stringify(settings));
  const module = { exports: {} }, requireReal = createRequire(filename);
  const sandbox = { module, exports: module.exports, fetch, AbortSignal, AbortController, setTimeout, clearTimeout,
    Buffer, console, require: name => name === './local-ai.cjs' ? { createLocalAi: () => ({ models: () => [] }), promptVersion: () => '' } : requireReal(name) };
  // Exercise the real request/retry functions without adding a production test API.
  vm.runInNewContext(source.replace('return { settings, saveSettings, translate, cancel, jump, ready, local, clouds: CLOUDS, defaultRules: () => TRANSLATION_RULES };',
    'return { settings, saveSettings, translate, cancel, generate, askOpenai, askQwen, askDeepl, askClaude, system, defaultRules: () => TRANSLATION_RULES };'), sandbox, { filename });
  return { ai: module.exports.createTranslator(dir), dir };
}

for (const [model, thinking] of [['gemini-2.5-flash', { thinkingBudget: 0 }], ['gemini-2.5-pro', { thinkingBudget: 128 }], ['gemini-3-flash', { thinkingLevel: 'low' }]]) {
  test(`Gemini request and thought filtering: ${model}`, async t => {
    const { ai } = setup(t, async (url, init) => {
      assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
      assert.equal(init.headers['x-goog-api-key'], 'fake-key');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.generationConfig.thinkingConfig, thinking);
      assert.equal(body.generationConfig.responseSchema.type, 'ARRAY');
      assert.equal(body.systemInstruction.parts[0].text, 'Translate');
      return response({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: '[{"i":0,"t":"안녕"}]' }] } }] });
    });
    assert.equal(await ai.generate('fake-key', model, 'Translate', '[]'), '[{"i":0,"t":"안녕"}]');
  });
}

test('OpenAI uses Responses structured outputs and keeps response storage off', async t => {
  const { ai } = setup(t, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer fake-key');
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.equal(body.reasoning.effort, 'low');
    return response({ output: [{ type: 'reasoning', summary: [] }, { content: [{ type: 'output_text', text: '{"lines":[]}' }] }] });
  });
  assert.equal(await ai.askOpenai({ openaiKey: 'fake-key' }, 'gpt-5-mini', 'JSON', '{}'), '{"lines":[]}');
});

for (const [region, host] of [['international', 'dashscope-intl.aliyuncs.com'], ['china', 'dashscope.aliyuncs.com']]) {
  test(`Qwen region, JSON and thinking switch: ${region}`, async t => {
    const { ai } = setup(t, async (url, init) => {
      assert.equal(url, `https://${host}/compatible-mode/v1/chat/completions`);
      const body = JSON.parse(init.body);
      assert.equal(body.enable_thinking, false);
      assert.equal(body.response_format.type, 'json_object');
      assert.equal(body.messages[0].role, 'system');
      return response({ choices: [{ message: { content: '{"lines":[]}' } }] });
    });
    assert.equal(await ai.askQwen({ qwenKey: 'fake-key', qwenRegion: region }, 'qwen-plus', 'JSON', '{}'), '{"lines":[]}');
  });
}

for (const [key, host] of [['fake:fx', 'api-free.deepl.com'], ['fake', 'api.deepl.com']]) {
  test(`DeepL endpoint and ordered translations: ${host}`, async t => {
    const { ai } = setup(t, async (url, init) => {
      assert.equal(url, `https://${host}/v2/translate`);
      assert.equal(init.headers.Authorization, `DeepL-Auth-Key ${key}`);
      const body = JSON.parse(init.body);
      assert.deepEqual(body.text, ['hello', 'bye']);
      assert.equal(body.target_lang, 'KO');
      assert.equal(body.context, 'Anime subtitles: Example');
      return response({ translations: [{ text: '안녕' }, { text: '잘 가' }] });
    });
    assert.deepEqual(Array.from(await ai.askDeepl({ deeplKey: key }, ['hello', 'bye'], { title: 'Example' })), ['안녕', '잘 가']);
  });
}

test('Qwen connection failure, empty models and wrong region never replace saved credentials', async t => {
  for (const failure of [() => { throw new TypeError('fetch failed'); }, () => response({ error: { message: 'busy' } }, 503), () => response({ error: { message: 'invalid key' } }, 401), () => response({ data: [] })]) {
    const original = { qwenKey: 'old-fake', qwenRegion: 'international', qwenModel: 'qwen-plus', qwenModels: ['qwen-plus'] };
    const { ai, dir } = setup(t, failure, original);
    await assert.rejects(ai.saveSettings({ qwenKey: 'new-fake', qwenRegion: 'china' }));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'translation.json'), 'utf8')), original);
  }
});

test('Qwen valid model list is saved after validation', async t => {
  const { ai } = setup(t, async () => response({ data: [{ id: 'qwen-plus' }, { id: 'qwen-vl-plus' }] }));
  const saved = await ai.saveSettings({ qwenKey: 'fake-key' });
  assert.equal(saved.qwenModel, 'qwen-plus');
  assert.deepEqual(Array.from(saved.qwenModels), ['qwen-plus']);
});

test('Gemini daily quota fails immediately without repeated requests', async t => {
  let calls = 0;
  const { ai } = setup(t, async () => { calls++; return response({ error: { message: 'quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDay' }] }] } }, 429); });
  await assert.rejects(ai.generate('fake-key', 'gemini-2.5-flash', 'JSON', '[]'), error => error.status === 429 && error.daily);
  assert.equal(calls, 1);
});

test('OpenAI falls back from unsupported schema and remembers the accepted request', async t => {
  const formats = [];
  const { ai } = setup(t, async (url, init) => {
    const format = JSON.parse(init.body).text.format.type;
    formats.push(format);
    return format === 'json_schema' ? response({ error: { message: 'Unsupported format' } }, 400)
      : response({ output: [{ content: [{ type: 'output_text', text: '{"lines":[]}' }] }] });
  });
  for (let i = 0; i < 2; i++) await ai.askOpenai({ openaiKey: 'fake-key' }, 'gpt-5-mini', 'JSON', '{}');
  assert.deepEqual(formats, ['json_schema', 'json_object', 'json_object']);
});

test('Gemini daily quota hands unfinished subtitles to the next configured API', async t => {
  const hosts = [];
  const { ai, dir } = setup(t, async url => {
    hosts.push(new URL(url).hostname);
    if (url.includes('googleapis.com')) return response({ error: { message: 'quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDay' }] }] } }, 429);
    return response({ output: [{ content: [{ type: 'output_text', text: '{"lines":[{"i":0,"t":"안녕"}]}' }] }] });
  }, { cloud: 'gemini', key: 'fake-key', model: 'gemini-2.5-flash', openaiKey: 'fake-openai', openaiModel: 'gpt-5-mini' });
  const file = path.join(dir, 'source.vtt');
  fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
  const result = await ai.translate({ file, provider: 'cloud' });
  assert.equal(result.failed, 0);
  assert.equal(result.engine, 'OpenAI');
  assert.match(result.fallbackNote, /OpenAI/);
  assert.deepEqual(hosts, ['generativelanguage.googleapis.com', 'api.openai.com']);
});

for (const api of ['gemini', 'openai', 'qwen', 'deepl', 'claude']) {
  test(`${api} cancellation interrupts rate-limit wait and sends no further requests`, async t => {
    let calls = 0;
    const { ai } = setup(t, async () => { calls++; return response({ error: { message: 'Rate limit exceeded', details: [{ retryDelay: '60s' }] } }, 429); });
    const abort = new AbortController();
    const promise = api === 'gemini' ? ai.generate('fake-key', 'gemini-2.5-flash', 'JSON', '[]', abort.signal)
      : api === 'openai' ? ai.askOpenai({ openaiKey: 'fake-key' }, 'gpt-5-mini', 'JSON', '{}', abort.signal)
      : api === 'qwen' ? ai.askQwen({ qwenKey: 'fake-key', qwenRegion: 'international' }, 'qwen-plus', 'JSON', '{}', abort.signal)
      : api === 'claude' ? ai.askClaude({ claudeKey: 'fake-key' }, 'claude-opus-5-5', 'JSON', '{}', abort.signal)
      : ai.askDeepl({ deeplKey: 'fake-key' }, ['hello'], {}, abort.signal);
    // Let fetch parsing complete and enter the retry delay before cancelling.
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(calls, 1);
  });
}

for (const api of ['gemini', 'openai', 'qwen', 'deepl', 'claude']) {
  test(`${api} complete subtitle translation preserves timing and caches result`, async t => {
    let calls = 0;
    const keys = { gemini: { key: 'fake-key', model: 'gemini-2.5-flash' }, openai: { openaiKey: 'fake-key', openaiModel: 'gpt-5-mini' }, qwen: { qwenKey: 'fake-key', qwenModel: 'qwen-plus' }, deepl: { deeplKey: 'fake:fx' }, claude: { claudeKey: 'fake-key', claudeModel: 'claude-opus-5-5', claudeModels: ['claude-opus-5-5'] } };
    const { ai, dir } = setup(t, async (url, init) => {
      calls++;
      const body = JSON.parse(init.body), answer = '[{"i":0,"t":"안녕"}]';
      if (api === 'gemini') return response({ candidates: [{ content: { parts: [{ text: answer }] } }] });
      if (api === 'openai') return response({ output: [{ content: [{ type: 'output_text', text: `{"lines":${answer}}` }] }] });
      if (api === 'qwen') return response({ choices: [{ message: { content: `{"lines":${answer}}` } }] });
      if (api === 'claude') return claudeStream(`{"lines":${answer}}`);
      assert.equal(body.text.length, 1);
      return response({ translations: [{ text: '안녕' }] });
    }, { cloud: api, ...keys[api] });
    const file = path.join(dir, 'source.vtt');
    fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
    const translated = await ai.translate({ file, provider: 'cloud' });
    assert.equal(translated.failed, 0);
    assert.match(fs.readFileSync(translated.path, 'utf8'), /00:00:01.000 --> 00:00:02.000\n안녕/);
    assert.equal((await ai.translate({ file, provider: 'cloud' })).cached, true);
    assert.equal(calls, 1);
  });
}

test('효과음·화자 이름 빼고 번역: labels and speaker names never reach the engine, and sound-only cues leave the file', async t => {
  const sent = [];
  const { ai, dir } = setup(t, async (url, init) => {
    const body = JSON.parse(init.body); sent.push(...body.text);
    return response({ translations: body.text.map(() => ({ text: '어?' })) });
  }, { cloud: 'deepl', deeplKey: 'fake:fx', dropCaptions: true });
  const file = path.join(dir, 'source.vtt');
  fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n（創太）えっ？\n\n00:00:03.000 --> 00:00:04.000\n（ため息）\n\n00:00:05.000 --> 00:00:06.000\nはあ…\n');
  const result = await ai.translate({ file, provider: 'cloud' });
  assert.deepEqual(sent, ['えっ？']);
  assert.equal(result.failed, 0);
  const out = fs.readFileSync(result.path, 'utf8');
  assert.match(out, /00:00:01.000 --> 00:00:02.000\n어\?/);
  assert.doesNotMatch(out, /00:00:03|00:00:05|ため息|はあ/);
});

test('번역 프롬프트: the user rules replace or follow the app rules, and the answer format always stays', async t => {
  const { ai } = setup(t, async () => response({}));
  const plain = ai.system({ title: '작품' }, true);
  assert.match(plain, /TRANSLATION\n- Read the lines as a scene/);
  assert.doesNotMatch(plain, /ADDITIONAL RULES/);
  const custom = ai.system({ title: '작품', rules: { custom: '- 의역 우선', extra: '- 욕설 유지' } }, true);
  assert.match(custom, /Anime: 작품/);
  assert.match(custom, /FORMAT\n- Input: a JSON object/);
  assert.match(custom, /TRANSLATION\n- 의역 우선\n\nADDITIONAL RULES FROM THE USER[^\n]*\n- 욕설 유지$/);
  assert.doesNotMatch(custom, /Read the lines as a scene/);
  assert.equal(ai.defaultRules().split('\n')[0], '- Read the lines as a scene: work out from the flow who is speaking to whom, and translate each line for that speaker and listener.');
});

test('번역 프롬프트 is saved trimmed, refused past 4000 characters, and a new prompt is translated again (DeepL is not)', async t => {
  let calls = 0, instructions = '';
  const { ai, dir } = setup(t, async (url, init) => {
    calls++; instructions = JSON.parse(init.body).instructions || '';
    return response({ output: [{ content: [{ type: 'output_text', text: '{"lines":[{"i":0,"t":"안녕"}]}' }] }] });
  }, { cloud: 'openai', openaiKey: 'fake-key', openaiModel: 'gpt-5-mini' });
  await ai.saveSettings({ promptExtra: '  - 반말 유지  ' });
  assert.equal(ai.settings().promptExtra, '- 반말 유지');
  await assert.rejects(ai.saveSettings({ promptRules: 'x'.repeat(4001) }), /4000자/);
  const file = path.join(dir, 'source.vtt');
  fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
  await ai.translate({ file, provider: 'cloud' });
  assert.match(instructions, /ADDITIONAL RULES FROM THE USER[^\n]*\n- 반말 유지/);
  assert.equal((await ai.translate({ file, provider: 'cloud' })).cached, true);
  await ai.saveSettings({ promptExtra: '- 존댓말' });
  assert.equal((await ai.translate({ file, provider: 'cloud' })).cached, false);
  assert.equal(calls, 2);
});

test('Claude: a key is checked by listing every model it can use, and the latest Opus is picked', async t => {
  const { ai } = setup(t, async (url, init) => {
    assert.equal(new URL(url).origin + new URL(url).pathname, 'https://api.anthropic.com/v1/models');
    assert.equal(new Headers(init.headers).get('x-api-key'), 'fake-key');
    return response({ data: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'].map(id => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-sonnet-5-5' });
  });
  const saved = await ai.saveSettings({ claudeKey: ' fake-key ' });
  assert.equal(saved.claudeKey, 'fake-key');
  assert.equal(saved.claudeModel, 'claude-opus-5-5');
  assert.deepEqual(Array.from(saved.claudeModels), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal((await ai.saveSettings({ claudeModel: 'claude-haiku-5-5' })).claudeModel, 'claude-haiku-5-5');
  assert.equal((await ai.saveSettings({ claudeModel: 'not-listed' })).claudeModel, 'claude-haiku-5-5');
});

test('Claude: a wrong key or one with no models never replaces the saved one', async t => {
  for (const failure of [() => response({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401), () => response({ data: [], has_more: false, first_id: null, last_id: null })]) {
    const original = { claudeKey: 'old-fake', claudeModel: 'claude-opus-5-5', claudeModels: ['claude-opus-5-5'] };
    const { ai, dir } = setup(t, failure, original);
    await assert.rejects(ai.saveSettings({ claudeKey: 'new-fake' }));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'translation.json'), 'utf8')), original);
  }
});

test('Claude: structured JSON at low effort with a cached system prompt and the server-side fallback', async t => {
  const { ai } = setup(t, async (url, init) => {
    assert.match(url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    const headers = new Headers(init.headers), body = JSON.parse(init.body);
    assert.equal(headers.get('x-api-key'), 'fake-key');
    assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.stream, true);
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.format.schema.additionalProperties, false);
    assert.deepEqual(body.system, [{ type: 'text', text: 'JSON', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(body.messages, [{ role: 'user', content: '{"lines":[]}' }]);
    return claudeStream('{"lines":[]}');
  });
  assert.equal(await ai.askClaude({ claudeKey: 'fake-key' }, 'claude-opus-5-5', 'JSON', '{"lines":[]}'), '{"lines":[]}');
});

test('Claude: a model without effort drops it and the working request is remembered; no fallback beta on older models', async t => {
  const shapes = [];
  const { ai } = setup(t, async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(new Headers(init.headers).get('anthropic-beta'), null);
    assert.equal(body.fallbacks, undefined);
    shapes.push(body.output_config?.effort ? 'effort' : body.output_config?.format ? 'schema' : 'plain');
    return body.output_config?.effort ? response({ type: 'error', error: { type: 'invalid_request_error', message: 'effort is not supported' } }, 400) : claudeStream('{"lines":[]}');
  });
  for (let i = 0; i < 2; i++) await ai.askClaude({ claudeKey: 'fake-key' }, 'claude-haiku-4-5', 'JSON', '{}');
  assert.deepEqual(shapes, ['effort', 'schema', 'schema']);
});

test('Claude: a key out of credit is not asked again in other shapes', async t => {
  let calls = 0;
  const { ai } = setup(t, async () => { calls++; return response({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 400); });
  await assert.rejects(ai.askClaude({ claudeKey: 'fake-key' }, 'claude-opus-5-5', 'JSON', '{}'), error => error.status === 400 && error.billing);
  assert.equal(calls, 1);
});

test('Claude: a declined batch is an error, not an empty translation', async t => {
  const { ai } = setup(t, async () => claudeStream('', 'refusal', { type: 'refusal', category: 'cyber', explanation: null }));
  await assert.rejects(ai.askClaude({ claudeKey: 'fake-key' }, 'claude-opus-5-5', 'JSON', '{}'), error => error.refused && /거절/.test(error.message));
});

test('Claude: a rate-limited model hands over to another of its family only', async t => {
  const models = [];
  const { ai, dir } = setup(t, async (url, init) => {
    const { model } = JSON.parse(init.body); models.push(model);
    if (model === 'claude-opus-5-5') return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '0.01' } });
    return claudeStream('{"lines":[{"i":0,"t":"안녕"}]}');
  }, { cloud: 'claude', claudeKey: 'fake-key', claudeModel: 'claude-opus-5-5', claudeModels: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5'] });
  const file = path.join(dir, 'source.vtt');
  fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
  const result = await ai.translate({ file, provider: 'cloud' });
  assert.equal(result.failed, 0);
  assert.equal(models.at(-1), 'claude-opus-5');
  assert.ok(!models.includes('claude-haiku-5-5'));
});

// Whisper's subtitle grows while it is translated: each run keeps its lines under linesKey, so the next one sends only
// the new lines; a partial run makes no file; the final run takes them all up and writes the translation.
test('a growing subtitle is translated line by line as it grows (linesKey, partial)', async t => {
  const sent = [];
  const { ai, dir } = setup(t, async (url, init) => {
    const body = String(init.body), texts = [...body.matchAll(/LINE(\d+)/g)].map(match => Number(match[1]));
    sent.push([...new Set(texts)]);
    const ids = [...new Set([...body.matchAll(/\\"i\\":(\d+)/g)].map(match => Number(match[1])))];
    return response({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ lines: ids.map(i => ({ i, t: `번역${i}` })) }) }] }] });
  }, { cloud: 'openai', openaiKey: 'fake-openai', openaiModel: 'gpt-5-mini' });
  const file = path.join(dir, 'whisper.vtt'), cue = n => `00:00:${String(n).padStart(2, '0')}.000 --> 00:00:${String(n).padStart(2, '0')}.900\nLINE${n}\n`;
  const write = count => fs.writeFileSync(file, `WEBVTT\n\n${Array.from({ length: count }, (_, n) => cue(n + 1)).join('\n')}`);
  write(3);
  const first = await ai.translate({ file, provider: 'cloud', linesKey: file, partial: true });
  assert.equal(first.partial, true); assert.equal(first.lines, 3);
  write(5);
  const shown = [];
  await ai.translate({ file, provider: 'cloud', linesKey: file, partial: true, lines: items => shown.push(...items) });
  assert.deepEqual(sent[sent.length - 1], [4, 5], 'only the two new lines are sent');
  assert.equal(new Set(shown.map(item => item.raw)).size, 5, 'the lines kept from before are given too');
  const requests = sent.length, final = await ai.translate({ file, provider: 'cloud', linesKey: file });
  assert.equal(sent.length, requests, 'the final run sends nothing');
  assert.ok(final.path && fs.readFileSync(final.path, 'utf8').includes('번역'));
});

// A user report on 0.5.63: "자동 번역 실패: TypeError: Cannot read properties of undefined (reading 'name')". With
// 효과음·화자 이름 빼고 번역 on, the lines left empty counted as a result, so a local AI that could not translate (llama.cpp
// not starting, the model not loading) left the run without an engine to name it. Its own error is what is said now.
test('a local AI that fails with 효과음·화자 이름 빼고 번역 on gives its own error, not a TypeError', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-ai-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = async (settings, translateLines) => {
    fs.writeFileSync(path.join(dir, 'translation.json'), JSON.stringify({ localModel: 'm', ...settings }));
    const local = { models: () => [{ id: 'm', file: 'm.gguf', label: 'm', installed: true }], translateLines };
    const module = { exports: {} }, requireReal = createRequire(filename);
    vm.runInNewContext(source, { module, exports: module.exports, fetch: async () => { throw new Error('no API here'); }, AbortSignal, AbortController, setTimeout, clearTimeout, Buffer, console,
      require: name => name === './local-ai.cjs' ? { createLocalAi: () => local, promptVersion: () => '' } : requireReal(name) }, { filename });
    const file = path.join(dir, `source-${Math.random().toString(36).slice(2)}.vtt`);
    fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n（拍手）\n\n00:00:03.000 --> 00:00:04.000\nこんにちは\n');
    return module.exports.createTranslator(dir).translate({ file, provider: 'local', only: true });
  };
  const failing = async () => { throw new Error('llama.cpp를 시작하지 못했습니다.'); };
  for (const dropCaptions of [true, false]) await assert.rejects(run({ dropCaptions }, failing), error => error.name === 'Error' && /llama\.cpp를 시작하지 못했습니다/.test(error.message));
  const result = await run({ dropCaptions: true }, async (lines, { onLine }) => lines.forEach((_, index) => onLine(index, '안녕하세요')));
  assert.equal(result.engine, '로컬 AI'); assert.match(fs.readFileSync(result.path, 'utf8'), /안녕하세요/);
});
