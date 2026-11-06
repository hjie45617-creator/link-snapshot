const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReport } = require('../skills/link-snapshot/scripts/lib/url-parser');

test('extracts report URLs in order, including Markdown, reference definitions and balanced parentheses', () => {
  const report = '报告 [来源](https://example.com/a "Title")。\n另一处 [1]。\n[1]: https://example.com/b\nhttps://en.wikipedia.org/wiki/Marketing_(business).';
  assert.deepEqual(parseReport(report).items, [
    { url: 'https://example.com/a' }, { url: 'https://example.com/b' },
    { url: 'https://en.wikipedia.org/wiki/Marketing_(business)' },
  ]);
});
test('extracts links without keeping claims, context, quotes or authors', () => {
  const parsed = parseReport('前文。\n报告说：“这是一句中文引用。” [来源](https://example.com/a)\n后文。\nhttps://example.com/a');
  assert.deepEqual(parsed.items, [{ url: 'https://example.com/a' }]);
  assert.equal(parsed.duplicateCount, 1);
});
test('deduplicates X post aliases and tracking parameters, but preserves different posts and web query strings', () => {
  const parsed = parseReport('https://twitter.com/a/status/123?s=20\nhttps://x.com/a/status/123?t=other\nhttps://x.com/a/status/1234\nhttps://example.com/search?q=a&b=c#results');
  assert.equal(parsed.uniqueUrls, 3);
  assert.equal(parsed.duplicateCount, 1);
  assert.equal(parsed.items[2].url, 'https://example.com/search?q=a&b=c#results');
});
test('handles HTML links, Chinese punctuation and empty input', () => {
  assert.deepEqual(parseReport('<a href="https://example.com/?a=1&amp;b=2">网址</a>，https://example.com/b。下一句').items,
    [{ url: 'https://example.com/?a=1&b=2' }, { url: 'https://example.com/b' }]);
  assert.equal(parseReport('').items.length, 0);
  assert.equal(parseReport('没有链接').warnings.length, 1);
});
