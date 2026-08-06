'use client';

/** Ranger page-head: the page's actions, aligned right. Renders nothing without
 *  any — a page with no actions has no head row to make space for. */
export function PageHead({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center justify-end gap-2.5">{children}</div>
  );
}

/** Small avatar with initials, Ranger style. */
export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = (name || '?')
    .split(/[ .@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');
  const dim = size === 'lg' ? 'h-11 w-11 text-[14px]' : size === 'md' ? 'h-9 w-9 text-[12.5px]' : 'h-[30px] w-[30px] text-[11.5px]';
  return (
    <div className={`grid ${dim} shrink-0 place-items-center rounded-full bg-[var(--brand-mid)] font-display font-semibold text-white`}>
      {initials}
    </div>
  );
}
