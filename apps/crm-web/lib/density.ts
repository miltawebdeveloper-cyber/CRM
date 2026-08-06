'use client';

/**
 * Row density — how much air the tables give each record.
 *
 * The CRM is read two ways. A manager scanning for one company wants as many
 * rows on screen as will fit; a rep working a lead at a time wants the row they
 * are on to be easy to stay inside of. That is a preference, not a design
 * decision, and every list tool that people live in offers it.
 *
 * Scoped to the shared table on purpose. Density means ROW HEIGHT here, not a
 * second type scale or a second spacing system: the type sizes stay exactly
 * where they are in both settings, so nothing reflows, nothing truncates
 * differently, and the only thing that moves is the padding above and below a
 * cell. A setting that quietly restyled the whole app would be a theme.
 *
 * Same mechanism as the palette: one attribute on <html>, values in globals.css.
 */

/** Preference key under `/me/preferences`, namespaced like the others. */
export const DENSITY_KEY = 'display:density';

/** Mirror of the choice, read before first paint so no row jumps. */
export const DENSITY_STORAGE_KEY = 'display:density';

export interface DensityOption {
  id: string;
  label: string;
  hint: string;
  /** Row height in px at this setting, quoted in the UI so the choice is concrete. */
  rowHeight: number;
}

export const DENSITIES: DensityOption[] = [
  { id: 'comfortable', label: 'Comfortable', hint: 'Roomier rows. The default.', rowHeight: 42 },
  { id: 'compact', label: 'Compact', hint: 'More records per screen, same type size.', rowHeight: 32 },
];

export const DEFAULT_DENSITY = 'comfortable';

export const isKnownDensity = (v: unknown): v is string =>
  typeof v === 'string' && DENSITIES.some((d) => d.id === v);

/** Set the row density. Returns what was actually applied. */
export function applyDensity(id: unknown): string {
  const next = isKnownDensity(id) ? id : DEFAULT_DENSITY;
  if (typeof document !== 'undefined') document.documentElement.dataset.density = next;
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, next);
  } catch {
    /* private mode — the server preference still holds it */
  }
  return next;
}

/** The density this browser last applied. */
export function storedDensity(): string {
  try {
    const v = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (isKnownDensity(v)) return v;
  } catch {
    /* unreadable storage is the same as never having chosen */
  }
  return DEFAULT_DENSITY;
}

/**
 * Applied in <head> before first paint, for the same reason the palette's is:
 * the saved value lives on the server, and adopting it after render would drop
 * every row of a long table by 10px under the reader's eyes.
 */
export const DENSITY_BOOT_SCRIPT = `(function(){try{var d=localStorage.getItem('${DENSITY_STORAGE_KEY}');document.documentElement.dataset.density=${JSON.stringify(
  DENSITIES.map((d) => d.id),
)}.indexOf(d)>-1?d:'${DEFAULT_DENSITY}';}catch(e){}})();`;
