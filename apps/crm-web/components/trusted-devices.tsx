'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Loader2, MonitorSmartphone, ShieldOff } from 'lucide-react';
import { trustedDevicesApi, type TrustedDevice } from '@/lib/crm';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from '@/lib/toast';
import { formatDate, formatDateTime } from '@/lib/display-settings';

function msgOf(err: unknown, fallback: string): string {
  const m = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(m)) return String(m[0]);
  return typeof m === 'string' && m ? m : fallback;
}

const fmt = (iso: string) =>
  formatDateTime(iso);
const fmtDate = (iso: string) => formatDate(iso);

/** Days left on the trust window — the number that actually matters at a glance. */
function daysLeft(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

const STATUS_STYLE: Record<TrustedDevice['status'], string> = {
  active: 'bg-[var(--brand-surface)] text-[var(--brand-on-surface)]',
  expired: 'bg-muted text-muted-foreground',
  revoked: 'bg-[var(--tone-red-bg)] text-[var(--tone-red-fg-2)]',
};

/**
 * Trusted Devices — the browsers allowed to skip the login OTP until their trust
 * period runs out.
 *
 * `scope="all"` is the admin view across every user; `scope="mine"` is a user
 * looking at their own. Revoking is the manual way to force a code again: the
 * next sign-in from that browser starts a fresh challenge.
 */
export function TrustedDevices({ scope = 'mine' }: { scope?: 'mine' | 'all' }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<TrustedDevice | 'all' | null>(null);
  const queryKey = ['trusted-devices', scope];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: scope === 'all' ? trustedDevicesApi.all : trustedDevicesApi.mine,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['trusted-devices'] });

  const revoke = useMutation({
    mutationFn: (d: TrustedDevice) => trustedDevicesApi.revoke(d.id),
    onSuccess: () => {
      toast.success('Device revoked — the next sign-in from it will need a new code');
      invalidate();
    },
    onError: (err) => toast.error(msgOf(err, 'Could not revoke the device.')),
  });

  const revokeAll = useMutation({
    mutationFn: () => trustedDevicesApi.revokeAll(),
    onSuccess: (r) => {
      toast.success(r.revoked ? `${r.revoked} device(s) revoked` : 'No active devices to revoke');
      invalidate();
    },
    onError: (err) => toast.error(msgOf(err, 'Could not revoke the devices.')),
  });

  const rows = data ?? [];
  const activeCount = rows.filter((d) => d.status === 'active').length;

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-[18px] py-4">
        <MonitorSmartphone className="h-4 w-4 text-primary" />
        <div className="flex-1">
          <h3 className="font-display text-[14px] font-semibold">Trusted Devices</h3>
          <div className="text-xs text-muted-foreground">
            {scope === 'all'
              ? 'Every device across all users that can sign in without an OTP'
              : 'Browsers that can sign in without an OTP until their trust period ends'}
          </div>
        </div>
        {scope === 'mine' && activeCount > 0 && (
          <button
            onClick={() => setConfirming('all')}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold text-[var(--tone-red-fg-2)] hover:bg-muted"
          >
            <ShieldOff className="h-3.5 w-3.5" /> Revoke all
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="px-[18px] py-8 text-center text-sm text-muted-foreground">Loading trusted devices…</p>
      ) : rows.length === 0 ? (
        <p className="px-[18px] py-8 text-center text-sm text-muted-foreground">
          No trusted devices yet. A device is remembered after its first verified login code.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                {scope === 'all' && <th className="px-[18px] py-2.5 font-semibold">User</th>}
                <th className="px-[18px] py-2.5 font-semibold">Device</th>
                <th className="px-[18px] py-2.5 font-semibold">Browser</th>
                <th className="px-[18px] py-2.5 font-semibold">Operating system</th>
                <th className="px-[18px] py-2.5 font-semibold">Last login</th>
                <th className="px-[18px] py-2.5 font-semibold">Trusted until</th>
                <th className="px-[18px] py-2.5 font-semibold">Status</th>
                <th className="px-[18px] py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  {scope === 'all' && (
                    <td className="px-[18px] py-3">
                      <div className="font-semibold">{d.user?.name ?? '—'}</div>
                      <div className="text-[11.5px] text-muted-foreground">{d.user?.email}</div>
                    </td>
                  )}
                  <td className="px-[18px] py-3">
                    <div className="flex items-center gap-2">
                      <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="font-semibold">{d.deviceName}</span>
                      {d.current && (
                        <span className="rounded-full bg-[var(--brand-surface)] px-2 py-[1px] text-[10.5px] font-semibold text-[var(--brand-on-surface)]">This device</span>
                      )}
                    </div>
                    {d.ipAddress && <div className="mt-0.5 pl-6 text-[11.5px] text-muted-foreground">{d.ipAddress}</div>}
                  </td>
                  <td className="px-[18px] py-3">{d.browser}</td>
                  <td className="px-[18px] py-3">{d.os}</td>
                  <td className="px-[18px] py-3 text-muted-foreground">{fmt(d.lastLoginAt)}</td>
                  <td className="px-[18px] py-3">
                    {fmtDate(d.trustedUntil)}
                    {d.status === 'active' && (
                      <span className="block text-[11.5px] text-muted-foreground">{daysLeft(d.trustedUntil)} day(s) left</span>
                    )}
                  </td>
                  <td className="px-[18px] py-3">
                    <span className={`inline-block rounded-full px-2.5 py-[3px] text-[11px] font-semibold capitalize ${STATUS_STYLE[d.status]}`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="px-[18px] py-3 text-right">
                    {d.status === 'active' && (
                      <button
                        onClick={() => setConfirming(d)}
                        disabled={revoke.isPending}
                        className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[12px] font-semibold text-[var(--tone-red-fg-2)] hover:bg-muted disabled:opacity-50"
                      >
                        {revoke.isPending && revoke.variables?.id === d.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldOff className="h-3.5 w-3.5" />
                        )}
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming === 'all' ? 'Revoke all trusted devices?' : 'Revoke this device?'}
          message={
            confirming === 'all'
              ? 'Every device on your account, including this one, will need a fresh verification code at the next sign-in.'
              : `${confirming.deviceName}${confirming.user ? ` (${confirming.user.name})` : ''} will need a fresh verification code at the next sign-in.`
          }
          confirmLabel="Revoke"
          onConfirm={async () => {
            if (confirming === 'all') await revokeAll.mutateAsync();
            else await revoke.mutateAsync(confirming);
          }}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
