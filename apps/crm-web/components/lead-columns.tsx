'use client';

import Link from 'next/link';
import { Eye, Info, Lock, Phone } from 'lucide-react';
import { movementLabel, type Lead } from '@/lib/leads';
import { leadDate, leadDateTime, zoneNote } from '@/lib/timezone';
import { type ColumnDef } from '@/components/data-table';
import { Avatar } from '@/components/page-head';
import { TimezoneChip } from '@/components/timezone-chip';
import { LeadOutcomeCell } from '@/components/lead-outcome-cell';
import { LeadCommentCell } from '@/components/lead-comment-cell';
import { LeadInlineCell } from '@/components/lead-inline-cell';

/**
 * The lead grid's columns — ONE definition, shared by Lead Library and Lead
 * Management.
 *
 * The two pages used to carry their own copy of these ~30 columns, line for
 * line, so every column change had to be made twice and the copies had already
 * drifted (the history button existed on one page only). The pages differ in
 * what they DO with a lead, not in what a lead looks like, so the differences
 * are passed in as `LeadColumnOptions` and everything else lives here.
 *
 * Keys are load-bearing and must not be renamed: each user's saved column
 * layout (`useColumnPrefs`) is keyed by them, and a sortable column's key is
 * the field name the API orders by.
 */
/**
 * Per-row links to a lead's page are NOT prefetched (`prefetch={false}`).
 * `next/link` prefetches every link that scrolls into view, and a grid holds
 * hundreds of leads, each its own dynamic URL — that would be hundreds of
 * background requests for pages nobody may open. The lead page's loading
 * boundary (`leads/[id]/loading.tsx`) makes the click itself feel immediate.
 */
const leadHref = (l: Lead) => `/leads/${l.id}`;

export interface LeadColumnOptions {
  /**
   * Call. Omitted while calling is disabled — a Call button that can't call is
   * worse than no button. The row's View action still opens the lead.
   */
  onCall?: (lead: Lead) => void;
  /**
   * The history drawer (ownership trail + activity log). Omitted for roles the
   * history endpoint refuses — it is Admin + Team Leader only.
   */
  onHistory?: (lead: Lead) => void;
  /**
   * Whether Lost Reason edits in place. It saves through the lead PATCH, which is
   * Admin + Team Leader only, so for anyone else it must render read-only or the
   * cell offers an edit that ends in a 403.
   */
  canEditLostReason: boolean;
}

const ACTION_BTN =
  'grid h-[30px] w-[30px] place-items-center rounded-lg border text-[var(--brand-deep)] hover:bg-primary hover:text-primary-foreground dark:text-foreground';

export function leadColumns({ onCall, onHistory, canEditLostReason }: LeadColumnOptions): ColumnDef<Lead>[] {
  return [
    // The order the leads arrived in, and the grid's default sort. Hidden by
    // default — it is the order the rows are already in, so it earns its space
    // only when someone wants to see or re-apply the position explicitly.
    {
      key: 'importSeq', header: 'Import Order', defaultHidden: true, sortable: true,
      cellClassName: 'tabular-nums text-muted-foreground',
      sortValue: (l) => l.importSeq,
      render: (l) => l.importSeq,
    },
    {
      // Pinned leftmost: the Lead ID identifies the row, so it stays the first
      // thing on it whatever else a user rearranges. `importSeq` above is hidden
      // by default and sorts behind this when shown.
      key: 'leadId', header: 'Lead ID', required: true, pinFirst: true, searchable: true, sortable: true,
      searchValue: (l) => l.leadId,
      // A real link, like Company Name: one click opens the lead, Ctrl/⌘-click
      // opens it in a new tab. The row itself can't be the link — a plain click
      // on a row already ticks it (that is how drag-select starts), and the
      // drag ignores presses that land on a link.
      render: (l) => (
        <Link href={leadHref(l)} prefetch={false} title={`Open ${l.leadId}`} className="group/link flex items-center gap-[10px]">
          <Avatar name={l.leadId} />
          <span className="font-mono text-[11px] text-muted-foreground group-hover/link:text-primary group-hover/link:underline">{l.leadId}</span>
        </Link>
      ),
    },
    { key: 'leadGenerationId', header: 'Lead Generation ID', cellClassName: 'text-muted-foreground', render: (l) => l.leadGenerationId ?? '—', searchable: true, sortable: true, searchValue: (l) => l.leadGenerationId },
    /**
     * The original creation stamp, to the minute.
     *
     * This is where the module's plain "Created Date" column used to be, and it
     * has taken that column's place: the date-only version was WITHDRAWN
     * TEMPORARILY rather than kept alongside, because the two showed the same
     * instant and the grid is wide enough already. Restoring it is one line —
     * `{ key: 'createdDate', header: 'Created Date', … formatDate(l.createdAt) }`
     * back in front of this one. The export still writes both.
     *
     * The date alone was never enough for the question this answers. A lead
     * reassigned in the afternoon, or carried into the next day, is
     * indistinguishable on the date from one created that morning. The time is
     * the evidence that the record is the ORIGINAL — and it survives every
     * reassignment and every next-day move, because nothing in the CRM writes
     * `createdAt` after the lead is created.
     *
     * `key` is `createdAt` deliberately: the grid sends the column key as the
     * server's sort field, and that is the column the server orders by.
     */
    {
      key: 'createdAt', header: 'Created Date & Time', width: 170, sortable: true,
      cellClassName: 'text-muted-foreground whitespace-nowrap',
      searchable: true,
      searchValue: (l) => leadDateTime(l.createdAt, l.timezone, ''),
      render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.createdAt, l.timezone)}</span>,
    },
    /**
     * The other half of the pair: the day this lead is currently scheduled to be
     * worked, taken from its active assignment.
     *
     * Distinct from Created Date & Time in exactly the way the two dates are
     * distinct. A lead created on the 1st, never finished, and carried forward
     * every night reads "Jan 1, 09:14" beside today's date — one row saying both
     * how old the lead is and that it is on today's queue. Before this pair
     * existed the grid could only show the first, so a carried lead looked like
     * a stale one nobody had scheduled.
     */
    {
      key: 'scheduledDate', header: 'Scheduled Date', width: 150,
      cellClassName: 'text-muted-foreground whitespace-nowrap',
      trackable: true,
      render: (l) => <span title={zoneNote(l.timezone)}>{leadDate(l.assignedAt, l.timezone)}</span>,
    },
    /**
     * How the lead came to be on that date — assigned, handed over, or moved
     * forward, with the number of times it has been moved.
     *
     * Hidden by default: it is a diagnosis column, wanted when a manager is
     * asking why a lead is still open rather than on every screen.
     */
    {
      key: 'movement', header: 'Movement', width: 190, defaultHidden: true,
      cellClassName: 'text-muted-foreground',
      searchable: true,
      searchValue: (l) => movementLabel(l),
      render: (l) => movementLabel(l) || '—',
    },
    { key: 'leadSource', header: 'Lead Source', cellClassName: 'text-muted-foreground', render: (l) => l.leadSource ?? '—', searchable: true, sortable: true, searchValue: (l) => l.leadSource },
    {
      key: 'businessName', header: 'Company Name', searchable: true, sortable: true, searchValue: (l) => l.businessName,
      render: (l) => (
        <Link href={leadHref(l)} prefetch={false} className="font-medium hover:text-primary hover:underline">
          {l.businessName || 'Unnamed lead'}
        </Link>
      ),
    },
    { key: 'contactName', header: 'Contact Person', render: (l) => l.contactName ?? '—', searchable: true, sortable: true, searchValue: (l) => l.contactName },
    { key: 'contactName2', header: 'Designation', render: (l) => l.contactName2 ?? '—', searchable: true, sortable: true, searchValue: (l) => l.contactName2 },
    { key: 'phone', header: 'Phone', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', render: (l) => l.phone, searchable: true, sortable: true, searchValue: (l) => l.phone },
    { key: 'altPhone', header: 'Alt Phone', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', render: (l) => l.altPhone ?? '—', searchable: true, sortable: true, searchValue: (l) => l.altPhone },
    { key: 'email', header: 'Email', cellClassName: 'text-muted-foreground', render: (l) => l.email ?? '—', searchable: true, sortable: true, searchValue: (l) => l.email },
    { key: 'website', header: 'Website', cellClassName: 'text-muted-foreground', render: (l) => l.website ?? '—', searchable: true, sortable: true, searchValue: (l) => l.website },
    { key: 'socialMedia', header: 'Social Media', cellClassName: 'text-muted-foreground', render: (l) => l.socialMedia ?? '—', searchable: true, sortable: true, searchValue: (l) => l.socialMedia },
    { key: 'country', header: 'Country', cellClassName: 'text-muted-foreground', render: (l) => l.country ?? '—', searchable: true, sortable: true, searchValue: (l) => l.country },
    { key: 'state', header: 'State', cellClassName: 'text-muted-foreground', render: (l) => l.state, searchable: true, sortable: true, searchValue: (l) => l.state },
    { key: 'city', header: 'City', cellClassName: 'text-muted-foreground', render: (l) => l.city, searchable: true, sortable: true, searchValue: (l) => l.city },
    // A lead with no zone is called out rather than shown as an empty chip: it
    // is the one state that blocks scheduling a callback, so the list is where
    // someone notices and fixes it.
    { key: 'tz', header: 'Time Zone', render: (l) => <TimezoneChip tz={l.timezone} /> },
    { key: 'industry', header: 'Industry', cellClassName: 'text-muted-foreground', render: (l) => l.industry ?? '—', searchable: true, sortable: true, searchValue: (l) => l.industry },
    { key: 'companySize', header: 'Company Size', cellClassName: 'text-muted-foreground', render: (l) => l.companySize ?? '—', searchable: true, sortable: true, searchValue: (l) => l.companySize },
    { key: 'foundedYear', header: 'Founded Year', cellClassName: 'text-muted-foreground', render: (l) => l.foundedYear ?? '—', searchable: true, sortable: true, searchValue: (l) => l.foundedYear },
    { key: 'address', header: 'Address', cellClassName: 'text-muted-foreground max-w-[200px] truncate', render: (l) => l.address ?? '—', searchable: true, sortable: true, searchValue: (l) => l.address },
    // An owned lead is called out with a badge, not just a name: a lead has
    // exactly one owner, and the assign dialog leaves owned leads out unless a
    // manager deliberately transfers them, so who holds it has to be obvious at
    // a glance.
    {
      key: 'caller',
      header: 'Assigned To',
      render: (l) =>
        l.assignedTo ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-surface)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--brand-on-surface)]">
            <Lock className="h-3 w-3" /> {l.assignedTo.name}
          </span>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
      searchable: true,
      trackable: true,
      searchValue: (l) => l.assignedTo?.name,
    },
    {
      key: 'callStatus',
      header: 'Call Outcome',
      // Editable in place: one click opens the configured outcome list and the
      // pick saves straight away, so a mis-dispositioned lead is corrected from
      // the row instead of a round trip through the Edit Lead page.
      render: (l) => <LeadOutcomeCell lead={l} />,
      searchable: true,
      sortable: true,
      searchValue: (l) => l.callStatus,
    },
    // Every date on this row belongs to the lead, so every one of them is read
    // on the lead's clock — including the follow-up, which is an hour agreed
    // with the customer and is the one it would be most damaging to state on
    // anybody else's.
    /**
     * The three contact stamps, to the minute.
     *
     * They carry a time now because the calling flow writes one: a disposition
     * records the instant it happened, and a booked callback is an hour agreed
     * with the customer. Shown to the day these read as three identical dates on
     * a lead called three times in an afternoon, and Next Follow-up — the one
     * somebody acts on — loses the only part of it that says when to ring.
     *
     * A lead whose values came from the import shows midnight, which is what its
     * sheet actually said.
     */
    { key: 'firstContact', header: 'First Contact', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.firstContact, l.timezone)}</span> },
    { key: 'lastContact', header: 'Last Contact', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.lastContact, l.timezone)}</span> },
    { key: 'followup', header: 'Next Follow-up', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.nextFollowUpDate, l.timezone)}</span>, trackable: true },
    // Counts the follow-ups actually MADE — a call that answered one an earlier
    // call booked. Written by the calling flow, so it climbs on its own; see the
    // contact-tracking block in the API's `applyDisposition`.
    { key: 'followupCount', header: 'Follow-up Count', cellClassName: 'text-muted-foreground tabular-nums', render: (l) => l.followupCount ?? '—' },
    // Requested tail order: Meeting Date → Comments → Lost Reason → Actions. Comments
    // and Lost Reason both edit in place; Comments also syncs with call notes.
    /**
     * The lead's next Zoom meeting, to the minute.
     *
     * Written by the Zoom module rather than only by the import: booking a
     * meeting sets it, rescheduling moves it, cancelling or completing it moves
     * to the next pending meeting or clears it. A meeting booked through the CRM
     * used to leave this cell empty, so the grid said a lead had no meeting
     * while the calendar had one.
     *
     * Independent of Next Follow-up above, and never written from it. The two
     * answer different questions — when are we meeting them, and when are we
     * ringing them back — and a lead can easily have one and not the other.
     */
    { key: 'meetingDate', header: 'Meeting Date & Time', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.meetingDate, l.timezone)}</span> },
    {
      key: 'comments',
      header: 'Comments',
      width: 240,
      render: (l) => <LeadCommentCell lead={l} />,
      searchable: true,
      trackable: true,
      sortable: true,
      searchValue: (l) => l.comments,
    },
    {
      key: 'lostReason',
      header: 'Lost Reason',
      width: 200,
      // A rep's rejecting disposition still fills it (see `applyDisposition`),
      // whether or not they may edit it here.
      render: (l) => <LeadInlineCell lead={l} field="lostReason" placeholder="Add a reason…" readOnly={!canEditLostReason} />,
      searchable: true,
      trackable: true,
      sortable: true,
      searchValue: (l) => l.lostReason,
    },
    {
      key: 'actions', header: '', required: true,
      render: (l) => (
        <div className="flex items-center gap-1.5">
          {/* Always at full strength: the ownership trail is the question this
              grid is most often opened to answer — who has this lead, and how
              did it get to them. */}
          {onHistory && (
            <button
              onClick={() => onHistory(l)}
              title="Lead history"
              aria-label={`History of ${l.businessName}`}
              className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[var(--tone-blue-line)] bg-[var(--tone-blue-bg-2)] text-[var(--tone-blue-fg-2)] hover:bg-[#2D8CFF] hover:text-white"
            >
              <Info className="h-[15px] w-[15px]" />
            </button>
          )}
          <div className="flex gap-1.5 opacity-50 transition-opacity group-hover:opacity-100">
            {onCall && (
              <button onClick={() => onCall(l)} title="Call" aria-label={`Call ${l.businessName}`} className={ACTION_BTN}>
                <Phone className="h-[15px] w-[15px]" />
              </button>
            )}
            {/* A link, so it opens in a new tab like any other — it was a button
                that could only navigate in place. */}
            <Link href={leadHref(l)} prefetch={false} title="View" aria-label={`View ${l.businessName}`} className={ACTION_BTN}>
              <Eye className="h-[15px] w-[15px]" />
            </Link>
          </div>
        </div>
      ),
    },
  ];
}
