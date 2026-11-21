import { describe, expect, it } from '@jest/globals';
import { dashboardLinks } from './dashboard-links';
import { EMPTY_DATE_FILTER } from './date-filters';

const TODAY = '2026-11-20';

describe('dashboardLinks', () => {
  it('sends a manager to the whole book, with each card on its own filter', () => {
    const l = dashboardLinks({ role: 'admin', dateFilter: EMPTY_DATE_FILTER, today: TODAY });
    expect(l.totalLeads).toBe('/lead-library?all=1');
    expect(l.unassignedLeads).toBe('/lead-library?owner=unassigned');
    expect(l.assignedLeads).toBe('/leads?all=1');
    expect(l.contactedLeads).toBe('/leads?contact=contacted');
    expect(l.balanceLeads).toBe('/leads?contact=never');
    expect(l.calls).toBe('/communications');
    expect(l.missedCalls).toBe('/communications');
    expect(l.targets).toBe('/targets');
    expect(l.teamToday).toBe('/call-summary');
    expect(l.widgets.todaysLeads).toBe(`/lead-library?date=day&from=${TODAY}&to=${TODAY}`);
  });

  it("keeps an employee inside their own pages and links nothing they can't open", () => {
    const l = dashboardLinks({ role: 'employee', dateFilter: EMPTY_DATE_FILTER, today: TODAY });
    expect(l.totalLeads).toBe('/leads?all=1');
    expect(l.unassignedLeads).toBeUndefined();
    expect(l.missedCalls).toBeUndefined();
    expect(l.perEmployee).toBeUndefined();
    expect(l.targets).toBeUndefined();
    expect(l.calls).toBe('/activity');
    expect(l.followUpLeads).toBe('/followups');
    expect(l.widgets.todaysLeads).toBe(`/leads?date=day&from=${TODAY}&to=${TODAY}`);
  });

  it("carries the dashboard's date range to the lead lists", () => {
    const l = dashboardLinks({ role: 'team_leader', dateFilter: { mode: 'custom', from: '2026-11-01', to: '2026-11-19' }, today: TODAY });
    expect(l.contactedLeads).toBe('/leads?contact=contacted&date=custom&from=2026-11-01&to=2026-11-19');
    // Pages that aren't lead lists don't take the range.
    expect(l.onboardingLeads).toBe('/closed-leads');
  });

  it('links nothing before the role is known', () => {
    const l = dashboardLinks({ role: undefined, dateFilter: EMPTY_DATE_FILTER, today: TODAY });
    expect(l.totalLeads).toBeUndefined();
    expect(l.widgets.tasks).toBeUndefined();
  });

  it("points today's work at today, whatever range the cards are on", () => {
    const l = dashboardLinks({ role: 'employee', dateFilter: { mode: 'custom', from: '2026-10-01', to: '2026-10-31' }, today: TODAY });
    expect(l.today.followUpOverdue).toBe('/leads?followup=overdue');
    expect(l.today.neverContacted).toBe('/leads?contact=never');
    expect(l.today.unassignedPool).toBeUndefined();
    const m = dashboardLinks({ role: 'admin', dateFilter: { mode: 'custom', from: '2026-10-01', to: '2026-10-31' }, today: TODAY });
    expect(m.today.unassignedPool).toBe('/lead-library?owner=unassigned');
  });
});
