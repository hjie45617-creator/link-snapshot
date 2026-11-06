const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const script = path.resolve(__dirname, '../skills/link-snapshot/scripts/snapshot.js');

test('CLI extracts report links, strips context, and deduplicates X aliases without a web service', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-cli-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const input = path.join(folder, 'report with spaces.txt');
  await fs.writeFile(input, '主张 [source](https://example.com)\nhttps://twitter.com/a/status/123?s=20\nhttps://x.com/a/status/123?t=test');
  const { stdout } = await execFile(process.execPath, [script, '--input', input, '--parse-only']);
  const result = JSON.parse(stdout);
  assert.equal(result.total, 2);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.items[0], { url: 'https://example.com/' });
});

test('CLI validates arguments and the 100-link boundary before opening a browser', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-cli-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const input = path.join(folder, 'report.txt');
  await fs.writeFile(input, Array.from({ length: 101 }, (_, index) => `https://example.com/${index}`).join('\n'));
  await assert.rejects(execFile(process.execPath, [script, '--input', input]), error => /100/.test(error.stderr));
  await assert.rejects(execFile(process.execPath, [script, '--url', 'file:///etc/passwd']), error => /HTTP/.test(error.stderr));
  await assert.rejects(execFile(process.execPath, [script, '--url', 'https://example.com', '--concurrency', '0']), error => /1–16/.test(error.stderr));
  const { stdout } = await execFile(process.execPath, [script, '--help']);
  assert.match(stdout, /--parse-only/);
});
