/**
 * The Schedule screen's tab keys, in the order the reporter listed them (feedback 1c5602cc).
 *
 * A PLAIN, NON-'use client' MODULE ON PURPOSE. The page is a Server Component and READS this list to
 * validate `?tab=`; importing a value from the 'use client' tab shell and using it on the server is the
 * exact class test/rsc-boundary-guard.test.ts exists to catch (a live P0 once — b7d84266).
 *
 * ⚠️ ONLY `general` HAS A PANEL. The other five are NAMED, EMPTY tabs so the shape the reporter asked for
 * is visible and nobody wonders whether one was forgotten — each will be defined and built as its own
 * piece of work. Adding a key here without a panel is fine and honest; adding a CONTROL to a panel for a
 * setting nothing stores is not (AGENTS 28). See the page header's audit.
 */
export const SCHEDULE_TAB_KEYS = [
  'general',
  'holiday',
  'overtime',
  'attendance',
  'request',
  'notification',
] as const;

export type ScheduleTabKey = (typeof SCHEDULE_TAB_KEYS)[number];
