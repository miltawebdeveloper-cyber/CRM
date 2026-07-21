'use client';

import { CalendarRange, Search, type LucideIcon } from 'lucide-react';

/**
 * Controlled filter dropdown used across list pages. Pass the current `value`
 * and an `onChange`; options are `{ label, value }` pairs. The first option is
 * typically the "All …" reset whose value is an empty string.
 */
export function FilterSelect({
  icon: Icon,
  value,
  onChange,
  options,
}: {
  icon: LucideIcon;
  value: string;
  onChange: (v: string) => void;
  options: readonly { label: string; value: string }[];
}) {
  return (
    <div className="flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[13px] font-medium text-[#163618] dark:text-foreground">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer border-none bg-transparent font-medium outline-none"
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
    <div className={`flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[13px] font-medium ${className}`}>
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
