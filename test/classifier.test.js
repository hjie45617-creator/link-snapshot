const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPage } = require('../skills/link-snapshot/scripts/lib/classifier');

test('classifies hard and soft 404 separately', () => {
  assert.equal(classifyPage({ httpStatus: 404 }).status, 'not_found');
  assert.equal(classifyPage({ httpStatus: 200, title: 'Page not found', visibleText: 'The page you requested does not exist.' }).status, 'soft_404');
});

test('recognizes a rendered public X post', () => {
  const result = classifyPage({
    httpStatus: 200,
    sourceType: 'x',
    xPostFound: true,
    visibleText: 'Researcher Example · This is a public post with a cited report.',
  });
  assert.equal(result.status, 'accessible');
});

test('does not call a blocked request dead', () => {
  assert.equal(classifyPage({ httpStatus: 403 }).status, 'blocked');
  assert.equal(classifyPage({ httpStatus: 429 }).status, 'rate_limited');
});

test('detects a script-only browser challenge with no visible text', () => {
  const result = classifyPage({
    httpStatus: 202,
    title: '',
    visibleText: '',
    challengeDetected: true,
  });
  assert.equal(result.status, 'challenge');
});
