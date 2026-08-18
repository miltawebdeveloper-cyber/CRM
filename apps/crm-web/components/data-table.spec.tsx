/** @jest-environment jsdom */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';

/**
 * The grid's side of the flicker, and the reason it froze on long lists.
 *
 * Two separate faults lived in this component. It emptied its own body whenever
 * a request was in flight — `loading ? <spinner> : rows.map(...)` — so every
 * filter, sort and post-save refetch blanked a table whose rows were perfectly
 * good. And it rendered those rows inline, so any table state at all
 * re-rendered every one of them: a keystroke in the search box, a tick in a
 * checkbox, and worst of all a drag-select, which updates the selection for
 * every row the pointer crosses.
 *
 * Both are asserted here rather than in `lib`, because both are about what the
 * component DOES with its inputs rather than what it decides — the decision
 * itself lives in `lib/table-state` and is tested there.
 */

// Column preferences are loaded from the server and cached in a module. Stubbed
// so rendering a table costs no network and no cross-test state.
jest.mock('@/lib/preferences', () => ({
  loadServerPreferences: async () => ({}),
  saveServerPreference: jest.fn(),
  removeServerPreference: jest.fn(),
}));

import { DataTable, type ColumnDef } from './data-table';

interface Row {
  id: string;
  name: string;
}

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, name: `Lead ${i + 1}` }));

/** Counts how many times each row's cell was rendered. */
function countingColumns(counts: Record<string, number>): ColumnDef<Row>[] {
  return [
    {
      key: 'name',
      header: 'Name',
      render: (row) => {
        counts[row.id] = (counts[row.id] ?? 0) + 1;
        return row.name;
      },
    },
  ];
}

const columns: ColumnDef<Row>[] = [{ key: 'name', header: 'Name', render: (r) => r.name }];

const bodyText = () => document.querySelector('tbody')!.textContent ?? '';

describe('DataTable', () => {
  beforeEach(() => localStorage.clear());

  describe('never hides rows it already has', () => {
    it('keeps every row on screen while refreshing', () => {
      // THE regression. A refresh is a reason to say "updating", never a reason
      // to show less than you have.
      render(
        <DataTable tableKey="t1" columns={columns} rows={rows(3)} getRowKey={(r) => r.id} refreshing selectable={false} />,
      );

      expect(screen.getByText('Lead 1')).toBeDefined();
      expect(screen.getByText('Lead 3')).toBeDefined();
      expect(bodyText()).not.toContain('Loading…');
    });

    it('keeps them even if a caller passes `loading` alongside rows', () => {
      // Defensive: `loading` means "nothing to show", but a caller that gets
      // that wrong must not be able to blank a populated grid.
      render(
        <DataTable tableKey="t2" columns={columns} rows={rows(2)} getRowKey={(r) => r.id} loading selectable={false} />,
      );

      expect(screen.getByText('Lead 1')).toBeDefined();
      expect(bodyText()).not.toContain('Loading…');
    });

    it('shows the placeholder only when there is genuinely nothing', () => {
      render(<DataTable tableKey="t3" columns={columns} rows={[]} getRowKey={(r) => r.id} loading selectable={false} />);

      expect(bodyText()).toContain('Loading…');
    });

    it('does not claim the list is empty while an answer is still coming', () => {
      // The second half of the original flicker: blank grid, then "no leads
      // match", then the leads. The middle statement was never true.
      render(
        <DataTable
          tableKey="t4"
          columns={columns}
          rows={[]}
          getRowKey={(r) => r.id}
          refreshing
          emptyText="No leads match the current filters."
          selectable={false}
        />,
      );

      expect(bodyText()).not.toContain('No leads match');
      expect(bodyText()).toContain('Loading…');
    });

    it('says the list is empty once nothing is in flight', () => {
      render(
        <DataTable
          tableKey="t5"
          columns={columns}
          rows={[]}
          getRowKey={(r) => r.id}
          emptyText="No leads match the current filters."
          selectable={false}
        />,
      );

      expect(bodyText()).toContain('No leads match the current filters.');
    });

    it('marks the table busy for assistive tech instead of emptying it', () => {
      const { container } = render(
        <DataTable tableKey="t6" columns={columns} rows={rows(2)} getRowKey={(r) => r.id} refreshing selectable={false} />,
      );

      expect(container.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    });

    it('is not busy when nothing is loading', () => {
      const { container } = render(
        <DataTable tableKey="t7" columns={columns} rows={rows(2)} getRowKey={(r) => r.id} selectable={false} />,
      );

      expect(container.querySelector('table')?.getAttribute('aria-busy')).toBeNull();
    });
  });

  describe('re-rendering', () => {
    it('re-renders only the row whose selection changed', () => {
      // The freeze. With the body inline, ticking one checkbox re-rendered every
      // row — and each lead row draws three cells that are components with their
      // own state. On a list scrolled to a few thousand rows that is thousands
      // of component renders per click, and per pointer move during a drag.
      const counts: Record<string, number> = {};
      const { container } = render(
        <DataTable tableKey="t8" columns={countingColumns(counts)} rows={rows(4)} getRowKey={(r) => r.id} />,
      );

      const before = { ...counts };
      // Row checkboxes only — the first is the header's select-all.
      const boxes = container.querySelectorAll('tbody input[type="checkbox"]');
      fireEvent.click(boxes[0]);

      expect(counts.r1).toBe(before.r1 + 1);
      expect(counts.r2).toBe(before.r2);
      expect(counts.r3).toBe(before.r3);
      expect(counts.r4).toBe(before.r4);
    });

    it('re-renders rows only when their own data changes', () => {
      const counts: Record<string, number> = {};
      const data = rows(3);
      const cols = countingColumns(counts);
      const { rerender } = render(
        <DataTable tableKey="t9" columns={cols} rows={data} getRowKey={(r) => r.id} selectable={false} />,
      );

      const before = { ...counts };
      // A refresh flag flipping is a change to the TABLE, not to any row.
      rerender(
        <DataTable tableKey="t9" columns={cols} rows={data} getRowKey={(r) => r.id} refreshing selectable={false} />,
      );

      expect(counts).toEqual(before);
    });
  });

  describe('selection still works', () => {
    it('selects and reports a row', () => {
      const { container } = render(
        <DataTable tableKey="t10" columns={columns} rows={rows(3)} getRowKey={(r) => r.id} />,
      );

      fireEvent.click(container.querySelectorAll('tbody input[type="checkbox"]')[1]);

      expect(screen.getByText('1 selected')).toBeDefined();
    });

    it('selects every row from the header box, and clears them again', () => {
      const { container } = render(
        <DataTable tableKey="t11" columns={columns} rows={rows(3)} getRowKey={(r) => r.id} />,
      );
      const selectAll = container.querySelector('thead input[type="checkbox"]')!;

      fireEvent.click(selectAll);
      expect(screen.getByText('3 selected')).toBeDefined();

      fireEvent.click(selectAll);
      expect(screen.queryByText('3 selected')).toBeNull();
    });

    it('hands the selected rows to a bulk action', () => {
      const onDelete = jest.fn();
      const { container } = render(
        <DataTable
          tableKey="t12"
          columns={columns}
          rows={rows(2)}
          getRowKey={(r) => r.id}
          onDeleteSelected={onDelete as (rows: Row[]) => void}
        />,
      );

      fireEvent.click(container.querySelectorAll('tbody input[type="checkbox"]')[0]);
      fireEvent.click(screen.getByLabelText('Delete'));

      // Confirmed before it runs — the dialog is the guard, not the handler.
      expect(onDelete).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Delete');
    });

    it('leaves a locked row out of select-all', () => {
      // Ownership protection: a lead that already belongs to somebody must not
      // be swept up by a bulk action.
      const { container } = render(
        <DataTable
          tableKey="t13"
          columns={columns}
          rows={rows(3)}
          getRowKey={(r) => r.id}
          isRowSelectable={(r) => r.id !== 'r2'}
        />,
      );

      fireEvent.click(container.querySelector('thead input[type="checkbox"]')!);

      expect(screen.getByText('2 selected')).toBeDefined();
    });
  });

  describe('the table search', () => {
    it('narrows the rows and says what did the narrowing', () => {
      render(
        <DataTable
          tableKey="t14"
          columns={[{ key: 'name', header: 'Name', render: (r: Row) => r.name, searchable: true, searchValue: (r: Row) => r.name }]}
          rows={rows(3)}
          getRowKey={(r) => r.id}
          selectable={false}
        />,
      );

      fireEvent.click(screen.getByLabelText('Search this table'));
      fireEvent.change(screen.getByPlaceholderText('Search this table…'), { target: { value: 'Lead 2' } });

      const body = within(document.querySelector('tbody')!);
      expect(body.getByText('Lead 2')).toBeDefined();
      expect(body.queryByText('Lead 1')).toBeNull();
    });

    it('distinguishes "no matches" from "no data"', () => {
      render(
        <DataTable
          tableKey="t15"
          columns={[{ key: 'name', header: 'Name', render: (r: Row) => r.name, searchable: true, searchValue: (r: Row) => r.name }]}
          rows={rows(3)}
          getRowKey={(r) => r.id}
          emptyText="No records."
          selectable={false}
        />,
      );

      fireEvent.click(screen.getByLabelText('Search this table'));
      fireEvent.change(screen.getByPlaceholderText('Search this table…'), { target: { value: 'nothing here' } });

      expect(bodyText()).toContain('No records match');
      expect(bodyText()).not.toBe('No records.');
    });
  });
});
