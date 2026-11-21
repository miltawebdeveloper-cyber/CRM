/** @jest-environment jsdom */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { Target } from 'lucide-react';
import { KpiCard, KpiGrid } from './kpi-card';

/** One spacing for every module's KPI row. */
describe('KpiGrid', () => {
  const classOf = (el: React.ReactElement) => (render(el).container.firstElementChild as HTMLElement).className;

  it('spaces every module the same: 12px gaps, 12px below', () => {
    const cls = classOf(<KpiGrid><span /></KpiGrid>);
    expect(cls).toContain('gap-3');
    expect(cls).toContain('mb-3');
    expect(cls).toContain('minmax(190px,1fr)');
  });

  it('keeps a page’s narrower card width, and can drop the margin inside a spaced section', () => {
    const cls = classOf(<KpiGrid min={180} bottom={false}><span /></KpiGrid>);
    expect(cls).toContain('minmax(180px,1fr)');
    expect(cls).not.toContain('mb-3');
  });
});

describe('KpiCard as a link', () => {
  // next/link needs the App Router mounted; a plain anchor is all this needs.
  jest.mock('next/link', () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
  }));

  it('opens the list behind its number when given one, and stays a plain tile otherwise', () => {
    const { container, rerender } = render(<KpiCard icon={Target} iconBg="" iconColor="" value="368" label="Balance Leads" href="/leads?contact=never" />);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/leads?contact=never');
    rerender(<KpiCard icon={Target} iconBg="" iconColor="" value="7.5%" label="Conversion Rate" />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('shows a change against the previous period beside its figure, in words as well as an arrow', () => {
    const { container } = render(
      <KpiCard icon={Target} iconBg="" iconColor="" value="12" label="Missed Calls" delta={{ text: '50%', direction: 'up', tone: 'worse', title: 'up 50% — 12 vs 8 in the previous 7 days' }} />,
    );
    const badge = container.querySelector('[title]')!;
    expect(badge.getAttribute('title')).toBe('up 50% — 12 vs 8 in the previous 7 days');
    expect(badge.textContent).toContain('▲');
    expect(badge.textContent).toContain('50%');
    expect(badge.className).toContain('tone-red');
  });
});

describe('KpiCard as a button', () => {
  it('acts on the page it is on when given a click', () => {
    const onClick = jest.fn();
    const { container } = render(<KpiCard icon={Target} iconBg="x" iconColor="y" value={5} label="Calls with no outcome" onClick={onClick} />);
    const button = container.querySelector('button')!;
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
