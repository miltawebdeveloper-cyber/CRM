'use client';

/**
 * Has React finished hydrating the app shell?
 *
 * One flag, flipped once, read during render — which is the point. A component
 * that mounts BEFORE hydration finishes is part of the markup the server sent,
 * so its first render has to match that markup exactly and may not read
 * `localStorage`. A component that mounts AFTER it — every page reached by
 * clicking through the CRM — has no markup to match and may read storage
 * straight away.
 *
 * That distinction is what removes a whole class of flicker. Restoring a saved
 * filter in an effect means the first render always uses the default, a query
 * fires against it, the effect corrects the value, and a SECOND query fires
 * against the real one: two requests and a visibly empty table between them, on
 * every single visit to Lead Management. Reading it during the first render
 * costs one request and shows one list.
 *
 * `Providers` sets it. Child effects run before parent effects, so everything
 * rendered in the initial commit still sees `false` and takes the SSR-safe
 * path.
 */
let hydrated = false;

export function markAppHydrated() {
  hydrated = true;
}

/** True once the initial client render has committed; false during it. */
export function isAppHydrated() {
  return hydrated;
}
