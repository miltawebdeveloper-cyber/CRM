import { movementLabel, type Lead } from './leads';
import { leadDate, leadDateTime } from './timezone';

/**
 * The Lead Management export — its columns, and how a lead fills them.
 *
 * A LIST of headers beside a LIST of values is a shape with one failure mode,
 * and it is silent: insert a column in one and not the other, and every field
 * after it lands under the wrong heading. Nothing throws, the file opens, and
 * the phone numbers are in the Email column. So the two live here as a pair,
 * next to each other, with a test that walks them together — rather than a
 * hundred lines apart inside a component where nothing can check them.
 *
 * Both of the module's dates are exported, named for what they are. A file
 * holding only "Created Date" cannot answer the question these exports get
 * pulled for — which leads are on today's list, and how long each has been going
 * round — because a lead carried forward for a fortnight carries a created date
 * a fortnight old and nothing to say it is still live work. Scheduled Date says
 * which day it is on now; Movement says how it got there and how many times.
 *
 * Dates are written as readable text, not as ISO: this file is opened in Excel
 * by the people who asked for it, not parsed by a machine.
 *
 * And every one of them is written on the LEAD's clock, not the exporter's. A
 * file pulled from Chennai used to state American leads' timestamps in IST,
 * which shifts a US afternoon onto the following DATE — so the created dates
 * disagreed with the CRM, and the exported day a lead was scheduled for was
 * routinely a day out. The Time Zone column travels with them, so a row always
 * says which clock its dates are on.
 */
const COLUMNS: ReadonlyArray<{ header: string; value: (lead: Lead) => string | number }> = [
  { header: 'Lead ID', value: (l) => l.leadId },
  { header: 'Lead Generation ID', value: (l) => l.leadGenerationId ?? '' },
  { header: 'Created Date', value: (l) => leadDate(l.createdAt, l.timezone, '') },
  // The original creation stamp, unchanged by every reassignment and every
  // next-day move the Movement column reports.
  { header: 'Created Date & Time', value: (l) => leadDateTime(l.createdAt, l.timezone, '') },
  { header: 'Scheduled Date', value: (l) => leadDate(l.assignedAt, l.timezone, '') },
  { header: 'Movement', value: (l) => movementLabel(l) },
  { header: 'Times Moved to Next Day', value: (l) => l.carriedForwardCount ?? 0 },
  { header: 'Lead Source', value: (l) => l.leadSource ?? '' },
  { header: 'Company Name', value: (l) => l.businessName },
  { header: 'Contact Person', value: (l) => l.contactName ?? '' },
  { header: 'Designation', value: (l) => l.contactName2 ?? '' },
  { header: 'Phone', value: (l) => l.phone },
  { header: 'Alt Phone', value: (l) => l.altPhone ?? '' },
  { header: 'Email', value: (l) => l.email ?? '' },
  { header: 'Website', value: (l) => l.website ?? '' },
  { header: 'Social Media', value: (l) => l.socialMedia ?? '' },
  { header: 'Country', value: (l) => l.country ?? '' },
  { header: 'State', value: (l) => l.state },
  { header: 'City', value: (l) => l.city },
  { header: 'Time Zone', value: (l) => l.timezone ?? '' },
  { header: 'Industry', value: (l) => l.industry ?? '' },
  { header: 'Company Size', value: (l) => l.companySize ?? '' },
  { header: 'Founded Year', value: (l) => l.foundedYear ?? '' },
  { header: 'Address', value: (l) => l.address ?? '' },
  { header: 'Assigned To', value: (l) => l.assignedTo?.name ?? '' },
  { header: 'Call Status', value: (l) => l.callStatus ?? '' },
  // To the minute, matching the grid — the file is read away from the screen
  // that produced it, so a column that says something different there is worse
  // than useless. See the note on those columns in the Lead Management page.
  { header: 'First Contact', value: (l) => leadDateTime(l.firstContact, l.timezone, '') },
  { header: 'Last Contact', value: (l) => leadDateTime(l.lastContact, l.timezone, '') },
  { header: 'Next Follow-up', value: (l) => leadDateTime(l.nextFollowUpDate, l.timezone, '') },
  { header: 'Follow-up Count', value: (l) => l.followupCount ?? '' },
  /**
   * When the lead's next Zoom meeting is, to the minute.
   *
   * Fed by the meetings themselves: scheduling one writes it, rescheduling moves
   * it, cancelling or completing it moves on to the next pending meeting or
   * clears it. It used to be a lead-sheet field only, so a Zoom booked through
   * the CRM never appeared in the grid or the file at all.
   *
   * Emphatically NOT the same column as Next Follow-up, and the two are never
   * written from each other: a meeting and a follow-up call are separate
   * commitments to the customer, and a file that conflated them would show a
   * callback on a lead that was only ever booked for a Zoom.
   */
  { header: 'Meeting Date & Time', value: (l) => leadDateTime(l.meetingDate, l.timezone, '') },
  { header: 'Lost Reason', value: (l) => l.lostReason ?? '' },
  { header: 'Comments', value: (l) => l.comments ?? '' },
];

/** Column headings, in file order. */
export const EXPORT_HEADERS: string[] = COLUMNS.map((c) => c.header);

/** One row per lead, in the same order as `EXPORT_HEADERS`, by construction. */
export const exportRows = (rows: Lead[]): (string | number)[][] =>
  rows.map((lead) => COLUMNS.map((c) => c.value(lead)));

/** A named column's position, for tests and for anything that has to find one. */
export const exportColumnIndex = (header: string): number => EXPORT_HEADERS.indexOf(header);
