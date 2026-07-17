'use client';

// Ranger status pills with a leading dot. Covers lead statuses + caller presence.
const LEAD: Record<string, { label: string; fg: string; bg: string }> = {
  new: { label: 'New', fg: '#2c5d8f', bg: '#e7f0f8' },
  in_progress: { label: 'In Progress', fg: '#c98a18', bg: '#fbf3e2' },
  contacted: { label: 'Contacted', fg: '#2f6f63', bg: '#e3f1ee' },
  interested: { label: 'Interested', fg: '#266929', bg: '#d8eed9' },
  closed: { label: 'Closed', fg: '#317d34', bg: '#e4f2e4' },
  rejected: { label: 'Rejected', fg: '#9e2b21', bg: '#fbeeec' },
};

const PRESENCE: Record<string, { label: string; fg: string; bg: string; pulse?: boolean }> = {
  'On Call': { label: 'On Call', fg: '#ffffff', bg: '#317d34', pulse: true },
  oncall: { label: 'On Call', fg: '#ffffff', bg: '#317d34', pulse: true },
  Idle: { label: 'Idle', fg: '#5a725b', bg: '#eaf1ea' },
  idle: { label: 'Idle', fg: '#5a725b', bg: '#eaf1ea' },
  'Wrap-up': { label: 'Wrap-up', fg: '#c98a18', bg: '#fbf3e2' },
  wrap: { label: 'Wrap-up', fg: '#c98a18', bg: '#fbf3e2' },
};

export function StatusPill({ status, kind = 'lead' }: { status: string; kind?: 'lead' | 'presence' }) {
  const map = kind === 'presence' ? PRESENCE : LEAD;
  const s = map[status] ?? { label: status.replace('_', ' '), fg: '#5a725b', bg: '#eaf1ea' };
  const pulse = (s as { pulse?: boolean }).pulse;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold capitalize"
      style={{ color: s.fg, background: s.bg }}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${pulse ? 'animate-pulse' : ''}`} style={{ background: 'currentColor' }} />
      {s.label}
    </span>
  );
}
