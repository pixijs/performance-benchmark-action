# PixiJS Performance Benchmark Action

A GitHub Action for running performance benchmarks on PixiJS. This action
measures rendering performance, frame rates, and other key metrics to help track
performance regressions and improvements in PixiJS projects. :rocket:

## About This Action

This GitHub Action runs automated performance benchmarks for PixiJS
applications. It helps you:

- Track rendering performance metrics across commits and pull requests
- Detect performance regressions before merging code
- Measure frame rates, draw calls, and other key performance indicators
- Compare benchmark results over time

The action runs various PixiJS rendering scenarios (sprites, graphics, etc.) and
collects performance data that can be used for analysis and reporting.

## Development Setup

To work on this action locally, you'll need Node.js (20.x or later).

1. :hammer_and_wrench: Install the dependencies

   ```bash
   npm install
   ```

2. :building_construction: Package the JavaScript for distribution

   ```bash
   npm run bundle
   ```
