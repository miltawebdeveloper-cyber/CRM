import { describe, expect, it } from '@jest/globals';
import { loginUrl, safeReturnPath } from './return-to';

describe('safeReturnPath', () => {
  it('follows a path on this site, query and hash included', () => {
    expect(safeReturnPath('/leads/abc')).toBe('/leads/abc');
    expect(safeReturnPath('/leads?state=TX&followup=overdue#top')).toBe('/leads?state=TX&followup=overdue#top');
  });

  it('refuses anything that could leave the site', () => {
    for (const raw of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', ' /leads', 'leads', 'javascript:alert(1)']) {
      expect(safeReturnPath(raw)).toBeNull();
    }
  });

  it('refuses the login page itself, which would just loop', () => {
    expect(safeReturnPath('/login')).toBeNull();
    expect(safeReturnPath('/login?next=%2Fleads')).toBeNull();
  });

  it('treats nothing as nothing', () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath('')).toBeNull();
  });
});

describe('loginUrl', () => {
  it('carries the page to come back to', () => {
    expect(loginUrl('/leads/abc?x=1')).toBe('/login?next=%2Fleads%2Fabc%3Fx%3D1');
  });

  it('leaves it off when there is nothing worth returning to', () => {
    expect(loginUrl('/')).toBe('/login');
    expect(loginUrl('/login')).toBe('/login');
    expect(loginUrl(undefined)).toBe('/login');
  });
});
