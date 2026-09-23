'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { timezonesApi } from '@/lib/crm';
import { setTimezoneSnapshot } from '@/lib/timezone';

/**
 * Keeps lib/timezone.ts's in-memory zone list in step with Admin → Timezones.
 * Renders nothing. Shares the `['timezones-config']` key the admin screen
 * invalidates on save, so a newly added zone reaches every picker in this tab
 * without a reload.
 */
export function TimezoneOptionsSync() {
  const { data } = useQuery({ queryKey: ['timezones-config'], queryFn: timezonesApi.list, retry: false });
  useEffect(() => {
    if (data) setTimezoneSnapshot(data);
  }, [data]);
  return null;
}
