import { describe, expect, it } from '@jest/globals';
import { neutraliseFormula } from './export';

/**
 * CSV exports carry lead data from imports and webhooks. A cell a spreadsheet
 * would evaluate must arrive as text; ordinary numbers and phone numbers must
 * arrive untouched, or every export of the lead book gets mangled.
 */
describe('neutraliseFormula', () => {
  it.each([
    '=HYPERLINK("https://evil.example","Click")',
    '=1+1',
    '@SUM(A1:A9)',
    '+cmd|" /C calc"!A0',
    '-2+3+cmd|" /C calc"!A0',
    '\t=1+1',
  ])('defuses %s', (cell) => {
    expect(neutraliseFormula(cell)).toBe(`'${cell}`);
  });

  it.each(['+1 813 555 0199', '+18135550199', '-42', '-3.5', '(813) 555-0199', 'Acme Tax LLC', 'a=b', ''])(
    'leaves %s alone',
    (cell) => {
      expect(neutraliseFormula(cell)).toBe(cell);
    },
  );
});
