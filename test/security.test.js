const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateAddress, parsePublicHttpUrl } = require('../skills/link-snapshot/scripts/lib/security');

test('blocks private and loopback addresses', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.2', '169.254.1.1', '198.18.0.1', '203.0.113.9', '::1', 'fd00::1', 'ff02::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});

test('allows public addresses', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('accepts only public-shaped HTTP URLs', () => {
  assert.equal(parsePublicHttpUrl('https://example.com/a').hostname, 'example.com');
  assert.throws(() => parsePublicHttpUrl('file:///etc/passwd'));
  assert.throws(() => parsePublicHttpUrl('http://localhost:3000'));
  assert.throws(() => parsePublicHttpUrl('http://[::1]:3000'));
  assert.throws(() => parsePublicHttpUrl('https://user:pass@example.com'));
});
