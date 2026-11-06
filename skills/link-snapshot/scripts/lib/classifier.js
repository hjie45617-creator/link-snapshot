const SOFT_404_PATTERNS = [
  /page\s+(?:was\s+)?not\s+found/i,
  /the page you (?:are looking for|requested) (?:does not|doesn't) exist/i,
  /内容不存在/,
  /页面不存在/,
  /找不到该页面/,
  /页面已被删除/,
];

const CHALLENGE_PATTERNS = [
  /verify you are human/i,
  /checking your browser/i,
  /enable javascript and cookies to continue/i,
  /captcha/i,
  /请完成验证/,
];

const LOGIN_PATTERNS = [
  /sign in to continue/i,
  /log in to continue/i,
  /you must be logged in/i,
  /登录后继续/,
];

const X_NOT_FOUND_PATTERNS = [
  /this post is from an account that no longer exists/i,
  /hmm[.…]*this page doesn.?t exist/i,
  /this post was deleted/i,
  /这个帖子已被删除/,
  /此页面不存在/,
];

const X_PROTECTED_PATTERNS = [
  /these posts are protected/i,
  /only confirmed followers have access/i,
  /这些帖子受到保护/,
];

function containsAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyPage(input) {
  const status = Number(input.httpStatus || 0);
  const title = String(input.title || '');
  const text = String(input.visibleText || '');
  const combined = `${title}\n${text.slice(0, 80_000)}`;
  const sourceType = input.sourceType || 'web';

  if (status === 404 || status === 410) {
    return verdict('not_found', '页面返回 404/410');
  }
  if (status === 401) return verdict('login_required', '页面返回 401');
  if (status === 403) return verdict('blocked', '页面返回 403');
  if (status === 429) return verdict('rate_limited', '页面返回 429');
  if (status >= 500) return verdict('server_error', `页面返回 ${status}`);

  if (input.challengeDetected || containsAny(combined, CHALLENGE_PATTERNS)) {
    return verdict('challenge', '页面显示验证码或浏览器验证');
  }

  if (sourceType === 'x') {
    if (containsAny(combined, X_NOT_FOUND_PATTERNS)) {
      return verdict('not_found', 'X 显示帖子或账号不存在');
    }
    if (containsAny(combined, X_PROTECTED_PATTERNS)) {
      return verdict('protected', '帖子来自受保护账号');
    }
    if (input.xPostFound) {
      return verdict('accessible', '已找到公开 X 帖子的渲染内容');
    }
  }

  if (containsAny(combined, LOGIN_PATTERNS) && text.length < 4_000) {
    return verdict('login_required', '页面主要内容是登录提示');
  }

  if (status >= 200 && status < 300 && containsAny(combined, SOFT_404_PATTERNS) && text.length < 8_000) {
    return verdict('soft_404', '页面返回成功状态，但正文显示内容不存在');
  }

  const rendered = input.hasVisualContent ?? (text.trim().length >= 80);
  if (status >= 200 && status < 400 && rendered) {
    return verdict('accessible', '页面已渲染');
  }

  if (status >= 200 && status < 400) {
    return verdict('unverifiable', '页面尚未加载出内容，请重试');
  }

  return verdict('unverifiable', status ? `未识别的 HTTP 状态 ${status}` : '没有收到主文档响应');
}

function verdict(status, reason) {
  return { status, reason };
}

module.exports = { classifyPage };
