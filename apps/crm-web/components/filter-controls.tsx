'use client';

import { CalendarRange, Search, type LucideIcon } from 'lucide-react';

/**
 * Controlled filter dropdown used across list pages. Pass the current `value`
 * and an `onChange`; options are `{ label, value }` pairs. The first option is
 * typically the "All …" reset whose value is an empty string.
 *
 * `className` is for the filter BAR to size the control — pass `min-w-0 flex-1`
 * and the row shares its width out evenly instead of wrapping. That is not the
 * default because a native `<select>` takes its intrinsic width from its WIDEST
 * OPTION, so an unconstrained control is as wide as the longest employee name
 * or city in the list. Left to itself a seven-filter row overflows and wraps;
 * given a flex basis it can't.
 */
export function FilterSelect({
  icon: Icon,
  value,
  onChange,
  options,
  className = '',
}: {
  icon: LucideIcon;
  value: string;
  onChange: (v: string) => void;
  options: readonly { label: string; value: string }[];
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium text-[var(--brand-ink)] dark:text-foreground ${className}`}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {/* `w-full min-w-0` is what lets the wrapper's width win over the widest
          option; without it the select refuses to shrink below its content. */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 cursor-pointer truncate border-none bg-transparent font-medium outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Controlled search box matching the filter bar styling. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium ${className}`}>
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border-none bg-transparent font-medium outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

export type DateRangeValue = '' | 'today' | 'yesterday' | '7d' | '30d';

const DATE_RANGE_OPTIONS: { label: string; value: DateRangeValue }[] = [
  { label: 'All Time', value: '' },
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: 'Last 7 Days', value: '7d' },
  { label: 'Last 30 Days', value: '30d' },
];

export function DateRangeSelect({
  value,
  onChange,
  options = DATE_RANGE_OPTIONS,
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  options?: readonly { label: string; value: DateRangeValue }[];
}) {
  return (
    <FilterSelect
      icon={CalendarRange}
      value={value}
      onChange={(v) => onChange(v as DateRangeValue)}
      options={options}
    />
  );
}

// Modern calendar pickers (req 8) live in date-picker.tsx; re-export here so
// pages keep importing date controls from a single module.
export { DateRangePicker, DatePicker, DateFilter } from './date-picker';

/** Build `{label,value}` options from distinct values found in data. */
export function optionsFrom(
  values: (string | null | undefined)[],
  allLabel: string,
): { label: string; value: string }[] {
  const seen = Array.from(new Set(values.filter((v): v is string => !!v))).sort();
  return [{ label: allLabel, value: '' }, ...seen.map((v) => ({ label: v, value: v }))];
}
