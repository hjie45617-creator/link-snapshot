# Link Snapshot

Turn a report full of links into a batch of local webpage snapshots.

Link Snapshot is a Codex skill that extracts URLs, checks whether their pages load, and saves screenshots with source URLs and capture times. It runs on your computer without an LLM API key or a screenshot service.

[中文说明](README.zh-CN.md)

## What it does

- Extract and deduplicate links from text, Markdown, or HTML reports.
- Process up to **100 unique URLs per batch**, with **4 concurrent pages** by default.
- Save long screenshots for article pages such as blog posts and news stories; use viewport screenshots for homepages, tools, and listing pages.
- Capture only the target **X / Twitter post**, once per unique post.
- Record final URLs, HTTP status, titles, capture times, dimensions, and failures.
- Export PNG screenshots, a portable ZIP with a manifest, and JSON/text result lists.

This checks page accessibility and records what the browser rendered. It does not verify claims, grade source credibility, or determine whether a citation supports a conclusion.

## Install as a Codex skill

Ask Codex to install the skill with:

```text
$skill-installer https://github.com/hjie45617-creator/link-snapshot/tree/main/skills/link-snapshot
```

Then ask Codex to check the skill's runtime dependencies.

For manual installation, copy the entire `skills/link-snapshot` folder into your personal `~/.agents/skills/` directory, or a project's `.agents/skills/` directory. Keep the scripts and `package.json` with `SKILL.md`.

Codex normally detects new skills automatically. If the skill does not appear, restart Codex. See the [official skills documentation](https://learn.chatgpt.com/docs/build-skills).

## Runtime requirements

- Node.js 20 or later.
- Playwright and a Chromium-based browser.

The skill can reuse Codex's bundled Playwright runtime and a local Chrome installation. Otherwise, run these commands inside the installed `link-snapshot` folder:

```sh
npm install
npx playwright install chromium
```

On Linux, Playwright may also require browser system dependencies. To use a specific browser executable, set `CHROMIUM_EXECUTABLE_PATH`.

No Apify token, OpenAI API key, or author account credentials are required.

## Use it

Give Codex your links or report and say:

> Use $link-snapshot to check these links and generate snapshots.

You can also run the script directly from this repository:

```sh
node skills/link-snapshot/scripts/snapshot.js --input examples/report.md --output ./snapshots
```

For one or more URLs:

```sh
node skills/link-snapshot/scripts/snapshot.js --url https://playwright.dev/ --output ./snapshots
```

Use `--parse-only` to extract links without opening a browser. Use `--concurrency N` to choose 1–16 concurrent pages; the default is 4. More concurrency is not always faster.

## Output

Each run creates its own directory containing:

```text
001/page.png          # Or post.png for X
001/result.json
snapshots.zip         # PNG files plus manifest.json
report.json           # Detailed results and local screenshot paths
summary.txt           # Readable per-link results
```

The CLI prints a compact JSON summary with output paths; `--json` prints the full report. Progress goes to stderr.

## Capture limits

Article detection uses publisher metadata, document structure, and URL rules. It can misclassify unusual pages. Article scrolling waits up to 15 seconds, and long screenshots are limited to 40,000 pixels high and 1920 pixels wide. Pages that exceed these limits or keep loading are marked as partial captures.

Login walls, browser challenges, rate limits, and network errors can prevent a capture. Public X posts are accessed without signing in; only the target post is captured. A failed capture does not prove that a link is fabricated.

Input URLs are visited in the local browser. There is no application server that receives the report. Generated files stay in the selected output directory.

## Development

```sh
npm install
npx playwright install chromium
npm test
```

Tests cover extraction, deduplication, page states, article/viewport selection, lazy-loaded content, exact X post cropping, CLI validation, ZIP output, and a 100-link batch against local fixture pages. They do not measure success rates across 100 live websites.
