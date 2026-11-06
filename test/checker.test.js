const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { checkUrls, getReusableBrowser, closeReusableBrowser, screenshotEvidence, normalizeXUrl, sourceTypeFor, xStatusId } = require('../skills/link-snapshot/scripts/lib/checker');

test('normalizes X URLs and extracts the exact status ID', () => {
  assert.equal(sourceTypeFor('https://twitter.com/example/status/123'), 'x');
  assert.equal(normalizeXUrl('https://twitter.com/example/status/123'), 'https://x.com/example/status/123');
  assert.equal(xStatusId('https://x.com/example/status/123?s=20'), '123');
});

test('captures unique pages, redirects and short visual pages, reports failures, and reuses saved images', { timeout: 30_000 }, async t => {
  let requests = 0;
  const fixture = http.createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/ok' }); return response.end(); }
    response.setHeader('content-type', 'text/html');
    if (request.url === '/ok') { requests++; return response.end('<title>Snapshot page</title><main><h1>Hello</h1></main>'); }
    if (request.url === '/delayed') return response.end('<title>Delayed page</title><nav>Navigation</nav><main>Loading</main><script>setTimeout(() => document.querySelector("main").innerHTML = "<h1>Rendered later</h1>", 700)</script>');
    if (request.url === '/shell') return response.end('<title>Empty shell</title><nav>Navigation</nav><main>Loading</main>');
    if (request.url === '/soft') return response.end('<title>Page not found</title><main>The page you requested does not exist.</main>');
    response.writeHead(404); response.end('<main>Missing</main>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'source-snap-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  t.after(closeReusableBrowser);
  const options = { dataRoot, allowPrivateNetwork: true, reuseBrowser: true, timeoutMs: 5000, renderSettleMs: 30, pageReadyTimeoutMs: 1200 };
  const progress = [];
  const report = await checkUrls(['/ok', '/redirect', '/soft', '/missing', '/delayed', '/shell', '/ok'].map(url => origin + url), {
    ...options, onResult: event => progress.push(event),
  });
  assert.equal(report.total, 6, 'duplicate URLs must be captured only once');
  assert.equal(report.capturedCount, 3);
  assert.equal(report.failedCount, 3);
  assert.deepEqual(report.results.map(result => result.snapshotSaved), [true, true, false, false, true, false]);
  assert.equal(report.results[1].finalUrl, `${origin}/ok`);
  assert.equal(report.results[1].redirected, true);
  assert.equal(progress.length, 6);
  const directory = path.join(dataRoot, report.runId);
  const png = await fs.readFile(path.join(directory, '001/page.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1440);
  assert.equal(png.readUInt32BE(20), 1100);
  await fs.access(path.join(directory, 'snapshots.zip'));
  assert.deepEqual((await fs.readdir(directory)).filter(name => /evidence\.(csv|html|pdf)$/.test(name)), []);
  assert.equal('riskSummary' in report, false);
  assert.equal('reportText' in report, false);
  assert.equal('verification' in report.results[0], false);
  assert.equal('author' in report.results[0], false);
  assert.equal(report.results[0].screenshotPath, path.join(directory, '001/page.png'));
  assert.equal('screenshotUrl' in report.results[0], false);
  assert.equal('previewUrl' in report.results[0], false);
  assert.equal(report.archivePath, path.join(directory, 'snapshots.zip'));
  assert.match(await fs.readFile(report.summaryPath, 'utf8'), /共 6 个链接/);
  const cached = await checkUrls([`${origin}/ok`], options);
  assert.equal(cached.results[0].cached, true);
  assert.equal(cached.results[0].capturedAt, report.results[0].capturedAt);
  const before = requests;
  const fresh = await checkUrls([{ url: `${origin}/ok`, claim: 'first' }, { url: `${origin}/ok`, claim: 'second' }], { ...options, forceRefresh: true });
  assert.equal(fresh.total, 1);
  assert.equal(requests - before, 1);
  assert.equal(fresh.results[0].cached, false);
});

test('X captures only the exact target post and never falls back to a different post or whole page', { timeout: 15_000 }, async t => {
  t.after(closeReusableBrowser);
  const browser = await getReusableBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<style>body{margin:0}article{width:400px;height:180px}article:first-of-type{height:250px}</style><article><a href="/a/status/1234">Wrong post</a></article><article><a href="/a/status/123">Right post</a></article>');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'x-snapshot-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  page.screenshot = () => { throw new Error('Whole-page screenshots are forbidden for X'); };
  assert.equal(await screenshotEvidence(page, output, 'x', '123'), 'post.png');
  const png = await fs.readFile(path.join(output, 'post.png'));
  assert.equal(png.readUInt32BE(16), 400);
  assert.equal(png.readUInt32BE(20), 180);
  assert.deepEqual(await fs.readdir(output), ['post.png']);
  await assert.rejects(() => screenshotEvidence(page, output, 'x', '999'), /目标帖子/);
});
