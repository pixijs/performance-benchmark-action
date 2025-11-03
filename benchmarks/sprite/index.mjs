import { Test } from './test.mjs'
;(async () => {
  const spriteBenchmark = new Test('Sprites (50k)', 50_000)
  await spriteBenchmark.init()
  spriteBenchmark.resetMetrics()
  await spriteBenchmark.render()
  // eslint-disable-next-line no-undef
  window.benchmarkResult = spriteBenchmark.getPerformanceMetrics()
})()
