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

function findRecursive(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      findRecursive(filePath, fileList);
    } else {
      if (filePath.endsWith('.html')) fileList.push(filePath);
    }
  });
  return fileList;
}

export async function run() {
  let server;
  let browser;
  try {
    const distPath = path.resolve(core.getInput('dist-path'));
    const benchmarkPath = core.getInput('benchmark-path');
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

    // Serve the built dist folder
    core.startGroup('Start local server');
    server = http.createServer((req, res) => {
      return handler(req, res, {});
    });

    await new Promise((resolve) => {
      server.listen(8080, resolve);
    });
    // loop through all benchmark pages
    const pages = [];
    const benchmarkFullPath = path.resolve(benchmarkPath);
    const benchmarkFiles = findRecursive(benchmarkFullPath);
    benchmarkFiles.forEach((file) => {
      const relativePath = path.relative(process.cwd(), path.dirname(file));
      const url = `http://localhost:8080/${relativePath.replace(/\\/g, '/')}/`;
      pages.push(url);
      core.info(`Found benchmark page: ${url}`);
    });

    core.endGroup();

    // Launch Playwright Chromium
    core.startGroup('Run headless benchmark in Playwright');
    // force gpu
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle']
    });
    const prResults = [];
    for (const pageUrl of pages) {
      const page = await browser.newPage();
      core.info(`Starting benchmark for: ${pageUrl}`);

      try {
        await page.goto(pageUrl);
        // Wait for benchmark result to appear
        core.info('Waiting for benchmarkResult...');
        const resultHandle = await page.waitForFunction(() => window.benchmarkResult, { timeout: 30_000 });
        const prResult = await resultHandle.jsonValue();
        prResults.push(prResult);
        core.info(`✅ Benchmark completed for ${pageUrl}: ${JSON.stringify(prResult)}`);
      } catch (error) {
        core.setFailed(`Benchmark failed for ${pageUrl}: ${error.message}`);
        throw error; // Add this to actually stop execution
      } finally {
        await page.close();
      }
    }

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
          diffPercent: null,
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
      const diffPercentFormatted = diffPercent == null ? '-' : `${arrow} ${diffPercent.toFixed(2)}%`;

      body += `| ${name} | FPS | ${devFPSFormatted} | ${prFPS.toFixed(2)} | ${diffPercentFormatted} |\n`;
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
    // Graceful teardown so the workflow can exit
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
