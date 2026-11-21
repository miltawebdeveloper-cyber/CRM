/** @jest-environment jsdom */
import { beforeAll, describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { TrendChart, endLabelOffsets, shortDay } from './trend-chart';

beforeAll(() => {
  // recharts' ResponsiveContainer measures its box; jsdom has no layout.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const DAYS = [
  { day: '2026-11-19', calls: 40, connected: 22, contacted: 9 },
  { day: '2026-11-20', calls: 35, connected: 18, contacted: 12 },
];

describe('TrendChart', () => {
  it('reads a day on the calendar, with no time-zone shift', () => {
    expect(shortDay('2026-11-01')).toMatch(/1/);
    expect(shortDay('2026-11-01')).not.toMatch(/31|30/);
  });

  it('names both series with their totals, and has every figure in a table view', () => {
    render(<TrendChart days={DAYS} />);
    expect(screen.getByText('Calls made')).toBeTruthy();
    expect(screen.getByText('75')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
    const cells = screen.getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual([shortDay('2026-11-19'), '40', '22', '9', shortDay('2026-11-20'), '35', '18', '12']);
  });

  it('keeps end labels apart when the two lines finish close together', () => {
    expect(endLabelOffsets({ calls: 30, contacted: 5 }, 40)).toEqual({ calls: 4, contacted: 4 });
    expect(endLabelOffsets({ calls: 12, contacted: 11 }, 40)).toEqual({ calls: -3, contacted: 11 });
    expect(endLabelOffsets({ calls: 11, contacted: 12 }, 40)).toEqual({ calls: 11, contacted: -3 });
  });
});
