/**
 * The mobile API contract, v1 (ADR-0088 §2). ONE owner for the shape of every response: the route
 * handlers parse their output through these schemas, and the Expo app imports the inferred types.
 *
 * THE SCHEMAS ARE AN ALLOW-LIST, AND THAT IS THEIR SECURITY JOB. `z.object` strips every key it does not
 * name, so a field reaches the phone only by being written down here. `core/read.ts` `myEmployments`
 * returns `basic` and `allowance`; `/me` is built from it and cannot carry either, because no schema
 * below names them. test/mobile-api-routes.test.ts asserts that for the salary-bearing reads.
 *
 * FROZEN ONCE PUBLISHED. A store-installed app updates on its user's schedule, so a v1 shape may gain an
 * OPTIONAL field but never lose, rename or retype one. A breaking change is a v2 beside v1.
 *
 * Money is a decimal STRING, as Postgres numeric arrives — never a float, and the app never does
 * arithmetic on it. Instants are ISO-8601 strings; calendar dates are `YYYY-MM-DD`.
 */
import { z } from 'zod';

export const MOBILE_API_VERSION = 'v1' as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^-?\d+(\.\d+)?$/);

// ── GET /api/mobile/v1/me ──────────────────────────────────────────────────────────────────────────

export const MeEmployment = z.object({
  employmentId: z.string().uuid(),
  company: z.string(),
  department: z.string().nullable(),
  position: z.string().nullable(),
  hiredOn: isoDate.nullable(),
});

export const MeResponse = z.object({
  apiVersion: z.literal(MOBILE_API_VERSION),
  person: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
  /** Active employments only (as the web's /me). More than one ⇒ the app shows the employment picker. */
  employments: z.array(MeEmployment),
  /** Role names, so the app can decide whether to show the Approvals tab. Authorization stays server-side. */
  roles: z.array(z.string()),
  /** Which billable modules this tenant holds, so the app hides tabs the API would answer empty. */
  modules: z.object({ payroll: z.boolean(), notifications: z.boolean() }),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ── GET /api/mobile/v1/payslips ────────────────────────────────────────────────────────────────────

export const PayslipSummary = z.object({
  id: z.string().uuid(),
  company: z.string(),
  payPeriod: z.string(),
  runType: z.string(),
  gross: money,
  deductions: money,
  net: money,
});

export const PayslipsResponse = z.object({
  /** False when the tenant does not hold Payroll; `items` is then always empty. */
  enabled: z.boolean(),
  /** RELEASED payslips only (closed run, release instant passed), newest period first. */
  items: z.array(PayslipSummary),
});
export type PayslipsResponse = z.infer<typeof PayslipsResponse>;

// ── GET /api/mobile/v1/leave ───────────────────────────────────────────────────────────────────────

/**
 * The card FRONT of the web's My Leave dashboard — the same figures, from the same `myLeaveDashboard`.
 * The breakdown side-sheet (and the per-company `essView` switches that gate ITS rows) is not in v1.
 */
export const LeaveCard = z.object({
  leaveTypeId: z.string().uuid(),
  leaveType: z.string(),
  code: z.string().nullable(),
  color: z.string().nullable(),
  placement: z.enum(['primary', 'secondary']),
  annualLeave: z.boolean(),
  cycleStart: isoDate,
  cycleEnd: isoDate,
  isCurrentCycle: z.boolean(),
  hasEntitlement: z.boolean(),
  takenOnly: z.boolean(),
  entitlement: z.number().nullable(),
  earnedSoFar: z.number().nullable(),
  taken: z.number().nullable(),
  pending: z.number().nullable(),
  balance: z.number().nullable(),
  canApplyFor: z.number().nullable(),
  expiringSoon: z.number().nullable(),
  /** The balance is a pool shared with other leave types; the app must say so beside the figure. */
  sharedPool: z.boolean(),
  /** Message key suffix under `leave.table` for the entitlement notice, or null when none is due. */
  entitlementNotice: z.string().nullable(),
});

export const LeaveResponse = z.object({
  today: isoDate,
  employmentId: z.string().uuid().nullable(),
  cards: z.array(LeaveCard),
});
export type LeaveResponse = z.infer<typeof LeaveResponse>;

// ── GET /api/mobile/v1/notifications ───────────────────────────────────────────────────────────────

export const NotificationItem = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  linkPath: z.string().nullable(),
  severity: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export const NotificationsResponse = z.object({
  enabled: z.boolean(),
  unread: z.number().int().nonnegative(),
  items: z.array(NotificationItem),
});
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * `auth_required` (401) ⇒ the app signs in again. `unavailable` (503) ⇒ the app retries and KEEPS the
 * user signed in — an outage must never look like a logout (the benchmark's top login complaint).
 */
export const ErrorResponse = z.object({
  error: z.enum(['auth_required', 'unavailable', 'bad_request', 'internal']),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
