const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');

// Electron throws on a second handler for the same channel, and the app does not start at all.
test('every IPC channel has one handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const names = [...source.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(names.length > 50);
  assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), []);
});
