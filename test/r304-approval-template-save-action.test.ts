/**
 * r304 (board 85875e4b) · `saveApprovalTemplateAction` RETURNS ITS OUTCOME — against a real database.
 *
 * The template form moved into a side drawer, and the action behind it stopped redirecting so a refused save
 * can stay in the drawer with the edits intact. Pinned here through the ACTION (not the service), because the
 * contract that changed is the action's:
 *
 *   1. A DELIBERATE DOMAIN REFUSAL COMES BACK AS THE SERVICE'S OWN MESSAGE and nothing is written — the
 *      service raises those as `ApprovalTemplateRefusedError`. Not a generic string, not `undefined` (r303
 *      found `fail(ENTITLEMENTS, <string>)` turning every refusal on a screen into "undefined").
 *   2. ANYTHING ELSE NEVER REACHES THE SCREEN AS ITS OWN TEXT. A database refusal is drizzle's wrapper —
 *      "Failed query: insert into "leave_approval_template" … params: <tenant id>,<name>,…" — and before the
 *      coordinator's fix pass that was exactly what a non-admin's drawer (and, before r304, the page banner)
 *      printed. It now gets ONE localized sentence (`leaveApproval.templateSaveFailed`, six locales), and the
 *      raw error is logged server-side with console.error.
 *   3. A SUCCESS carries the id (a created row has no id on the client yet) and the name AS STORED.
 *   4. AUTHORIZATION DID NOT MOVE. The action calls the same `getSession()` and the same two services with the
 *      same session. Neither service checks for an administrator in code; the table's RLS policy does
 *      (`leave_approval_template_rls … WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin())`,
 *      db/migrations/0170). A non-admin session is driven through the services the old redirecting action
 *      called AND through the action: both are refused, and nothing is written either way.
 *
 * It never redirects: `redirect` is stubbed to throw, so a leftover redirect would fail every case here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createApprovalTemplate, updateApprovalTemplate } from '../core/leave-approval-template';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let SESSION: SessionContext;
vi.mock('@/lib/session', () => ({ getSession: async () => SESSION }));

let REDIRECTS: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    REDIRECTS.push(url);
    throw new Error('NEXT_REDIRECT');
  },
}));

/** The request locale the action translates its generic sentence into. Swapped per case. */
const INTL = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ms' | 'ta' | 'th' | 'vi' | 'zh' }));
vi.mock('next-intl/server', async () => {
  const catalogues = {
    en: (await import('../messages/en.json')).default,
    ms: (await import('../messages/ms.json')).default,
    ta: (await import('../messages/ta.json')).default,
    th: (await import('../messages/th.json')).default,
    vi: (await import('../messages/vi.json')).default,
    zh: (await import('../messages/zh.json')).default,
  } as Record<string, unknown>;
  const lookup = (obj: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  return {
    getLocale: async () => INTL.locale,
    getTranslations: async (ns: string) => (key: string) => {
      const hit = lookup(catalogues[INTL.locale], `${ns}.${key}`);
      if (typeof hit !== 'string') throw new Error(`MISSING_MESSAGE ${INTL.locale}:${ns}.${key}`);
      return hit;
    },
  };
});

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';
const GENERIC = {
  en: en.leaveApproval.templateSaveFailed,
  ms: ms.leaveApproval.templateSaveFailed,
  ta: ta.leaveApproval.templateSaveFailed,
  th: th.leaveApproval.templateSaveFailed,
  vi: vi_.leaveApproval.templateSaveFailed,
  zh: zh.leaveApproval.templateSaveFailed,
} as const;
const LOCALES = Object.keys(GENERIC) as (keyof typeof GENERIC)[];

import { saveApprovalTemplateAction } from '../app/admin/leave-approval/actions';

let b: Base;
let admin: SessionContext;
let errorLog: ReturnType<typeof vi.spyOn>;

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
const TWO_STEP = JSON.stringify([
  { kind: 'direct_manager', employmentId: null, alternates: [] },
  { kind: 'hr_admin', employmentId: null, alternates: [] },
]);

/** Every template row, read as the OWNER (RLS bypassed) so a refused write cannot hide behind a filtered read. */
const rows = () =>
  owner.db
    .select({ id: schema.leaveApprovalTemplate.id, name: schema.leaveApprovalTemplate.name, levels: schema.leaveApprovalTemplate.levels })
    .from(schema.leaveApprovalTemplate)
    .where(eq(schema.leaveApprovalTemplate.tenantId, b.tenantId))
    .orderBy(asc(schema.leaveApprovalTemplate.name));

async function sessionWithRole(role: 'employee' | 'manager'): Promise<SessionContext> {
  const e = await hireEmployee(admin, {
    person: { fullName: 'Nurul Huda', primaryEmail: `r304_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const userId = await createAppUser(b.tenantId, e.personId, role);
  return { ...admin, userId, roles: [role], personId: e.personId, grants: undefined };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  admin = adminCtx(b);
  SESSION = admin;
  REDIRECTS = [];
  INTL.locale = 'en';
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
});
afterAll(async () => {
  await closeAll();
});

describe('r304 · saveApprovalTemplateAction returns instead of redirecting', () => {
  it('a create answers ok with the new id and the name as stored', async () => {
    const result = await saveApprovalTemplateAction(form({ name: '  Night   Shift ', description: '', levels: TWO_STEP }));
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(result).toEqual({ ok: true, id: stored[0].id, name: 'Night Shift', created: true });
    expect(REDIRECTS).toEqual([]);
  });

  it('an update answers ok with the same id, created: false', async () => {
    const { id } = await createApprovalTemplate(admin, { name: 'Senior Staff', levels: ['department_head'] });
    const result = await saveApprovalTemplateAction(
      form({ templateId: id, name: 'Senior Staff v2', description: 'Heads first', levels: TWO_STEP }),
    );
    expect(result).toEqual({ ok: true, id, name: 'Senior Staff v2', created: false });
    const [row] = await rows();
    expect(row.name).toBe('Senior Staff v2');
    expect(REDIRECTS).toEqual([]);
  });

  it('a duplicate name is refused with the SERVICE message, and the edited template is untouched', async () => {
    await createApprovalTemplate(admin, { name: 'Standard Leave Approval', levels: ['direct_manager', 'hr_admin'] });
    const { id } = await createApprovalTemplate(admin, { name: 'Senior Staff', levels: ['department_head'] });
    const before = await rows();

    const result = await saveApprovalTemplateAction(
      form({ templateId: id, name: 'Standard Leave Approval', description: '', levels: TWO_STEP }),
    );
    expect(result).toEqual({ ok: false, error: 'A template with that name already exists' });
    expect(await rows()).toEqual(before);
    expect(REDIRECTS).toEqual([]);
    // A refusal the service raised on purpose is an answer, not a fault: nothing is logged as an error.
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('a create that collides is refused by name and inserts nothing', async () => {
    await createApprovalTemplate(admin, { name: 'Standard Leave Approval', levels: ['hr_admin'] });
    const result = await saveApprovalTemplateAction(
      form({ name: 'Standard Leave Approval', description: '', levels: TWO_STEP }),
    );
    expect(result).toEqual({ ok: false, error: 'A template with that name already exists' });
    expect(await rows()).toHaveLength(1);
  });

  it('an empty chain and a named-approver step with nobody named are refused by the service, word for word', async () => {
    const empty = await saveApprovalTemplateAction(form({ name: 'Empty', description: '', levels: '[]' }));
    expect(empty).toEqual({ ok: false, error: 'A template needs at least one approval step' });

    const unnamed = await saveApprovalTemplateAction(
      form({
        name: 'Unnamed approver',
        description: '',
        // One good level beside the unnamed one: alone, the unnamed level is dropped to an empty chain and the
        // "at least one step" refusal (above) answers first.
        levels: JSON.stringify([
          { kind: 'hr_admin', employmentId: null, alternates: [] },
          { kind: 'specific_employee', employmentId: null, alternates: [] },
        ]),
      }),
    );
    expect(unnamed.ok).toBe(false);
    expect(unnamed.ok === false && unnamed.error).toBe(
      'Every approval level needs an approver — choose a person for any named-approver step',
    );
    expect(await rows()).toEqual([]);
  });
});

/** The thrown error's message plus every `cause` below it — drizzle wraps the Postgres error. */
function causeChain(e: unknown): string {
  const parts: string[] = [];
  let cur = e as { message?: string; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.message) parts.push(cur.message);
    cur = cur.cause as typeof cur;
  }
  return parts.join(' <- ');
}

/** What must never be in a payload a screen renders: the driver's wrapper, SQL, bound parameters, the tenant. */
function expectNoDatabaseText(result: unknown) {
  const payload = JSON.stringify(result);
  expect(payload).not.toMatch(/failed query/i);
  expect(payload).not.toMatch(/params:|insert into|update\s+\\?"|leave_approval_template|row-level security/i);
  expect(payload).not.toContain(b.tenantId);
}

/** The raw failure went to the server log — nothing is lost by not showing it. */
function expectLoggedDatabaseRefusal() {
  const logged: unknown[] = errorLog.mock.calls.flat();
  expect(logged.some((arg: unknown) => arg instanceof Error && /row-level security/i.test(causeChain(arg))), 'the RLS refusal was not logged').toBe(true);
}

describe('r304 · authorization is exactly what it was: RLS refuses a non-admin, before and after', () => {
  it.each(['employee', 'manager'] as const)('a %s session cannot create a template — refused with the generic sentence, nothing written, raw error logged', async (role) => {
    const member = await sessionWithRole(role);

    // BEFORE — the service the redirecting action called, with the same session and the same input. It
    // throws the database's refusal, and its message is raw SQL with the tenant id in it: what used to leak.
    const thrown = await createApprovalTemplate(member, {
      name: 'Sneaky',
      description: null,
      levels: JSON.parse(TWO_STEP) as unknown[],
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown, 'a non-admin create went through the service').toBeInstanceOf(Error);
    expect(causeChain(thrown)).toMatch(/row-level security/i);
    expect((thrown as Error).message).toMatch(/^Failed query:/);
    expect((thrown as Error).message).toContain(b.tenantId);
    expect(await rows()).toEqual([]);

    // AFTER — the returning action, same session: refused, in words, with none of that text.
    SESSION = member;
    const result = await saveApprovalTemplateAction(form({ name: 'Sneaky', description: '', levels: TWO_STEP }));
    expect(result).toEqual({ ok: false, error: GENERIC.en });
    expectNoDatabaseText(result);
    expectLoggedDatabaseRefusal();
    expect(await rows()).toEqual([]);
    expect(REDIRECTS).toEqual([]);
  });

  it.each(['employee', 'manager'] as const)('a %s session cannot rename an existing template — generic sentence, row unchanged', async (role) => {
    const { id } = await createApprovalTemplate(admin, { name: 'Standard Leave Approval', levels: ['hr_admin'] });
    const before = await rows();
    const member = await sessionWithRole(role);

    const thrown = await updateApprovalTemplate(member, id, {
      name: 'Hijacked',
      description: null,
      levels: JSON.parse(TWO_STEP) as unknown[],
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown, 'a non-admin rename went through the service').toBeInstanceOf(Error);
    expect(causeChain(thrown)).toMatch(/row-level security/i);
    expect(await rows()).toEqual(before);

    SESSION = member;
    const result = await saveApprovalTemplateAction(
      form({ templateId: id, name: 'Hijacked', description: '', levels: TWO_STEP }),
    );
    expect(result).toEqual({ ok: false, error: GENERIC.en });
    expectNoDatabaseText(result);
    expect(JSON.stringify(result)).not.toContain(id);
    expectLoggedDatabaseRefusal();
    expect(await rows()).toEqual(before);
  });

  it('the generic sentence is in the viewer\'s language, in all six locales', async () => {
    SESSION = await sessionWithRole('employee');
    for (const loc of LOCALES) {
      INTL.locale = loc;
      const result = await saveApprovalTemplateAction(form({ name: 'Sneaky', description: '', levels: TWO_STEP }));
      expect(result, loc).toEqual({ ok: false, error: GENERIC[loc] });
      expectNoDatabaseText(result);
    }
    expect(new Set(Object.values(GENERIC)).size, 'a locale still carries the English sentence').toBe(LOCALES.length);
    expect(await rows()).toEqual([]);
  });

  it('a failure that is not the database and not a refusal (no tenant on the session) is not shown as its own text either', async () => {
    SESSION = { ...admin, tenantId: '' };
    const result = await saveApprovalTemplateAction(form({ name: 'Night Shift', description: '', levels: TWO_STEP }));
    expect(result).toEqual({ ok: false, error: GENERIC.en });
    expect(JSON.stringify(result)).not.toMatch(/withTenant|session context/i);
    expect(errorLog).toHaveBeenCalled();
  });
});
