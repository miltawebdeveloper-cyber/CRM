/**
 * Unit tests for the browser app's pure logic — the modules under `lib/` that
 * decide things, rather than the components that draw them.
 *
 * Deliberately narrow. There is no jsdom and no component renderer here: those
 * bring a second dependency tree and a second set of failure modes, and the
 * bugs this app has actually shipped in this area were not rendering bugs. They
 * were a label that read wrong and an export whose columns drifted out of step
 * with its headings — plain functions over plain data, which is what this runs.
 *
 * Compiler settings come from `tsconfig.jest.json`, which swaps the app's
 * bundler-targeted module system for one Node can require.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/lib'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  // Mirrors the `@/*` path alias in tsconfig, so tests import modules by the
  // same name the app does.
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
};
