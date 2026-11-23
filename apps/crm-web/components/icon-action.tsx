'use client';

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

type IconActionProps = {
  icon: LucideIcon;
  /** The action's name — shown on hover, focus or tap, and read by screen readers. */
  label: string;
  /** `primary` keeps the page's main action filled, so it still stands out among icons. */
  /** `ghost`: no border or fill until hover — for actions repeated on every row of a list. */
  variant?: 'default' | 'primary' | 'ghost';
  disabled?: boolean;
  /** Spins the icon while the action runs (a sync, say). */
  busy?: boolean;
  /**
   * `sm` (32px, the default) sits in a chip row like the lead pages' quick
   * filters; `md` (36px) matches the full-size text buttons in a page header,
   * where an icon action stands beside the page's main action.
   */
  size?: 'sm' | 'md';
  /**
   * Where the name label sits under the icon: centred (default), or flush with
   * the icon's right edge — for an icon at the right edge of the page, whose
   * centred label would hang off the screen.
   */
  align?: 'center' | 'end';
} & ({ href: string; onClick?: never } | { href?: undefined; onClick: () => void });

/**
 * A compact page-header action: the icon alone, with its name in a small label
 * that appears on hover, on keyboard focus, and on tap.
 *
 * Replaces the full text buttons along the top of the lead pages, which took a
 * row of their own on narrower screens. The label is drawn here rather than
 * left to the browser's `title`, which waits about a second, looks different
 * in every browser and never shows on a touch screen — the one place an
 * icon-only button most needs explaining. It also shows on a disabled action,
 * so a greyed-out icon still says what it is.
 */
export function IconAction(props: IconActionProps) {
  const { icon: Icon, label, variant = 'default', disabled, busy, size = 'sm', align = 'center' } = props;
  const box =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground shadow-sm hover:opacity-90'
      : variant === 'ghost'
        ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
        : 'border bg-card text-foreground hover:bg-muted';
  const cls = `grid ${size === 'md' ? 'h-9 w-9' : 'h-8 w-8'} place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50 ${box}`;
  const icon = <Icon className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden />;

  return (
    <span className="group/tip relative inline-flex">
      {props.href ? (
        <Link href={props.href} aria-label={label} className={cls}>
          {icon}
        </Link>
      ) : (
        <button type="button" onClick={props.onClick} disabled={disabled} aria-label={label} className={cls}>
          {icon}
        </button>
      )}
      {/* Decorative: the control's aria-label already names it, so this is
          hidden from screen readers rather than read twice.

          Out of the layout until hover or focus (`hidden`, not `opacity-0`).
          A transparent label still takes up room, and one under an icon at the
          right edge made the whole page 30-odd px wider than the screen — a
          sideways scroll on every phone. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute top-full z-50 mt-1.5 hidden whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[11.5px] font-medium text-background shadow-md group-focus-within/tip:block group-hover/tip:block ${
          align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2'
        }`}
      >
        {label}
      </span>
    </span>
  );
}
