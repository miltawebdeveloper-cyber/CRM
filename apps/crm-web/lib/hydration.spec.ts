import { describe, expect, it, jest } from '@jest/globals';

/**
 * A one-line module with a rule that is easy to break by accident: it must start
 * FALSE.
 *
 * Everything rendered in the initial commit has server markup to match and may
 * not read `localStorage` during that render. Only components mounted afterwards
 * — every page reached by clicking through the CRM — are free to. A default of
 * `true` would flip that on its head and put a hydration mismatch on the first
 * paint of every hard load, which is precisely the "screen goes blank" failure
 * this was written to remove.
 *
 * `isolateModules` gives each test a fresh copy, since the flag is module state
 * and is meant to be one-way.
 */
describe('app hydration gate', () => {
  const fresh = () => {
    let mod!: typeof import('./hydration');
    jest.isolateModules(() => {
      mod = require('./hydration') as typeof import('./hydration');
    });
    return mod;
  };

  it('starts false, so the first render matches the server markup', () => {
    expect(fresh().isAppHydrated()).toBe(false);
  });

  it('is true once the shell reports hydration finished', () => {
    const mod = fresh();
    mod.markAppHydrated();
    expect(mod.isAppHydrated()).toBe(true);
  });

  it('is one-way — marking twice is not a toggle', () => {
    const mod = fresh();
    mod.markAppHydrated();
    mod.markAppHydrated();
    expect(mod.isAppHydrated()).toBe(true);
  });

  it('does not leak between module instances', () => {
    const first = fresh();
    first.markAppHydrated();
    expect(fresh().isAppHydrated()).toBe(false);
  });
});
