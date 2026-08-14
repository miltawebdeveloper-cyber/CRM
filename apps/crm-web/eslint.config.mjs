// ESLint 10 flat config for Next 16. eslint-config-next 16 ships native flat
// config arrays — consume directly (no FlatCompat).
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const config = [
  { ignores: ['.next', 'node_modules', 'next-env.d.ts'] },
  ...nextCoreWebVitals,
  {
    // Scoped to the file types Next's config actually registers the react-hooks
    // plugin for. Without `files` this block applies to EVERY linted file, and
    // eslint refuses to run at all the moment the app gains one it doesn't cover
    // — a `jest.config.cjs` was enough to fail the whole lint with "could not
    // find plugin react-hooks", which says nothing about the real cause.
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts}'],
    // The React Compiler checks (react-hooks v6) ship as ERRORS in Next 16's
    // core-web-vitals config. They flag legitimate, working patterns in existing
    // code (localStorage hydration in effects, ref reads, etc.), so downgrade them
    // to warnings — they still surface in editors and CI logs, but don't fail the
    // build. Revisit and fix incrementally rather than blocking every push.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },
];

export default config;
