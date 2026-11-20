'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadServerPreferences, saveServerPreference } from './preferences';
import { filtersToParams, normaliseFilters, type LeadListFilters } from './lead-list-filters';

/**
 * Named filter sets — "My Texas overdue follow-ups" — for Lead Library and Lead
 * Management.
 *
 * Kept per user on the server (`/me/preferences`), alongside the column
 * layouts, so a view saved at the desk is there on the laptop. Each list has
 * its own set: a Library view would mean something different on Lead
 * Management, which never shows unassigned leads.
 */
export interface SavedView {
  id: string;
  name: string;
  filters: LeadListFilters;
}

/** Enough for anyone's working set; past it the menu stops being a shortcut. */
export const MAX_SAVED_VIEWS = 20;

export const savedViewsKey = (listKey: string) => `views:${listKey}`;

/** A stored value, read defensively — preferences are free-form JSON. */
export function parseSavedViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is { id: string; name: string; filters: unknown } =>
      !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.name === 'string' && v.name.trim() !== '',
    )
    .slice(0, MAX_SAVED_VIEWS)
    .map((v) => ({ id: v.id, name: v.name.trim(), filters: normaliseFilters(v.filters) }));
}

/**
 * Whether two filter sets show the same list. Compared through the URL form,
 * which is canonical by construction — same parameters, same order — so key
 * order in a stored object can't make two identical views look different.
 */
export function sameFilters(a: LeadListFilters, b: LeadListFilters): boolean {
  return filtersToParams(a).toString() === filtersToParams(b).toString();
}

/**
 * Add a view, or overwrite the one with the same name (case-insensitive) — so
 * "Save" on a name already taken updates it instead of making a twin.
 */
export function withSavedView(views: SavedView[], name: string, filters: LeadListFilters, newId: () => string): SavedView[] {
  const clean = name.trim();
  const existing = views.find((v) => v.name.toLowerCase() === clean.toLowerCase());
  if (existing) return views.map((v) => (v.id === existing.id ? { ...v, name: clean, filters } : v));
  return [...views, { id: newId(), name: clean, filters }].slice(-MAX_SAVED_VIEWS);
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function useSavedViews(listKey: string) {
  const [views, setViews] = useState<SavedView[]>([]);

  useEffect(() => {
    let live = true;
    loadServerPreferences().then((all) => {
      if (live) setViews(parseSavedViews(all[savedViewsKey(listKey)]));
    });
    return () => {
      live = false;
    };
  }, [listKey]);

  const persist = useCallback(
    (next: SavedView[]) => {
      setViews(next);
      saveServerPreference(savedViewsKey(listKey), next);
    },
    [listKey],
  );

  const save = useCallback((name: string, filters: LeadListFilters) => persist(withSavedView(views, name, filters, newId)), [persist, views]);
  const remove = useCallback((id: string) => persist(views.filter((v) => v.id !== id)), [persist, views]);

  return { views, save, remove };
}
