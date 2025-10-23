import * as core from '@actions/core'
import * as github from '@actions/github'
import { Octokit } from 'octokit'
import { spawn } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

import fetch from 'node-fetch'

// Wait for the local server to become ready
async function waitForServer(url, retries = 20, delay = 300) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        return true
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, delay))
  }
  throw new Error(`Server at ${url} did not respond after ${retries * delay}ms`)
}

export async function run() {
  let server
  try {
    const distPath = path.resolve(core.getInput('dist-path'))
    const outputFile = core.getInput('output-file')
    const baselineFile = core.getInput('baseline-file')
    const token = process.env.GITHUB_TOKEN

    if (!fs.existsSync(distPath)) {
      throw new Error(`dist path not found: ${distPath}`)
    }

    // copy dist to current folder
    core.startGroup('📂 Copy dist files')
    // ensure temp folder exists
    fs.mkdirSync('./temp', { recursive: true })
    fs.readdirSync(distPath).forEach((file) => {
      fs.copyFileSync(path.join(distPath, file), path.join('./temp', file))
    })
    core.endGroup()

    // Serve the built dist folder
    core.startGroup('🚀 Start local server')
    server = spawn('npx', ['http-server', './', '-p', '8080', '--silent'], {
      detached: true,
      stdio: 'ignore'
    })
    // loop through all benchmark pages
    const pages = ['http://localhost:8080/dist/benchmark/sprite/index.html']
    await waitForServer(pages[0])
    core.endGroup()

    // Launch Playwright Chromium
    core.startGroup('🧪 Run headless benchmark in Playwright')
    const browser = await chromium.launch({ headless: false })
    const prResults = []
    for (const pageUrl of pages) {
      const page = await browser.newPage()
      await page.goto(pageUrl)

      // Wait for benchmark result to appear
      core.info('Waiting for benchmarkResult...')
      const resultHandle = await page.waitForFunction(
        // eslint-disable-next-line no-undef
        () => window.benchmarkResult,
        { timeout: 30_000 }
      )
      const prResult = await resultHandle.jsonValue()
      prResults.push(prResult)
      core.info(
        `✅ Benchmark completed for ${pageUrl}: ${JSON.stringify(prResult)}`
      )
      await page.close()
    }
    await browser.close()

    fs.writeFileSync(outputFile, JSON.stringify(prResults, null, 2))
    core.info(`🏁 Benchmark result: ${JSON.stringify(prResults, null, 2)}`)
    core.endGroup()

    // --- Comparison and PR Comment ---
    if (!baselineFile || !fs.existsSync(baselineFile)) {
      core.info('No baseline provided—skip comparison.')
      return
    }

    const baseline = JSON.parse(fs.readFileSync(baselineFile))
    const tableRows = []
    let regressionDetected = false
    // compare all pages
    for (let i = 0; i < pages.length; i++) {
      const prResult = prResults[i]
      const baselineResult = baseline[i]

      if (!baselineResult) {
        core.info(`No baseline result for ${pages[i]}—skip comparison.`)
        continue
      }

      const devFPS = Number(baselineResult.fps)
      const prFPS = Number(prResult.fps)
      const diffPercent = ((devFPS - prFPS) / devFPS) * 100
      const regression = diffPercent > 5
      const arrow = diffPercent > 0 ? '🔻' : '🔺'
      tableRows.push({ devFPS, prFPS, diffPercent, regression, arrow })
    }
    const MARKER = '<!-- PIXIJS_BENCHMARK_COMMENT -->'

    // build a comment body that includes all benchmark results
    let body = `
${MARKER}
### 🧪 PixiJS Benchmark Results
| Metric | dev | PR  | Change |
|:-------|----:|----:|-------:|
`
    tableRows.forEach(({ devFPS, prFPS, diffPercent, regression, arrow }) => {
      body += `| FPS | ${devFPS.toFixed(2)} | ${prFPS.toFixed(2)} | ${arrow} ${diffPercent.toFixed(2)}% |\n\n`
      if (regression) regressionDetected = true
    })
    body += `
${
  regressionDetected
    ? '❌ **Performance regression detected (>5%)**'
    : '✅ Performance within acceptable range'
}
`

    if (token && github.context.payload.pull_request) {
      const octokit = new Octokit({ auth: token })
      const issueNumber = github.context.payload.pull_request.number

      const { data: comments } = await octokit.rest.issues.listComments({
        ...github.context.repo,
        issue_number: issueNumber
      })

      const existing = comments.find((c) => c.body?.includes(MARKER))
      if (existing) {
        await octokit.rest.issues.updateComment({
          ...github.context.repo,
          comment_id: existing.id,
          body
        })
        core.info('Updated existing benchmark comment.')
      } else {
        await octokit.rest.issues.createComment({
          ...github.context.repo,
          issue_number: issueNumber,
          body
        })
        core.info('Posted new benchmark comment.')
      }
    }

    if (regressionDetected) {
      core.setFailed(`Performance regression >5% detected.`)
    } else {
      core.info('✅ Performance within acceptable range.')
    }
  } catch (err) {
    core.setFailed(err.message)
  } finally {
    if (server) process.kill(-server.pid)
  }
}
