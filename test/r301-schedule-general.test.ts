/**
 * 6d091cc0 (r301) — Attendance › Schedule › General becomes the ONE schedule setup page.
 *
 * The approved plan moved two screens onto this tab and removed the two links that led to them:
 *   Shifts available · Schedule Group · Company Policy Settings · Work Schedule & Overtime Rates · Not configured here
 * with the Schedule Group editor and each company's setting opening as PANELS on the same page, Delete on a
 * group asking first, no Delete on a company's setting, the old addresses landing on the matching card, and the
 * refused-Save-policy banner that never showed (a `?tab=general?error=…` URL) fixed.
 *
 * WHAT IS PINNED, AND HOW. Everything that can be RUN is run: the page is rendered through its real server
 * components against a real database; every moved writer is executed and the address it redirected to is read;
 * the redirect stubs are called; the Last-updated read is executed under RLS as three different sessions.
 *
 *   A. The General tab, rendered: the five cards in order, the two links gone, the moved blocks present.
 *   B. No element id is rendered twice — with no panel, and with each of the three panels open.
 *   C. Company Policy Settings: one row per company, Saved / Using defaults, Last updated three ways, no Delete.
 *   D. Schedule Group Delete: a confirmation, none on Standard, an in-use group refused with the shift named.
 *   E. Every moved writer returns to the General tab (the plain Schedule path) — and a refusal re-opens the panel
 *      it came from, or shows at the top, exactly once.
 *   F. THE BUG: a refused Save policy lands on a URL whose `error` parses, and the banner renders.
 *   G. The panel editors are the SAME forms posting the SAME fields: the group panel's markup is byte-identical
 *      to what the retired rules/[ruleId] page rendered, and the policy panel is that company's form alone.
 *   H. The old addresses are guarded redirects to the anchors (the guard runs first).
 *   I. Panel addressing: `?group=` (the Attendance/Overtime selector) opens no editor; an open panel forces General.
 *   J. Last updated is readable by an HR admin under RLS (group-wide and company-scoped), and by nobody else.
 *
 * FILE-LEVEL MOCKS, the house pattern (test/r299-leave-credit-deploy-day.test.ts, test/schedule-tab-writers.test.ts):
 * requireAdmin()/getSession() return the module-level ADMIN (or refuse, for H); redirect() throws a recognisable
 * error carrying its path; getTranslations is a REAL translator over messages/en.json that THROWS on a missing or
 * malformed message (so a MISSING_MESSAGE / FORMATTING_ERROR fails here, not only in a dev log); cookies() has no
 * company_scope. The services, RLS and the rendered components are the real ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { cloneElement, createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';

let ADMIN: SessionContext;
let REFUSE_ADMIN = false;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz')>()),
  requireAdmin: async () => {
    if (REFUSE_ADMIN) throw new Error('NOT_AN_ADMIN');
    return ADMIN;
  },
}));
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => ADMIN,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new RedirectError(p);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const messages = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        onError: (e) => {
          throw e;
        },
      }),
  };
});

import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { listAttendancePolicies, setAttendancePolicy } from '../core/attendance';
import {
  createAttendanceRule,
  ensureStandardRule,
  getAttendanceRule,
  listAttendanceRules,
  type AttendanceRuleInput,
} from '../core/attendance-rule';
import { createShift, listShiftsForTenant } from '../core/roster';
import { hireEmployee } from '../core/org';
import { registerDevice } from '../core/attendance-device';
import { setAttendancePolicyAction } from '../app/admin/actions';
import {
  copyAttendanceRuleAction,
  createAttendanceRuleAction,
  deleteAttendanceRuleAction,
  setAttendanceRuleStatusAction,
  updateAttendanceRuleAction,
} from '../app/admin/attendance-policy/rule-actions';
import { revokeDeviceAction } from '../app/admin/attendance-policy/device-actions';
import { setStatutoryComponentAction } from '../app/payroll/configuration/actions';
import { policyLastUpdated } from '../app/admin/attendance-policy/policy-last-updated';
import { RuleForm } from '../app/admin/attendance-policy/rules/rule-form';
import { ruleShiftChoices } from '../app/admin/attendance-policy/rules/shift-choices';
import { WorkScheduleForm } from '../app/admin/attendance-policy/schedule/work-schedule-form';
import SchedulePage from '../app/admin/attendance/schedule/page';
import OldScheduleGroupPage from '../app/admin/attendance-policy/page';
import OldWorkSchedulePage from '../app/admin/attendance-policy/schedule/page';
import OldNewRulePage from '../app/admin/attendance-policy/rules/new/page';
import OldEditRulePage from '../app/admin/attendance-policy/rules/[ruleId]/page';
import { todayInKualaLumpur } from '../lib/hr-date';

const root = path.resolve(__dirname, '..');
const en = JSON.parse(fs.readFileSync(path.join(root, 'messages/en.json'), 'utf8'));
const SC = en.admin.scheduleConfig;
const SCHEDULE = '/admin/attendance/schedule';

let b: Base;
let companyB: string; // SAVED row with no event (the provisioning shape)
let companyC: string; // no row at all (Using defaults)

const POLICY = (companyId: string) => ({
  companyId,
  workStart: '08:00',
  workEnd: '17:00',
  breakMinutes: 60,
  lateAfter: '08:15',
  halfDayBefore: '12:00',
  workingDays: [1, 2, 3, 4, 5],
});

const ruleInput = (over: Partial<AttendanceRuleInput> = {}): AttendanceRuleInput => ({
  name: `R_${randomUUID().slice(0, 8)}`,
  description: null,
  status: 'active',
  lateGracePeriodMinutes: 0,
  lateAfterMinutes: 0,
  lateDeductMinutes: 0,
  includeGraceInLateness: false,
  earlyGracePeriodMinutes: 0,
  earlyAfterMinutes: 0,
  earlyDeductMinutes: 0,
  includeGraceInEarlyOut: false,
  applyToEarlyOt: false,
  otRows: [],
  ...over,
});

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Run something that ends in redirect() and return where it went. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected a redirect, but none happened');
}

/** The query of a redirect target, parsed the way a browser (and Next) parses it. */
const queryOf = (target: string) => new URL(target, 'http://x').searchParams;

// ── rendering ──────────────────────────────────────────────────────────────────────────────────────────────

const isAsync = (f: unknown) =>
  typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';

/**
 * Await every async server component in a tree — INCLUDING ones passed through props that are not `children`.
 * The Schedule page hands its tab panels to ClientTabs as `panels={{ general, attendance, overtime }}`, so a
 * children-only walk (the r299 helper) would render the General tab's cards as unresolved promises.
 */
async function settle(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (isAsync(el.type)) return settle(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const next: Record<string, unknown> = {};
    let touched = false;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === 'children' || isValidElement(v) || Array.isArray(v) || isPlainRecord(v)) {
        next[k] = await settle(v);
        touched = true;
      }
    }
    return touched ? cloneElement(el, next) : el;
  }
  if (isPlainRecord(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = await settle(v);
    return out;
  }
  return node;
}
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !isValidElement(v) && Object.getPrototypeOf(v) === Object.prototype;
}

const toMarkup = async (tree: unknown) =>
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      timeZone: 'Asia/Kuala_Lumpur',
      messages: en,
      children: (await settle(tree)) as never,
    }),
  ).replace(/<script[\s\S]*?<\/script>/g, '');

type SP = { tab?: string; group?: string; error?: string; editGroup?: string; policy?: string; viewPolicy?: string };
const renderSchedule = async (sp: SP = {}) => toMarkup(await SchedulePage({ searchParams: Promise.resolve(sp) }));

/** React escapes text; compare against the escaped form. */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** The element whose start tag carries `id="<id>"`, up to its balanced closing tag. */
function elementById(html: string, id: string): string {
  const at = html.indexOf(` id="${id}"`);
  if (at < 0) return '';
  const start = html.lastIndexOf('<', at);
  const tag = /^<([a-z0-9]+)/.exec(html.slice(start))![1];
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return '';
}

/** Every rendered element id, with the ones that occur more than once. */
function duplicateIds(html: string): string[] {
  const seen = new Map<string, number>();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

/** The table row carrying `text` as a whole text node (a company name, a group name, an employee). */
function rowNaming(html: string, text: string): string {
  const rows = [...html.matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)].map((m) => m[0]);
  return rows.find((r) => r.includes(`>${esc(text)}<`)) ?? '';
}

// ── fixture ────────────────────────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  REFUSE_ADMIN = false;
  const [cb] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  companyB = cb.id;
  const [cc] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Gamma Sdn Bhd' })
    .returning({ id: schema.company.id });
  companyC = cc.id;
  // Company A: saved through the service (an attendance-policy.updated event exists).
  await setAttendancePolicy(ADMIN, POLICY(b.companyId));
  // Company B: a row written directly, as db/provision.ts seedCompanyCatalogs does — SAVED, but no event.
  await owner.db.insert(schema.attendancePolicy).values({ tenantId: b.tenantId, companyId: companyB });
  // Company C: nothing — every reader falls back to the built-in defaults.
});

// ── A ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('A. the General tab is the one setup page', () => {
  it('renders the five cards, in the approved order, on the General tab', async () => {
    const html = await renderSchedule();
    const general = elementById(html.replace('data-tabpanel="general"', 'id="__general" data-tabpanel="general"'), '__general');
    expect(general, 'the General tab panel rendered').not.toBe('');
    const ids = ['shifts-available', 'schedule-groups', 'company-policy-settings', 'work-schedule-overtime', 'not-configured-here'];
    const at = ids.map((id) => general.indexOf(` id="${id}"`));
    expect(at.every((i) => i > -1), `all five cards are on the General tab: ${JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, at[i]])))}`).toBe(true);
    expect([...at].sort((x, y) => x - y), 'in the order Shifts · Schedule Group · Company Policy · Work Schedule & OT · Not configured here').toEqual(at);
    // And each card says what it is, in the reporter's words.
    const titles = [SC.shiftsTitle, SC.groupTitle, SC.policyTitle, SC.wsOtTitle, SC.gapsTitle];
    for (const [i, id] of ids.entries()) {
      expect(elementById(general, id), `${id} is titled "${titles[i]}"`).toContain(esc(titles[i]));
    }
  });

  it('the two links away are gone', async () => {
    const html = await renderSchedule();
    expect(html, 'no link to the old Schedule Group list').not.toContain('href="/admin/attendance-policy"');
    expect(html, 'no link to the old Work Schedule page').not.toContain('href="/admin/attendance-policy/schedule"');
    expect(html, 'no link to the retired editor routes').not.toContain('href="/admin/attendance-policy/rules/');
    expect(html).not.toContain(esc(SC.workScheduleLink));
    expect(html).not.toContain(`>${esc(SC.groupLibraryLink)}<`);
  });

  it('Work Schedule & Overtime Rates carries overtime rates, registered devices with Revoke, and backup-shift coverage', async () => {
    const hire = await hireEmployee(ADMIN, {
      person: { fullName: 'Dev Holder', primaryEmail: `dev_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await registerDevice(ADMIN, { employmentId: hire.employmentId, label: 'Pixel 9' });
    const card = elementById(await renderSchedule(), 'work-schedule-overtime');
    const rates = elementById(card, 'overtime-rates');
    expect(rates, 'the overtime rates are on the card').toContain(esc(en.admin.attendancePolicy.otRatesTitle));
    expect(rates, 'with the publish form returning to the PLAIN Schedule path').toContain(
      `name="returnTo" value="${SCHEDULE}"`,
    );
    const devices = elementById(card, 'registered-devices');
    expect(devices).toContain('Pixel 9');
    expect(rowNaming(devices, 'Dev Holder'), 'each device row has Revoke').toContain(`>${en.admin.attendancePolicy.devRevoke}</button>`);
    const coverage = elementById(card, 'backup-shift-coverage');
    expect(coverage).toContain(esc(en.admin.attendancePolicy.coverageTitle));
    expect(coverage, 'the hire has no backup shift, so the coverage gap names them').toContain('Dev Holder');
  });
});

// ── B ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('B. no element id renders twice — now that two pages are one', () => {
  it('with no panel, the group editor, the policy editor, and the policy view', async () => {
    const group = await createAttendanceRule(ADMIN, ruleInput({ name: 'Office staff' }));
    for (const sp of [{}, { editGroup: group.id }, { editGroup: 'new' }, { policy: b.companyId }, { viewPolicy: companyB }] as SP[]) {
      const html = await renderSchedule(sp);
      expect(duplicateIds(html), `duplicate ids with ${JSON.stringify(sp)}`).toEqual([]);
    }
    // Non-vacuity: the per-company row ids AND the editor card's own id are both present at once.
    const withEditor = await renderSchedule({ policy: b.companyId });
    expect(withEditor).toContain(`id="policy-row-${b.companyId}"`);
    expect(withEditor).toContain(`id="policy-${b.companyId}"`);
  });
});

// ── C ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('C. Company Policy Settings — one row per company', () => {
  it('Saved / Using defaults, working hours, Last updated three ways, View and Edit — and no Delete', async () => {
    const card = elementById(await renderSchedule(), 'company-policy-settings');
    const [evt] = await owner.db
      .select({ at: schema.domainEvent.occurredAt })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'attendance-policy.updated')))
      .orderBy(desc(schema.domainEvent.sequence))
      .limit(1);

    const a = rowNaming(card, 'Acme Sdn Bhd');
    expect(a).toContain(`>${SC.policySaved}<`);
    expect(a, 'its own hours').toContain('08:00–17:00');
    expect(a, 'Last updated = the latest save, as a KL date').toContain(`>${todayInKualaLumpur(evt.at)}</td>`);

    const bRow = rowNaming(card, 'Beta Sdn Bhd');
    expect(bRow, 'a provisioned row is Saved').toContain(`>${SC.policySaved}<`);
    expect(bRow, 'but its change date is unknown, and says so').toContain(`>${SC.lastUpdatedNotRecorded}</td>`);

    const c = rowNaming(card, 'Gamma Sdn Bhd');
    expect(c).toContain(`>${en.admin.attendancePolicy.usingDefaults}<`);
    expect(c, 'the defaults are shown').toContain('09:00–18:00');
    expect(c, 'never saved: a dash').toContain('>—</td>');

    for (const [row, id] of [[a, b.companyId], [bRow, companyB], [c, companyC]] as const) {
      expect(row).toContain(`href="${SCHEDULE}?viewPolicy=${id}#schedule-panel"`);
      expect(row).toContain(`href="${SCHEDULE}?policy=${id}#schedule-panel"`);
      expect(row, 'no Delete on a company setting').not.toContain('>Delete<');
      expect(row).not.toContain('<form');
    }
    expect(card, 'the card says why there is no Delete').toContain(esc(SC.policyNoDelete));
  });

  it('View is read-only: that company’s figures, nothing that can be submitted', async () => {
    const html = await renderSchedule({ viewPolicy: b.companyId });
    const panel = elementById(html, 'schedule-panel');
    expect(panel).toContain(esc(SC.policyViewTitle.replace('{company}', 'Acme Sdn Bhd')));
    expect(panel).toContain('08:15'); // late after, company A's own
    expect(panel).not.toMatch(/<form|<input|<select|<textarea/);
    expect(panel, 'and it offers Edit for the same company').toContain(`href="${SCHEDULE}?policy=${b.companyId}#schedule-panel"`);
  });
});

// ── D ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('D. Schedule Group Delete asks first; Standard has none; an in-use group is refused', () => {
  it('the list: Delete is a confirmation trigger, not a submit button, and the Standard row has no Delete', async () => {
    await ensureStandardRule(ADMIN);
    await createAttendanceRule(ADMIN, ruleInput({ name: 'Office staff' }));
    const card = elementById(await renderSchedule(), 'schedule-groups');
    const standard = rowNaming(card, 'Standard');
    expect(standard, 'fixture: the Standard row rendered').toContain('>Edit<');
    expect(standard, 'Standard offers no Delete at all').not.toContain('>Delete<');
    expect(standard, 'but Duplicate and the toggle stay').toContain('>Duplicate<');

    const office = rowNaming(card, 'Office staff');
    const del = /<button[^>]*>Delete<\/button>/.exec(office)?.[0] ?? '';
    expect(del, 'the row has a Delete button').not.toBe('');
    expect(del, 'which does not submit on its own').toContain('type="button"');
    expect(del, 'it opens the confirmation dialog').toContain('aria-haspopup="dialog"');
    // …still inside the same form, posting the same one field, so Confirm submits exactly what a click did.
    const form = /<form[^>]*>(?:(?!<\/form>)[\s\S])*>Delete<\/button>(?:(?!<\/form>)[\s\S])*<\/form>/.exec(office)?.[0] ?? '';
    expect(form).toMatch(/<input type="hidden" name="ruleId" value="[0-9a-f-]{36}"\/>/);
    // The four actions, in order.
    const order = ['>Edit<', '>Duplicate<', '>Deactivate<', '>Delete<'].map((l) => office.indexOf(l));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(order[0]).toBeGreaterThan(-1);
  });

  it('the writer: an in-use group is refused, naming the shift; Standard is refused; an unused group goes', async () => {
    const standard = await ensureStandardRule(ADMIN);
    const used = await createAttendanceRule(ADMIN, ruleInput({ name: 'Used group' }));
    await createShift(ADMIN, {
      companyId: b.companyId,
      name: 'Night Crew',
      code: `N_${randomUUID().slice(0, 6)}`,
      startTime: '21:00:00',
      endTime: '06:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      ruleId: used.id,
    });
    const refused = await redirectOf(() => deleteAttendanceRuleAction(fd({ ruleId: used.id })));
    expect(refused.startsWith(`${SCHEDULE}?error=`), refused).toBe(true);
    expect(queryOf(refused).get('error')).toContain('Night Crew');
    expect(await getAttendanceRule(ADMIN, used.id), 'still there').not.toBeNull();

    const std = await redirectOf(() => deleteAttendanceRuleAction(fd({ ruleId: standard.id })));
    expect(std.startsWith(`${SCHEDULE}?error=`), std).toBe(true);
    expect(await getAttendanceRule(ADMIN, standard.id)).not.toBeNull();

    // …and the refusal is SHOWN on the General tab (no panel is open, so the page banner carries it).
    const html = await renderSchedule({ error: queryOf(refused).get('error')! });
    expect(html.split(esc(queryOf(refused).get('error')!)).length - 1, 'shown exactly once').toBe(1);

    const unused = await createAttendanceRule(ADMIN, ruleInput({ name: 'Unused group' }));
    expect(await redirectOf(() => deleteAttendanceRuleAction(fd({ ruleId: unused.id })))).toBe(SCHEDULE);
    expect(await getAttendanceRule(ADMIN, unused.id)).toBeNull();
  });
});

// ── E ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('E. every moved writer returns to the General tab', () => {
  it('Schedule Group: create, update, status, duplicate (opens the copy), and a refusal re-opens its panel', async () => {
    expect(await redirectOf(() => createAttendanceRuleAction(fd({ name: 'Warehouse' })))).toBe(SCHEDULE);
    const created = (await listAttendanceRules(ADMIN)).find((r) => r.name === 'Warehouse')!;
    expect(created).toBeDefined();

    expect(
      await redirectOf(() => updateAttendanceRuleAction(fd({ ruleId: created.id, name: 'Warehouse', status: 'active' }))),
    ).toBe(SCHEDULE);
    expect(
      await redirectOf(() => setAttendanceRuleStatusAction(fd({ ruleId: created.id, status: 'inactive' }))),
    ).toBe(SCHEDULE);
    expect((await getAttendanceRule(ADMIN, created.id))!.status).toBe('inactive');

    const copied = await redirectOf(() => copyAttendanceRuleAction(fd({ ruleId: created.id })));
    expect(copied.startsWith(`${SCHEDULE}?editGroup=`), copied).toBe(true);
    const copyId = queryOf(copied).get('editGroup')!;
    expect(copyId).not.toBe(created.id);
    const copy = await getAttendanceRule(ADMIN, copyId);
    expect(copy, 'the panel it opens is the COPY').not.toBeNull();
    const copyPanel = elementById(await renderSchedule({ editGroup: copyId }), 'schedule-panel');
    expect(copyPanel).toContain(`name="ruleId" value="${copyId}"`);
    expect(copyPanel).toContain(`value="${esc(copy!.name)}"`);

    // A refusal from the editor re-opens THAT panel with the message — shown once, inside it.
    const refused = await redirectOf(() => updateAttendanceRuleAction(fd({ ruleId: created.id, name: '', status: 'active' })));
    const q = queryOf(refused);
    expect(refused.startsWith(`${SCHEDULE}?editGroup=${created.id}&error=`), refused).toBe(true);
    const html = await renderSchedule({ editGroup: q.get('editGroup')!, error: q.get('error')! });
    expect(html.split(esc(q.get('error')!)).length - 1, 'the refusal is shown exactly once').toBe(1);
    expect(elementById(html, 'schedule-panel'), 'inside the panel it belongs to').toContain(esc(q.get('error')!));

    const refusedNew = await redirectOf(() => createAttendanceRuleAction(fd({ name: '' })));
    expect(refusedNew.startsWith(`${SCHEDULE}?editGroup=new&error=`), refusedNew).toBe(true);
  });

  it('Revoke a device, and publish the overtime rates, both return to the plain Schedule path', async () => {
    const hire = await hireEmployee(ADMIN, {
      person: { fullName: 'Revoke Me', primaryEmail: `rv_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    const { deviceId } = await registerDevice(ADMIN, { employmentId: hire.employmentId, label: 'Old phone' });
    expect(await redirectOf(() => revokeDeviceAction(fd({ deviceId })))).toBe(SCHEDULE);
    const [dev] = await owner.db.select().from(schema.employeeDevice).where(eq(schema.employeeDevice.id, deviceId));
    expect(dev.revokedAt).not.toBeNull();
    const missing = await redirectOf(() => revokeDeviceAction(fd({ deviceId: randomUUID() })));
    expect(missing.startsWith(`${SCHEDULE}?error=`), missing).toBe(true);

    // The overtime-rates form posts returnTo = the card's value; the statutory action accepts only a path with
    // no ? or #, so this is the check that the card's choice actually reaches the General tab. Refused on purpose
    // (no version), so nothing is published.
    const refusedOt = await redirectOf(() =>
      setStatutoryComponentAction(
        fd({ returnTo: SCHEDULE, body: 'ot', effectiveFrom: todayInKualaLumpur(), version: '', wageCeiling: '4000' }),
      ),
    );
    expect(refusedOt.startsWith(`${SCHEDULE}?error=`), refusedOt).toBe(true);
  });
});

// ── F ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('F. THE BUG — a refused Save policy shows its error', () => {
  it('the refusal lands on a URL whose error parses, and the General tab renders the banner', async () => {
    const target = await redirectOf(() =>
      setAttendancePolicyAction(
        fd({
          companyId: b.companyId,
          workStart: '18:00',
          workEnd: '09:00', // before the start: refused by the service
          breakMinutes: '60',
          lateAfter: '18:15',
          halfDayBefore: '13:00',
          dayType_1: 'full',
        }),
      ),
    );
    // Exactly one `?` — the old '?tab=general?error=…' read `tab` as 'general?error=…' and `error` as nothing.
    expect(target.split('?').length - 1, target).toBe(1);
    expect(target.startsWith(`${SCHEDULE}?error=`), target).toBe(true);
    const message = queryOf(target).get('error');
    expect(message).toBe('Work end must be after work start.');
    const html = await renderSchedule(Object.fromEntries(queryOf(target)) as SP);
    expect(html, 'the banner renders the refusal').toContain(`>${esc(message!)}</div>`);
    // …and the stored row did not move.
    const [pol] = await listAttendancePolicies(ADMIN, [b.companyId]);
    expect(pol.workStart).toBe('08:00:00');
  });

  it('a successful save returns to the plain General tab and changes only that company', async () => {
    const before = await listAttendancePolicies(ADMIN, [companyB, companyC]);
    const target = await redirectOf(() =>
      setAttendancePolicyAction(
        fd({ ...Object.fromEntries(Object.entries(POLICY(b.companyId)).map(([k, v]) => [k, String(v)])), workStart: '07:00', lateAfter: '07:10', dayType_1: 'full', dayType_2: 'full' }),
      ),
    );
    expect(target).toBe(SCHEDULE);
    const [a] = await listAttendancePolicies(ADMIN, [b.companyId]);
    expect(a.workStart).toBe('07:00:00');
    expect(await listAttendancePolicies(ADMIN, [companyB, companyC]), 'the other companies are untouched').toEqual(before);
  });
});

// ── G ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('G. the panel editors are the same forms, posting the same fields', () => {
  it('the Schedule Group panel is byte-for-byte what the retired rules/[ruleId] and rules/new pages rendered', async () => {
    await ensureStandardRule(ADMIN);
    const group = await createAttendanceRule(
      ADMIN,
      ruleInput({
        name: 'Plant crew',
        lateGracePeriodMinutes: 7,
        applyToEarlyOt: true,
        applyDeductions: true,
        otRows: [{ fromMinutes: 0, toMinutes: 120, ratePattern: 'flat', rate: 1.5, phRate: null, roundingMode: 'down', roundToMinutes: 15 }],
      }),
    );
    await createShift(ADMIN, {
      companyId: b.companyId,
      name: 'Plant AM',
      code: `P_${randomUUID().slice(0, 6)}`,
      startTime: '07:00:00',
      endTime: '16:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      ruleId: group.id,
    });

    // EXACTLY the retired rules/[ruleId] page body (main@1164f8d1): getAttendanceRule + the two parallel reads.
    const oldEdit = await toMarkup(
      await RuleForm({
        rule: await getAttendanceRule(ADMIN, group.id),
        shifts: ruleShiftChoices(await listShiftsForTenant(ADMIN), await listAttendanceRules(ADMIN), group.id),
        error: undefined,
      }),
    );
    const panel = elementById(await renderSchedule({ editGroup: group.id }), 'schedule-panel');
    expect(oldEdit.length).toBeGreaterThan(2000);
    expect(panel, 'the panel renders the old edit page’s form verbatim — same action, same fields, same values').toContain(oldEdit);
    // Pinned positively too, so "verbatim" cannot be satisfied by two empty renders.
    for (const name of ['ruleId', 'name', 'status', 'description', 'lateGracePeriodMinutes', 'applyDeductions', 'allowedShiftsEditor', 'allowedShiftIds', 'otRows']) {
      expect(panel, `the editor posts ${name}`).toContain(`name="${name}"`);
    }

    // And Add New: the retired rules/new page body.
    const oldNew = await toMarkup(
      await RuleForm({ rule: null, shifts: ruleShiftChoices(await listShiftsForTenant(ADMIN), await listAttendanceRules(ADMIN), null), error: undefined }),
    );
    expect(elementById(await renderSchedule({ editGroup: 'new' }), 'schedule-panel')).toContain(oldNew);
  });

  it('the policy Edit panel is that company’s WorkScheduleForm, and only that company’s', async () => {
    const [policyB] = await listAttendancePolicies(ADMIN, [companyB]);
    const standalone = await toMarkup(await WorkScheduleForm({ company: { id: companyB, name: 'Beta Sdn Bhd' }, policy: policyB }));
    const html = await renderSchedule({ policy: companyB });
    const panel = elementById(html, 'schedule-panel');
    expect(panel).toContain(standalone);
    expect([...html.matchAll(/name="companyId" value="([^"]+)"/g)].map((m) => m[1]), 'one company form on the page').toEqual([companyB]);
    expect(panel, 'no routing field rides the form any more').not.toContain('name="returnTo"');
  });
});

// ── H ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('H. the old addresses are guarded redirects to the matching card', () => {
  it('each redirects to its anchor on the General tab', async () => {
    expect(await redirectOf(() => OldScheduleGroupPage())).toBe(`${SCHEDULE}#schedule-groups`);
    expect(await redirectOf(() => OldWorkSchedulePage())).toBe(`${SCHEDULE}#work-schedule-overtime`);
    expect(await redirectOf(() => OldNewRulePage())).toBe(`${SCHEDULE}?editGroup=new#schedule-panel`);
    const id = randomUUID();
    expect(await redirectOf(() => OldEditRulePage({ params: Promise.resolve({ ruleId: id }) }))).toBe(
      `${SCHEDULE}?editGroup=${id}#schedule-panel`,
    );
  });

  it('…and the guard runs FIRST: a non-administrator is refused, not told where the setting went', async () => {
    REFUSE_ADMIN = true;
    for (const run of [
      () => OldScheduleGroupPage(),
      () => OldWorkSchedulePage(),
      () => OldNewRulePage(),
      () => OldEditRulePage({ params: Promise.resolve({ ruleId: randomUUID() }) }),
    ]) {
      await expect(run()).rejects.toThrow('NOT_AN_ADMIN');
    }
  });

  it('every anchor they name is rendered exactly once on the page', async () => {
    const group = await createAttendanceRule(ADMIN, ruleInput());
    const html = await renderSchedule({ editGroup: group.id });
    for (const id of ['schedule-groups', 'work-schedule-overtime', 'schedule-panel']) {
      expect(html.split(` id="${id}"`).length - 1, id).toBe(1);
    }
  });
});

// ── I ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('I. panel addressing', () => {
  it('`?group=` is the Attendance/Overtime selector and opens NO editor; an unknown id opens nothing', async () => {
    const group = await createAttendanceRule(ADMIN, ruleInput());
    expect(await renderSchedule({ tab: 'attendance', group: group.id })).not.toContain('id="schedule-panel"');
    expect(await renderSchedule({ editGroup: randomUUID() })).not.toContain('id="schedule-panel"');
    expect(await renderSchedule({ policy: randomUUID() })).not.toContain('id="schedule-panel"');
    expect(await renderSchedule({ editGroup: group.id })).toContain('id="schedule-panel"');
  });

  it('an open panel lands on General even when the URL still says another tab', async () => {
    const group = await createAttendanceRule(ADMIN, ruleInput());
    const html = await renderSchedule({ tab: 'attendance', group: group.id, editGroup: group.id });
    expect(html).toMatch(/<div role="tabpanel" data-tabpanel="general" class="space-y-6">/);
    expect(html).toMatch(/<div role="tabpanel" data-tabpanel="attendance" hidden="">/);
    // Without a panel the requested tab is honoured, as before.
    expect(await renderSchedule({ tab: 'attendance', group: group.id })).toMatch(
      /<div role="tabpanel" data-tabpanel="attendance" class="space-y-6">/,
    );
  });

  it('the tab shell is KEYED on the open panel (source pin — the behaviour lives in client state)', () => {
    // ClientTabs keeps its active tab in useState, and a soft navigation (a <Link> click, a server-action
    // redirect) re-renders the same component in place, so `defaultTab` changing is IGNORED. Clicking the
    // Attendance tab's "Edit this Schedule Group" would leave the reader on Attendance with the editor open on a
    // hidden General tab. Re-keying on the panel re-mounts the shell. Server rendering cannot observe a key, so
    // this is pinned on the source; the render check exercises it in a browser.
    const page = fs.readFileSync(path.join(root, 'app/admin/attendance/schedule/page.tsx'), 'utf8');
    expect(page).toMatch(/<ClientTabs<ScheduleTabKey>\s+key=\{schedulePanelKey\(panel\)\}/);
  });

  it('the Attendance and Overtime tabs’ "Edit this Schedule Group" opens that group’s panel', async () => {
    const group = await createAttendanceRule(ADMIN, ruleInput());
    const html = await renderSchedule({ tab: 'overtime', group: group.id });
    const links = [...html.matchAll(new RegExp(`href="([^"]*)"[^>]*>${esc(SC.groupLink)}<`, 'g'))].map((m) => m[1]);
    expect(links.length, 'rendered on both tabs').toBe(2);
    expect(new Set(links)).toEqual(new Set([`${SCHEDULE}?editGroup=${group.id}#schedule-panel`]));
  });
});

// ── J ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('J. Last updated — an HR admin session can read attendance-policy.updated under RLS', () => {
  it('group-wide hr_admin, company-scoped hr_admin: both read the latest save per company; an employee reads nothing', async () => {
    // A later save for company A, so "latest" is a real choice between two events.
    await setAttendancePolicy(ADMIN, { ...POLICY(b.companyId), workStart: '07:30', lateAfter: '07:45' });

    const groupWide = await policyLastUpdated(ADMIN, [b.companyId, companyB, companyC]);
    expect(groupWide.has(b.companyId), 'the group-wide HR admin sees company A’s save').toBe(true);
    expect(groupWide.has(companyB), 'company B has a row but no event — no entry, never an invented date').toBe(false);
    expect(groupWide.has(companyC)).toBe(false);

    const events = await owner.db
      .select({ at: schema.domainEvent.occurredAt })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'attendance-policy.updated')))
      .orderBy(desc(schema.domainEvent.sequence));
    expect(events).toHaveLength(2);
    expect(groupWide.get(b.companyId)!.getTime(), 'the NEWEST of the two').toBe(events[0].at.getTime());

    const scoped: SessionContext = { ...ADMIN, grants: [{ role: 'hr_admin', companyId: b.companyId }] };
    expect((await policyLastUpdated(scoped, [b.companyId])).get(b.companyId)?.getTime(), 'a company-scoped HR admin reads it too').toBe(
      events[0].at.getTime(),
    );

    const employee: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'], entitlements: ADMIN.entitlements };
    expect((await policyLastUpdated(employee, [b.companyId])).size, 'RLS is really in play: a non-admin reads no policy events').toBe(0);
  });
});
