/** @jest-environment jsdom */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { IconAction } from './icon-action';

// next/link needs the App Router mounted; a plain anchor is all this needs.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

describe('IconAction', () => {
  it('is named for screen readers and shows its name as a label, not as text in the button', () => {
    render(<IconAction icon={Plus} label="Add Lead" variant="primary" onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'Add Lead' });
    expect(button.textContent).toBe('');
    // The visible label sits beside it, hidden from assistive tech (no double reading).
    const tip = screen.getByText('Add Lead');
    expect(tip.getAttribute('aria-hidden')).toBe('true');
    expect(tip.className).toContain('group-hover/tip:block');
    expect(tip.className).toContain('group-focus-within/tip:block');
    // Out of the layout at rest: a transparent label still widened the page.
    expect(tip.className).toContain('hidden');
  });

  it('can hang its label from its right edge, for an icon at the edge of the page', () => {
    render(<IconAction icon={Plus} label="Export breakdown CSV" align="end" onClick={() => {}} />);
    const tip = screen.getByText('Export breakdown CSV');
    expect(tip.className).toContain('right-0');
    expect(tip.className).not.toContain('-translate-x-1/2');
  });

  it('is a real link when it navigates', () => {
    render(<IconAction icon={Trash2} label="Recently deleted" href="/lead-library/deleted" />);
    expect(screen.getByRole('link', { name: 'Recently deleted' }).getAttribute('href')).toBe('/lead-library/deleted');
  });

  it('runs its action, and not when disabled', () => {
    const onClick = jest.fn();
    const { rerender } = render(<IconAction icon={Plus} label="Add Lead" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Lead' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<IconAction icon={Plus} label="Add Lead" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Lead' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('matches the full-size header buttons when asked to', () => {
    const { rerender } = render(<IconAction icon={Plus} label="Export CSV" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Export CSV' }).className).toContain('h-8 w-8');
    rerender(<IconAction icon={Plus} label="Export CSV" onClick={() => {}} size="md" />);
    expect(screen.getByRole('button', { name: 'Export CSV' }).className).toContain('h-9 w-9');
  });
});
