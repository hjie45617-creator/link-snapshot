const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const sharp = require('sharp');
const { checkUrls, closeReusableBrowser } = require('../skills/link-snapshot/scripts/lib/checker');

const paragraph = '<p>' + 'A detailed example explaining the subject with enough original text for an article page. '.repeat(5) + '</p>';
function pageHTML(title, body, metadata = '') {
  return `<!doctype html><html><head><title>${title}</title>${metadata}<style>html,body{margin:0}body{font:16px sans-serif}main{min-height:3600px}h1,p{margin:16px}</style></head><body>${body}</body></html>`;
}

test('auto captures articles in full, loads lower images, and leaves landing pages and blog indexes at viewport size', { timeout: 30_000 }, async t => {
  let imageRequests = 0;
  const fixture = http.createServer((request, response) => {
    if (request.url === '/lazy.svg') {
      imageRequests++;
      response.setHeader('content-type', 'image/svg+xml');
      return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><path fill="red" d="M0 0h400v200H0z"/></svg>');
    }
    response.setHeader('content-type', 'text/html');
    if (request.url === '/blog/article') return response.end(pageHTML('Article with lazy image',
      `<main><article><h1>Long article</h1>${paragraph.repeat(4)}<div style="height:2300px"></div><img id="late" style="display:block;width:400px;height:200px" data-src="/lazy.svg"><p>End of article</p></article></main>
      <script>const img=document.querySelector('#late');new IntersectionObserver((entries, observer)=>{if(entries.some(entry=>entry.isIntersecting)){img.src=img.dataset.src;observer.disconnect();}}).observe(img);</script>`));
    if (request.url === '/blog') return response.end(pageHTML('Blog index', `<main>${Array.from({length:5}, () => `<article><h2>Article preview</h2>${paragraph.repeat(3)}</article>`).join('')}</main>`));
    if (request.url === '/landing') return response.end(pageHTML('Product landing', `<main><h1>Useful tool</h1>${paragraph.repeat(4)}</main>`));
    if (request.url === '/news-story') return response.end(pageHTML('News story', `<main><h1>News report</h1>${paragraph.repeat(4)}</main>`, '<meta property="og:type" content="article">'));
    if (request.url === '/structured') return response.end(pageHTML('Structured article', `<main><h1>Publisher article</h1>${paragraph.repeat(4)}</main>`, '<script type="application/ld+json">{"@type":"BlogPosting"}</script>'));
    if (request.url === '/infinite') return response.end(pageHTML('Infinite article', `<main><article><h1>Article feed</h1>${paragraph.repeat(4)}<div style="height:10000px"></div></article></main>`));
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  t.after(closeReusableBrowser);
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-auto-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const report = await checkUrls(['/blog/article', '/blog', '/landing', '/news-story', '/structured'].map(route => origin + route), {
    dataRoot, allowPrivateNetwork: true, reuseBrowser: true, cacheTtlMs: 0, renderSettleMs: 30,
  });
  assert.equal(report.capturedCount, 5);
  assert.deepEqual(report.results.map(result => result.captureScope), ['article_full', 'viewport', 'viewport', 'article_full', 'article_full']);
  assert.ok(report.results[0].dimensions.height >= 3600);
  assert.equal(report.results[1].dimensions.height, 1100);
  assert.equal(report.results[2].dimensions.height, 1100);
  assert.equal(report.results[0].truncated, false);
  assert.ok(imageRequests > 0, 'must scroll far enough to trigger the lower image');
  const imagePath = path.join(dataRoot, report.runId, '001/page.png');
  const { data, info } = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
  let lowerRedPixels = 0;
  for (let y = 2000; y < info.height; y++) for (let x = 0; x < Math.min(400, info.width); x += 20) {
    const offset = (y * info.width + x) * info.channels;
    if (data[offset] > 240 && data[offset + 1] < 10 && data[offset + 2] < 10) lowerRedPixels++;
  }
  assert.ok(lowerRedPixels > 100, 'the saved long image must actually contain the loaded lower image');
  await assert.rejects(() => fs.access(path.join(dataRoot, report.runId, '001/preview.webp')));
  const partial = await checkUrls([origin + '/infinite'], {
    dataRoot, allowPrivateNetwork: true, reuseBrowser: true, cacheTtlMs: 0,
    renderSettleMs: 0, scrollStepMs: 10, maxCaptureHeight: 2400,
  });
  assert.equal(partial.capturedCount, 1);
  assert.equal(partial.partialCount, 1);
  assert.equal(partial.results[0].truncated, true);
  assert.equal(partial.results[0].dimensions.height, 2400);
  assert.match(partial.results[0].warnings.join(), /2400|2,400/);
});

test('100 unique URLs complete in one batch with bounded concurrency, per-link progress and a complete ZIP', { timeout: 180_000 }, async t => {
  let requests = 0;
  let peakPages = 0;
  const fixture = http.createServer((request, response) => {
    requests++;
    response.setHeader('content-type', 'text/html');
    const number = new URL(request.url, 'http://fixture').searchParams.get('page');
    const article = Number(number) % 10 === 0;
    response.end(pageHTML(`Batch page ${number}`, article
      ? `<main><article><h1>Article ${number}</h1>${paragraph.repeat(4)}</article></main>`
      : `<main><h1>Landing ${number}</h1>${paragraph}</main>`));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  t.after(closeReusableBrowser);
  const { getReusableBrowser } = require('../skills/link-snapshot/scripts/lib/checker');
  const browser = await getReusableBrowser();
  const sample = setInterval(() => { peakPages = Math.max(peakPages, browser.contexts().length); }, 20);
  t.after(() => clearInterval(sample));
  const dataRoot = path.resolve(__dirname, '../data/qa/batch-100');
  const urls = Array.from({ length: 100 }, (_, index) => `http://127.0.0.1:${fixture.address().port}/?page=${index + 1}`);
  const progress = [];
  const report = await checkUrls([...urls, urls[0]], {
    browser, dataRoot, allowPrivateNetwork: true, cacheTtlMs: 0, renderSettleMs: 0, scrollStepMs: 10,
    onResult: event => {
      progress.push(event.completed);
      if (event.completed % 25 === 0) console.log(`100-link batch progress: ${event.completed}/100`);
    },
  });
  assert.equal(report.total, 100);
  assert.equal(report.capturedCount, 100);
  assert.equal(report.failedCount, 0);
  assert.equal(report.results.filter(result => result.captureScope === 'article_full').length, 10);
  assert.equal(requests, 100, 'deduplicated links must not trigger another navigation');
  assert.deepEqual(progress, Array.from({ length: 100 }, (_, index) => index + 1));
  assert.ok(peakPages > 1 && peakPages <= 4, `expected at most 4 browser contexts, saw ${peakPages}`);
  const directory = path.join(dataRoot, report.runId);
  const zip = await fs.readFile(path.join(directory, 'snapshots.zip'));
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 101, '100 images plus one manifest');
  assert.equal(report.results[99].title, 'Batch page 100');
  console.log(JSON.stringify({ batch100: { runId: report.runId, total: report.total, captured: report.capturedCount, durationMs: report.durationMs, peakPages, zipBytes: zip.length } }));
});
