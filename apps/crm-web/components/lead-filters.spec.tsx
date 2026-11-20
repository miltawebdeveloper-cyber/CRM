/** @jest-environment jsdom */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { LeadQuickFilters } from './lead-filters';

describe('LeadQuickFilters', () => {
  it('turns a chip on, and a second click turns it back off', () => {
    const onChange = jest.fn();
    const { rerender } = render(<LeadQuickFilters followUp="" contact="" onChange={onChange} />);
    fireEvent.click(screen.getByText('Overdue follow-ups'));
    expect(onChange).toHaveBeenLastCalledWith({ followUp: 'overdue' });

    rerender(<LeadQuickFilters followUp="overdue" contact="" onChange={onChange} />);
    expect(screen.getByText('Overdue follow-ups').closest('button')!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('Overdue follow-ups'));
    expect(onChange).toHaveBeenLastCalledWith({ followUp: '' });
  });

  it('keeps the follow-up and contact groups independent', () => {
    const onChange = jest.fn();
    render(<LeadQuickFilters followUp="today" contact="" onChange={onChange} />);
    fireEvent.click(screen.getByText('Never contacted'));
    // Only the contact field changes — "due today AND never contacted" is a
    // valid view, so picking one group never clears the other.
    expect(onChange).toHaveBeenLastCalledWith({ contact: 'never' });
  });

  it("carries the page's actions at the end of the row, so they don't need a row of their own", () => {
    render(<LeadQuickFilters followUp="" contact="" onChange={() => {}} trailing={<button>Export CSV</button>} />);
    const action = screen.getByRole('button', { name: 'Export CSV' });
    expect(action.parentElement!.className).toContain('ml-auto');
  });
});
