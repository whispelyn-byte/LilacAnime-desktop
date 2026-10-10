const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
  return source.slice(first, last);
}
const context = vm.createContext({});
vm.runInContext(section('const SPECIAL_EPISODE=', 'async function ohliDetail('), context);
const info = label => ({ ...vm.runInContext(`episodeLabelInfo(${JSON.stringify(label)})`, context) });

test('Korean sites\' episode labels: numbers, half episodes and specials', () => {
  assert.deepEqual(info('12화'), { name: '12', number: 12 });
  assert.deepEqual(info('1150.5화'), { name: '1150.5', number: 1150.5 });
  assert.deepEqual(info('12화 (끝)'), { name: '12', number: 12 });
  assert.deepEqual(info('3'), { name: '3', number: 3 });
  for (const [label, name] of [['OVA 1화', 'OVA 1'], ['OAD 2화', 'OAD 2'], ['SP 노벨 히로인즈', 'SP 노벨 히로인즈'], ['특별편', '특별편'], ['스페셜 3화', '스페셜 3'], ['ova 2화', 'ova 2']])
    assert.deepEqual(info(label), { name, number: null, special: true }, label);
  assert.equal(info('SPY 1화').special, undefined, 'a word that only starts like SP is not a special');
});
