# Link Snapshot · 链接核验与快照

把报告里的链接，批量变成带来源和时间的本地快照。

这是一个 Codex Skill，没有网页界面，也不需要 API Key。

## 功能

- 从文本、Markdown、HTML 报告中提取链接并去重。
- 每批最多 100 个不同链接，默认 4 个并发排队处理。
- 博客、新闻等文章按需截长图；首页、工具页、列表页截首屏。
- X / Twitter 只截对应目标帖子一次。
- 保存原始网址、最终网址、访问状态、标题、截图时间和尺寸。
- 输出 PNG、整批 ZIP、JSON 和文本清单，失败不影响其他链接。

“核验”指页面访问状态与实际快照，不包括报告主张真假、来源可信度评级或引用支持度分析。

## 安装

直接在 Codex 中输入：

```text
$skill-installer https://github.com/hjie45617-creator/link-snapshot/tree/main/skills/link-snapshot
```

安装后，让 Codex 检查并配置运行依赖。

也可将整个文件夹放到个人 `~/.agents/skills/link-snapshot/` 或项目 `.agents/skills/link-snapshot/`。不能只复制 `SKILL.md`，需要保留脚本和 `package.json`。未识别时重启 Codex。

需要 Node.js 20+、Playwright 和浏览器。可复用 Codex 自带运行库和本机 Chrome；缺少依赖时，在安装后的 Skill 目录执行：

```sh
npm install
npx playwright install chromium
```

Linux 可能还需要安装浏览器系统依赖。也可通过 `CHROMIUM_EXECUTABLE_PATH` 指定浏览器。

不需要作者的账号、Apify Token 或 OpenAI API Key。

## 使用

提供报告或链接，然后说：

> 帮我核验这些链接，生成快照。

也可以明确调用：

> 使用 $link-snapshot 帮我核验并生成快照。

命令行用法：

```sh
node skills/link-snapshot/scripts/snapshot.js --input examples/report.md --output ./snapshots
```

每次运行单独生成一个目录，包含 PNG、`snapshots.zip`、`report.json` 和 `summary.txt`。`--parse-only` 只提取链接，不打开浏览器；`--concurrency N` 可设置 1–16 个并发，默认 4 个。

## 当前边界

文章识别依赖网页元数据、正文结构和路径规则，特殊页面可能识别不准。长图滚动加载最多等待 15 秒，最高 40,000 像素、最宽 1920 像素；达到上限或持续加载时标注“部分截取”。

登录、验证码、限流及网络错误可能导致失败；失败不等于链接虚构。X 使用公开帖子的匿名访问页面，只保存目标帖子区域。

链接由本机浏览器访问，截图和清单保存在指定本地目录；没有接收报告的应用服务器。

## 开发验证

在仓库根目录执行 `npm install`，安装浏览器后运行 `npm test`。测试包含本地网页上的 100 条批次，不代表对 100 个真实网站的成功率测试。
