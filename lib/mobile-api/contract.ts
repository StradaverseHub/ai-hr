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
import { parseMobileDesign, type MobileDesign } from '../mobile-design';

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

// GET /api/mobile/v1/design: append-only presentation contract, no HR data or draft.
export const MobileDesignResponse = z.object({
  tenantId: z.string().uuid(), revision: z.number().int().nonnegative(), publishedAt: z.string(),
  config: z.custom<MobileDesign>(value => { try { parseMobileDesign(value); return true; } catch { return false; } }),
});
export type MobileDesignResponse = z.infer<typeof MobileDesignResponse>;


// Native journeys. Every request is strict: identities/policy flags are never body fields.
export const ClockReceipt = z.object({ id: z.string().uuid(), direction: z.enum(['in', 'out']), recordedAt: z.string(), date: isoDate, photoAvailable: z.boolean() });
export const ClockResponse = z.object({
  enabled: z.boolean(), employmentId: z.string().uuid().nullable(),
  state: z.object({
    serverNow: z.string(), date: isoDate, clockedIn: z.boolean(), openSince: z.string().nullable(), workedSeconds: z.number().nonnegative(),
    geofencingRequired: z.boolean(), attendancePhotoSetting: z.enum(['required','optional','not_required']), deviceRequired: z.boolean(),
    shift: z.object({code:z.string().nullable(),start:z.string().nullable(),end:z.string().nullable()}),
    captures: z.array(ClockReceipt.extend({requestId:z.string().uuid(), locationName:z.string().nullable()})),
    legacy:z.array(z.object({direction:z.string(),time:z.string()})),
  }).nullable(),
});
export type ClockResponse = z.infer<typeof ClockResponse>;
export const ClockCommand = z.object({action:z.enum(['in','out']),requestId:z.string().uuid(),lat:z.number().finite().min(-90).max(90),lng:z.number().finite().min(-180).max(180),accuracy:z.number().finite().nonnegative(),sampledAt:z.number().finite().int().positive(),deviceToken:z.string().uuid().optional()}).strict();
export const ClockResult = z.discriminatedUnion('outcome', [
  z.object({outcome:z.literal('accepted'),receipt:ClockReceipt}),
  z.object({outcome:z.literal('refused'),code:z.enum(['corrected_day','clock_conflict','location_required','outside_geofence','photo_required','photo_invalid','device_required','mock_location'])}),
]);
export type ClockResult = z.infer<typeof ClockResult>;
export const DeviceCommand=z.object({label:z.string().trim().min(1).max(80)}).strict();
export const DeviceResponse=z.object({deviceId:z.string().uuid(),deviceToken:z.string().uuid()});
export type DeviceResponse=z.infer<typeof DeviceResponse>;
export const TeamResponse=z.object({enabled:z.boolean(),today:isoDate,through:isoDate,items:z.array(z.object({employmentId:z.string().uuid(),name:z.string(),dates:z.array(z.object({date:isoDate,status:z.enum(['approved','pending']),session:z.string()}))}))});
export type TeamResponse=z.infer<typeof TeamResponse>;
const duration=z.enum(['full_day','half_day_am','half_day_pm','hourly']);
const calendarDate=isoDate.refine(v=>{const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;});
export const LeaveCommand=z.object({
  requestId:z.string().uuid(),leaveTypeId:z.string().uuid(),startDate:calendarDate,endDate:calendarDate,durationType:duration,
  fromTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),toTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  reason:z.string().trim().max(2000).optional(),employeeRemark:z.string().trim().max(2000).optional(),
  reasonCategory:z.enum(['illness','personal','other']).optional(),unpaidConsent:z.boolean().optional(),
  survivingChildren:z.number().int().min(0).max(100).optional(),confinementDate:calendarDate.optional(),
  overrideConsent:z.array(z.string().max(100)).max(8).optional(),
}).strict().refine(v=>v.endDate>=v.startDate && Date.parse(v.endDate)-Date.parse(v.startDate)<=400*86400000,'Invalid date range');
export type LeaveCommand=z.infer<typeof LeaveCommand>;
export const LeaveOptionsResponse=z.object({employmentId:z.string().uuid().nullable(),items:z.array(z.object({
  id:z.string().uuid(),name:z.string(),code:z.string(),durations:z.array(duration),requiresDocument:z.boolean(),mandatoryAfterDays:z.number().nullable(),
  allowedMimeTypes:z.array(z.string()),maxDocBytes:z.number(),employeeRemarkRequired:z.boolean(),emergencySplit:z.boolean(),maternity:z.boolean(),notice:z.string().nullable(),
}))});
export type LeaveOptionsResponse=z.infer<typeof LeaveOptionsResponse>;
export const LeaveRequestsResponse=z.object({employmentId:z.string().uuid().nullable(),total:z.number().int().nonnegative(),items:z.array(z.object({id:z.string().uuid(),type:z.string(),from:isoDate,to:isoDate,status:z.string(),partial:z.boolean()}))});
export type LeaveRequestsResponse=z.infer<typeof LeaveRequestsResponse>;
export const LeavePreviewResponse=z.object({days:z.number().nullable(),unpaidDays:z.number().nullable(),emergencySplit:z.boolean(),overrides:z.array(z.object({consentToken:z.string(),needsConsent:z.boolean(),action:z.string(),fromTypeName:z.string().nullable(),toTypeName:z.string().nullable().optional(),daysInAdvance:z.number().optional(),minAdvanceDays:z.number().nullable().optional(),minAdvanceDayType:z.string().optional(),paidDays:z.number().optional(),unpaidDays:z.number().optional()}))});
export type LeavePreviewResponse=z.infer<typeof LeavePreviewResponse>;
export const LeaveResult=z.discriminatedUnion('outcome',[
 z.object({outcome:z.literal('accepted'),id:z.string().uuid(),days:z.number(),maternityAllowanceWarning:z.boolean(),holidayWarning:z.boolean()}),
 z.object({outcome:z.literal('refused'),code:z.literal('leave_refused'),message:z.string().max(4000)}),
]);
export type LeaveResult=z.infer<typeof LeaveResult>;
