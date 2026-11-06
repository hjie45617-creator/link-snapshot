const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadPlaywright, installedChrome } = require('./runtime');
const { chromium } = loadPlaywright();
const { assertPublicHostname } = require('./security');
const { classifyPage } = require('./classifier');
const { uniqueItems, urlKey } = require('./url-parser');
const { writeSnapshotArchive } = require('./archive');
const { chooseCaptureScope, prepareArticle } = require('./capture');

const resultCache = new Map();
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
let sharedBrowserPromise = null;

function normalizeXUrl(url) {
  const parsed = new URL(url);
  if (/(^|\.)twitter\.com$/.test(parsed.hostname)) parsed.hostname = 'x.com';
  return parsed.href;
}
function sourceTypeFor(url) { return /(^|\.)(x|twitter)\.com$/.test(new URL(url).hostname) ? 'x' : 'web'; }
function xStatusId(url) { return /\/status\/(\d+)(?:\/|$)/.exec(new URL(url).pathname)?.[1] || null; }
function browserLaunchOptions(options = {}) {
  const executablePath = options.executablePath || process.env.CHROMIUM_EXECUTABLE_PATH || installedChrome();
  return { headless: options.headless !== false, ...(executablePath ? { executablePath } : {}) };
}
async function getReusableBrowser(options = {}) {
  if (!sharedBrowserPromise) {
    const pending = chromium.launch(browserLaunchOptions(options));
    sharedBrowserPromise = pending;
    pending.then(browser => browser.on('disconnected', () => {
      if (sharedBrowserPromise === pending) sharedBrowserPromise = null;
    })).catch(() => { if (sharedBrowserPromise === pending) sharedBrowserPromise = null; });
  }
  return sharedBrowserPromise;
}
async function closeReusableBrowser() {
  const pending = sharedBrowserPromise;
  sharedBrowserPromise = null;
  if (pending) await pending.then(browser => browser.close()).catch(() => {});
}

async function waitForContentReady(page, sourceType, statusId, options) {
  if (sourceType === 'x') {
    if (!statusId) return;
    await page.waitForFunction(id => {
      const link = [...document.querySelectorAll('article a[href*="/status/"]')]
        .find(node => new RegExp(`/status/${id}(?:[/?#]|$)`).test(node.getAttribute('href')));
      const article = link?.closest('article');
      return Boolean(article && (article.innerText.trim() || article.querySelector('img,video')));
    }, statusId, { timeout: options.xReadyTimeoutMs || 10_000, polling: 200 }).catch(() => {});
  } else {
    // Wait for rendering rather than demanding an article of a particular length.
    await page.waitForFunction(() => {
      const root = document.querySelector('main,[role="main"],article') || document.body;
      if (!root) return false;
      const text = root.innerText.trim();
      return Boolean(text && !/^(loading[.\s…]*|please wait[.\s…]*|加载中[.\s…]*)$/i.test(text))
        || [...root.querySelectorAll('img,canvas,svg,video')].some(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 60 && rect.height > 40 && rect.top < innerHeight;
        });
    }, null, { timeout: options.pageReadyTimeoutMs || 6_000, polling: 150 }).catch(() => {});
    await page.waitForLoadState('load', { timeout: 2_000 }).catch(() => {});
  }
  // A small bounded settle period catches client rendering and visible images.
  await page.waitForTimeout(options.renderSettleMs ?? 800);
  await page.evaluate(() => Promise.race([
    Promise.all([...document.images].filter(img => {
      const rect = img.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight && rect.width > 20;
    }).map(img => img.decode().catch(() => {}))),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ])).catch(() => {});
}

async function pageState(page, sourceType, statusId) {
  return page.evaluate(({ sourceType, statusId }) => {
    const root = document.querySelector('main,[role="main"],article') || document.body;
    const text = root?.innerText?.trim() || '';
    const link = sourceType === 'x' && statusId ? [...document.querySelectorAll('article a[href*="/status/"]')]
      .find(node => new RegExp(`/status/${statusId}(?:[/?#]|$)`).test(node.getAttribute('href'))) : null;
    const hasVisual = Boolean(text && !/^(loading[.\s…]*|please wait[.\s…]*|加载中[.\s…]*)$/i.test(text))
      || [...(root?.querySelectorAll('img,canvas,svg,video') || [])].some(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 60 && rect.height > 40 && rect.top < innerHeight;
      });
    return {
      title: document.title || document.querySelector('meta[property="og:title"]')?.content || '',
      visibleText: (document.body?.innerText || '').slice(0, 80_000),
      hasVisualContent: hasVisual,
      xPostFound: Boolean(link?.closest('article')),
      challengeDetected: Boolean(document.querySelector('#challenge-container,script[src*="token.awswaf.com"],script[src*="challenge-platform"]')),
    };
  }, { sourceType, statusId });
}

async function screenshotEvidence(page, outputDir, sourceType, statusId, capture = null) {
  if (sourceType === 'x') {
    if (!statusId) throw new Error('请使用具体的 X 帖子链接');
    // Never fall back to another article or a whole-page X screenshot.
    const post = page.locator('article').filter({ has: page.locator(`a[href*="/status/${statusId}"]`) });
    // Match the complete status ID, so /status/123 does not match /status/1234.
    const articles = await post.all();
    for (const article of articles) {
      const matches = await article.locator('a[href*="/status/"]').evaluateAll((links, id) =>
        links.some(link => new RegExp(`/status/${id}(?:[/?#]|$)`).test(link.getAttribute('href'))), statusId);
      if (!matches) continue;
      // X can keep changing its layout. Capture the exact post rectangle
      // without waiting indefinitely for Playwright's element-stability check.
      await article.evaluate(element => {
        element.scrollIntoView({ block: 'start', behavior: 'instant' });
        // Keep X's sticky navigation above, rather than over, the post author.
        window.scrollBy({ top: -100, behavior: 'instant' });
      });
      await page.waitForTimeout(150);
      const clip = await article.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height, scale: 1 };
      });
      if (clip.width <= 0 || clip.height <= 0 || clip.width * clip.height > 80_000_000) throw new Error('目标帖子区域尺寸无效，未截取其他内容');
      const session = await page.context().newCDPSession(page);
      try {
        const screenshot = await session.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
        await fs.writeFile(path.join(outputDir, 'post.png'), Buffer.from(screenshot.data, 'base64'));
      } finally { await session.detach(); }
      return 'post.png';
    }
    throw new Error('没有加载到目标帖子，未截取其他内容');
  }
  await page.screenshot({ path: path.join(outputDir, 'page.png'), fullPage: Boolean(capture),
    ...(capture ? { clip: { x: 0, y: 0, width: capture.width, height: capture.height } } : {}),
    animations: 'disabled', timeout: 15_000 });
  return 'page.png';
}

async function checkOne(browser, input, options) {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const parsed = await assertPublicHostname(input.url, options);
  const sourceType = sourceTypeFor(parsed.href);
  const normalizedUrl = sourceType === 'x' ? normalizeXUrl(parsed.href) : parsed.href;
  const statusId = sourceType === 'x' ? xStatusId(normalizedUrl) : null;
  if (sourceType === 'x' && !statusId) throw new Error('请使用具体的 X 帖子链接');
  const slug = String(options.index + 1).padStart(3, '0');
  const outputDir = path.join(options.runDir, slug);
  await fs.mkdir(outputDir, { recursive: true });
  const key = `skill-v1:${urlKey(normalizedUrl)}`;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = !options.forceRefresh && cacheTtlMs > 0 ? resultCache.get(key) : null;
  if (cached && cached.expiresAt > Date.now()) {
    try {
      const filename = sourceType === 'x' ? 'post.png' : 'page.png';
      await fs.copyFile(path.join(cached.outputDir, filename), path.join(outputDir, filename));
      const result = { ...cached.result, submittedUrl: input.url, checkedAt, cached: true,
        durationMs: Date.now() - startedAt, screenshotPath: path.join(outputDir, filename) };
      await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
      return result;
    } catch { resultCache.delete(key); }
  }
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US',
    timezoneId: 'UTC', colorScheme: 'light', serviceWorkers: 'block',
    userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36` });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);
    await page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try { await assertPublicHostname(request.url(), options); }
        catch { return route.abort('blockedbyclient'); }
      }
      const tracking = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|analytics\.twitter\.com)$/.test(new URL(request.url()).hostname);
      return ['font', 'media'].includes(request.resourceType()) || tracking ? route.abort() : route.continue();
    });
    let mainResponse = null;
    page.on('response', response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) mainResponse = response;
    });
    let navigationError = null;
    try { mainResponse = await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs }); }
    catch (error) { navigationError = error.message; }
    if (page.url().startsWith('http')) await assertPublicHostname(page.url(), options);
    if (mainResponse?.status() < 400) await waitForContentReady(page, sourceType, statusId, options);
    const data = await pageState(page, sourceType, statusId);
    const classification = classifyPage({ ...data, sourceType, httpStatus: mainResponse?.status() });
    if (sourceType === 'x' && !data.xPostFound) {
      classification.status = 'unverifiable';
      classification.reason = '没有加载到目标帖子，请重试';
    }
    let filename = null;
    let captureScope = sourceType === 'x' ? 'x_post' : 'viewport';
    let capture = null;
    let dimensions = null;
    if (classification.status === 'accessible') {
      try {
        if (sourceType !== 'x') {
          const choice = await chooseCaptureScope(page);
          captureScope = choice.scope;
          if (captureScope === 'article_full') capture = await prepareArticle(page, options);
        }
        filename = await screenshotEvidence(page, outputDir, sourceType, statusId, capture);
        const image = await fs.open(path.join(outputDir, filename), 'r');
        try {
          const header = Buffer.alloc(24);
          await image.read(header, 0, header.length, 0);
          dimensions = { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
        } finally { await image.close(); }
      }
      catch (error) { classification.reason = `截图失败：${error.message}`; classification.status = 'error'; }
    }
    if (navigationError && !mainResponse) { classification.status = 'error'; classification.reason = '页面未能打开，请重试'; }
    const result = { submittedUrl: input.url, normalizedUrl, finalUrl: page.url().startsWith('http') ? page.url() : null,
      title: data.title, sourceType, checkedAt, capturedAt: filename ? new Date().toISOString() : null,
      httpStatus: mainResponse?.status() || null, redirected: page.url() !== normalizedUrl,
      accessStatus: classification.status, reason: filename ? '快照已生成' : classification.reason,
      snapshotSaved: Boolean(filename), screenshotPath: filename ? path.join(outputDir, filename) : null,
      captureScope, dimensions, truncated: capture?.truncated || false, warnings: capture?.warnings || [],
      cached: false, durationMs: Date.now() - startedAt };
    await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
    if (result.snapshotSaved && cacheTtlMs > 0) {
      if (resultCache.size >= 500) resultCache.delete(resultCache.keys().next().value);
      resultCache.set(key, { result, outputDir, expiresAt: Date.now() + cacheTtlMs });
    }
    return result;
  } finally { await context.close(); }
}

async function checkUrls(rawInputs, options = {}) {
  const inputs = uniqueItems(rawInputs);
  if (!inputs.length) throw new Error('没有识别到 HTTP/HTTPS 链接，请提供网址或带链接的报告');
  if (inputs.length > 100) throw new Error('每批最多生成 100 个不同链接的快照，请分批提交');
  const startedAt = Date.now();
  const runId = options.runId || `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  if (!/^[\w-]+$/.test(runId)) throw new Error('无效的批次编号');
  const runDir = path.resolve(options.dataRoot || path.resolve(process.cwd(), 'snapshots'), runId);
  await fs.mkdir(runDir, { recursive: true });
  const ownsBrowser = !options.browser && !options.reuseBrowser;
  const browser = options.browser || (options.reuseBrowser ? await getReusableBrowser(options) : await chromium.launch(browserLaunchOptions(options)));
  const results = new Array(inputs.length);
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      let result;
      try { result = await checkOne(browser, inputs[index], { ...options, index, runId, runDir, timeoutMs: options.timeoutMs || 15_000 }); }
      catch (error) {
        result = { submittedUrl: inputs[index].url, checkedAt: new Date().toISOString(), capturedAt: null,
          accessStatus: 'error', snapshotSaved: false, screenshotPath: null, cached: false, reason: error.message };
      }
      results[index] = result;
      completed++;
      await options.onResult?.({ index, result, completed, total: inputs.length });
    }
  }
  try { await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(options.concurrency) || 4, inputs.length)) }, worker)); }
  finally { if (ownsBrowser) await browser.close(); }
  const capturedCount = results.filter(result => result.snapshotSaved).length;
  const report = { runId, createdAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
    total: results.length, capturedCount, failedCount: results.length - capturedCount,
    partialCount: results.filter(result => result.snapshotSaved && result.truncated).length,
    summary: results.reduce((summary, result) => { summary[result.accessStatus] = (summary[result.accessStatus] || 0) + 1; return summary; }, {}),
    outputDir: runDir, reportPath: path.join(runDir, 'report.json'),
    archivePath: path.join(runDir, 'snapshots.zip'), summaryPath: path.join(runDir, 'summary.txt'), results };
  await writeSnapshotArchive(report, runDir);
  report.durationMs = Date.now() - startedAt;
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const scopeNames = { viewport: '首屏', article_full: '文章长图', x_post: 'X 帖子' };
  const summary = [
    `链接核验与快照：共 ${report.total} 个链接，${report.capturedCount} 张快照，${report.failedCount} 个失败，${report.partialCount} 张部分截取。`,
    `生成时间：${report.createdAt}`, `耗时：${(report.durationMs / 1000).toFixed(1)} 秒`, '',
    ...results.flatMap((item, index) => [
      `${index + 1}. ${item.snapshotSaved ? (item.truncated ? '部分截取' : '已保存') : '失败'} | ${item.submittedUrl}`,
      `   ${item.title || ''} | HTTP ${item.httpStatus || '无响应'} | ${scopeNames[item.captureScope] || ''}`,
      `   最终网址：${item.finalUrl || '未打开'}`,
      item.snapshotSaved ? `   截图：${item.screenshotPath}` : `   原因：${item.reason}`,
      ...(item.warnings || []).map(warning => `   提示：${warning}`), '',
    ]),
  ].join('\n');
  await fs.writeFile(report.summaryPath, summary);
  return report;
}
module.exports = { checkUrls, closeReusableBrowser, getReusableBrowser, normalizeXUrl, sourceTypeFor, xStatusId, screenshotEvidence };
