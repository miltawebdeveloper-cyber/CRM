import { canAccessPath, type Role } from './nav';
import { leadListHref } from './lead-list-filters';
import type { DateFilterValue } from './date-filters';

/**
 * Where each dashboard card and list leads when clicked.
 *
 * Kept in one place, and out of the page, so the rules are easy to check:
 *  • A card links only to a list that shows the thing it counts. "Converted"
 *    (interested + onboarding) and "Conversion Rate" have no such list, so they
 *    stay plain numbers rather than opening something that disagrees with them.
 *  • A link appears only for a role that may open its page — an employee's
 *    Total goes to their own Lead Management, a manager's to the Lead Library,
 *    and Missed Calls links only for managers (Communications is theirs).
 *  • Lead-list links carry the dashboard's date range, so a card counting this
 *    week's leads opens this week's leads.
 */
export interface DashboardLinks {
  totalLeads?: string;
  unassignedLeads?: string;
  assignedLeads?: string;
  contactedLeads?: string;
  balanceLeads?: string;
  followUpLeads?: string;
  onboardingLeads?: string;
  perEmployee?: string;
  /** The dashboard's "Team today" leaderboard — Call Summary shows the same per-rep figures in full. */
  teamToday?: string;
  calls?: string;
  missedCalls?: string;
  meetings?: string;
  callbacks?: string;
  targets?: string;
  widgets: {
    callbacks?: string;
    tasks?: string;
    followUps?: string;
    missedCalls?: string;
    todaysLeads?: string;
    closed?: string;
  };
  /**
   * Today's work — the employee's "My day" row and the manager's unassigned
   * alert. These never carry the dashboard's date range: they are about now,
   * whatever period the cards are looking at.
   */
  today: {
    followUpToday?: string;
    followUpOverdue?: string;
    neverContacted?: string;
    unassignedPool?: string;
  };
}

export function dashboardLinks({ role, dateFilter, today }: { role?: Role; dateFilter: DateFilterValue; today: string }): DashboardLinks {
  const can = (href: string) => (role && canAccessPath(href.split('?')[0], role) ? href : undefined);
  // The whole book lives in the Lead Library, which only managers may open; an
  // employee's whole book is their own Lead Management.
  const book = can('/lead-library') ? '/lead-library' : '/leads';
  const leads = (base: string, patch: Parameters<typeof leadListHref>[1] = {}) => can(leadListHref(base, { dateFilter, ...patch }));

  return {
    totalLeads: leads(book),
    unassignedLeads: leads('/lead-library', { ownership: 'unassigned' }),
    assignedLeads: leads('/leads'),
    contactedLeads: leads('/leads', { contact: 'contacted' }),
    // Assigned minus contacted — exactly the "Never contacted" chip.
    balanceLeads: leads('/leads', { contact: 'never' }),
    followUpLeads: can('/followups'),
    onboardingLeads: can('/closed-leads'),
    perEmployee: can('/productivity'),
    teamToday: can('/call-summary'),
    calls: can('/communications') ?? can('/activity'),
    missedCalls: can('/communications'),
    meetings: can('/zoom'),
    callbacks: can('/followups'),
    targets: can('/targets'),
    widgets: {
      callbacks: can('/followups'),
      tasks: can('/tasks'),
      followUps: can('/followups'),
      missedCalls: can('/communications'),
      // Today on the business calendar — the day the widget itself asks for.
      todaysLeads: can(leadListHref(book, { dateFilter: { mode: 'day', from: today, to: today } })),
      closed: can('/closed-leads'),
    },
    today: {
      followUpToday: can(leadListHref('/leads', { followUp: 'today' })),
      followUpOverdue: can(leadListHref('/leads', { followUp: 'overdue' })),
      neverContacted: can(leadListHref('/leads', { contact: 'never' })),
      unassignedPool: can(leadListHref('/lead-library', { ownership: 'unassigned' })),
    },
  };
}
