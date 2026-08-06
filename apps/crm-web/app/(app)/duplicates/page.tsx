'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, Filter, Loader2, RefreshCw, Search, Trash2, Undo2 } from 'lucide-react';
import { leadsApi, type DuplicateGroup, type DuplicateScanOptions } from '@/lib/leads';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHead } from '@/components/page-head';
import { formatDate } from '@/lib/display-settings';

/** Server message if there is one, else the transport error. */
function errorText(err: unknown): string {
  const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  if (Array.isArray(msg)) return msg.join(', ');
  return msg ?? (err as Error)?.message ?? 'Unknown error.';
}

/** A group's stable identity across re-scans — the lead ids it holds. */
const groupKey = (g: DuplicateGroup) => g.leads.map((l) => l.id).join('|');

export default function DuplicatesPage() {
  const qc = useQueryClient();

  // The scan is not run on arrival. It walks the whole lead book, and a screen
  // that starts a full scan just because someone opened the menu is a screen
  // people learn to avoid.
  const [opts, setOpts] = useState<DuplicateScanOptions>({
    checkFields: ['phone', 'email'],
    ignorePhoneFormatting: false,
    matchCompanyDomain: false,
    matchLocation: false,
  });
  const [ran, setRan] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);

  /** Lead ids marked for removal. Nothing is selected by default — a purge
   *  screen that arrives pre-armed is one misclick from deleting real work. */
  const [doomed, setDoomed] = useState<Set<string>>(new Set());

  const scan = useQuery({
    queryKey: ['lead-duplicates', opts],
    queryFn: () => leadsApi.duplicates(opts),
    enabled: ran,
    retry: false,
    refetchOnWindowFocus: false,
  });

  /**
   * The last batch this screen removed, kept so it can be put back.
   *
   * Held here rather than fetched, because "what did I just do" is a fact about
   * this sitting: it survives a re-scan (which is exactly when someone notices
   * the mistake) and dies with the page, by which time the undo has stopped
   * being an undo and become an edit.
   */
  const [undoable, setUndoable] = useState<{ ids: string[]; count: number } | null>(null);

  const refreshAfterChange = () => {
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    qc.invalidateQueries({ queryKey: ['lead-duplicates'] });
  };

  // Reversible, unlike every other delete in the CRM: the rows are archived, not
  // destroyed, so the bar below can put them back. See archiveMany in the API.
  const purge = useMutation({
    mutationFn: (ids: string[]) => leadsApi.bulkArchive(ids),
    onSuccess: (res) => {
      setDoomed(new Set());
      setUndoable(res.archived > 0 ? { ids: res.ids, count: res.archived } : null);
      refreshAfterChange();
    },
  });

  const undo = useMutation({
    mutationFn: (ids: string[]) => leadsApi.bulkRestore(ids),
    meta: { successMessage: 'Leads restored' },
    onSuccess: () => {
      setUndoable(null);
      refreshAfterChange();
    },
  });

  const groups = useMemo(() => scan.data?.groups ?? [], [scan.data]);
  const doomedCount = doomed.size;

  /** Guard against the one destructive mistake this screen can make: every
   *  record of a group marked for removal, deleting the company outright. */
  const wipedGroups = useMemo(
    () => groups.filter((g) => g.leads.every((l) => doomed.has(l.id))),
    [groups, doomed],
  );

  const toggle = (id: string) =>
    setDoomed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Mark everything a group holds except its suggested keeper. */
  const selectSuggested = () => {
    const next = new Set<string>();
    for (const g of groups) for (const l of g.leads.slice(1)) next.add(l.id);
    setDoomed(next);
  };

  const setField = (field: 'phone' | 'email') =>
    setOpts((prev) => {
      const has = prev.checkFields?.includes(field);
      const next = has ? (prev.checkFields ?? []).filter((f) => f !== field) : [...(prev.checkFields ?? []), field];
      // An empty list means "compare everything" to the API, so refusing the
      // last one is the only way this screen says what it does.
      return next.length === 0 ? prev : { ...prev, checkFields: next };
    });

  const rerun = () => { setDoomed(new Set()); setRan(true); scan.refetch(); };

  return (
    <div>
      <PageHead>
        <button
          onClick={rerun}
          disabled={scan.isFetching}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60"
        >
          {scan.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : ran ? <RefreshCw className="h-4 w-4" /> : <Search className="h-4 w-4" />}
          {scan.isFetching ? 'Scanning…' : ran ? 'Re-scan' : 'Scan for duplicates'}
        </button>
      </PageHead>

      {/* Matching settings — same rule as the import, said the same way. */}
      <div className="rounded-2xl border bg-card p-[18px] shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-primary" />
            <h3 className="font-display text-[14px] font-semibold">What counts as a duplicate</h3>
          </div>
          <span className="text-[11.5px] text-muted-foreground">The same rule the lead import uses</span>
        </div>

        <div className="flex flex-wrap items-center gap-6 pt-1 text-[12.5px]">
          {([
            { field: 'phone' as const, label: 'Phone Number', hint: 'Compared as written, including Alt Phone' },
            { field: 'email' as const, label: 'Email Address', hint: 'Case-insensitive; +tags and Gmail dots ignored' },
          ]).map(({ field, label, hint }) => {
            const on = !!opts.checkFields?.includes(field);
            const locked = on && (opts.checkFields?.length ?? 0) === 1;
            return (
              <label
                key={field}
                title={locked ? 'At least one field has to be compared.' : hint}
                className={`flex items-center gap-2 font-medium ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked}
                  onChange={() => setField(field)}
                  className="h-4 w-4 rounded border-muted-foreground/30 accent-primary disabled:opacity-60"
                />
                <span>{label}</span>
                <span className="text-[11px] font-normal text-muted-foreground">{hint}</span>
              </label>
            );
          })}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5 text-[12px]">
            <input
              type="checkbox"
              checked={!!opts.ignorePhoneFormatting}
              disabled={!opts.checkFields?.includes('phone')}
              onChange={() => setOpts((p) => ({ ...p, ignorePhoneFormatting: !p.ignorePhoneFormatting }))}
              className="mt-0.5 h-4 w-4 rounded border-muted-foreground/30 accent-primary disabled:opacity-50"
            />
            <span>
              <span className="font-medium">Also match numbers written differently</span>
              <span className="block text-[11px] leading-relaxed text-muted-foreground">
                Compares the last 10 digits, so <span className="font-mono">+1 (305) 555-1234</span> and{' '}
                <span className="font-mono">3055551234</span> count as one number.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5 text-[12px]">
            <input
              type="checkbox"
              checked={!!opts.matchCompanyDomain}
              onChange={() => setOpts((p) => ({ ...p, matchCompanyDomain: !p.matchCompanyDomain }))}
              className="mt-0.5 h-4 w-4 rounded border-muted-foreground/30 accent-primary"
            />
            <span>
              <span className="font-medium">Also match the company domain</span>
              <span className="block text-[11px] leading-relaxed text-muted-foreground">
                From the email and the website. Noisier — it groups two{' '}
                <b className="font-semibold">different people</b> at one firm, which is often two real leads. Gmail and
                other mailbox providers are ignored.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5 text-[12px] sm:col-span-2">
            <input
              type="checkbox"
              checked={!!opts.matchLocation}
              onChange={() => setOpts((p) => ({ ...p, matchLocation: !p.matchLocation }))}
              className="mt-0.5 h-4 w-4 rounded border-muted-foreground/30 accent-primary"
            />
            <span>
              <span className="font-medium">Also match company name with city and state</span>
              <span className="block text-[11px] leading-relaxed text-muted-foreground">
                All three together, so <span className="font-mono">Acme Tax · Miami · FL</span> listed twice is one
                firm, while <span className="font-mono">Acme Tax · Austin · TX</span> stays its own lead. Catches the
                same company saved again under a different number. Case, punctuation and{' '}
                <span className="font-mono">Florida</span> vs <span className="font-mono">FL</span> are ignored; records
                missing any of the three are not compared on location at all.
              </span>
            </span>
          </label>
        </div>
      </div>

      {scan.isError && (
        <div className="mt-4 rounded-md bg-[var(--tone-red-bg)] px-4 py-3 text-sm text-[var(--tone-red-fg-2)]">
          Scan failed. {errorText(scan.error)}
        </div>
      )}

      {/* Undo — a bar rather than a toast. This is the one screen in the CRM
          that removes records in bulk on a rule, and the mistake it invites is
          noticed a moment later, on the re-scan: a four-second toast is gone by
          then. It stays until it is used or dismissed, and says what it would
          bring back. */}
      {undoable && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--brand-edge)] bg-[var(--brand-surface)] px-4 py-3">
          <Undo2 className="h-4 w-4 shrink-0 text-[var(--brand-on-surface)]" />
          <span className="flex-1 text-[12.5px] text-[var(--brand-on-surface)]">
            <b className="font-semibold">{undoable.count}</b> {undoable.count === 1 ? 'lead' : 'leads'} removed. They are
            out of the book but not destroyed — their calls, notes and history are intact.
          </span>
          <button
            onClick={() => undo.mutate(undoable.ids)}
            disabled={undo.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60"
          >
            {undo.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
            {undo.isPending ? 'Restoring…' : 'Undo'}
          </button>
          <button
            onClick={() => setUndoable(null)}
            className="rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium hover:bg-muted"
          >
            Dismiss
          </button>
        </div>
      )}

      {!ran && (
        <div className="mt-[18px] rounded-2xl border border-dashed bg-card p-10 text-center">
          <div className="mx-auto mb-3 grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-[var(--brand-surface)] text-[var(--brand-on-surface)]">
            <Copy className="h-6 w-6" />
          </div>
          <div className="font-semibold">Nothing scanned yet</div>
          <p className="mx-auto mt-1 max-w-[520px] text-[12px] leading-relaxed text-muted-foreground">
            Choose what counts as a duplicate above, then run the scan. It reads the whole lead book and changes
            nothing — you pick what to remove afterwards.
          </p>
        </div>
      )}

      {ran && scan.data && (
        <>
          <div className="mt-[18px] flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border bg-card px-[18px] py-3.5 text-[12.5px] shadow-sm">
            <span>Leads scanned: <b className="tabular-nums">{scan.data.scanned.toLocaleString()}</b></span>
            <span>Duplicate groups: <b className="tabular-nums">{scan.data.totalGroups.toLocaleString()}</b></span>
            <span>
              Redundant records:{' '}
              <b className="tabular-nums text-[var(--tone-red-fg)]">{scan.data.redundantLeads.toLocaleString()}</b>
            </span>
            {scan.data.totalGroups > scan.data.returned && (
              <span className="text-muted-foreground">
                showing the largest {scan.data.returned} — clear these and re-scan for the rest
              </span>
            )}
            {groups.length > 0 && (
              <button
                onClick={selectSuggested}
                className="ml-auto rounded-md border bg-card px-3 py-1.5 text-[11.5px] font-semibold hover:bg-muted"
              >
                Mark all but the suggested keeper
              </button>
            )}
          </div>

          {scan.data.totalGroups === 0 && (
            <div className="mt-[18px] rounded-2xl border bg-[var(--brand-surface-2)] p-8 text-center text-sm text-[var(--brand-on-surface)]">
              No duplicates found under these settings.
            </div>
          )}

          <div className="mt-[18px] space-y-[18px]">
            {groups.map((g) => (
              <div key={groupKey(g)} className="overflow-hidden rounded-2xl border bg-card shadow-sm">
                <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-[18px] py-3">
                  <span className="font-display text-[13px] font-semibold">{g.size} matching records</span>
                  {g.matchedOn.map((m) => (
                    <span key={m} className="rounded-full bg-[var(--tone-amber-bg)] px-2.5 py-0.5 text-[10.5px] font-semibold text-[var(--tone-amber-fg-strong)]">
                      {m}
                    </span>
                  ))}
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    Untick the one to keep — ticked records are deleted
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full whitespace-nowrap text-[12px]">
                    <thead>
                      <tr className="border-b text-left text-[10.5px] uppercase tracking-wider text-muted-foreground">
                        <th className="w-[46px] px-[18px] py-2.5 font-semibold">Del</th>
                        <th className="px-3 py-2.5 font-semibold">Lead</th>
                        <th className="px-3 py-2.5 font-semibold">Contact points</th>
                        <th className="px-3 py-2.5 font-semibold">Owner / status</th>
                        <th className="px-3 py-2.5 font-semibold">Created</th>
                        <th className="px-3 py-2.5 font-semibold">Fields filled</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {g.leads.map((l, i) => {
                        const marked = doomed.has(l.id);
                        return (
                          <tr key={l.id} className={marked ? 'bg-[var(--tone-red-bg-2)]' : i === 0 ? 'bg-[var(--brand-surface-2)]/50' : ''}>
                            <td className="px-[18px] py-2.5">
                              <input
                                type="checkbox"
                                checked={marked}
                                onChange={() => toggle(l.id)}
                                aria-label={`Delete ${l.leadId}`}
                                className="h-4 w-4 rounded border-muted-foreground/30 accent-[var(--tone-red-fg)]"
                              />
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1.5 font-semibold">
                                <span className="font-mono text-[11px] text-primary">{l.leadId}</span>
                                <span>{l.businessName || <span className="italic text-muted-foreground">Unnamed</span>}</span>
                                {i === 0 && (
                                  <span className="rounded-full bg-[var(--brand-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--brand-on-surface)]">
                                    suggested keeper
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {[l.contactName, l.city, l.state].filter(Boolean).join(' · ') || '—'}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                              {[l.phone, l.altPhone, l.email, l.website].filter(Boolean).join(' · ') || '—'}
                            </td>
                            <td className="px-3 py-2.5 text-muted-foreground">
                              {l.assignedTo ?? 'Unassigned'} · {l.status}
                            </td>
                            <td className="px-3 py-2.5 text-muted-foreground">{formatDate(l.createdAt)}</td>
                            <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{l.filled} / 10</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Action bar — only once something is actually marked. */}
      {doomedCount > 0 && (
        <div className="sticky bottom-4 mt-[18px] flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--tone-red-line)] bg-card px-[18px] py-3.5 shadow-md">
          <div className="text-[12.5px]">
            <b className="tabular-nums text-[var(--tone-red-fg)]">{doomedCount}</b> record{doomedCount === 1 ? '' : 's'} marked for
            deletion.
            {wipedGroups.length > 0 && (
              <span className="ml-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--tone-amber-bg)] px-2 py-1 text-[11.5px] font-semibold text-[var(--tone-amber-fg-strong)]">
                <AlertTriangle className="h-3.5 w-3.5" />
                {wipedGroups.length} group{wipedGroups.length === 1 ? ' has' : 's have'} every record marked — leave one
                to keep the company.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setDoomed(new Set())} className="rounded-md border bg-card px-3 py-2 text-[12px] font-semibold hover:bg-muted">
              Clear selection
            </button>
            <button
              onClick={() => setConfirmPurge(true)}
              disabled={purge.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--tone-red-fg)] px-4 py-2.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {purge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete {doomedCount} record{doomedCount === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}

      {confirmPurge && (
        <ConfirmDialog
          title="Remove duplicate leads"
          message={
            // Says what actually happens now. Promising permanence when the next
            // screen offers an Undo would teach people to distrust both.
            `${doomedCount} lead${doomedCount === 1 ? '' : 's'} will be taken out of the book, along with their calls, ` +
            `comments and history. Nothing is destroyed — you can undo this straight afterwards.` +
            (wipedGroups.length > 0
              ? ` ${wipedGroups.length} group${wipedGroups.length === 1 ? '' : 's'} would be removed entirely, leaving no record of that company in the book.`
              : '')
          }
          confirmLabel={`Remove ${doomedCount} lead${doomedCount === 1 ? '' : 's'}`}
          onConfirm={async () => { await purge.mutateAsync([...doomed]); await scan.refetch(); }}
          onClose={() => setConfirmPurge(false)}
        />
      )}

      {purge.isError && (
        <div className="mt-4 rounded-md bg-[var(--tone-red-bg)] px-4 py-3 text-sm text-[var(--tone-red-fg-2)]">
          Removal failed — nothing was taken out. {errorText(purge.error)}
        </div>
      )}
    </div>
  );
}
