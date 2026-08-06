'use client';

// Colored pill for a call outcome. Color comes from the configurable Outcome
// record, so it is DATA, not a token: the wash, the dot and the dark-mode
// lightening are all derived from it by `.pill-tinted` in globals.css. This used
// to build its background by concatenating alpha onto the hex, which produced
// nothing at all when the colour was a var() and left an unreadable dark chip on
// a dark card when it wasn't.
export function OutcomePill({ name, color = 'var(--tone-neutral-fg)' }: { name: string; color?: string }) {
  return (
    <span
      className="pill-tinted inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold"
      style={{ '--pill': color } as React.CSSProperties}
    >
      <span className="pill-dot h-1.5 w-1.5 rounded-full" />
      {name}
    </span>
  );
}
