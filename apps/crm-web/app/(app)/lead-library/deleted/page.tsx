'use client';

import { IconAction } from '@/components/icon-action';
import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';
import { leadsApi, type ArchivedLead } from '@/lib/leads';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/display-settings';
import { useDebounced } from '@/lib/use-debounced';
import { pushToast } from '@/lib/toast';
import { PageHead } from '@/components/page-head';
import { SearchInput } from '@/components/filter-controls';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { ConfirmDialog } from '@/components/confirm-dialog';

const PAGE_SIZE = 100;

/**
 * Recently deleted — the Lead Library's archived leads.
 *
 * The Library's bulk delete (and the Duplicate Leads purge) archive rather than
 * destroy, but until this page there was no way back to an archived lead once
 * the Undo bar was dismissed, and no way to remove one for good either. Here a
 * manager can restore leads — they come back exactly as they were, with their
 * owner, calls, notes and history — and an admin can delete them permanently.
 */
export default function RecentlyDeletedPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 250);
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const isAdmin = me?.role === 'admin';

  const list = useInfiniteQuery({
    queryKey: ['leads', 'archived', debouncedQ],
    queryFn: ({ pageParam, signal }) => leadsApi.archived({ q: debouncedQ, page: pageParam, pageSize: PAGE_SIZE }, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;

  // Restoring or purging changes the book itself, so every view of it refreshes.
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    qc.invalidateQueries({ queryKey: ['assignments-summary'] });
    qc.invalidateQueries({ queryKey: ['caller-leads'] });
    qc.invalidateQueries({ queryKey: ['caller-dash'] });
    qc.invalidateQueries({ queryKey: ['lead-duplicates'] });
  };

  const restore = useMutation({
    mutationFn: (ids: string[]) => leadsApi.bulkRestore(ids),
    onSuccess: (r) => {
      refresh();
      pushToast('success', `Restored ${r.restored.toLocaleString()} lead${r.restored === 1 ? '' : 's'} to the Lead Library`);
    },
  });

  const [purging, setPurging] = useState<{ rows: ArchivedLead[]; clear: () => void } | null>(null);
  const purge = useMutation({
    mutationFn: (ids: string[]) => leadsApi.purgeArchived(ids),
    onSuccess: (r) => {
      refresh();
      pushToast('success', `Permanently deleted ${r.deleted.toLocaleString()} lead${r.deleted === 1 ? '' : 's'}`);
    },
  });

  const columns = useMemo<ColumnDef<ArchivedLead>[]>(
    () => [
      { key: 'leadId', header: 'Lead ID', required: true, cellClassName: 'font-mono text-[11px] text-muted-foreground', render: (l) => l.leadId },
      { key: 'businessName', header: 'Company Name', render: (l) => <span className="font-medium">{l.businessName || 'Unnamed lead'}</span> },
      { key: 'phone', header: 'Phone', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', render: (l) => l.phone || '—' },
      { key: 'email', header: 'Email', cellClassName: 'text-muted-foreground', render: (l) => l.email ?? '—' },
      { key: 'location', header: 'Location', cellClassName: 'text-muted-foreground', render: (l) => [l.city, l.state].filter(Boolean).join(', ') || '—' },
      // Restoring puts the lead back with this person — worth seeing first.
      { key: 'owner', header: 'Assigned To', render: (l) => l.assignedTo?.name ?? <span className="text-muted-foreground">Unassigned</span> },
      { key: 'deletedAt', header: 'Deleted', width: 170, cellClassName: 'whitespace-nowrap text-muted-foreground', render: (l) => formatDateTime(l.deletedAt) },
      { key: 'deletedBy', header: 'Deleted By', render: (l) => l.deletedBy ?? <span className="text-muted-foreground">—</span> },
    ],
    [],
  );

  return (
    <div>
      <PageHead>
        {/* Secondary actions as compact icons (name on hover, focus or tap); the page's main action keeps its text. See components/icon-action. */}
        <IconAction size="md" icon={ArrowLeft} label="Back to Lead Library" href="/lead-library" />
      </PageHead>

      <p className="mb-4 max-w-3xl text-[12.5px] text-muted-foreground">
        Leads deleted from the Lead Library or removed as duplicates. They are out of every list, queue, count and export,
        but nothing about them is lost: restoring one brings it back exactly as it was, with its owner, calls, notes and
        history.{isAdmin ? ' Deleting permanently removes the lead and everything attached to it, and cannot be undone.' : ''}
      </p>

      <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
        <SearchInput value={q} onChange={setQ} placeholder="Search company, Lead ID, phone, email…" className="min-w-[260px] max-w-md flex-1" />
      </div>

      <DataTable
        tableKey="lead-library-deleted"
        columns={columns}
        rows={rows}
        getRowKey={(l) => l.id}
        title="Recently deleted"
        subtitle={
          list.isLoading
            ? 'Loading…'
            : total === 0
              ? 'Nothing deleted'
              : rows.length >= total
                ? `${total.toLocaleString()} lead${total === 1 ? '' : 's'}`
                : `${rows.length.toLocaleString()} of ${total.toLocaleString()} loaded`
        }
        loading={list.isLoading}
        refreshing={list.isFetching && !list.isLoading && !list.isFetchingNextPage}
        emptyText={debouncedQ ? 'No deleted leads match that search.' : 'No deleted leads.'}
        selectable
        dragSelect
        uppercaseHeaders
        bulkActions={(selected, clear) => (
          <>
            <button
              onClick={() => restore.mutate(selected.map((l) => l.id), { onSuccess: clear })}
              disabled={restore.isPending}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" /> {restore.isPending ? 'Restoring…' : 'Restore'}
            </button>
            {isAdmin && (
              <button
                onClick={() => setPurging({ rows: selected, clear })}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--tone-red-line)] bg-card px-2.5 text-[12px] font-semibold text-[var(--tone-red-fg)] hover:bg-[var(--tone-red-bg-2)]"
              >
                <Trash2 className="h-4 w-4" /> Delete permanently
              </button>
            )}
          </>
        )}
      />

      {list.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted disabled:opacity-50"
          >
            {list.isFetchingNextPage ? 'Loading more…' : `Load more (${(total - rows.length).toLocaleString()} left)`}
          </button>
        </div>
      )}

      {purging && (
        <ConfirmDialog
          title={`Delete ${purging.rows.length.toLocaleString()} lead${purging.rows.length === 1 ? '' : 's'} permanently?`}
          message={
            <>
              This removes {purging.rows.length === 1 ? 'the lead' : 'these leads'} and everything attached — calls, recordings,
              notes, follow-ups and history. It cannot be undone, and {purging.rows.length === 1 ? 'it' : 'they'} will not be
              restorable from here.
            </>
          }
          confirmLabel="Delete permanently"
          onConfirm={async () => {
            await purge.mutateAsync(purging.rows.map((l) => l.id));
            purging.clear();
          }}
          onClose={() => setPurging(null)}
        />
      )}
    </div>
  );
}
