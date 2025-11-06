import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from 'octokit';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import handler from 'serve-handler';
import http from 'node:http';

const REPEATS = 3;

function findIndexModules(dir, list = []) {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fp = path.join(dir, entry);
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) findIndexModules(fp, list);
    else if (entry === 'index.mjs') list.push(fp);
  }
  return list;
}

function ensureBenchmarkHtmlTemplates(benchmarkRoot) {
  core.startGroup('Ensure benchmark HTML pages');
  const indexFiles = findIndexModules(benchmarkRoot);
  if (indexFiles.length === 0) {
    core.info('No index.mjs files found. Skipping.');
    core.endGroup();
    return;
  }

  // local version
  const localHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>PixiJS Benchmark - Local</title>
<script type="importmap">
{
  "imports": { "pixi.js": "/dist/pixi.mjs" }
}
</script>
</head>
<body>
<script type="module" src="./index.mjs"></script>
</body>
</html>`;

  // dev CDN version (fetching from jsDelivr 'dev' branch)
  const devHTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>PixiJS Benchmark - Dev CDN</title>
<script type="importmap">
{
  "imports": { "pixi.js": "//cdn.jsdelivr.net/npm/pixi.js@dev/dist/pixi.mjs" }
}
</script>
</head>
<body>
<script type="module" src="./index.mjs"></script>
</body>
</html>`;

  for (const indexPath of indexFiles) {
    const dir = path.dirname(indexPath);
    const local = path.join(dir, 'local.html');
    const dev = path.join(dir, 'dev.html');

    if (!fs.existsSync(local)) {
      fs.writeFileSync(local, localHTML);
      core.info(`Created ${local}`);
    }
    if (!fs.existsSync(dev)) {
      fs.writeFileSync(dev, devHTML);
      core.info(`Created ${dev}`);
    }
  }
  core.endGroup();
}

async function runIsolatedBenchmark(url, label, browserArgs) {
  const sampleFPS = [];

  for (let i = 0; i < REPEATS; i++) {
    const browser = await chromium.launch({ headless: true, args: browserArgs });
    try {
      await runSingleBenchmark(browser, url, label, sampleFPS, i);
    } finally {
      try {
        for (const context of browser.contexts()) {
          await context.close().catch(() => {});
        }
        await browser.close();
      } catch {
        throw new Error('Failed to close browser');
      }
    }
  }
  const avg = sampleFPS.reduce((a, b) => a + b, 0) / sampleFPS.length;
  const stddev = Math.sqrt(sampleFPS.reduce((s, n) => s + (n - avg) ** 2, 0) / sampleFPS.length);
  return { avg, stddev, samples: sampleFPS };
}

async function runSingleBenchmark(browser, url, label, sampleFPS, i) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

  core.info(`Measurement ${i + 1}/${REPEATS} for ${label}`);
  await page.waitForFunction(() => window.benchmarkResult, {
    timeout: 60_000
  });
  const result = await page.evaluate(() => window.benchmarkResult);
  sampleFPS.push(result.fps);
  await page.close();
}

export async function run() {
  let server;
  let browser;

  try {
    const benchmarkPath = core.getInput('benchmark-path');
    const perfChange = Number(core.getInput('perf-change'));
    const token = process.env.GITHUB_TOKEN;

    const distPath = path.resolve('./dist');
    if (!fs.existsSync(distPath)) throw new Error(`dist path not found: ${distPath}`);

    const pixiPath = path.join(distPath, 'pixi.mjs');
    if (!fs.existsSync(pixiPath)) throw new Error(`pixi.mjs not found in dist path: ${pixiPath}`);

    core.startGroup('Start local server');
    server = http.createServer((req, res) => handler(req, res, { public: '.' }));
    await new Promise((resolve) => server.listen(8080, resolve));
    core.endGroup();

    const benchmarkFullPath = path.resolve(benchmarkPath);
    ensureBenchmarkHtmlTemplates(benchmarkFullPath);

    const indexFiles = findIndexModules(benchmarkFullPath);
    if (indexFiles.length === 0) throw new Error('No index.mjs benchmark entrypoints found.');

    const browserArgs = ['--use-gl=angle', '--disable-web-security'];

    const comparisons = [];
    core.startGroup('Run dev vs local benchmarks');

    for (const indexFile of indexFiles) {
      const dir = path.dirname(indexFile);
      const relDir = path.relative(process.cwd(), dir).replace(/\\/g, '/');

      const devURL = `http://localhost:8080/${relDir}/dev.html`;
      const localURL = `http://localhost:8080/${relDir}/local.html`;
      const name = path.basename(dir);

      core.info(`Benchmark: ${name}`);

      const devResult = await runIsolatedBenchmark(devURL, `${name} [dev]`, browserArgs);
      const localResult = await runIsolatedBenchmark(localURL, `${name} [local]`, browserArgs);

      const diffPercent = ((devResult.avg - localResult.avg) / devResult.avg) * 100;
      // Scale allowed difference relative to an optimistic 60fps target.
      // If dev FPS is lower than 60, tolerance increases proportionally.
      // Example: base tolerance 5%, dev=30fps => allowed = 5 * (60/30) = 10%.
      // If dev FPS is very low, guard against division by zero.
      const effectiveDevFps = Math.max(devResult.avg, 1);
      const allowedPercent = perfChange * (60 / effectiveDevFps);
      const regression = diffPercent > allowedPercent;
      const arrow = diffPercent > 0 ? '🔻' : '🔺';

      comparisons.push({
        name,
        devResult,
        localResult,
        diffPercent,
        regression,
        arrow
      });

      core.info(
        `${name} → dev: ${devResult.avg.toFixed(2)} fps, local: ${localResult.avg.toFixed(
          2
        )} fps, Δ=${diffPercent.toFixed(2)}%`
      );
    }

    core.endGroup();

    // build markdown output
    const MARKER = '<!-- PIXIJS_BENCHMARK_COMMENT -->';
    let body = `
${MARKER}
### PixiJS Benchmark Results (dev CDN vs local dist)
| Name | dev Avg FPS | local Avg FPS | Δ% | Trend |
|:-----|-------------:|--------------:|----:|:------:|
`;

    let regressionDetected = false;
    for (const row of comparisons) {
      const { name, devResult, localResult, diffPercent, regression, arrow } = row;
      if (regression) regressionDetected = true;
      body += `| ${name} | ${devResult.avg.toFixed(2)} | ${localResult.avg.toFixed(2)} | ${diffPercent.toFixed(
        2
      )}% | ${arrow} |\n`;
    }

    body += `
${
  regressionDetected
    ? `❌ Performance regression detected (> ${perfChange}% slower than dev)`
    : '✅ Performance within acceptable range'
}
`;

    if (token && github.context.payload.pull_request) {
      const octokit = new Octokit({ auth: token });
      const issueNumber = github.context.payload.pull_request.number;
      const { data: comments } = await octokit.rest.issues.listComments({
        ...github.context.repo,
        issue_number: issueNumber
      });
      const existing = comments.find((c) => c.body?.includes(MARKER));
      if (existing) {
        await octokit.rest.issues.updateComment({
          ...github.context.repo,
          comment_id: existing.id,
          body
        });
        core.info('Updated existing benchmark comment.');
      } else {
        await octokit.rest.issues.createComment({
          ...github.context.repo,
          issue_number: issueNumber,
          body
        });
        core.info('Posted new benchmark comment.');
      }
    }

    if (regressionDetected) {
      core.setFailed(`Performance regression > ${perfChange}% slower than dev.`);
    } else {
      core.info('✅ No significant regression detected.');
    }
  } catch (err) {
    core.setFailed(err.message);
  } finally {
    if (browser) {
      try {
        for (const context of browser.contexts()) {
          await context.close().catch(() => {});
        }
        await browser.close();
      } catch {}
    }
    if (server) {
      try {
        await new Promise((r) => server.close(r));
      } catch {}
    }
  }
}
