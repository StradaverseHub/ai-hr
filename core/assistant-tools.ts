import {assistantToolSpec} from '../lib/ai/assistant-tool-catalogue';
/**
 * The assistant's read-only tool registry (ADR-0082 §2.3).
 *
 * Every tool enters the explicit canonical read facade with the CALLER'S OWN SessionContext.
 * The facade binds the actual read transaction; the registry receives only named read methods. The security
 * property is INHERITED, not invented: the same policies that decide what the caller's own pages show
 * decide what the assistant can see, because it is literally the same query in the same session.
 *
 * ── THE THREE RULES ──────────────────────────────────────────────────────────────────────────────────
 * Each is a SOURCE-SHAPE GUARD (test/assistant-tools-shape.test.ts), not a convention, because each is a
 * property of the REGISTRY that no single-tool unit test can observe:
 *
 *   1. NO TOOL BUILDS ITS OWN SESSION. `ctx` arrives and is passed on. A tool that assembled one, widened
 *      its authority, or reached for the owner/migration pool would defeat the entire design in a way
 *      every individual tool test would still pass. This file therefore imports SessionContext as a TYPE
 *      ONLY — at runtime it holds no database handle at all; its read facade owns the transaction, with no
 *      seam through which raw SQL could be smuggled in beside a read.
 *   2. NO TOOL CHANGES ANYTHING. Not behind a confirmation — none. The closed facade exposes no
 *      mutation, and its transaction enforces database read-only mode. The source guard independently
 *      refuses effect-capable imports and write paths in this registry.
 *   3. NO TOOL RESULT SELECTS OR AUTHORISES ANOTHER TOOL. Output is data. The loop lets the MODEL pick
 *      the next call, and the model's calls are constrained to this registry.
 *
 * ── PROJECT BY ALLOW-LIST, NEVER BY OMISSION ─────────────────────────────────────────────────────────
 * Every wrapper names the fields it returns. It never spreads a read's row and subtracts. core/read.ts
 * grows columns whenever a screen needs one — `employeeDetail` is ~90 wide and gained race, religion,
 * three postal addresses and the emergency register over eight rounds — and a subtract-list hands each
 * new column to the model on the day it is added, silently. An allow-list fails the other way: a genuinely
 * needed field is missing until someone adds it on purpose.
 *
 * ⚠️ THE GUARD DOES NOT STRIP COMMENTS (test/helpers/import-ratchet.ts documents the trade: a regex
 * stripper mangles '//' inside string literals and starts MISSING real edges, and for a leak guard failing
 * loud in the safe direction is the correct bias). So the forbidden spellings must not appear in this
 * file's PROSE either. That is why the paragraphs above say "no such path" and "builds its own session"
 * rather than naming the tokens.
 */
import type { SessionContext } from '../db/client';
import type { AiJsonSchema, AiToolSpec } from '../lib/ai/types';
import {projectMineLeaveBalance,projectMineLeaveEntitlement} from './assistant-leave-projection';
import { AGENT_MODULE_CODES, isAgentModuleCode } from '../lib/ai/module-agents';
import { todayInKualaLumpur } from '../lib/hr-date';
// Reads `statutory.componentLines` BY SHAPE, so this file consumes the kernel's stamp without importing
// core/payroll and dragging the engine into every assistant caller.
import { storedComponentLines } from './payslip-earning-lines';
import { isModuleEnabled } from './entitlements';
import { ASSISTANT_PUBLIC_REPLIES } from '../lib/ai/assistant-public-replies';
import { withAssistantRead, type AssistantReadSession } from './assistant-read-session';

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The refusal vocabulary
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Why the model was told "no" — a legitimate ANSWER, never a fault.
 *
 * A scope refusal is `ok: false` here but reaches the model as an ORDINARY tool result with no error
 * flag (ADR-0082 §5). Marking it as a fault pushes the model toward retrying or apologising instead of
 * relaying the plain truth, and "you are not allowed to see this person" IS the correct answer to the
 * question that was asked. Genuine faults — a dropped connection, a thrown read — are not caught in this
 * file at all and surface to the loop, which is what turns them into an error result.
 */
export type ToolRefusalCode =
  /** The caller has no employee record at all — an admin or support login with no linked person. */
  | 'no_employment'
  /**
   * The subject is not visible to the caller — OR does not exist. ONE code and ONE sentence for both,
   * deliberately: separating them turns the tool into an existence oracle over the whole tenant, which
   * is the disclosure test/notice-board-rls.test.ts refuses for the same reason.
   */
  | 'not_visible'
  /** The subject exists and may even be visible, but the caller does not manage them. */
  | 'not_your_report'
  /** In scope, nothing to return — e.g. a leave type the caller's own record carries no entitlement on. */
  | 'no_data'
  /** The model's arguments did not validate against the declared schema. */
  | 'invalid_input'
  /** A window wider than the tool will answer. */
  | 'out_of_range';

export type ToolOutcome =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; refusal: ToolRefusalCode; message: string };

export type AssistantTool = {
  spec: AiToolSpec;
  /**
   * Runs against the CALLER's context, never a constructed or elevated one. The wrapper receives no
   * query handle. The read facade owns one caller-bound transaction or an explicitly supplied session.
   */
  run(ctx: SessionContext, input: unknown, readSession?: AssistantReadSession): Promise<ToolOutcome>;
  /**
   * The module this tool's data belongs to; not offered when the tenant does not hold it (ADR-0077).
   *
   * `string | null`, not a narrower alias: `ModuleCatalogEntry.code` is a plain string and no ModuleCode
   * type exists anywhere in this codebase (ADR-0082 §2.3 assumes one).
   */
  module: string | null;
  /** Reads that carry money or identity are declared, for the audit trail and the admin toggle. */
  sensitivity: 'ordinary' | 'pay' | 'identity';
};

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * Registry-level mechanics — defined once so a tool added later inherits them without a type change
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** The most rows any tool will hand back in one result. */
const ROW_CAP = 50;

/** The widest window `who_is_away` will answer, in days. */
const AWAY_WINDOW_DAYS = 62;

const refuse = (refusal: ToolRefusalCode, message: string): ToolOutcome => ({
  ok: false,
  refusal,
  message: refusal === 'not_visible' || refusal === 'not_your_report' ? ASSISTANT_PUBLIC_REPLIES.access : message,
});

/**
 * Truncate to a ceiling and SAY SO. `truncated` and `totalRows` exist because a silently short list is
 * indistinguishable from a complete one, and the model will present it as complete.
 */
const cap = <T>(rows: T[], n = ROW_CAP) => ({
  rows: rows.slice(0, n),
  truncated: rows.length > n,
  totalRows: rows.length,
});

/**
 * drizzle `numeric` arrives as a STRING, and inconsistently: `leaveBalances` already coerces, while
 * `leaveRequestsFor.days`, `plannedAbsences.leaves[].days/hours` and `myPayslips.gross/net` do not.
 * Serialising both shapes hands the model `"3.00"` for one read and `3` for another, and any arithmetic
 * it then attempts is a factuality failure of exactly the kind the assistant is meant not to produce.
 *
 * Applied per FIELD, never blanket: an employee code like '0012' must stay a string, and a blanket
 * coercer would hand the model 12.
 */
const num = (v: string | number | null | undefined): number | null =>
  v == null ? null : typeof v === 'number' ? v : Number(v);

/**
 * A calendar date the model supplied. BOTH halves are load-bearing: the pattern rejects prose, and the
 * parse rejects a well-shaped impossibility like 2026-02-30, which the pattern alone admits and which
 * would otherwise reach a query as a silently wrong window.
 */
/**
 * A REAL calendar date, not merely a well-shaped string.
 *
 * THE ROUND-TRIP IS THE WHOLE CHECK. `Date.parse('2026-02-30T00:00:00Z')` does NOT fail — it ROLLS OVER
 * to 2026-03-02 and returns a perfectly finite timestamp, so format + finiteness accepted every
 * impossible date the model could invent: 30 February, 31 April, 31 June. The value then reached
 * Postgres as a bound parameter and came back as `22008 date/time field value out of range`, thrown out
 * of the tool instead of the structured refusal the tool declares. Every date a tool takes is
 * MODEL-SUPPLIED, so this is the ordinary case, not the edge one.
 */
const isIsoDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === v;
};

const daysBetween = (a: string, b: string) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

const asObject = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

/**
 * One integer argument, validated against the same bounds the schema declares.
 *
 * A DIGIT STRING IS ACCEPTED, and that is not laxity. The three SDKs disagree about JSON number
 * fidelity and at least one routinely renders tool arguments as strings; refusing `"5"` would spend a
 * whole turn on a disagreement between vendors rather than on anything the user asked. Everything else
 * — absent, fractional, out of range, prose — refuses, and the message names the bound so the model's
 * retry is informed rather than a guess.
 */
function intArg(o: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const raw = o[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function strArg(o: Record<string, unknown>, key: string): string | null {
  const raw = o[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * A syntactically valid UUID, checked BEFORE the value becomes a bound query parameter.
 *
 * EVERY IDENTIFIER A TOOL RECEIVES IS MODEL-SUPPLIED, and the tool descriptions say "do not guess one"
 * precisely because the model sometimes will — `employment_id: "E12345"` from a user who quoted their
 * staff number. A non-empty-string check passes that straight through to a uuid comparison, where
 * Postgres raises `22P02 invalid input syntax for type uuid` OUT of the tool, as an exception, instead
 * of the structured refusal the tool declares and the loop knows how to relay. Same shape as the
 * calendar-date rollover above: the model's ordinary behaviour, not an edge case.
 */
const isUuid = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** `strArg` plus the uuid check — for the arguments that reach an id column. */
function idArg(o: Record<string, unknown>, key: string): string | null {
  const raw = strArg(o, key);
  return raw !== null && isUuid(raw) ? raw : null;
}

/**
 * Every property is REQUIRED. OpenAI's strict mode demands it, and ADR-0082 §2.2 mechanic 4 wants a
 * validated input more here than in an ordinary loop: these become query parameters against tables whose
 * scope the database is enforcing, so a half-specified call is a query nobody wrote.
 */

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The twelve read-only tools
 *
 * ORDER IS LOAD-BEARING AND MUST NOT BE SORTED AT CALL TIME. `tools` renders BEFORE `system` in the
 * cacheable prefix (ADR-0082 §2.2), and prompt caching is a PREFIX match: one reordered byte invalidates
 * everything after it and costs roughly ten times as much per request while reporting nothing at all.
 * New tools are APPENDED, never inserted, so a change confines itself to a suffix.
 *
 * HOW `search_handbook` SLOTS IN LATER WITHOUT REOPENING ANY OF THIS: it is one appended element with
 * `module: 'knowledge_base'` (already a catalog code) and `sensitivity: 'ordinary'` (already in the
 * union). `ToolOutcome`, `cap()` and the refusal codes are registry-level, so a ranked result set
 * inherits truncation and the refusal envelope for free. The only new work is its own slice's full-text
 * index and a ctx-first search read — neither of which exists in this codebase today, which is why it is
 * not in the current catalogue.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

const myLeaveBalances: AssistantTool = {
  module: 'leave',
  sensitivity: 'ordinary',
  spec: assistantToolSpec('my_leave_balances'),
  async run(ctx, _input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'leave', async (read): Promise<ToolOutcome> => {
    const emps = await read.myEmployments();
    if (emps.length === 0) {
      return refuse('no_employment', 'The asking user has no employee record, so they hold no leave balance.');
    }
    const employments = [];
    for (const e of emps) {
      // NO `locale`, and NEVER `includeHidden`. That flag defeats the visible-to-employee gate, and
      // core/read.ts names its only two legitimate callers — an admin screen and the shared-pool summer.
      // An assistant answering an employee would be a third, on an employee-facing path.
      // ec991c2a — and never `includeArchived` either, for the same reason: this answers an EMPLOYEE about
      // their own leave, so it must return the list their own screen returns. Stated explicitly.
      // d272834b — and never `includeIneligible` either, for the third time and the same reason: this
      // answers an EMPLOYEE about their own leave, so it must return the list their own screen returns.
      // An assistant that named a Maternity balance a man was never eligible for would be reintroducing
      // the reported defect through a channel with no card to look at.
      const rows = await read.leaveBalances(e.employmentId, undefined, { includeArchived: false });
      employments.push({
        employmentId: e.employmentId,
        company: e.company,
        balances: rows.map(projectMineLeaveBalance),
      });
    }
    return { ok: true, employments };

    }, readSession);
  },
};

const myLeaveRequests: AssistantTool = {
  module: 'leave',
  sensitivity: 'ordinary',
  spec: assistantToolSpec('my_leave_requests'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'leave', async (read): Promise<ToolOutcome> => {
    const limit = intArg(asObject(input), 'limit', 1, 25);
    if (limit === null) return refuse('invalid_input', '`limit` must be a whole number between 1 and 25.');
    const emps = await read.myEmployments();
    if (emps.length === 0) {
      return refuse('no_employment', 'The asking user has no employee record, so they have no leave applications.');
    }
    const merged = [];
    for (const e of emps) {
      for (const r of await read.leaveRequestsFor(e.employmentId)) {
        merged.push({
          company:e.company,
          leaveTypeId: r.leaveTypeId,
          leaveType: r.leaveType,
          status: r.status,
          startDate: r.startDate,
          endDate: r.endDate,
          days: num(r.days),
          hours: num(r.hours),
          durationType: r.durationType,
          fromTime: r.fromTime,
          toTime: r.toTime,
          reason: r.reason,
          employeeRemark: r.employeeRemark,
          workingDates: r.workingDates,
          hasDocument: r.hasDocument,
          hasRejectedDates: r.hasRejectedDates,
        });
      }
    }
    // `leaveRequestsFor` is unbounded — every application for the employment, ever — and the cap belongs
    // HERE rather than in core/read.ts, whose screen callers legitimately want the whole set.
    merged.sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0));
    return { ok: true, ...cap(merged, limit) };

    }, readSession);
  },
};

const leaveEntitlementExplain: AssistantTool = {
  module: 'leave',
  sensitivity: 'ordinary',
  spec: assistantToolSpec('leave_entitlement_explain'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'leave', async (read): Promise<ToolOutcome> => {
    const o = asObject(input);
    const leaveTypeId = idArg(o, 'leave_type_id');
    if (!leaveTypeId) return refuse('invalid_input', '`leave_type_id` must be an id from a my_leave_balances result.');
    const asOf = o.as_of;
    if (!isIsoDate(asOf)) return refuse('invalid_input', '`as_of` must be a real calendar date in YYYY-MM-DD form.');
    const emps = await read.myEmployments();
    if (emps.length === 0) {
      return refuse('no_employment', 'The asking user has no employee record, so they hold no entitlement.');
    }
    // EVERY EMPLOYMENT, NOT `emps[0]`. This tool consumes a leaveTypeId produced by my_leave_balances,
    // which loops over all of them — and `leave_type` is TENANT-scoped, not per-employment, so the id
    // alone cannot say which employment it came from. Resolving the earliest employment therefore
    // answered a shared-services employee's question about Company B with Company A's cycle start,
    // brought-forward and entitlement, silently and with no way for the model to ask for the other one.
    // A wrong figure stated confidently is the failure ADR-0082 §7 exists to prevent, so the tool now
    // returns one breakdown per employment and lets the model name the company it is quoting.
    const breakdowns = [];
    for (const e of emps) {
      const row = await read.leaveEntitlementBreakdown(e.employmentId, leaveTypeId, asOf);
      if (row) breakdowns.push({ employment: e, breakdown: row });
    }
    if (breakdowns.length === 0) {
      return refuse('no_data', 'That leave type carries no entitlement on the asking user’s own record.');
    }
    // EVERY FIGURE SITS UNDER THE EMPLOYMENT IT BELONGS TO. Hoisting any of them to the top level is
    // what created the defect this shape replaces: a single `cycleStart` or `totalEntitlement` beside a
    // list of employments reads as "the" answer, and the model quotes it for whichever company the user
    // asked about.
    return {
      ok: true,
      leaveTypeId,
      asOf,
      employments: breakdowns.map(({ employment, breakdown: b }) => ({
        employmentId: employment.employmentId,
        company: employment.company,
        ...projectMineLeaveEntitlement(b),
      })),
    };

    }, readSession);
  },
};

const upcomingHolidaysTool: AssistantTool = {
  module: 'org',
  sensitivity: 'ordinary',
  spec: assistantToolSpec('upcoming_holidays'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'org', async (read): Promise<ToolOutcome> => {
    const o = asObject(input);
    const from = o.from;
    if (!isIsoDate(from)) return refuse('invalid_input', '`from` must be a real calendar date in YYYY-MM-DD form.');
    const limit = intArg(o, 'limit', 1, 20);
    if (limit === null) return refuse('invalid_input', '`limit` must be a whole number between 1 and 20.');
    const me = await read.myEmployment();
    if (!me) {
      return refuse(
        'no_employment',
        'The asking user has no employee record, so no holiday calendar resolves for them.',
      );
    }
    // TWO READS, because neither answers on its own. `upcomingHolidays` is tenant-wide — it filters on the
    // DATE and nothing else — so it supplies NAMES and an ordering; `holidayDatesForEmployment` resolves
    // what this employment actually observes and supplies the FILTER. Over-fetch the candidates because
    // the filter removes an unknown fraction of them.
    const candidates = await read.upcomingHolidays({ from, limit: limit * 4 });
    if (candidates.length === 0) return { ok: true, employmentId: me.employmentId, holidays: [] };
    const observed = new Set(
      await read.holidayDatesForEmployment({
        employmentId: me.employmentId,
        from,
        to: candidates[candidates.length - 1].date,
      }),
    );
    const holidays: { date: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (!observed.has(c.date) || seen.has(c.date)) continue;
      seen.add(c.date);
      holidays.push({ date: c.date, name: c.name });
      if (holidays.length >= limit) break;
    }
    // Stated honestly rather than hidden: two holiday rows can share a date under different names, so the
    // DATE is always right and the NAME is best-effort. The alternative — returning the tenant-wide list
    // with a caveat in the description — is worse, because the model relays the list and the caveat
    // competes with it for attention.
    return { ok: true, employmentId: me.employmentId, holidays };

    }, readSession);
  },
};

const whoIsAway: AssistantTool = {
  module: 'leave',
  sensitivity: 'ordinary',
  spec: assistantToolSpec('who_is_away'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'leave', async (read): Promise<ToolOutcome> => {
    const o = asObject(input);
    const from = o.from;
    const to = o.to;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return refuse('invalid_input', '`from` and `to` must both be real calendar dates in YYYY-MM-DD form.');
    }
    if (to < from) return refuse('invalid_input', '`to` must be on or after `from`.');
    if (daysBetween(from, to) > AWAY_WINDOW_DAYS) {
      return refuse('out_of_range', `The window must be ${AWAY_WINDOW_DAYS} days or less. Ask for a narrower range.`);
    }
    // `companyIds: undefined`, never a fabricated list — a company filter is a UX narrowing driven by the
    // viewer's scope cookie, and a tool has no cookie. `opts.personIds` is likewise never passed: an empty
    // array there matches a sentinel id and would silently return zero people rather than everyone.
    // `today` is omitted on purpose: supplying it makes the read resolve per-employment working-date sets
    // for a cancellation affordance this tool discards, at a round trip per employment.
    const people = await read.plannedAbsences(undefined, { from, to });
    // THE READ RETURNS EVERY VISIBLE PERSON, INCLUDING THOSE WITH NO LEAVE IN THE WINDOW — the calendar it
    // was built for needs the empty rows to draw them. Without this filter the tool would answer "who is
    // away" with the whole headcount, and its count branch would trip on tenant size rather than on
    // absences.
    const away = people.filter((p) => p.leaves.length > 0);
    if (away.length > ROW_CAP) {
      return {
        ok: true,
        mode: 'count',
        from,
        to,
        personCount: away.length,
        approvedOnFromDate: await read.awayTodayCount(undefined, from),
      };
    }
    return {
      ok: true,
      mode: 'list',
      from,
      to,
      ...cap(
        away.map((p) => ({
          personName: p.name,
          employeeCode: p.employeeCode,
          // The ids team_leave_summary and employee_profile accept. A person holding concurrent
          // employments has more than one.
          employmentIds: p.employmentIds,
          absences: p.leaves.map((l) => ({
            leaveType: l.typeName,
            status: l.status,
            startDate: l.startDate,
            endDate: l.endDate,
            days: num(l.days),
            hours: num(l.hours),
          })),
        })),
      ),
    };

    }, readSession);
  },
};

const teamLeaveSummary: AssistantTool = {
  module: 'leave',
  sensitivity: 'ordinary',
  spec: assistantToolSpec('team_leave_summary'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'leave', async (read): Promise<ToolOutcome> => {
    const employmentId = idArg(asObject(input), 'employment_id');
    if (!employmentId) {
      return refuse('invalid_input', '`employment_id` must be an id from a previous tool result.');
    }
    // The date comes from the house clock, never from the model: a subject-supplied "today" would move
    // what counts as upcoming. This read's own gate is NARROWER than the database's — self, plain HR
    // admins and heads of department all get nothing — and that is correct for a manager affordance. It
    // must not be "fixed" by falling back to a wider balance read.
    const rows = await read.subordinateLeaveSummary(employmentId, todayInKualaLumpur());
    if (rows === null) {
      return refuse('not_your_report', 'That person does not report to the asking user, so their leave is not shown.');
    }
    return {
      ok: true,
      employmentId,
      ...cap(
        rows.map((r) => ({
          leaveTypeId: r.leaveTypeId,
          leaveType: r.leaveType,
          balance: r.balance,
          pendingCount: r.pendingCount,
          upcomingFrom: r.upcomingFrom,
          upcomingTo: r.upcomingTo,
        })),
      ),
    };

    }, readSession);
  },
};

/**
 * The ten fields `employee_profile` will return, and the ONLY ten.
 *
 * Exported so the guard can pin them from outside rather than restating them, which is what keeps the
 * list and its test from drifting apart. `employeeDetail` projects roughly ninety columns including date
 * of birth, gender, marital status, race, religion, nationality, three postal addresses, personal phone
 * and email, and the emergency-contact register. The narrowing IS the tool.
 */
export const EMPLOYEE_PROFILE_FIELDS = [
  'employmentId',
  'employeeCode',
  'name',
  'company',
  'gradeName',
  'holidayGroupName',
  'workState',
  'hiredOn',
  'joinDate',
  'terminatedOn',
] as const;

const employeeProfile: AssistantTool = {
  module: 'employees',
  sensitivity: 'identity',
  spec: assistantToolSpec('employee_profile'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'employees', async (read): Promise<ToolOutcome> => {
    const employmentId = idArg(asObject(input), 'employment_id');
    if (!employmentId) {
      return refuse('invalid_input', '`employment_id` must be an id from a previous tool result.');
    }
    const d = await read.employeeDetail(employmentId);
    // ONE sentence for "you may not see this person" and for "no such employment". Telling them apart
    // would let the model enumerate which ids exist across the whole tenant, one refusal at a time.
    if (!d) {
      return refuse('not_visible', 'That employee is not visible to the asking user.');
    }
    return {
      ok: true,
      employee: {
        employmentId: d.employmentId,
        employeeCode: d.employeeCode,
        name: d.name,
        company: d.company,
        gradeName: d.gradeName,
        holidayGroupName: d.holidayGroupName,
        workState: d.workState,
        hiredOn: d.hiredOn,
        joinDate: d.joinDate,
        terminatedOn: d.terminatedOn,
      },
    };

    }, readSession);
  },
};

const myReportingLine: AssistantTool = {
  module: 'org',
  sensitivity: 'ordinary',
  spec: assistantToolSpec('my_reporting_line'),
  async run(ctx, _input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'org', async (read): Promise<ToolOutcome> => {
    const me = await read.myEmployment();
    if (!me) {
      return refuse('no_employment', 'The asking user has no employee record, so they have no reporting line.');
    }
    // THE ABSENCE OF AN employment_id ARGUMENT IS A SECURITY CONTROL, NOT AN ERGONOMIC CHOICE.
    // `reporting_line`'s read policy is tenant-wide and nothing more: the SUBJECT employment is never
    // access-checked, and the only gate is the join onto the COUNTERPARTY. A caller who could name an
    // arbitrary employment would learn "X reports to Y" for every Y they can see — the org chart of a
    // department they have no business reading. Hard-binding the subject to the caller's own employment
    // closes that, and it is why ADR-0082 §2.4's "exfiltration beyond scope: impossible via tools" is not
    // true of this read as written.
    // A SECOND, QUIETER PROPERTY OF THIS READ, verified against app.can_see_employment (0109) rather than
    // assumed: both halves inner-join the COUNTERPARTY's employment row, so a counterparty the caller may
    // not see drops out silently. For an ordinary employee that is their own manager — the policy admits
    // self, admins, managers looking DOWN and heads of department, and none of those is "my boss". So
    // `managers` is routinely empty for exactly the person most likely to ask. The tool does not paper
    // over it (there is no ctx-first self-superior read to paper over it WITH); the description tells the
    // model what an empty list does and does not mean, because the failure mode otherwise is a confident,
    // wrong "you report to nobody".
    const lines = await read.reportingLinesFor(me.employmentId);
    return {
      ok: true,
      employmentId: me.employmentId,
      managers: lines.managers.map((m) => ({
        name: m.name,
        employeeCode: m.employeeCode,
        lineType: m.lineType,
      })),
      reports: lines.reports.map((r) => ({
        name: r.name,
        employmentId: r.employmentId,
        lineType: r.lineType,
      })),
    };

    }, readSession);
  },
};

const myPayslipSummary: AssistantTool = {
  module: 'payroll',
  sensitivity: 'pay',
  spec: assistantToolSpec('my_payslip_summary'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'payroll', async (read): Promise<ToolOutcome> => {
    const limit = intArg(asObject(input), 'limit', 1, 12);
    if (limit === null) return refuse('invalid_input', '`limit` must be a whole number between 1 and 12.');
    // Leaver-safe on purpose: a resigned employee asking for their pay history is exactly the caller this
    // serves, and the narrower active-only resolver would answer nothing for them.
    const ids = (await read.myEmploymentIdsAll()).map((e) => e.employmentId);
    if (ids.length === 0) {
      return refuse('no_employment', 'The asking user has no employee record, so they have no payslips.');
    }
    const rows = await read.myPayslips(ids);
    // THE RELEASE FILTER IS MANDATORY AND LIVES HERE. `myPayslips` does not enforce the self-service
    // release gate — it STAMPS a flag and lets the caller filter, and its own comment says the employee's
    // payslip section is what filters on it. Without this line the assistant would quote an unreleased
    // payslip the employee's own screen refuses to show them. `statutory` (the contribution breakdown and
    // the tax-relief record) is dropped entirely by the projection below.
    const released = rows
      .filter((r) => r.released)
      .map((r) => ({
        payPeriod: r.payPeriod,
        company: r.company,
        runType: r.runType,
        gross: num(r.gross),
        deductions: num(r.deductions),
        net: num(r.net),
      }));
    return { ok: true, ...cap(released, limit) };

    }, readSession);
  },
};


/**
 * ADR-0074 item 5 — THE EMPLOYEE-FACING EXPLANATION AGENT, as a tool rather than a screen.
 *
 * "Why is my pay different this month?" is the question that actually consumes a payroll team's day, and
 * ADR-0074 lists deflecting it as its own item precisely because answering it faster is worth less than
 * not being asked. Built as a registry tool rather than a bespoke surface so it inherits the whole loop:
 * the caller's own SessionContext (so RLS scopes it), the budget gate, the audit row, and the refusal
 * envelope.
 *
 * THE ARITHMETIC IS DONE HERE. Every difference below is computed in this function and handed to the
 * model already worked out. That is ADR-0074's non-negotiable invariant — the LLM never computes the
 * money — and it is also what makes the answer checkable: each number the employee is told corresponds
 * to a subtraction someone can repeat against their own two payslips.
 *
 * THE RELEASE FILTER IS MANDATORY AND IS THE SAME ONE `my_payslip_summary` DOCUMENTS. `myPayslips`
 * STAMPS a `released` flag rather than enforcing it; without this filter the assistant would explain a
 * payslip the employee's own screen refuses to show them.
 *
 * A PERIOD IS SUMMED ACROSS ITS RUNS, deliberately. An employee thinks in months; payroll thinks in runs,
 * and a month can carry a regular run plus a bonus or off-cycle one. Comparing single runs would answer
 * "why is this PAYSLIP different", which is a question nobody asked and whose answer ("because it is the
 * bonus run") is not the one they need.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN: the statutory breakdown. `statutory` carries the EPF/SOCSO/PCB
 * split and the tax-relief record, and only the component lines are projected out of it — the same
 * restraint `my_payslip_summary` states. A deduction TOTAL that moved is reported and is usually the
 * answer; the split is on the employee's own payslip, which they can already open.
 */
const myPayChange: AssistantTool = {
  module: 'payroll',
  sensitivity: 'pay',
  spec: assistantToolSpec('my_pay_change'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'payroll', async (read): Promise<ToolOutcome> => {
    const period = strArg(asObject(input), 'period');
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return refuse('invalid_input', '`period` must be a month in YYYY-MM form, for example 2026-08.');
    }
    const ids = (await read.myEmploymentIdsAll()).map((e) => e.employmentId);
    if (ids.length === 0) {
      return refuse('no_employment', 'The asking user has no employee record, so they have no payslips.');
    }

    const released = (await read.myPayslips(ids)).filter((r) => r.released);
    if (released.length === 0) return refuse('no_data', 'The asking user has no released payslips.');

    // Sum each period across its runs — see the header on why a month, not a payslip, is the unit.
    const byPeriod = new Map<string, { gross: number; deductions: number; net: number; lines: Map<string, { name: string; amount: number }> }>();
    for (const r of released) {
      const acc = byPeriod.get(r.payPeriod) ?? { gross: 0, deductions: 0, net: 0, lines: new Map() };
      acc.gross += num(r.gross) ?? 0;
      acc.deductions += num(r.deductions) ?? 0;
      acc.net += num(r.net) ?? 0;
      // ONLY the component lines are taken out of `statutory`. The rest of that object is the
      // contribution breakdown and the tax-relief record and must not reach the model.
      for (const line of storedComponentLines(r.statutory)) {
        const code = (line.code ?? '').trim();
        if (!code) continue;
        const prev = acc.lines.get(code);
        acc.lines.set(code, {
          name: (line.name ?? code).trim() || code,
          amount: (prev?.amount ?? 0) + (num(line.amount as string | number | null) ?? 0),
        });
      }
      byPeriod.set(r.payPeriod, acc);
    }

    const current = byPeriod.get(period);
    if (!current) {
      return refuse('no_data', `The asking user has no released payslip for ${period}.`);
    }
    // The previous period they were actually PAID for, which is not necessarily the previous calendar
    // month — a leaver, a joiner or an unpaid month all leave gaps, and stepping back one month would
    // compare against nothing and read as "your pay fell to zero".
    const earlier = [...byPeriod.keys()].filter((p) => p < period).sort();
    const previousPeriod = earlier.length ? earlier[earlier.length - 1]! : null;
    const round2 = (n: number) => Math.round(n * 100) / 100;

    if (!previousPeriod) {
      return {
        ok: true,
        period,
        previousPeriod: null,
        // Stated rather than left to inference: with one payslip there is nothing to compare, and a
        // model handed a lone figure will otherwise describe it as though it were a change.
        note: 'This is the earliest released payslip, so there is no previous period to compare it against.',
        gross: round2(current.gross),
        deductions: round2(current.deductions),
        net: round2(current.net),
      };
    }

    const prev = byPeriod.get(previousPeriod)!;
    const codes = new Set([...current.lines.keys(), ...prev.lines.keys()]);
    const lines = [...codes]
      .map((code) => {
        const c = current.lines.get(code);
        const p = prev.lines.get(code);
        return {
          code,
          name: c?.name ?? p?.name ?? code,
          current: round2(c?.amount ?? 0),
          previous: round2(p?.amount ?? 0),
          change: round2((c?.amount ?? 0) - (p?.amount ?? 0)),
        };
      })
      // Unchanged items are dropped: they are not why the pay is different, and a list of twenty
      // identical rows buries the two that moved.
      .filter((l) => l.change !== 0)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
      ok: true,
      period,
      previousPeriod,
      gross: { current: round2(current.gross), previous: round2(prev.gross), change: round2(current.gross - prev.gross) },
      deductions: {
        current: round2(current.deductions),
        previous: round2(prev.deductions),
        change: round2(current.deductions - prev.deductions),
      },
      net: { current: round2(current.net), previous: round2(prev.net), change: round2(current.net - prev.net) },
      ...cap(lines, 25),
    };

    }, readSession);
  },
};

/** Claims specialist read: server-owned self selection and minimal canonical status fields. */
const myClaimStatuses: AssistantTool = {
  module: 'claims',
  sensitivity: 'ordinary',
  spec: assistantToolSpec('my_claim_statuses'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    return withAssistantRead(ctx, 'claims', async (read): Promise<ToolOutcome> => {
    const object = asObject(input);
    if (Object.keys(object).some(key => key !== 'limit')) return refuse('invalid_input', 'Only a record limit is accepted.');
    const limit = intArg(object, 'limit', 1, 25);
    if (limit === null) return refuse('invalid_input', 'Limit must be an integer from 1 to 25.');
    const result = await read.ownClaimStatuses(limit);
    if (!result.hasEmployment) return refuse('no_employment', 'The asking user has no employee record.');
    return { ok: true, claims: result.claims, returnedRows: result.claims.length, truncated: result.truncated };

    }, readSession);
  },
};

const myModuleWork: AssistantTool = {
  module: null,
  // The union includes released pay data. A generic ordinary flag must not evade pay controls.
  sensitivity: 'pay',
  spec: assistantToolSpec('my_module_work'),
  async run(ctx, input, readSession?: AssistantReadSession) {
    const object = asObject(input);
    if (Object.keys(object).some(key => key !== 'module') || !isAgentModuleCode(object.module)) {
      return refuse('invalid_input', 'Choose one supported module.');
    }
    const module = object.module;
    return withAssistantRead(ctx, module, async (read): Promise<ToolOutcome> => ({
      ok: true, ...(await read.moduleSpecialistWork(module)),
    }), readSession);
  },
};

/** APPEND ONLY — see the prefix-caching note above. */
export const ASSISTANT_TOOLS: readonly AssistantTool[] = [
  myLeaveBalances,
  myLeaveRequests,
  leaveEntitlementExplain,
  upcomingHolidaysTool,
  whoIsAway,
  teamLeaveSummary,
  employeeProfile,
  myReportingLine,
  myPayslipSummary,
  // ADR-0074 item 5. APPENDED, never inserted — one reordered byte invalidates the cached prefix.
  myPayChange,
  myClaimStatuses,
  myModuleWork,
];

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * Selection
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The tools this caller may be offered.
 *
 * This baseline selector filters by module. The active conversation strategy may select a per-user
 * prompt/tool description, so cache reuse also depends on that versioned strategy. Keep prefix order stable.
 *
 * The twelve tools include core reads, two payroll reads, own claim status and the module-work read. This selection only determines the offered catalogue. The Claims source
 * reader independently rechecks its actual entitlement and principal before projecting data.
 * An offered name is never an authorization capability or an effect command.
 *
 * `isModuleEnabled` can throw for an exempt context; that is not caught here and cannot arise in
 * practice, because an exchange is gated by assertMayUseAssistant() first and `assistant` is itself
 * billable — an exempt context has already thrown by the time this runs.
 */
export function toolsFor(ctx: SessionContext): AssistantTool[] {
  return ASSISTANT_TOOLS.filter((t) => t.module === null || isModuleEnabled(ctx, t.module));
}

export const specsFor = (ctx: SessionContext): AiToolSpec[] => toolsFor(ctx).map((t) => t.spec);

// There is deliberately NO lookup across all of ASSISTANT_TOOLS. Dispatch resolves a call only from the
// list toolsFor() offered for this exchange (core/assistant.ts runTools); a lookup over the whole
// registry is how a tool the tenant does not hold (my_payslip_summary without payroll) used to run when
// the model named it. test/assistant-dispatch-offered.test.ts pins it.
