const test = require('node:test');
const assert = require('node:assert/strict');
const { crc32, buildZip } = require('../skills/link-snapshot/scripts/lib/archive');
test('writes UTF-8 ZIP entries with correct checksums and rejects traversal paths', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = buildZip([{ name: '快照.png', data: Buffer.from('image') }, { name: 'manifest.json', data: '{}' }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  const central = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(central), 0x02014b50);
  assert.equal(zip.readUInt32LE(central + 16), crc32(Buffer.from('image')));
  assert.ok(zip.includes(Buffer.from('快照.png')));
  assert.throws(() => buildZip([{ name: '../escape', data: '' }]), /路径/);
});

test('incremental checksums match a complete buffer', () => {
  const first = Buffer.from('1234');
  const second = Buffer.from('56789');
  assert.equal(crc32(second, crc32(first)), 0xcbf43926);
});
