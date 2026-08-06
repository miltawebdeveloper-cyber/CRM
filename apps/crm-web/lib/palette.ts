'use client';

/**
 * The CRM's colour palette — which brand family the UI is painted in.
 *
 * A palette is NOT a theme. Light and dark are still next-themes' business, and
 * every palette works in both: what a palette swaps is the brand family alone —
 * the sidebar, the primary buttons, the active nav row, the green pills and the
 * lime highlights. Status colours are deliberately untouched, because red still
 * has to mean rejected and amber still has to mean pending whatever the CRM is
 * painted in; a palette that recoloured those would be changing what the screen
 * SAYS, not how it looks.
 *
 * Everything is done with CSS variables and one attribute on <html>. The values
 * live in globals.css under `[data-palette='…']`, so switching is a single
 * attribute write with no re-render, no reload and no flash of the old colours.
 *
 * Adding a palette is a block in globals.css plus an entry here. Nothing else in
 * the app names a brand colour directly — see the `--brand-*` tokens.
 */

/** Preference key under `/me/preferences`, namespaced like the others. */
export const PALETTE_KEY = 'display:palette';

/** Mirror of the choice, read before first paint so nothing flashes. */
export const PALETTE_STORAGE_KEY = 'display:palette';

export interface PaletteOption {
  id: string;
  label: string;
  /** One line on what it reads as, shown under the name. */
  hint: string;
  /**
   * The swatch, in the order the palette is actually met: the sidebar's ink,
   * the brand itself, the tint the pills use, and the canvas the whole app sits
   * on. The canvas is last because it is the largest area on screen and the
   * quietest colour — a swatch without it shows three colours the eye sees for
   * a moment and omits the one it looks at all day.
   *
   * Written out rather than read from the CSS, because a swatch has to show a
   * palette that is NOT currently applied.
   */
  swatch: [string, string, string, string];
}

export const PALETTES: PaletteOption[] = [
  { id: 'forest', label: 'Forest', hint: 'Milta green on warm paper. The default.', swatch: ['#163618', '#266929', '#e7f5dc', '#f6f5f1'] },
  { id: 'ocean', label: 'Ocean', hint: 'Deep blue on cool paper.', swatch: ['#122b3d', '#1e5f86', '#dcecf6', '#f0f4f7'] },
  { id: 'violet', label: 'Violet', hint: 'Indigo on the faintest lilac.', swatch: ['#26193d', '#5b3fa0', '#ece4fa', '#f6f4fa'] },
  { id: 'graphite', label: 'Graphite', hint: 'True neutral. Lets the data carry the colour.', swatch: ['#1f2429', '#445059', '#e6eaed', '#f4f5f6'] },
];

export const DEFAULT_PALETTE = 'forest';

export const isKnownPalette = (v: unknown): v is string =>
  typeof v === 'string' && PALETTES.some((p) => p.id === v);

/**
 * Paint the app in a palette.
 *
 * The default is written as an attribute too, rather than being left off: the
 * value is what tells a later read which palette is deliberate, and an absent
 * attribute cannot be told apart from a palette that failed to apply.
 */
export function applyPalette(id: unknown): string {
  const next = isKnownPalette(id) ? id : DEFAULT_PALETTE;
  if (typeof document !== 'undefined') document.documentElement.dataset.palette = next;
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, next);
  } catch {
    /* private mode / storage disabled — the server preference still holds it */
  }
  return next;
}

/** The palette this browser last applied, for the pre-paint script and the UI. */
export function storedPalette(): string {
  try {
    const v = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (isKnownPalette(v)) return v;
  } catch {
    /* unreadable storage is the same as never having chosen */
  }
  return DEFAULT_PALETTE;
}

/**
 * Applied in <head>, before the first paint, from localStorage alone.
 *
 * The saved preference comes from the server and cannot be waited for without
 * showing something first — so the browser's own copy paints immediately and the
 * server's answer, which is the same value in every ordinary case, confirms it a
 * moment later. Written as a string because it has to run as a plain <script>,
 * ahead of React: by the time a component could set this attribute the user has
 * already seen the default palette.
 */
export const PALETTE_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem('${PALETTE_STORAGE_KEY}');document.documentElement.dataset.palette=${JSON.stringify(
  PALETTES.map((p) => p.id),
)}.indexOf(p)>-1?p:'${DEFAULT_PALETTE}';}catch(e){}})();`;
