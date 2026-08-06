'use client';

// Colored pill for a call outcome. Color comes from the configurable Outcome
// record; rendered as a soft tinted chip (color text on a low-opacity bg).
export function OutcomePill({ name, color = '#6f7268' }: { name: string; color?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold"
      style={{ color, background: `${color}1f` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}
