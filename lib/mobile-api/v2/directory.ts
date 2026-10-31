/**
 * The staff directory in the app: the web's read-only People directory (app/(app)/personnel/page.tsx, screen `people`,
 * guard scopedSession) through the SAME owner and the SAME row visibility. Read only. Imported by route handlers AND
 * by the Expo app, so this file stays dependency-free (zod only, no server module, no 'server-only').
 *
 *   GET /api/mobile/v2/directory?q&offset&limit   → DirectoryPageV2
 *
 * ROWS. core/read.ts listEmployeesPage with the caller's allowed companies (the web's company scope, every allowed
 * company — the app has no company switcher), the web's `active` status filter (not terminated) and its search
 * (`q` over name, email and employee ID), in its order (name ascending). RLS decides which employments are visible,
 * exactly as on the web.
 *
 * FIELDS. Only what the web directory already shows to the same viewer: name, position, department and company
 * (the list and its profile page), `email` (the list prints it under the name) and `phone` (the profile page opened
 * from the list prints it). No employee ID, IC, birth date, address, pay or any other personal record.
 *
 * `enabled` is false only when the web would refuse the screen. Today the web gates nothing at the page boundary
 * for `people` (lib/permissions.ts rolesForGuard('scopedSession') is every role, and the Function Access grid is a
 * read-only reference over route guards, not a per-role switch), so an authenticated caller always gets `true`.
 *
 * PAGING. Offset paging, as the web's pager: `limit` 1..DIRECTORY_PAGE_MAX (default DIRECTORY_PAGE_DEFAULT),
 * `offset` ≥ 0; `q` is trimmed and at most DIRECTORY_QUERY_MAX characters. Anything else is a 400, never truncated.
 */
import { z } from 'zod';

export const DIRECTORY_PAGE_DEFAULT = 30;
export const DIRECTORY_PAGE_MAX = 50;
export const DIRECTORY_QUERY_MAX = 100;
/** An engineering bound on `offset` (a request, not a policy): beyond it the request is refused. */
export const DIRECTORY_OFFSET_MAX = 100_000;

const label = z.string().max(500);
export const DirectoryEntryV2 = z.object({
  employmentId: z.string().uuid(),
  name: label,
  position: label.nullable(),
  department: label.nullable(),
  company: label,
  email: z.string().max(320).nullable(),
  phone: z.string().max(100).nullable(),
}).strict();
export type DirectoryEntryV2 = z.infer<typeof DirectoryEntryV2>;

export const DirectoryPageV2 = z.object({
  enabled: z.boolean(),
  items: z.array(DirectoryEntryV2).max(DIRECTORY_PAGE_MAX),
  /** Every matching employment the caller may see, for the pager. */
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(DIRECTORY_PAGE_MAX),
}).strict();
export type DirectoryPageV2 = z.infer<typeof DirectoryPageV2>;
