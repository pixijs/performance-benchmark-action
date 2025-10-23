// See: https://jestjs.io/docs/configuration

/** @type {import('jest').Config} */
const jestConfig = {
  clearMocks: true,
  collectCoverage: false,
  moduleFileExtensions: ['js'],
  reporters: ['default'],
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  testPathIgnorePatterns: ['/dist/', '/node_modules/'],
  verbose: true
}

export default jestConfig
