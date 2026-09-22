/**
 * Unit tests for the browser app.
 *
 * TWO KINDS, and the split is deliberate.
 *
 * Most of it is still what it always was: pure logic under `lib/` — the modules
 * that DECIDE things — run in plain Node with no DOM in sight. That is the
 * cheapest test to write and the one that survives a redesign, and it is where
 * the bugs this app used to ship lived: a label that read wrong, an export whose
 * columns drifted out of step with its headings.
 *
 * The second kind is new, and it is here because the bugs changed. The flicker
 * that emptied Lead Management, and the saved filter that arrived a render late
 * and fired a second query, were not decisions taken wrongly — the decisions
 * were fine. They were about WHEN a component read something and what it showed
 * while it waited, and no amount of testing pure functions can see that. Those
 * need a renderer, so `@testing-library/react` and jsdom now earn their place.
 *
 * A render test opts in with a docblock at the top of the file:
 *
 *     /** @jest-environment jsdom *\/
 *
 * Everything else stays in Node. Keep it that way — a DOM that nothing on the
 * page needs is just a slower test.
 *
 * Compiler settings come from `tsconfig.jest.json`, which swaps the app's
 * bundler-targeted module system for one Node can require.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // `components` joins `lib` so the shared table can be rendered against. Route
  // `page.tsx` files stay out: a page is a composition of many things, and
  // testing one means standing up its every query. `app` itself is in only for
  // `(app)/layout.tsx` — not a page, the one shell every page renders inside —
  // and even that test mocks every child component rather than standing them
  // up, so it stays a test of the layout's own gating logic, not a composition
  // test in disguise.
  roots: ['<rootDir>/lib', '<rootDir>/components', '<rootDir>/app'],
  testMatch: ['**/?(*.)+(spec|test).ts?(x)'],
  // Mirrors the `@/*` path alias in tsconfig, so tests import modules by the
  // same name the app does.
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
};
