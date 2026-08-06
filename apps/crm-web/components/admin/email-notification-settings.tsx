'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Plus, Trash2, Check } from 'lucide-react';
import { notificationsApi, type CallbackEmailType, type EmailSettings } from '@/lib/crm';

const TYPE_LABELS: { key: CallbackEmailType; label: string; desc: string }[] = [
  { key: 'callback_reminder', label: 'Upcoming Callback Reminder', desc: 'Sent ~1 day before a scheduled callback' },
  { key: 'callback_due', label: 'Callback Due Today', desc: 'Sent when a callback becomes due' },
  { key: 'callback_missed', label: 'Missed Callback Notification', desc: 'Sent when a callback is not completed in time' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`relative h-6 w-[42px] shrink-0 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-[var(--brand-line)]'}`}
      aria-pressed={on}
    >
      <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${on ? 'left-[21px]' : 'left-[3px]'}`} />
    </button>
  );
}

export function EmailNotificationSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['email-settings'], queryFn: notificationsApi.getEmailSettings, retry: false });

  const [recipients, setRecipients] = useState<string[]>([]);
  const [types, setTypes] = useState<Record<CallbackEmailType, boolean>>({
    callback_reminder: true,
    callback_due: true,
    callback_missed: true,
  });
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState('');

  // Hydrate local form from the server once loaded.
  useEffect(() => {
    if (data) {
      setRecipients(data.recipients);
      setTypes(data.types);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (s: EmailSettings) => notificationsApi.updateEmailSettings(s),
    onSuccess: (saved) => qc.setQueryData(['email-settings'], saved),
  });

  function addEmail() {
    const e = newEmail.trim().toLowerCase();
    if (!e) return;
    if (!EMAIL_RE.test(e)) return setError('Enter a valid email address.');
    if (recipients.includes(e)) return setError('That address is already on the list.');
    setRecipients((r) => [...r, e]);
    setNewEmail('');
    setError('');
  }

  function removeEmail(e: string) {
    setRecipients((r) => r.filter((x) => x !== e));
  }

  const dirty =
    !!data &&
    (JSON.stringify(recipients) !== JSON.stringify(data.recipients) ||
      JSON.stringify(types) !== JSON.stringify(data.types));

  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-[18px] py-4">
        <Mail className="h-4 w-4 text-[var(--brand)]" />
        <div>
          <h3 className="font-display text-[14px] font-semibold">Email Notification Settings</h3>
          <div className="text-xs text-muted-foreground">Recipients & types for callback emails — editable without code changes</div>
        </div>
      </div>

      <div className="space-y-5 p-[18px]">
        {/* Recipients */}
        <div>
          <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.06em] text-muted-foreground">Recipients</div>
          <div className="space-y-2">
            {recipients.map((e) => (
              <div key={e} className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-[12.5px]">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 font-medium">{e}</span>
                <button type="button" onClick={() => removeEmail(e)} className="text-muted-foreground hover:text-[#9e2b21]" aria-label={`Remove ${e}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {recipients.length === 0 && !isLoading && (
              <p className="text-[12.5px] text-muted-foreground">No recipients yet. The assigned user is always notified; add managers/admins below.</p>
            )}
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => { setNewEmail(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEmail(); } }}
              placeholder="manager@company.com"
              className="min-w-[220px] flex-1 rounded-md border bg-background px-3 py-2 text-[12.5px] outline-none"
            />
            <button type="button" onClick={addEmail} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted/50">
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          </div>
          {error && <p className="mt-1.5 text-[11.5px] font-medium text-[#9e2b21]">{error}</p>}
        </div>

        {/* Type toggles */}
        <div>
          <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-[.06em] text-muted-foreground">Notification Types</div>
          {TYPE_LABELS.map(({ key, label, desc }) => (
            <div key={key} className="flex items-center justify-between gap-4 border-b py-3 last:border-0">
              <div>
                <div className="text-[13px] font-semibold">{label}</div>
                <div className="text-[12px] text-muted-foreground">{desc}</div>
              </div>
              <Toggle on={types[key]} onChange={(v) => setTypes((t) => ({ ...t, [key]: v }))} />
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate({ recipients, types })}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            <Check className="h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
          {save.isSuccess && !dirty && <span className="text-[12px] font-medium text-[var(--brand-strong)]">Saved.</span>}
          {save.isError && <span className="text-[12px] font-medium text-[#9e2b21]">Failed to save.</span>}
        </div>
      </div>
    </div>
  );
}
