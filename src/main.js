import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from 'octokit';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import handler from 'serve-handler';
import http from 'node:http';

/**
 * Recursively find all index.mjs entrypoints under a directory.
 * @param {string} dir
 * @param {string[]} list
 * @returns {string[]}
 */
function findIndexModules(dir, list = []) {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fp = path.join(dir, entry);
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      findIndexModules(fp, list);
    } else if (entry === 'index.mjs') {
      list.push(fp);
    }
  }
  return list;
}

/**
 * Ensure local.html and dev.html exist next to each index.mjs entrypoint.
 * Adds missing files using provided templates.
 * @param {string} benchmarkRoot
 */
function ensureBenchmarkHtmlTemplates(benchmarkRoot) {
  core.startGroup('Ensure benchmark HTML pages');
  const indexFiles = findIndexModules(benchmarkRoot);
  if (indexFiles.length === 0) {
    core.info('No index.mjs files found. Skipping template generation.');
    core.endGroup();
    return;
  }

  const localTemplate = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>PixiJS Benchmark</title>
    <script type="importmap">
      {
        "imports": {
          "pixi.js": "/dist/pixi.mjs"
        }
      }
    </script>
  </head>
  <body>
    <script type="module" src="./index.mjs"></script>
  </body>
</html>
`;

  const devTemplate = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>PixiJS Benchmark</title>
    <script type="importmap">
      {
        "imports": {
          "pixi.js": "//cdn.jsdelivr.net/npm/pixi.js@dev/dist/pixi.mjs"
        }
      }
    </script>
  </head>
  <body>
    <script type="module" src="./index.mjs"></script>
  </body>
</html>
`;

  for (const indexPath of indexFiles) {
    const dir = path.dirname(indexPath);
    const localHtml = path.join(dir, 'local.html');
    const devHtml = path.join(dir, 'dev.html');

    if (!fs.existsSync(localHtml)) {
      fs.writeFileSync(localHtml, localTemplate);
      core.info(`Created local.html for ${indexPath}`);
    } else {
      core.info(`local.html already exists for ${indexPath}`);
    }

    if (!fs.existsSync(devHtml)) {
      fs.writeFileSync(devHtml, devTemplate);
      core.info(`Created dev.html for ${indexPath}`);
    } else {
      core.info(`dev.html already exists for ${indexPath}`);
    }
  }
  core.endGroup();
}

export async function run() {
  let server;
  let browser;
  try {
    const benchmarkPath = core.getInput('benchmark-path');
    const perfChange = Number(core.getInput('perf-change'));
    const token = process.env.GITHUB_TOKEN;

    const distPath = path.resolve('./dist');
    if (!fs.existsSync(distPath)) {
      throw new Error(`dist path not found: ${distPath}`);
    }

    const pixiPath = path.join(distPath, 'pixi.mjs');
    if (!fs.existsSync(pixiPath)) {
      core.setFailed(`pixi.mjs not found in dist path: ${pixiPath}`);
      return;
    }

    core.startGroup('Start local server');
    server = http.createServer((req, res) => {
      return handler(req, res, {
        rewrites: [
          { source: '**/dev/', destination: '/$1/dev.html' },
          { source: '**/local/', destination: '/$1/local.html' }
        ]
      });
    });
    await new Promise((resolve) => server.listen(8080, resolve));

    const benchmarkFullPath = path.resolve(benchmarkPath);
    ensureBenchmarkHtmlTemplates(benchmarkFullPath);

    // Build explicit list of dev/local pages from index.mjs entries
    const indexFiles = findIndexModules(benchmarkFullPath);
    if (indexFiles.length === 0) {
      core.setFailed('No index.mjs benchmark entrypoints found.');
      return;
    }

    const pages = [];
    for (const indexFile of indexFiles) {
      const dir = path.dirname(indexFile);
      const relDir = path.relative(process.cwd(), dir).replace(/\\/g, '/');
      pages.push({ variant: 'dev', url: `http://localhost:8080/${relDir}/dev.html` });
      pages.push({ variant: 'local', url: `http://localhost:8080/${relDir}/local.html` });
    }

    pages.forEach((p) => core.info(`Discovered benchmark page (${p.variant}): ${p.url}`));
    core.endGroup();

    core.startGroup('Run benchmarks (dev vs local)');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-web-security', '--use-gl=angle']
    });

    const rawResults = [];
    for (const { url, variant } of pages) {
      const page = await browser.newPage();
      core.info(`Starting benchmark (${variant}) -> ${url}`);
      try {
        await page.goto(url);
        const resultHandle = await page.waitForFunction(() => window.benchmarkResult, { timeout: 30_000 });
        const result = await resultHandle.jsonValue();
        rawResults.push({ ...result, variant });
        core.info(`✅ Completed (${variant}) ${result.name}: ${JSON.stringify(result)}`);
      } catch (error) {
        core.setFailed(`Benchmark failed (${variant}) ${url}: ${error.message}`);
        throw error;
      } finally {
        await page.close();
      }
    }
    core.endGroup();

    // Group results by benchmark name
    const grouped = new Map();
    for (const r of rawResults) {
      if (!grouped.has(r.name)) grouped.set(r.name, {});
      grouped.get(r.name)[r.variant] = Number(r.fps);
    }

    // Prepare comparison table rows
    const tableRows = [];
    let regressionDetected = false;
    for (const [name, vals] of grouped.entries()) {
      const devFPS = vals.dev;
      const localFPS = vals.local;
      if (devFPS == null || localFPS == null) {
        tableRows.push({ name, devFPS, localFPS, diffPercent: null, regression: false, arrow: null });
        continue;
      }
      const diffPercent = ((devFPS - localFPS) / devFPS) * 100; // positive = local slower
      const regression = diffPercent > perfChange;
      if (regression) regressionDetected = true;
      const arrow = diffPercent > 0 ? '🔻' : '🔺';
      tableRows.push({ name, devFPS, localFPS, diffPercent, regression, arrow });
    }

    const MARKER = '<!-- PIXIJS_BENCHMARK_COMMENT -->';
    let body = `
${MARKER}
### PixiJS Benchmark Results (dev CDN vs local dist)
| Name | Metric | dev (CDN) | local (dist) | Change |
|:-----|:-------|----------:|-------------:|-------:|
`;
    for (const row of tableRows) {
      const devF = row.devFPS == null ? '⚠️' : row.devFPS.toFixed(2);
      const localF = row.localFPS == null ? '⚠️' : row.localFPS.toFixed(2);
      const change = row.diffPercent == null ? '-' : `${row.arrow} ${row.diffPercent.toFixed(2)}%`;
      body += `| ${row.name} | FPS | ${devF} | ${localF} | ${change} |\n`;
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
      core.setFailed(`Performance regression >${perfChange}% (local slower than dev).`);
    } else {
      core.info('✅ No performance regression detected.');
    }
  } catch (err) {
    core.setFailed(err.message);
  } finally {
    if (browser) {
      try {
        core.info('Shutting down browser...');
        for (const context of browser.contexts()) {
          await context.close().catch(() => {});
        }
        await browser.close();
        core.info('Browser shut down.');
      } catch (e) {
        core.warning(`Browser close failed: ${e.message}`);
      }
    }
    if (server) {
      core.info('Shutting down server...');
      await new Promise((resolve) => server.close(resolve));
      core.info('Server shut down.');
    }
  }
}
