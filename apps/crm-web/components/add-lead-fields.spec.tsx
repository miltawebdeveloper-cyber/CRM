/** @jest-environment jsdom */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { CreateLeadInput } from '@/lib/leads';
import { AddLeadFields } from './add-lead-fields';

const FORM = { businessName: '', phone: '', state: '', city: '', timezone: 'EST' } as CreateLeadInput;

function renderFields(onChange = jest.fn()) {
  const qc = new QueryClient();
  // Seed the two lists the form reads, so no request is made.
  qc.setQueryData(['assignments-summary'], { unassigned: 0, callers: [{ id: 'u1', name: 'Ann', email: 'ann@example.com', leadCount: 12 }] });
  qc.setQueryData(['outcomes-config'], [{ id: 'o1', slug: 'call_back', name: 'Call Back' }]);
  render(
    <QueryClientProvider client={qc}>
      <AddLeadFields form={FORM} onChange={onChange} onCountry={() => {}} countries={[]} zones={[{ value: 'EST', label: 'Eastern' }]} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('AddLeadFields', () => {
  it('groups the fields into sections', () => {
    renderFields();
    for (const title of ['Company', 'Contact', 'Location', 'Pipeline']) expect(screen.getByText(title)).toBeTruthy();
  });

  it('assigns by picking an employee, sending their email', () => {
    const onChange = renderFields();
    fireEvent.change(screen.getByLabelText('Assigned To'), { target: { value: 'ann@example.com' } });
    expect(onChange).toHaveBeenLastCalledWith({ caller: 'ann@example.com' });
  });

  it("takes a time for the follow-up, and says whose clock it is on", () => {
    const onChange = renderFields();
    const input = screen.getByLabelText('Next Follow-up') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    fireEvent.change(input, { target: { value: '2026-11-20T14:30' } });
    expect(onChange).toHaveBeenLastCalledWith({ nextFollowUpDate: '2026-11-20T14:30' });
    expect(screen.getByText("Dates and times are the lead's local time (EST).")).toBeTruthy();
  });
});
