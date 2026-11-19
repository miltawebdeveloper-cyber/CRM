import { afterEach, describe, expect, it } from '@jest/globals';
import { businessDate, getBusinessTimezone, setBusinessTimezone } from './business-day';

/**
 * The browser's "Today" has to ask for the day the API counts as today. These
 * pin that the date comes from the business zone the API reports — not from
 * the browser's own clock — and that a bad value can't knock it over.
 */
describe('business day', () => {
  afterEach(() => setBusinessTimezone('America/New_York'));

  // 2026-08-14 00:30 IST — India is on the 14th, New York still on the 13th.
  const indianMidnightPassed = new Date('2026-08-13T19:00:00Z');

  it('defaults to Eastern, matching the API default', () => {
    expect(getBusinessTimezone()).toBe('America/New_York');
    expect(businessDate(indianMidnightPassed)).toBe('2026-08-13');
  });

  it('follows the zone /auth/me reports', () => {
    setBusinessTimezone('Asia/Kolkata');
    expect(businessDate(indianMidnightPassed)).toBe('2026-08-14');
  });

  it('ignores a zone the browser cannot use, and non-strings', () => {
    setBusinessTimezone('Not/AZone');
    setBusinessTimezone(undefined);
    setBusinessTimezone(42);
    expect(getBusinessTimezone()).toBe('America/New_York');
  });
});
