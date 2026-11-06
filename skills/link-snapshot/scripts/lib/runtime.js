const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadPlaywright() {
  try { return require('playwright'); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  if (fs.existsSync(bundled)) return require(bundled);
  throw new Error('缺少 Playwright。请在本 Skill 目录安装 package.json 的依赖，并安装 Chromium，或指定本机 Chrome。');
}

function installedChrome() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
        .filter(Boolean).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(candidate => fs.existsSync(candidate));
}

module.exports = { loadPlaywright, installedChrome };
