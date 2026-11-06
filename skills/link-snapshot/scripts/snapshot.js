#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseReport, uniqueItems } = require('./lib/url-parser');

const HELP = `链接核验与快照

node scripts/snapshot.js --input /absolute/report.txt --output /absolute/snapshots
node scripts/snapshot.js --url https://example.com --url https://example.org --output /absolute/snapshots

--input FILE      读取带链接的 UTF-8 报告、Markdown 或 HTML；- 表示标准输入
--url URL         直接指定链接，可重复
--output DIR      输出目录，默认当前工作目录下的 snapshots
--concurrency N   并发数，默认 4，可设置 1–16
--timeout MS      单次导航等待时间，默认 15000 毫秒
--parse-only      只提取并去重链接，不打开浏览器
--json            输出完整 JSON 报告，默认只输出简短摘要和文件路径
--quiet           不输出进度
--help            显示帮助

每批最多 100 个不同链接。文章自动截长图，其他网页截首屏，X 只截目标帖子。
`;

function parseArgs(args) {
  const options = { urls: [], output: path.resolve('snapshots'), concurrency: 4, timeout: 15_000 };
  const switches = new Map([['--help', 'help'], ['--json', 'json'], ['--quiet', 'quiet'], ['--parse-only', 'parseOnly']]);
  const values = new Map([['--input', 'input'], ['--url', 'url'], ['--output', 'output'], ['--concurrency', 'concurrency'], ['--timeout', 'timeout']]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (switches.has(argument)) { options[switches.get(argument)] = true; continue; }
    if (!values.has(argument)) throw new Error(`不支持的参数：${argument}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少参数`);
    const name = values.get(argument);
    if (name === 'url') options.urls.push(value);
    else options[name] = value;
  }
  options.concurrency = Number(options.concurrency);
  options.timeout = Number(options.timeout);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error('并发数必须为 1–16 的整数');
  if (!Number.isInteger(options.timeout) || options.timeout < 1000 || options.timeout > 120_000) throw new Error('导航等待时间必须在 1000–120000 毫秒之间');
  options.output = path.resolve(options.output);
  return options;
}

async function readInput(filename, input = process.stdin) {
  if (filename !== '-') {
    if ((await fs.stat(filename)).size > 5_000_000) throw new Error('报告文件超过 5MB，请拆分后处理');
    return fs.readFile(filename, 'utf8');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error('报告内容超过 5MB，请拆分后处理');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { process.stdout.write(HELP); return; }
  if (!options.input && !options.urls.length) throw new Error('请通过 --input 提供报告文件，或通过 --url 提供链接');
  const parsed = parseReport(options.input ? await readInput(options.input) : '');
  for (const url of options.urls) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`只支持 HTTP/HTTPS 链接：${url}`);
    try { new URL(url); } catch { throw new Error(`URL 格式无效：${url}`); }
  }
  const items = uniqueItems([...parsed.items, ...options.urls]);
  if (!items.length) throw new Error('没有识别到 HTTP/HTTPS 链接，请提供网址或带链接的报告');
  const duplicateCount = parsed.items.length + parsed.duplicateCount + options.urls.length - items.length;
  if (options.parseOnly) {
    process.stdout.write(JSON.stringify({ total: items.length, duplicateCount, items }, null, 2) + '\n');
    return;
  }
  if (items.length > 100) throw new Error(`识别到 ${items.length} 个不同链接，每批最多 100 个，请拆分后处理`);
  const { checkUrls } = require('./lib/checker');
  const report = await checkUrls(items, {
    dataRoot: options.output, concurrency: options.concurrency, timeoutMs: options.timeout, forceRefresh: true,
    onResult: ({ completed, total, result }) => {
      if (!options.quiet && (completed === 1 || completed % 10 === 0 || completed === total)) {
        process.stderr.write(`已处理 ${completed}/${total} · ${result.snapshotSaved ? '快照已保存' : '访问失败'}\n`);
      }
    },
  });
  const summary = { total: report.total, duplicateCount, capturedCount: report.capturedCount,
    failedCount: report.failedCount, partialCount: report.partialCount, durationMs: report.durationMs,
    outputDir: report.outputDir, reportPath: report.reportPath, archivePath: report.archivePath, summaryPath: report.summaryPath };
  process.stdout.write(JSON.stringify(options.json ? report : summary, null, 2) + '\n');
}

if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
});
module.exports = { main, parseArgs, readInput };
