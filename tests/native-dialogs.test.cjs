const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
// GitHub issue #16: after a native confirm() box on Windows the page takes no typing (the header search box) until the
// window is refocused. The renderer asks with its own dialog (askConfirm) instead.
test('the renderer never opens native alert/confirm/prompt boxes', () => {
  const dir = path.resolve(__dirname, '../src');
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(source, /(?<![.\w])(?:window\.)?(?:alert|confirm|prompt)\(/, name);
  }
});
