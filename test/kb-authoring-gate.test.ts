/**
 * CUSTOMER-DEPLOYMENT-READINESS Part 4, "Knowledge base authoring" — CAN AN EMPLOYEE STILL PUBLISH TO THE
 * COMPANY LIBRARY BY POSTING TO THE ACTION?
 *
 * `createArticleAction` and `uploadFileAction` took a bare `getSession()`, and `app/knowledge-base/page.tsx`
 * mounted the composer unconditionally. So any authenticated employee was OFFERED the composer and could
 * file an article at any audience up to `hr_admin` — the shelf HR reads as official guidance.
 *
 * AND THE DATABASE DOES NOT ANSWER THIS ONE. That is what makes the service guard load-bearing rather than
 * belt-and-braces, and it is the first thing measured below: `0039_kb_rls.sql` fences UPDATE and DELETE
 * behind `app.is_admin() OR own-and-not-system`, but its INSERT policy is `WITH CHECK (tenant_id =
 * app.current_tenant_id())` and nothing more (ADR-0017 §3 chose open contribution). An employee's INSERT
 * is accepted by Postgres. Remove `assertKbAuthor` and there is no second line of defence — unlike the
 * roster, where RLS refuses a supervisor even with the application guard gone.
 *
 * BOTH ARMS, BECAUSE THE SECOND IS WHERE A VACUOUS GUARD HIDES. Every refusal below is paired with the
 * same action succeeding for an administrator, asserted on the row that reached the library — a guard that
 * refuses everyone passes a refusal-only file.
 *
 * HIDING THE COMPOSER IS NOT A GUARD: the two Server Action ids ship in every authenticated user's bundle
 * and are POST endpoints with or without a button. The last block therefore renders the real page twice and
 * reads the tree (composer ABSENT from an employee's, present for an administrator's), and it is the
 * complement of the action tests, not a substitute for them — the precedent pair is
 * test/roster-write-guard.test.ts + test/roster-page-admin-gating.test.ts.
 *
 * WATCHED-FAIL, RECORDED AND NOT ASSUMED. With the three call sites unwired — `assertKbAuthor(ctx)` out of
 * `createArticle`/`uploadDocument`, `assertAudienceWithinClearance` out of all three writes,
 * `refuseNonAuthor(s)` out of the two actions, and `{canAuthor(s) && <KbComposer />}` back to a bare
 * `<KbComposer />` — this file runs **9 failed | 9 passed (18)**, and the nine are exactly the ones that
 * measure the fix:
 *
 *   the action must refuse; instead it redirected to /knowledge-base/ffd03da6-…?toast=Article+created
 *   the action must refuse; instead it redirected to /knowledge-base/6d6856fa-…?toast=File+uploaded
 *   the action must refuse; instead it redirected to /knowledge-base/75d9fa7a-…?toast=Saved
 *   promise resolved "{ id: 'a1d6358b-…' }" instead of rejecting          (createArticle, core boundary)
 *   expected true to be false                                            (composer on an employee's page)
 *
 * The nine that still PASS are the second arm and the premise: the administrator publishes, edits,
 * archives and restores exactly as before, and the RLS INSERT still accepts a member. That split is the
 * point — a guard that simply refused everyone would take the administrator's nine down with it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  assertKbAuthor,
  canAuthor,
  createArticle,
  getDocument,
  KbAudienceAboveClearanceError,
  KbAuthorAdminRequiredError,
  listDocuments,
  updateDocument,
  uploadDocument,
  type KbAudience,
} from '../core/knowledge-base';

/** The session every action and every render resolves. Swapped per test. */
let SESSION: SessionContext;
vi.mock('@/lib/session', () => ({ getSession: async () => SESSION }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string) => k,
  getLocale: async () => 'en',
}));

/** next/navigation's redirect() signals by THROWING; a stub that merely records would let the action run
 *  on past its own refusal, which is the opposite of what is being tested. */
let LAST_REDIRECT = '';
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));

import {
  archiveDocumentAction,
  createArticleAction,
  restoreDocumentAction,
  updateDocumentAction,
  uploadFileAction,
} from '../app/knowledge-base/actions';
import KnowledgeBasePage from '../app/knowledge-base/page';
import { KbComposer } from '../components/kb-composer';

/** Anything that betrays the driver: the wrapper, the statement, or its bound parameters. */
const RAW_SQL = /failed query|insert into|update\s+"|delete from|\bparams:/i;
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let b: Base;
let admin: SessionContext;
let employee: SessionContext;
let manager: SessionContext;

const uniqEmail = () => `kb_${randomUUID().slice(0, 8)}@t.local`;

/** A REAL non-admin session: its own person, its own app_user, its own role grant — which is what makes
 *  `created_by_user_id` meaningful for the author-owns-their-document paths below. */
async function sessionWithRole(role: 'employee' | 'manager'): Promise<SessionContext> {
  const e = await hireEmployee(admin, {
    person: { fullName: 'Nurul Huda', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const userId = await createAppUser(b.tenantId, e.personId, role);
  return { ...admin, userId, roles: [role], personId: e.personId };
}

/** A document authored by a NON-ADMIN — the shape that existed before the author gate and that RLS still
 *  lets its owner edit. Written as the owner role (RLS bypassed) precisely because the service now refuses
 *  to create one: the fixture must not depend on the hole being open. */
async function legacyMemberDocument(authorUserId: string, audience: KbAudience = 'all'): Promise<string> {
  const [row] = await owner.db
    .insert(schema.kbDocument)
    .values({
      tenantId: b.tenantId,
      kind: 'article',
      title: 'Team Potluck Sign-up',
      body: 'Bring a dish.',
      category: 'general',
      audience,
      createdByUserId: authorUserId,
      updatedByUserId: authorUserId,
    })
    .returning({ id: schema.kbDocument.id });
  return row.id;
}

const formOf = (fields: Record<string, string | File>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

/** Run an action that reports by redirecting; return the `error` it put in the query string. Asserts an
 *  `error` was there at all FIRST, and names the destination if not — so a guard that has stopped
 *  guarding reports "it redirected to …?toast=Article+created" rather than "expected '' to match". */
async function redirectError(run: () => Promise<unknown>): Promise<string> {
  LAST_REDIRECT = '';
  await expect(run()).rejects.toThrow('NEXT_REDIRECT');
  const err = new URL(LAST_REDIRECT, 'https://x.invalid').searchParams.get('error');
  expect(err, `the action must refuse; instead it redirected to ${LAST_REDIRECT}`).not.toBeNull();
  return err ?? '';
}

/** Run an action expected to SUCCEED; return the path it redirected to. */
async function redirectPath(run: () => Promise<unknown>): Promise<URL> {
  LAST_REDIRECT = '';
  await expect(run()).rejects.toThrow('NEXT_REDIRECT');
  const url = new URL(LAST_REDIRECT, 'https://x.invalid');
  expect(url.searchParams.get('error'), `expected success, got ?error=${url.searchParams.get('error')}`).toBeNull();
  return url;
}

/** Everything in the library, read as the administrator — the honest "what actually landed". */
const library = () => listDocuments(admin, { includeArchived: true });

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  admin = adminCtx(b);
  employee = await sessionWithRole('employee');
  manager = await sessionWithRole('manager');
  SESSION = employee; // the caller this file is about; the admin blocks set their own
  LAST_REDIRECT = '';
});

describe('why the guard has to be in the service — the database does not refuse a member INSERT', () => {
  it('kb_document_insert accepts an employee, so nothing backstops createArticle', async () => {
    // The unguarded INSERT the action used to reach, made directly under the employee's own session and
    // therefore under the employee's own RLS. If this ever starts throwing, the policy was changed and the
    // comment on assertKbAuthor needs rewriting — but it must not be REMOVED on the strength of a green
    // refusal test, which would then be pinning RLS instead of the guard.
    const inserted = await withTenant(employee, async (tx) =>
      tx
        .insert(schema.kbDocument)
        .values({
          tenantId: employee.tenantId,
          kind: 'article',
          title: 'Raw insert',
          body: 'x',
          category: 'general',
          audience: 'hr_admin',
          createdByUserId: employee.userId ?? null,
        })
        .returning({ id: schema.kbDocument.id }),
    );
    expect(inserted, 'RLS admits a member INSERT — ADR-0017 §3').toHaveLength(1);
  });

  it('canAuthor / assertKbAuthor: administrators in, employee and manager out, in plain words', () => {
    expect(canAuthor(admin)).toBe(true);
    expect(canAuthor({ ...admin, roles: ['super_admin'] })).toBe(true);
    expect(canAuthor(employee)).toBe(false);
    expect(canAuthor(manager)).toBe(false);

    expect(() => assertKbAuthor(employee)).toThrow(KbAuthorAdminRequiredError);
    expect(() => assertKbAuthor(manager)).toThrow(KbAuthorAdminRequiredError);
    expect(() => assertKbAuthor(admin)).not.toThrow();

    const message = new KbAuthorAdminRequiredError().message;
    expect(message).toMatch(/HR administrator/i);
    expect(message).not.toMatch(RAW_SQL);
    expect(message).not.toMatch(ANY_UUID);
  });
});

describe('the two ways into the library refuse a non-administrator IN THE SERVER', () => {
  it('createArticleAction — an employee posting straight at the action is refused, readably', async () => {
    SESSION = employee;
    const seen = await redirectError(() =>
      createArticleAction(
        formOf({ title: 'Company Policy Update', body: 'Everyone now gets Fridays off.', audience: 'all' }),
      ),
    );
    expect(seen).toMatch(/HR administrator/i);
    expect(seen).not.toMatch(RAW_SQL);
    expect(seen).not.toMatch(ANY_UUID);
    expect(await library(), 'refused, so nothing was published').toHaveLength(0);
  });

  it('createArticleAction — and at the hr_admin audience, which is the one that matters most', async () => {
    SESSION = employee;
    const seen = await redirectError(() =>
      createArticleAction(formOf({ title: 'Payroll Instruction', body: 'Wire it here.', audience: 'hr_admin' })),
    );
    expect(seen).toMatch(/HR administrator/i);
    expect(await library()).toHaveLength(0);
  });

  it('uploadFileAction — the other door, refused the same way', async () => {
    SESSION = employee;
    const file = new File([Buffer.from('%PDF-1.4 fake')], 'handbook.pdf', { type: 'application/pdf' });
    const seen = await redirectError(() => uploadFileAction(formOf({ title: 'Handbook', file, audience: 'all' })));
    expect(seen).toMatch(/HR administrator/i);
    expect(seen).not.toMatch(RAW_SQL);
    expect(await library()).toHaveLength(0);
  });

  it('a MANAGER is refused too — this is an administrator gate, not an employee gate', async () => {
    SESSION = manager;
    const seen = await redirectError(() => createArticleAction(formOf({ title: 'Team Rules', body: 'x' })));
    expect(seen).toMatch(/HR administrator/i);
    expect(await library()).toHaveLength(0);
  });

  it('createArticle / uploadDocument refuse at the CORE boundary as well, not only in the actions', async () => {
    await expect(createArticle(employee, { title: 'Direct', body: 'x' })).rejects.toThrow(KbAuthorAdminRequiredError);
    await expect(
      uploadDocument(employee, {
        title: 'Direct',
        fileName: 'a.txt',
        mimeType: 'text/plain',
        content: Buffer.from('hello'),
      }),
    ).rejects.toThrow(KbAuthorAdminRequiredError);
    expect(await library()).toHaveLength(0);
  });
});

describe('…and an administrator can still publish — the arm a refuse-everything guard would break', () => {
  it('createArticleAction succeeds and the article is really in the library', async () => {
    SESSION = admin;
    const url = await redirectPath(() =>
      createArticleAction(
        formOf({ title: 'Leave Policy 2026', body: '# Leave\nTake it.', category: 'People', audience: 'hr_admin' }),
      ),
    );
    expect(url.searchParams.get('toast')).toBe('Article created');
    const id = url.pathname.replace('/knowledge-base/', '');

    const doc = await getDocument(admin, id);
    expect(doc?.title).toBe('Leave Policy 2026');
    expect(doc?.kind).toBe('article');
    expect(doc?.audience, 'an administrator reaches every audience').toBe('hr_admin');
    expect(doc?.category).toBe('people');
    expect(await library()).toHaveLength(1);
  });

  it('uploadFileAction succeeds and the file is really in the library', async () => {
    SESSION = admin;
    const file = new File([Buffer.from('%PDF-1.4 real')], 'handbook.pdf', { type: 'application/pdf' });
    const url = await redirectPath(() => uploadFileAction(formOf({ title: 'Staff Handbook', file, audience: 'all' })));
    expect(url.searchParams.get('toast')).toBe('File uploaded');

    const [doc] = await library();
    expect(doc.title).toBe('Staff Handbook');
    expect(doc.kind).toBe('file');
    expect(doc.fileName).toBe('handbook.pdf');
  });
});

describe('the sibling writes in the same file — update, archive, restore', () => {
  it('a stranger cannot edit, archive or restore someone else’s document (RLS, and it reads plainly)', async () => {
    // Authored by the MANAGER, attacked by the EMPLOYEE: neither is an admin, so the only thing standing
    // here is kb_document_update / kb_document_delete's own-and-not-system clause.
    const id = await legacyMemberDocument(manager.userId!);
    SESSION = employee;

    const edit = await redirectError(() => updateDocumentAction(formOf({ id, title: 'Hijacked', body: 'mine now' })));
    expect(edit).toMatch(/cannot edit it/i);
    expect(edit).not.toMatch(RAW_SQL);
    expect(edit).not.toMatch(ANY_UUID);
    expect((await getDocument(admin, id))?.title, 'unchanged').toBe('Team Potluck Sign-up');

    const archived = await redirectError(() => archiveDocumentAction(formOf({ id })));
    expect(archived).toMatch(/cannot archive it/i);
    expect(archived).not.toMatch(RAW_SQL);
    expect((await getDocument(admin, id))?.archivedAt, 'still on the shelf').toBeNull();

    await owner.db
      .update(schema.kbDocument)
      .set({ archivedAt: new Date() })
      .where(eq(schema.kbDocument.id, id));
    const restored = await redirectError(() => restoreDocumentAction(formOf({ id })));
    expect(restored).toMatch(/cannot restore it/i);
    expect((await getDocument(admin, id))?.archivedAt, 'still archived').not.toBeNull();
  });

  it('an administrator can edit, archive and restore — the second arm for the siblings', async () => {
    const id = await legacyMemberDocument(manager.userId!);
    SESSION = admin;

    await redirectPath(() => updateDocumentAction(formOf({ id, title: 'Potluck, Rescheduled', body: 'Friday.' })));
    expect((await getDocument(admin, id))?.title).toBe('Potluck, Rescheduled');

    await redirectPath(() => archiveDocumentAction(formOf({ id })));
    expect((await getDocument(admin, id))?.archivedAt).not.toBeNull();

    await redirectPath(() => restoreDocumentAction(formOf({ id })));
    expect((await getDocument(admin, id))?.archivedAt).toBeNull();
  });
});

describe('audience: nobody files a document on a shelf they cannot read', () => {
  it('a member-author cannot promote their own document to the hr_admin shelf', async () => {
    const id = await legacyMemberDocument(employee.userId!);
    await expect(updateDocument(employee, { id, audience: 'hr_admin' })).rejects.toThrow(
      KbAudienceAboveClearanceError,
    );
    await expect(updateDocument(employee, { id, audience: 'manager' })).rejects.toThrow(
      KbAudienceAboveClearanceError,
    );
    expect((await getDocument(admin, id))?.audience, 'never moved').toBe('all');

    // …but their own clearance is still theirs: 'employee' is at their rank, and the edit goes through.
    await updateDocument(employee, { id, audience: 'employee' });
    expect((await getDocument(admin, id))?.audience).toBe('employee');
  });

  it('the action surfaces that refusal as a sentence, not a stack trace', async () => {
    const id = await legacyMemberDocument(employee.userId!);
    SESSION = employee;
    const seen = await redirectError(() =>
      updateDocumentAction(formOf({ id, title: 'Potluck', body: 'Bring a dish.', audience: 'hr_admin' })),
    );
    expect(seen).toMatch(/not cleared to read/i);
    expect(seen).not.toMatch(RAW_SQL);
    expect(seen).not.toMatch(ANY_UUID);
  });

  it('an administrator is cleared for every audience, so the clamp never fires on them', async () => {
    for (const audience of ['all', 'employee', 'manager', 'hr_admin'] as KbAudience[]) {
      const { id } = await createArticle(admin, { title: `Guide ${audience}`, body: 'x', audience });
      expect((await getDocument(admin, id))?.audience).toBe(audience);
    }
    expect(await library()).toHaveLength(4);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every React element in a rendered tree, descending through element-valued props as well as children. */
function elementsIn(node: unknown, acc: any[] = [], seen = new Set<unknown>()): any[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) elementsIn(n, acc, seen);
    return acc;
  }
  const el = node as any;
  if (el.type !== undefined) acc.push(el);
  for (const v of Object.values(el.props ?? {})) if (v && typeof v === 'object') elementsIn(v, acc, seen);
  return acc;
}

/** Every STRING anywhere in the tree — children AND string-valued props. Translations are mocked to return
 *  their KEY, so a label here is the message key the page asked for. */
function stringsIn(tree: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (n: unknown): void => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    for (const v of Object.values(n as Record<string, unknown>)) visit(v);
  };
  visit(tree);
  return out;
}

const hasComposer = (tree: unknown): boolean => elementsIn(tree).some((el) => el.type === KbComposer);

async function renderAs(s: SessionContext): Promise<unknown> {
  SESSION = s;
  return KnowledgeBasePage({ searchParams: Promise.resolve({}) } as any);
}

describe('the knowledge base screen offers the composer only to someone who can use it', () => {
  it('an administrator is offered it', async () => {
    const tree = await renderAs(admin);
    expect(hasComposer(tree), 'the composer element itself, not a label').toBe(true);
  });

  it('an employee is NOT — absent from the tree, not hidden by a class', async () => {
    const tree = await renderAs(employee);
    expect(hasComposer(tree)).toBe(false);
    // Nothing of the composer survives by another route either: its label key is not on the page.
    expect(stringsIn(tree)).not.toContain('compose');
  });

  it('a manager is NOT either', async () => {
    expect(hasComposer(await renderAs(manager))).toBe(false);
  });

  it('but the page RENDERED for the employee — otherwise every assertion above is a false green', async () => {
    await createArticle(admin, { title: 'Leave Policy 2026', body: 'x', audience: 'all' });
    const tree = await renderAs(employee);
    const labels = stringsIn(tree);

    expect(labels).toContain('title');
    expect(labels).toContain('subtitle');
    expect(labels).toContain('search');
    expect(labels).toContain('resultCount');
    expect(labels).toContain('filterAll');
    // Reading is untouched by this change: the administrator's article is on the employee's screen.
    expect(labels).toContain('Leave Policy 2026');
  });
});
