import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from 'octokit';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from 'serve-handler';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Recursively copy a directory or file
 * @param {string} src - Source path
 * @param {string} dest - Destination path
 */
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src);

    for (const entry of entries) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

export async function run() {
  let server;
  try {
    const distPath = path.resolve(core.getInput('dist-path'));
    const outputFile = core.getInput('output-file');
    const baselineFile = core.getInput('baseline-file');
    const perfChange = Number(core.getInput('perf-change'));
    const token = process.env.GITHUB_TOKEN;

    if (!fs.existsSync(distPath)) {
      throw new Error(`dist path not found: ${distPath}`);
    }

    // check that pixi.mjs exists
    const pixiPath = path.join(distPath, 'pixi.mjs');
    if (!fs.existsSync(pixiPath)) {
      core.setFailed(`pixi.mjs not found in dist path: ${pixiPath}`);
      return;
    }

    // copy dist to current folder
    core.startGroup('📂 Copy dist files');
    // ensure temp folder exists
    const tempPath = path.join(__dirname, 'temp');
    fs.mkdirSync(tempPath, { recursive: true });
    fs.readdirSync(distPath).forEach((file) => {
      const srcPath = path.join(distPath, file);
      const destPath = path.join(tempPath, file);
      // log paths
      core.info(`Copying ${srcPath} to ${destPath}`);
      copyRecursive(srcPath, destPath);
    });
    core.endGroup();

    // Serve the built dist folder
    core.startGroup('Start local server');
    const actionRoot = __dirname;
    server = http.createServer((req, res) => {
      return handler(req, res, {
        public: actionRoot
      });
    });

    await new Promise((resolve) => {
      server.listen(8080, resolve);
    });
    // loop through all benchmark pages
    const pages = ['http://localhost:8080/benchmarks/sprite/'];
    core.endGroup();

    // Launch Playwright Chromium
    core.startGroup('Run headless benchmark in Playwright');
    // force gpu
    const browser = await chromium.launch({
      headless: false,
      args: ['--use-gl=angle']
    });
    const prResults = [];
    for (const pageUrl of pages) {
      const page = await browser.newPage();
      await page.goto(pageUrl);

      // Wait for benchmark result to appear
      core.info('Waiting for benchmarkResult...');
      const resultHandle = await page.waitForFunction(
        // eslint-disable-next-line no-undef
        () => window.benchmarkResult,
        { timeout: 30_000 }
      );
      const prResult = await resultHandle.jsonValue();
      prResults.push(prResult);
      core.info(`✅ Benchmark completed for ${pageUrl}: ${JSON.stringify(prResult)}`);
      await page.close();
    }
    await browser.close();

    fs.writeFileSync(outputFile, JSON.stringify(prResults, null, 2));
    core.info(`🏁 Benchmark result: ${JSON.stringify(prResults, null, 2)}`);
    core.endGroup();

    // --- Comparison and PR Comment ---
    const MARKER = '<!-- PIXIJS_BENCHMARK_COMMENT -->';
    let body = '';
    let regressionDetected = false;

    const baselineExists = baselineFile && fs.existsSync(baselineFile);

    // Comparison logic
    const baseline = JSON.parse(baselineExists ? fs.readFileSync(baselineFile) : '[]');
    const tableRows = [];

    for (let i = 0; i < pages.length; i++) {
      const prResult = prResults[i];
      const baselineResult = baseline[i];

      if (!baselineResult) {
        core.info(`No baseline result for ${pages[i]}—skip comparison.`);
        tableRows.push({
          name: prResult.name,
          devFPS: null,
          prFPS: Number(prResult.fps),
          diffPercent: 'N/A',
          regression: false,
          arrow: null
        });
        continue;
      }

      const devFPS = Number(baselineResult.fps);
      const prFPS = Number(prResult.fps);
      const diffPercent = ((devFPS - prFPS) / devFPS) * 100;
      const regression = diffPercent > perfChange;
      const arrow = diffPercent > 0 ? '🔻' : '🔺';
      tableRows.push({ name: prResult.name, devFPS, prFPS, diffPercent, regression, arrow });
    }

    // Build comment body with comparison
    body = `
${MARKER}
### PixiJS Benchmark Results
| Name | Metric | dev | PR  | Change |
|:---|:-------|----:|----:|-------:|
`;
    tableRows.forEach(({ devFPS, prFPS, diffPercent, regression, arrow, name }) => {
      const devFPSFormatted = devFPS == null ? '⚠️' : devFPS.toFixed(2);
      const diffPercentFormatted = diffPercent == null ? '-' : `${diffPercent.toFixed(2)}%`;

      body += `| ${name} | FPS | ${devFPSFormatted} | ${prFPS.toFixed(2)} | ${arrow} ${diffPercentFormatted} |\n\n`;
      if (regression) regressionDetected = true;
    });
    body += `
${
  regressionDetected
    ? `❌ **Performance regression detected (> ${perfChange}%)**`
    : '✅ Performance within acceptable range'
}
`;

    // Post or update GitHub comment
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
      core.setFailed(`Performance regression >${perfChange}% detected!`);
    } else {
      core.info('✅ Performance within acceptable range.');
    }
  } catch (err) {
    core.setFailed(err.message);
  } finally {
    if (server) server.close();
  }
}
