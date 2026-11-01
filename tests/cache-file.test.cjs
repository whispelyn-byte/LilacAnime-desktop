const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

// Cache files are written in the background through a temporary file renamed over them: never half-written, the
// writes of one file in the order asked, the latest kept.
test('cache files are replaced whole, in order, without leftovers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-cache-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = source.indexOf('const cacheWrites='), last = source.indexOf('// The list (several MB)', first);
  assert.ok(first >= 0 && last > first);
  const context = vm.createContext({ fs, process, Map, Promise });
  vm.runInContext(source.slice(first, last), context);
  const file = path.join(dir, 'index.json');
  fs.writeFileSync(file, JSON.stringify({ version: 0 }));
  await Promise.all(Array.from({ length: 20 }, (_, i) => context.writeCacheFile(file, JSON.stringify({ version: i + 1, pad: 'x'.repeat(200000) }))));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 20);
  assert.deepEqual(fs.readdirSync(dir), ['index.json']);
  // A folder that cannot be written leaves nothing behind and does not throw.
  await context.writeCacheFile(path.join(dir, 'missing', 'x.json'), '{}');
  assert.deepEqual(fs.readdirSync(dir), ['index.json']);
});
