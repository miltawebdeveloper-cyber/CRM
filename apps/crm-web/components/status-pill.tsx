'use client';

// Ranger status pills with a leading dot. Covers lead statuses + caller presence.
const LEAD: Record<string, { label: string; fg: string; bg: string }> = {
  new: { label: 'New', fg: 'var(--tone-blue-fg)', bg: 'var(--tone-blue-bg)' },
  in_progress: { label: 'In Progress', fg: 'var(--tone-amber-fg)', bg: 'var(--tone-amber-bg)' },
  contacted: { label: 'Contacted', fg: 'var(--tone-teal-fg)', bg: 'var(--tone-teal-bg)' },
  interested: { label: 'Interested', fg: 'var(--brand-on-surface)', bg: 'var(--brand-surface)' },
  closed: { label: 'Closed', fg: 'var(--brand-on-surface)', bg: 'var(--brand-surface-2)' },
  rejected: { label: 'Rejected', fg: 'var(--tone-red-fg)', bg: 'var(--tone-red-bg)' },
};

const PRESENCE: Record<string, { label: string; fg: string; bg: string; pulse?: boolean }> = {
  'On Call': { label: 'On Call', fg: '#ffffff', bg: 'var(--brand-strong)', pulse: true },
  oncall: { label: 'On Call', fg: '#ffffff', bg: 'var(--brand-strong)', pulse: true },
  Idle: { label: 'Idle', fg: 'var(--tone-neutral-fg)', bg: 'var(--tone-neutral-bg)' },
  idle: { label: 'Idle', fg: 'var(--tone-neutral-fg)', bg: 'var(--tone-neutral-bg)' },
  'Wrap-up': { label: 'Wrap-up', fg: 'var(--tone-amber-fg)', bg: 'var(--tone-amber-bg)' },
  wrap: { label: 'Wrap-up', fg: 'var(--tone-amber-fg)', bg: 'var(--tone-amber-bg)' },
};

export function StatusPill({ status, kind = 'lead' }: { status: string; kind?: 'lead' | 'presence' }) {
  const map = kind === 'presence' ? PRESENCE : LEAD;
  const s = map[status] ?? { label: status.replace('_', ' '), fg: 'var(--tone-neutral-fg)', bg: 'var(--tone-neutral-bg)' };
  const pulse = (s as { pulse?: boolean }).pulse;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold capitalize"
      style={{ color: s.fg, background: s.bg }}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${pulse ? 'animate-pulse' : ''}`} style={{ background: 'currentColor' }} />
      {s.label}
    </span>
  );
}
