// Decide from page structure and publisher metadata, without a language model.
async function chooseCaptureScope(page) {
  return page.evaluate(() => {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, innerHeight);
    const articleTypes = new Set(['article', 'blogposting', 'newsarticle', 'report', 'scholarlyarticle', 'techarticle']);
    const types = [];
    const inspect = value => {
      if (Array.isArray(value)) return value.forEach(inspect);
      if (!value || typeof value !== 'object') return;
      types.push(...[].concat(value['@type'] || []).map(type => String(type).split('/').pop().toLowerCase()));
      if (value['@graph']) inspect(value['@graph']);
      if (value.mainEntity) inspect(value.mainEntity);
    };
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { inspect(JSON.parse(node.textContent)); } catch { /* Ignore invalid publisher markup. */ }
    }
    const ogArticle = document.querySelector('meta[property="og:type"]')?.content?.toLowerCase() === 'article';
    const article = [...document.querySelectorAll('article,[itemprop="articleBody"]')]
      .sort((a, b) => (b.innerText?.length || 0) - (a.innerText?.length || 0))[0];
    const root = article || document.querySelector('main,[role="main"]') || document.body;
    const paragraphs = [...(root?.querySelectorAll('p') || [])].map(node => node.innerText.trim()).filter(text => text.length >= 45);
    const textLength = paragraphs.join('\n').length;
    const structuredArticle = types.some(type => articleTypes.has(type));
    const listingPath = /^\/(?:blog|blogs|news|articles|insights|category|tag|search)\/?$/i.test(location.pathname);
    const articlePath = /\/(?:blog|blogs|news|articles|insights)\/[^/]+/i.test(location.pathname);
    const articleBody = Boolean(article && article.querySelector('h1,h2') && paragraphs.length >= 3 && textLength >= 800);
    const articleLike = !listingPath && !types.includes('collectionpage')
      && (structuredArticle || ogArticle || articleBody || (articlePath && paragraphs.length >= 3 && textLength >= 800));
    const longPage = height > innerHeight + 150;
    return { scope: articleLike && longPage ? 'article_full' : 'viewport',
      reason: articleLike ? (longPage ? '文章页面' : '文章内容可在首屏显示') : '普通网页', pageHeight: height };
  });
}

async function prepareArticle(page, options = {}) {
  // Finite articles reach their footer. Infinite feeds stop at a visible limit.
  return page.evaluate(async ({ maxHeight, maxDurationMs, stepDelayMs }) => {
    const started = Date.now();
    const height = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, innerHeight);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    let position = 0;
    let reachedEnd = false;
    const step = Math.max(300, Math.floor(innerHeight * .85));
    while (Date.now() - started < maxDurationMs) {
      window.scrollTo({ top: position, behavior: 'instant' });
      await pause(stepDelayMs);
      const visibleImages = [...document.images].filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && rect.width > 20;
      });
      await Promise.race([Promise.all(visibleImages.map(img => img.decode().catch(() => {}))), pause(700)]);
      const before = height();
      if (position + innerHeight >= before - 2) {
        await pause(Math.max(stepDelayMs, 250));
        if (height() <= before) { reachedEnd = true; break; }
      }
      if (position + innerHeight >= maxHeight) break;
      position = Math.min(position + step, Math.max(0, height() - innerHeight), maxHeight - innerHeight);
    }
    const pageHeight = height();
    const pageWidth = Math.max(document.documentElement.scrollWidth, innerWidth);
    const width = Math.min(pageWidth, 1920);
    const captureHeight = Math.min(pageHeight, maxHeight);
    const warnings = [];
    if (pageHeight > maxHeight) warnings.push(`页面超过 ${maxHeight.toLocaleString('en-US')} 像素，已截取前 ${maxHeight.toLocaleString('en-US')} 像素`);
    if (!reachedEnd && pageHeight <= maxHeight) warnings.push('页面持续加载或滚动等待超时，截图可能不完整');
    if (pageWidth > width) warnings.push('页面横向超宽，已限制截图宽度');
    window.scrollTo({ top: 0, behavior: 'instant' });
    await pause(100);
    return { width, height: captureHeight, pageHeight, truncated: warnings.length > 0, warnings };
  }, { maxHeight: options.maxCaptureHeight || 40_000, maxDurationMs: options.scrollTimeoutMs || 15_000, stepDelayMs: options.scrollStepMs ?? 100 });
}

module.exports = { chooseCaptureScope, prepareArticle };
