/** @jest-environment jsdom */
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react';
import React from 'react';
import { KpiGrid } from './kpi-card';

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
