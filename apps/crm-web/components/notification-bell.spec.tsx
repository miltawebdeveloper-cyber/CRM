/** @jest-environment jsdom */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { Notification as AppNotification } from '@/lib/crm';
import { NotificationBell } from './notification-bell';

// next/link needs the App Router mounted; a plain anchor is all this needs.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const mockUnreadCount = jest.fn<() => Promise<{ count: number }>>();
const mockListUnread = jest.fn<() => Promise<AppNotification[]>>();
const mockList = jest.fn<() => Promise<AppNotification[]>>();
const mockMarkRead = jest.fn<(id: string) => Promise<unknown>>();
const mockMarkAllRead = jest.fn<() => Promise<unknown>>();
// Read through closures: the factory runs before these constants exist.
jest.mock('@/lib/crm', () => ({
  notificationsApi: {
    unreadCount: () => mockUnreadCount(),
    listUnread: () => mockListUnread(),
    list: () => mockList(),
    markRead: (id: string) => mockMarkRead(id),
    markAllRead: () => mockMarkAllRead(),
  },
}));

const note = (id: string, isRead = false): AppNotification => ({
  id,
  title: `Title ${id}`,
  body: `Body ${id}`,
  type: 'callback_due',
  isRead,
  createdAt: '2026-11-20T10:00:00Z',
});

/** A request that only answers when the test says so. */
function held<T>() {
  let answer!: (v: T) => void;
  let refuse!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    answer = res;
    refuse = rej;
  });
  return { promise, answer, refuse };
}

function renderBell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NotificationBell />
    </QueryClientProvider>,
  );
  return qc;
}

const badge = () => screen.queryByTestId('notification-badge')?.textContent ?? null;

async function openBell(unread: number) {
  fireEvent.click(await screen.findByRole('button', { name: `Notifications, ${unread} unread` }));
  return screen.findByRole('dialog', { name: 'Unread notifications' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUnreadCount.mockResolvedValue({ count: 2 });
  mockListUnread.mockResolvedValue([note('a'), note('b')]);
});

describe('NotificationBell', () => {
  it('is always in the bar — with nothing unread it shows the bell and no badge', async () => {
    mockUnreadCount.mockResolvedValue({ count: 0 });
    renderBell();
    await waitFor(() => expect(mockUnreadCount).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
    expect(badge()).toBeNull();
  });

  it('stays in the bar when the count cannot be read', async () => {
    mockUnreadCount.mockRejectedValue(new Error('offline'));
    renderBell();
    await waitFor(() => expect(mockUnreadCount).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('shows the unread count on a badge', async () => {
    mockUnreadCount.mockResolvedValue({ count: 3 });
    renderBell();
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeTruthy();
    expect(badge()).toBe('3');
  });

  it('caps a large count at 99+', async () => {
    mockUnreadCount.mockResolvedValue({ count: 150 });
    renderBell();
    await screen.findByRole('button', { name: 'Notifications, 150 unread' });
    expect(badge()).toBe('99+');
  });

  it('lists unread notifications only', async () => {
    mockListUnread.mockResolvedValue([note('a'), note('old', true)]);
    renderBell();
    await openBell(2);
    expect(await screen.findByRole('button', { name: /Title a/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Title old/ })).toBeNull();
    // Asked of the server as unread, not picked out of the full history.
    expect(mockListUnread).toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('marks a notification read on click: it leaves the list and the badge drops before the server answers', async () => {
    const req = held<unknown>();
    mockMarkRead.mockReturnValue(req.promise);
    renderBell();
    await openBell(2);
    fireEvent.click(await screen.findByRole('button', { name: /Title a/ }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /Title a/ })).toBeNull());
    expect(mockMarkRead).toHaveBeenCalledWith('a');
    // The server still says 2 — this 1 is the click, shown without waiting.
    expect(badge()).toBe('1');
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Title b/ })).toBeTruthy();

    // The server agrees, and its own figures come back the same.
    mockUnreadCount.mockResolvedValue({ count: 1 });
    mockListUnread.mockResolvedValue([note('b')]);
    await act(async () => req.answer({ count: 1 }));
    await waitFor(() => expect(mockUnreadCount.mock.calls.length).toBeGreaterThan(1));
    expect(badge()).toBe('1');
    expect(screen.queryByRole('button', { name: /Title a/ })).toBeNull();
  });

  it('puts it back if the server refuses', async () => {
    const req = held<unknown>();
    mockMarkRead.mockReturnValue(req.promise);
    renderBell();
    await openBell(2);
    fireEvent.click(await screen.findByRole('button', { name: /Title a/ }));
    await waitFor(() => expect(badge()).toBe('1'));

    await act(async () => req.refuse(new Error('500')));
    expect(await screen.findByRole('button', { name: /Title a/ })).toBeTruthy();
    expect(badge()).toBe('2');
  });

  it('Mark all read empties the list and clears the badge at once', async () => {
    mockMarkAllRead.mockReturnValue(held<unknown>().promise);
    renderBell();
    await openBell(2);
    await screen.findByRole('button', { name: /Title a/ });
    fireEvent.click(screen.getByRole('button', { name: /Mark all read/ }));

    expect(await screen.findByText('You’re all caught up.')).toBeTruthy();
    expect(badge()).toBeNull();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('closes on Escape, handing focus back to the bell, and on a click elsewhere', async () => {
    renderBell();
    await openBell(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Notifications, 2 unread' }));

    await openBell(2);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('links to the full history', async () => {
    renderBell();
    await openBell(2);
    expect(screen.getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/notifications');
  });
});
