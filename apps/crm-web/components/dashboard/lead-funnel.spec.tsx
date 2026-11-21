/** @jest-environment jsdom */
import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { LeadFunnel, stepShare } from './lead-funnel';

const STAGES = [
  { key: 'total', label: 'Total leads', value: 843, href: '/lead-library?all=1' },
  { key: 'assigned', label: 'Assigned', value: 375, href: '/leads?all=1' },
  { key: 'contacted', label: 'Contacted', value: 7, href: '/leads?contact=contacted' },
  { key: 'converted', label: 'Converted', value: 0 },
];

describe('stepShare', () => {
  it('is the share of the stage before, to one decimal', () => {
    expect(stepShare(375, 843)).toBe(44.5);
    expect(stepShare(7, 375)).toBe(1.9);
  });

  it('has nothing to say about the first stage, or after an empty one', () => {
    expect(stepShare(843, null)).toBeNull();
    expect(stepShare(0, 0)).toBeNull();
  });
});

describe('LeadFunnel', () => {
  it('prints every stage as text — the list is its own table view', () => {
    render(<LeadFunnel stages={STAGES} />);
    expect(screen.getByText('843')).toBeTruthy();
    expect(screen.getByText('44.5% of total leads')).toBeTruthy();
    expect(screen.getByText('1.9% of assigned')).toBeTruthy();
    expect(screen.getByText('0% of contacted')).toBeTruthy();
  });

  it('draws each bar against the first stage, and nothing for a stage at zero', () => {
    const { container } = render(<LeadFunnel stages={STAGES} />);
    const fills = [...container.querySelectorAll<HTMLElement>('li span[aria-hidden] > span')];
    expect(fills.map((f) => f.style.width)).toEqual(['100%', `${(375 / 843) * 100}%`, `${(7 / 843) * 100}%`, '0%']);
    // A tiny but real stage still shows; an empty one shows only its track.
    expect(fills[2].style.minWidth).toBe('3px');
    expect(fills[3].style.minWidth).toBe('0');
  });

  it('links a stage only where a list shows exactly what it counts', () => {
    render(<LeadFunnel stages={STAGES} />);
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/lead-library?all=1', '/leads?all=1', '/leads?contact=contacted']);
  });
});
