/** @jest-environment jsdom */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { Lead } from '@/lib/leads';
import { leadColumns } from './lead-columns';

// next/link needs the App Router mounted; a plain anchor is all these cells need here.
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean }) => <a href={href} {...rest}>{children}</a> }));

/**
 * One column list now serves Lead Library and Lead Management, so the things
 * that differ between the pages are options — and the keys every saved column
 * layout and every server-side sort depend on must not move.
 */
const LEAD = { id: 'lead-1', leadId: 'L-2026-1', businessName: 'Acme', phone: '3055550100', lostReason: 'Too small', timezone: 'EST' } as unknown as Lead;

function renderActions(opts: Parameters<typeof leadColumns>[0]) {
  const actions = leadColumns(opts).find((c) => c.key === 'actions')!;
  render(<>{actions.render(LEAD, 0)}</>);
}

describe('leadColumns', () => {
  it('keeps the keys that saved layouts and server sorts are bound to', () => {
    const keys = leadColumns({ canEditLostReason: true }).map((c) => c.key);
    expect(keys).toEqual([
      'importSeq', 'leadId', 'leadGenerationId', 'createdAt', 'scheduledDate', 'movement', 'leadSource',
      'businessName', 'contactName', 'contactName2', 'phone', 'altPhone', 'email', 'website', 'socialMedia',
      'country', 'state', 'city', 'tz', 'industry', 'companySize', 'foundedYear', 'address', 'caller',
      'callStatus', 'firstContact', 'lastContact', 'followup', 'followupCount', 'meetingDate', 'comments',
      'lostReason', 'actions',
    ]);
  });

  it('shows only the actions the page passes in', () => {
    renderActions({ canEditLostReason: false });
    expect(screen.getByTitle('View')).toBeTruthy();
    expect(screen.queryByTitle('Call')).toBeNull();
    expect(screen.queryByTitle('Lead history')).toBeNull();
  });

  it('wires history and call to the lead on the row', () => {
    const onHistory = jest.fn();
    const onCall = jest.fn();
    renderActions({ onCall, onHistory, canEditLostReason: true });
    fireEvent.click(screen.getByTitle('Lead history'));
    fireEvent.click(screen.getByTitle('Call'));
    expect(onHistory).toHaveBeenCalledWith(LEAD);
    expect(onCall).toHaveBeenCalledWith(LEAD);
  });

  it('renders Lost Reason read-only unless the page says it may be edited', () => {
    const lost = (canEdit: boolean) => leadColumns({ canEditLostReason: canEdit }).find((c) => c.key === 'lostReason')!;
    const qc = new QueryClient();
    const { unmount } = render(<QueryClientProvider client={qc}>{lost(false).render(LEAD, 0)}</QueryClientProvider>);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    render(<QueryClientProvider client={qc}>{lost(true).render(LEAD, 0)}</QueryClientProvider>);
    expect(screen.getByRole('button').textContent).toBe('Too small');
  });

  it('opens the lead from its Lead ID and Company Name, as real links', () => {
    const cols = leadColumns({ canEditLostReason: true });
    for (const key of ['leadId', 'businessName']) {
      const { unmount } = render(<>{cols.find((c) => c.key === key)!.render(LEAD, 0)}</>);
      expect(screen.getByRole('link').getAttribute('href')).toBe('/leads/lead-1');
      unmount();
    }
  });
});
