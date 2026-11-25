import type { ComponentType, ReactNode } from 'react';

/**
 * `next/dynamic` for the unit tests (mapped in jest.config.cjs).
 *
 * The real one fetches its component with `import()`, which these tests —
 * compiled to CommonJS, run without Node's VM-modules flag — cannot execute.
 * A component loaded on demand is a part the page can draw without (a chart's
 * plot, say), so a test renders its loading placeholder instead and asserts
 * on everything around it, which is what the tests are about.
 */
export default function dynamic<P>(_load: unknown, opts?: { loading?: () => ReactNode }): ComponentType<P> {
  function OnDemand() {
    return <>{opts?.loading?.() ?? null}</>;
  }
  return OnDemand as unknown as ComponentType<P>;
}
