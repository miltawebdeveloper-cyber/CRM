import { describe, expect, it } from '@jest/globals';
import { canAccessPath, navForRole, titleForPath } from './nav';

describe('Recently deleted in the nav', () => {
  it('is titled as itself, not as the Lead Library it sits under', () => {
    expect(titleForPath('/lead-library/deleted')).toBe('Recently Deleted');
    expect(titleForPath('/lead-library')).toBe('Lead Library');
  });

  it('keeps the Library’s manager-only rule', () => {
    expect(canAccessPath('/lead-library/deleted', 'admin')).toBe(true);
    expect(canAccessPath('/lead-library/deleted', 'team_leader')).toBe(true);
    expect(canAccessPath('/lead-library/deleted', 'employee')).toBe(false);
  });

  it('stays out of the sidebar', () => {
    const hrefs = navForRole('admin').flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain('/lead-library');
    expect(hrefs).not.toContain('/lead-library/deleted');
  });
});
