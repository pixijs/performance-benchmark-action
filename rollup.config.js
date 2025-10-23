// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import { copy } from '@web/rollup-plugin-copy'

const config = {
  input: 'src/index.js',
  output: {
    esModule: true,
    dir: 'dist',
    format: 'es',
    sourcemap: true
  },
  plugins: [
    commonjs(),
    json(),
    nodeResolve({ preferBuiltins: true }),
    copy({
      rootDir: './src',
      // the benchmark folders need to be copied as-is
      patterns: ['./benchmarks/**']
    })
  ]
}

export default config
