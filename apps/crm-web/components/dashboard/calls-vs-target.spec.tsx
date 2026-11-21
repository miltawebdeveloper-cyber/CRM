/** @jest-environment jsdom */
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react';
import React from 'react';
import { CallsVsTarget } from './calls-vs-target';

describe('CallsVsTarget', () => {
  it('reads "12 / 40" against a target, and says it in words to a screen reader', () => {
    const { container } = render(<CallsVsTarget calls={12} target={40} />);
    expect(container.textContent).toBe('12 / 40 of a daily target of 40');
    // The "/ 40" is for the eye; the words are for the ear.
    expect(container.querySelector('[aria-hidden]')?.textContent).toBe(' / 40');
    expect(container.querySelector('.sr-only')?.textContent).toBe(' of a daily target of 40');
  });

  it('shows just the count when no target is set', () => {
    const { container } = render(<CallsVsTarget calls={7} target={0} />);
    expect(container.textContent).toBe('7');
    expect(container.querySelector('.sr-only')).toBeNull();
  });
});
