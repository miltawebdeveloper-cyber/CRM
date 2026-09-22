'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { authSettingsApi, type OtpSettings } from '@/lib/crm';
import { toast } from '@/lib/toast';

/** Server message out of an axios error. */
function msgOf(err: unknown, fallback: string): string {
  const m = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(m)) return String(m[0]);
  return typeof m === 'string' && m ? m : fallback;
}

/**
 * Authentication Settings (admin) — the email-OTP policy applied to every login.
 *
 * Every code goes to the signing-in user's own registered email — there is no
 * shared or configurable recipient, so one account's code can never reach
 * another account's inbox. The panel says plainly when SMTP isn't configured:
 * turning the gate on without working mail would mean nobody could ever
 * receive a code, i.e. nobody could sign in.
 */
export function AuthenticationSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['auth-otp-settings'], queryFn: authSettingsApi.get });
  const [form, setForm] = useState<Omit<OtpSettings, 'mailReady'> | null>(null);

  // Seed the form once the saved policy arrives.
  useEffect(() => {
    if (data && !form) {
      const { mailReady: _mailReady, ...rest } = data;
      setForm(rest);
    }
  }, [data, form]);

  const save = useMutation({
    mutationFn: () => authSettingsApi.save(form!),
    onSuccess: (next) => {
      toast.success('Authentication settings saved');
      qc.setQueryData(['auth-otp-settings'], next);
    },
    onError: (err) => toast.error(msgOf(err, 'Could not save the settings.')),
  });

  if (isLoading || !form) {
    return <div className="rounded-2xl border bg-card p-[18px] text-sm text-muted-foreground shadow-sm">Loading authentication settings…</div>;
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-[18px] py-4">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <div>
          <h3 className="font-display text-[14px] font-semibold">Authentication Settings</h3>
          <div className="text-xs text-muted-foreground">Email OTP required after password sign-in</div>
        </div>
      </div>

      <div className="space-y-[18px] p-[18px]">
        {/* Without SMTP the code is only written to the server log, so enabling the
            gate would lock everyone out. Say so before they flip the switch. */}
        {data && !data.mailReady && (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--tone-red-bg)] px-3 py-2.5 text-[12px] text-[var(--tone-red-fg-2)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <b>SMTP is not configured</b>, so OTP emails cannot be delivered. Enabling this now would prevent everyone from
              signing in — the code would only appear in the server logs. Configure <code>SMTP_HOST</code> first.
            </span>
          </div>
        )}

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
          />
          <span>
            <span className="block text-[13px] font-semibold">OTP Authentication</span>
            <span className="block text-[11.5px] text-muted-foreground">
              Require a one-time code, emailed to each user&apos;s own registered address, after every successful password sign-in.
            </span>
          </span>
        </label>

        <div className="grid gap-3.5 sm:grid-cols-3">
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-semibold">OTP Expiry (minutes)</span>
            <input type="number" min={1} max={60} value={form.expiryMinutes}
              onChange={(e) => set('expiryMinutes', Number(e.target.value))}
              className="w-full rounded-md border bg-background px-3 py-2 outline-none focus:border-primary" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-semibold">Maximum Attempts</span>
            <input type="number" min={1} max={10} value={form.maxAttempts}
              onChange={(e) => set('maxAttempts', Number(e.target.value))}
              className="w-full rounded-md border bg-background px-3 py-2 outline-none focus:border-primary" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-semibold">Resend Timer (seconds)</span>
            <input type="number" min={15} max={600} value={form.resendSeconds}
              onChange={(e) => set('resendSeconds', Number(e.target.value))}
              className="w-full rounded-md border bg-background px-3 py-2 outline-none focus:border-primary" />
          </label>
        </div>

        {/* Trusted devices — the reason a user isn't asked for a code on every
            single sign-in. Off = a code every time, on any device. */}
        <div className="space-y-[14px] rounded-lg border bg-muted/30 p-3.5">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={form.trustDeviceEnabled}
              onChange={(e) => set('trustDeviceEnabled', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
            />
            <span>
              <span className="block text-[13px] font-semibold">Remember trusted devices</span>
              <span className="block text-[11.5px] text-muted-foreground">
                After a code is verified, that browser skips the OTP until the trust period ends. Signing out does not
                clear it — only an expiry or a revoke does.
              </span>
            </span>
          </label>

          <label className="block max-w-[260px] space-y-1 text-sm">
            <span className="text-xs font-semibold">Trust Period (days)</span>
            <input
              type="number"
              min={1}
              max={365}
              disabled={!form.trustDeviceEnabled}
              value={form.trustDeviceDays}
              onChange={(e) => set('trustDeviceDays', Number(e.target.value))}
              className="w-full rounded-md border bg-background px-3 py-2 outline-none focus:border-primary disabled:opacity-50"
            />
            <span className="block text-[11px] text-muted-foreground">
              Default 180 days. The next sign-in after this window needs a fresh code, which then renews it.
            </span>
          </label>
        </div>

        <div className="flex justify-end">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
