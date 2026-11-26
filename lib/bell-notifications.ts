import type { NotificationRow as StoredNotificationRow } from '@/core/notifications';

/** One row of the bell's Notification, Task or History tab. */
export type BellNotificationRow = Pick<StoredNotificationRow, 'id' | 'title' | 'body' | 'severity' | 'linkPath' | 'createdAt' | 'readAt'>
  & Partial<Pick<StoredNotificationRow, 'kind'>>;

/**
 * The notification half of the bell (app/bell-notifications.ts): the shell renders it, and a mark-read returns a fresh
 * copy so the bell updates without redrawing the app frame (ADR 0181 decision 4).
 */
export type BellNotifications = {
  /** Unread informational notifications, exact (the Notification tab badge). */
  unread: number;
  /** The Notification tab list: unread, non-action, bounded. */
  items: BellNotificationRow[];
  /** Unread severity-'action' notifications, bounded. */
  taskNotifications: BellNotificationRow[];
  /** Exact count of unread severity-'action' notifications: the notification share of the Task tab badge. */
  notificationTaskCount: number;
  /** Read notifications for the History tab, bounded. */
  readItems: BellNotificationRow[];
};
