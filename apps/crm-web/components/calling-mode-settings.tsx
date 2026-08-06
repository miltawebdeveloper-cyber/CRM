'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneOff, Loader2, ListChecks } from 'lucide-react';
import { callingModeApi, type CallingMode } from '@/lib/crm';
import { toast } from '@/lib/toast';

function msgOf(err: unknown, fallback: string): string {
  const m = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(m)) return String(m[0]);
  return typeof m === 'string' && m ? m : fallback;
}

/**
 * Calling Mode (admin) — the switch that puts the CRM into lead-processing mode.
 *
 * Turning calling off stops the CRM placing any call: the Quo handoff, the
 * queue's auto-dial and every dial button go quiet, and the API refuses to start
 * a call even if an old tab asks. What keeps working is everything else — the
 * queue order, the lead card, outcomes, notes, save-and-advance — so a team can
 * work through leads without dialling. Nothing is removed: this toggle is the
 * whole mechanism, and flipping it back restores calling immediately.
 */
export function CallingModeSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['calling-mode'], queryFn: callingModeApi.get });
  const [form, setForm] = useState<CallingMode | null>(null);

  useEffect(() => {
    if (data && !form) setForm(data);
  }, [data, form]);

  const save = useMutation({
    mutationFn: () => callingModeApi.save(form!),
    onSuccess: (next) => {
      setForm(next);
      qc.setQueryData(['calling-mode'], next);
      // Every Call button in the app reads this — make them re-read it now.
      qc.invalidateQueries({ queryKey: ['calling-mode'] });
      toast.success(next.callingEnabled ? 'Calling enabled' : 'Calling disabled — the queue keeps working');
    },
    onError: (err) => toast.error(msgOf(err, 'Could not save the calling mode.')),
  });

  if (isLoading || !form) {
    return <div className="rounded-2xl border bg-card p-[18px] text-sm text-muted-foreground shadow-sm">Loading calling mode…</div>;
  }

  const disabled = !form.callingEnabled;

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-[18px] py-4">
        {disabled ? <PhoneOff className="h-4 w-4 text-[var(--tone-red-fg-2)]" /> : <ListChecks className="h-4 w-4 text-primary" />}
        <div>
          <h3 className="font-display text-[14px] font-semibold">Calling Mode</h3>
          <div className="text-xs text-muted-foreground">Temporarily process the queue without placing calls</div>
        </div>
      </div>

      <div className="space-y-[18px] p-[18px]">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setForm({ ...form, callingEnabled: !e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
          />
          <span>
            <span className="block text-[13px] font-semibold">Disable calling (lead-processing mode)</span>
            <span className="block text-[11.5px] text-muted-foreground">
              Stops every outgoing call, the Quo app handoff and the queue&apos;s auto-dial, and hides the in-call
              controls. Agents keep working the same queue: review the lead, log the outcome and notes, save, and the
              next lead loads automatically. Incoming calls still ring in Quo as normal.
            </span>
          </span>
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-xs font-semibold">Message shown to agents</span>
          <input
            value={form.disabledReason}
            onChange={(e) => setForm({ ...form, disabledReason: e.target.value })}
            maxLength={300}
            placeholder="Calling is temporarily disabled — process the queue and save your notes as usual."
            className="w-full rounded-md border bg-background px-3 py-2 outline-none focus:border-primary"
          />
          <span className="block text-[11px] text-muted-foreground">
            Appears on the Calling Panel and the dial pad, where the call controls used to be.
          </span>
        </label>

        {disabled && (
          <p className="rounded-lg bg-[var(--tone-amber-bg)] px-3 py-2.5 text-[12px] text-[#8a6d1f]">
            No calls are being placed anywhere in the CRM. Calls made figures will stay flat for as long as this is on —
            leads worked in this mode are recorded against the lead, not as calls.
          </p>
        )}

        <div className="flex justify-end">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {save.isPending ? 'Saving…' : 'Save calling mode'}
          </button>
        </div>
      </div>
    </div>
  );
}
