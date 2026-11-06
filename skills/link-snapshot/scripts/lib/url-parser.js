  function cleanUrl(raw) {
    let value = String(raw).replace(/&amp;/g, '&').replace(/[.,;:!?，。；：！？、]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
    }
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
    } catch { return null; }
  }

  function urlKey(url) {
    const parsed = new URL(url);
    const id = /\/status\/(\d+)(?:\/|$)/.exec(parsed.pathname)?.[1];
    return /(^|\.)(x|twitter)\.com$/i.test(parsed.hostname) && id ? `x:status:${id}` : parsed.href;
  }

  function uniqueItems(values) {
    const seen = new Set();
    return values.flatMap(value => {
      const raw = typeof value === 'string' ? value : value?.url;
      const url = cleanUrl(raw || '');
      if (!url || seen.has(urlKey(url))) return [];
      seen.add(urlKey(url));
      return [{ url }];
    });
  }

  function parseReport(value) {
    const text = String(value || '');
    const matches = [];
    const spans = [];
    const markdown = /\[([^\]\n]*)\]\(\s*(https?:\/\/(?:[^\s()]|\([^\s()]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/gi;
    for (const match of text.matchAll(markdown)) {
      spans.push([match.index, match.index + match[0].length]);
      matches.push({ index: match.index, url: cleanUrl(match[2]) });
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"“”「」『』，。；！？、]+/gi)) {
      if (spans.some(([a, b]) => match.index >= a && match.index < b)) continue;
      matches.push({ index: match.index, url: cleanUrl(match[0]) });
    }
    const urls = matches.sort((a, b) => a.index - b.index).map(item => item.url).filter(Boolean);
    const items = uniqueItems(urls);
    return {
      items,
      uniqueUrls: items.length,
      duplicateCount: urls.length - items.length,
      warnings: !items.length && text.trim() ? ['没有识别到 HTTP/HTTPS 链接，请保留链接地址后再粘贴。'] : [],
    };
  }
module.exports = { parseReport, cleanUrl, uniqueItems, urlKey };
