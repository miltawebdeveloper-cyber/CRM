'use client';

// Ranger status pills with a leading dot. Covers lead statuses + caller presence.
const LEAD: Record<string, { label: string; fg: string; bg: string }> = {
  new: { label: 'New', fg: '#2c5d8f', bg: '#e6effb' },
  in_progress: { label: 'In Progress', fg: '#c98a18', bg: '#fdf1de' },
  contacted: { label: 'Contacted', fg: '#2f6f63', bg: '#e3f1ee' },
  interested: { label: 'Interested', fg: 'var(--brand)', bg: 'var(--brand-tint)' },
  closed: { label: 'Closed', fg: 'var(--brand-strong)', bg: 'var(--brand-tint-2)' },
  rejected: { label: 'Rejected', fg: '#9e2b21', bg: '#fde9e6' },
};

const PRESENCE: Record<string, { label: string; fg: string; bg: string; pulse?: boolean }> = {
  'On Call': { label: 'On Call', fg: '#ffffff', bg: 'var(--brand-strong)', pulse: true },
  oncall: { label: 'On Call', fg: '#ffffff', bg: 'var(--brand-strong)', pulse: true },
  Idle: { label: 'Idle', fg: '#6f7268', bg: '#f1f2ee' },
  idle: { label: 'Idle', fg: '#6f7268', bg: '#f1f2ee' },
  'Wrap-up': { label: 'Wrap-up', fg: '#c98a18', bg: '#fdf1de' },
  wrap: { label: 'Wrap-up', fg: '#c98a18', bg: '#fdf1de' },
};

export function StatusPill({ status, kind = 'lead' }: { status: string; kind?: 'lead' | 'presence' }) {
  const map = kind === 'presence' ? PRESENCE : LEAD;
  const s = map[status] ?? { label: status.replace('_', ' '), fg: '#6f7268', bg: '#f1f2ee' };
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
