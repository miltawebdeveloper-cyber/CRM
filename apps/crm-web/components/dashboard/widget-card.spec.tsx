/** @jest-environment jsdom */
import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
jest.mock('@/lib/preferences', () => ({
  loadServerPreferences: async () => ({}),
  saveServerPreference: jest.fn(),
  removeServerPreference: jest.fn(),
}));

import { WidgetCard } from './widget-card';

const rows = Array.from({ length: 10 }, (_, i) => ({ name: `Lead ${i + 1}` }));
const columns = [{ key: 'name', header: 'Name' }];

describe('WidgetCard', () => {
  it('reports the real total, not the ten rows it shows, and links to the rest', () => {
    render(<WidgetCard title="Today's Leads" columns={columns} rows={rows} total={214} href="/leads?all=1" />);
    expect(screen.getByText('Showing 10 of 214')).toBeTruthy();
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/leads?all=1', '/leads?all=1']);
    expect(links[1].textContent).toContain('View all 214');
  });

  it('says when everything is already on screen, and offers no link without a page to go to', () => {
    render(<WidgetCard title="My Open Tasks" columns={columns} rows={rows.slice(0, 3)} />);
    expect(screen.getByText('Showing all 3')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
