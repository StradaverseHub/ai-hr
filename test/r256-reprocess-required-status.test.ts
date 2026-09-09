/**
 * 0b326d5f (r256) — "REPROCESS REQUIRED" IN THE PAYROLL PROCESS LISTING.
 *
 * WHAT THIS ITEM ACTUALLY WAS. The reporter asked for a fourth payroll status to be raised whenever
 * payroll-affecting data changes after a run is processed. The DETECTION for that has been live since
 * 49e7e0a2: a one-off transaction added, changed or removed on a processed run stamps
 * `payroll_batch.needs_recalc_at` with the exact employments, and `closeBatch` refuses while it is set.
 * Measured on production 2026-09-08, SIX runs were carrying that mark — and every one of them read as a
 * plain "Processed" on the Payroll Process listing, so nothing told the administrator the figures were
 * stale until Close was refused. This was a DISPLAY gap, and nothing here rebuilds the detection.
 *
 * AND IT IS STILL NOT A FOURTH ENUM VALUE. `payrollStatusEnum` remains exactly
 * ('draft','processed','closed') — db/schema.ts says so at the column, and
 * test/payroll-dashboard-timeline.test.ts pins the listing's STATUS_STYLE to exactly those three. What
 * the screen shows is DERIVED (app/payroll/dashboard-logic.ts `payrollListState`), so every report,
 * export, permission and service predicate that already understands 'processed' is untouched.
 *
 * WHAT IS PINNED HERE, and why each case exists rather than one happy path:
 *   A. The derivation, pure. Closed is silent WHATEVER the flag says (the reporter's own rule, and the
 *      case that `status !== 'draft'` would have got wrong), a draft is silent, and the affected set is
 *      read defensively out of a `jsonb` column.
 *   B. The STATUS FILTER reaches the new chip. A badge the single-select filter cannot select is the
 *      failure the build note called out by name; "Processed" also still returns the stale runs, which
 *      is the promise the approved plan made to the reporter.
 *   C. The REAL SCREEN, rendered against a REAL run in Postgres, driven through the REAL mechanism
 *      (`createIndividualTxn` on a processed run marks it; a selective `generatePayslips` clears it).
 *      A source-shape assertion would pass on a page that renders the badge from a column nothing sets.
 *   D. The three new labels resolve in all six catalogs.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';

/** The session every mocked entry point hands back — replaced once the fixture has seeded. */
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown as SessionContext, scopeIds: [] as string[] } }));

vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  notFound: () => {
    throw new Error('notFound() — a route gate closed; the fixture is wrong, not the assertion');
  },
  redirect: (u: string) => {
    throw new Error(`redirect(${u})`);
  },
}));
vi.mock('next/cache', async (orig) => ({
  ...(await orig<typeof import('next/cache')>()),
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
/**
 * Translations that CARRY THEIR VALUES: `t('reprocessAffected', { n: 2 })` renders as
 * `reprocessAffected({"n":2})`. A bare identity function would make the affected-employee COUNT — half
 * of what this item asked for — invisible to every assertion below, so the count could regress to a
 * hard-coded 1 and the file would stay green. Copy itself is case D's business, not this one's.
 */
vi.mock('next-intl/server', async (orig) => ({
  ...(await orig<typeof import('next-intl/server')>()),
  getTranslations: async () =>
    Object.assign((k: string, vals?: Record<string, unknown>) => (vals ? `${k}(${JSON.stringify(vals)})` : k), {
      rich: (k: string) => k,
      markup: (k: string) => k,
      raw: (k: string) => k,
      has: () => true,
    }),
  getLocale: async () => 'en',
}));
vi.mock('@/lib/scope', async (orig) => ({
  ...(await orig<typeof import('../lib/scope')>()),
  scopedAdmin: async () => ({ s: scope.s, scopeIds: scope.scopeIds }),
}));
vi.mock('@/lib/authz', async (orig) => ({
  ...(await orig<typeof import('../lib/authz')>()),
  requireAdmin: async () => scope.s,
  requireModule: async () => scope.s,
}));

import { createTranslator } from 'next-intl';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { createIndividualTxn } from '../core/payroll-individual-txn';
import {
  REPROCESS_REQUIRED,
  applyFilters,
  needsReprocess,
  payrollListState,
  periodsForYear,
  reprocessEmploymentIds,
} from '../app/payroll/dashboard-logic';
import PayrollListPage from '../app/payroll/page';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

// ─────────────────────────── walking a rendered server-component tree ───────────────────────────

type Elementish = { type?: unknown; props?: Record<string, unknown> };

/** Every string anywhere in the rendered tree — the text a reader would see, plus title attributes. */
function collectText(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, acc);
    return acc;
  }
  const props = (node as Elementish).props;
  if (props) for (const v of Object.values(props)) collectText(v, acc);
  return acc;
}

/** Every `href` in the tree, including inside props that are nodes (the row menu passes links down). */
function collectHrefs(node: unknown, acc: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectHrefs(n, acc);
    return acc;
  }
  const props = (node as Elementish).props;
  if (props) {
    if (typeof props.href === 'string') acc.push(props.href);
    for (const v of Object.values(props)) collectHrefs(v, acc);
  }
  return acc;
}

/**
 * The text of the ONE TABLE ROW for a batch — found by the hrefs it carries, not by position.
 *
 * Row-scoped on purpose. The summary tiles across the top of this screen are labelled with the very same
 * keys (`t('status.processed')` and friends), so a whole-tree `not.toContain('status.processed')` can
 * never pass and the "Reprocess Required INSTEAD of Processed" rule — the reporter's actual ask — would
 * go unasserted while looking asserted.
 */
function rowTextFor(node: unknown, batchId: string): string[] {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = rowTextFor(n, batchId);
      if (found.length) return found;
    }
    return [];
  }
  const el = node as Elementish;
  if (el.type === 'tr' && collectHrefs(el).some((h) => h.includes(batchId))) return collectText(el);
  if (!el.props) return [];
  for (const v of Object.values(el.props)) {
    const found = rowTextFor(v, batchId);
    if (found.length) return found;
  }
  return [];
}

/** The `statusOptions` the page hands its filter bar — the options the single-select can offer. */
function statusOptionsOf(node: unknown): { value: string; label: string }[] | null {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = statusOptionsOf(n);
      if (found) return found;
    }
    return null;
  }
  const el = node as Elementish;
  if (Array.isArray(el.props?.statusOptions)) return el.props.statusOptions as { value: string; label: string }[];
  if (!el.props) return null;
  for (const v of Object.values(el.props)) {
    const found = statusOptionsOf(v);
    if (found) return found;
  }
  return null;
}

// ────────────────────────────── A. the derivation, pure (no DB) ──────────────────────────────

describe('0b326d5f — the display state is derived, and CLOSED is silent whatever the flag says', () => {
  const at = new Date('2026-08-01T02:00:00Z');

  it('a processed run carrying the mark reads as reprocess_required; a clean one still reads processed', () => {
    expect(payrollListState({ status: 'processed', needsRecalcAt: at })).toBe(REPROCESS_REQUIRED);
    expect(payrollListState({ status: 'processed', needsRecalcAt: null })).toBe('processed');
    expect(payrollListState({ status: 'processed' })).toBe('processed');
    expect(needsReprocess({ status: 'processed', needsRecalcAt: at })).toBe(true);
  });

  it('a CLOSED run never shows it, and that is the reporter\'s own rule rather than a defensive habit', () => {
    // `unlockClosedBatch` flips closed → processed and clears NEITHER closed_at NOR needs_recalc_at, so a
    // closed row carrying the mark is reachable, not hypothetical. A derivation written as
    // `status !== 'draft' && needsRecalcAt != null` passes every other case in this file and fails here.
    expect(payrollListState({ status: 'closed', needsRecalcAt: at })).toBe('closed');
    expect(needsReprocess({ status: 'closed', needsRecalcAt: at })).toBe(false);
    expect(reprocessEmploymentIds({ status: 'closed', needsRecalcAt: at, recalcEmploymentIds: ['e1'] })).toEqual([]);
  });

  it('a DRAFT run never shows it either — a draft has no payslips, so nothing of its can be stale', () => {
    expect(payrollListState({ status: 'draft', needsRecalcAt: at })).toBe('draft');
    expect(reprocessEmploymentIds({ status: 'draft', needsRecalcAt: at, recalcEmploymentIds: ['e1'] })).toEqual([]);
  });

  it('the affected set is read defensively out of the jsonb column, and is empty when the run is clean', () => {
    const ids = (v: unknown) => reprocessEmploymentIds({ status: 'processed', needsRecalcAt: at, recalcEmploymentIds: v });
    expect(ids(['e1', 'e2'])).toEqual(['e1', 'e2']);
    expect(ids(['e1', 'e1'])).toEqual(['e1']); // written by a read-modify-write; de-duplicated, not counted twice
    expect(ids(['e1', '', 7, null])).toEqual(['e1']);
    expect(ids(null)).toEqual([]);
    expect(ids('e1')).toEqual([]); // not an array — never a count of 1 for a string of length 2
    expect(reprocessEmploymentIds({ status: 'processed', needsRecalcAt: null, recalcEmploymentIds: ['e1'] })).toEqual([]);
  });
});

// ─────────────────────── B. the status filter reaches the new chip ───────────────────────

describe('0b326d5f — the new state is FILTERABLE, and Processed keeps its old meaning', () => {
  const at = new Date('2026-08-01T02:00:00Z');
  const rows = [
    { payPeriod: '2026-05', companyId: 'c1', runType: 'regular', status: 'draft', needsRecalcAt: null },
    { payPeriod: '2026-06', companyId: 'c1', runType: 'regular', status: 'processed', needsRecalcAt: null },
    { payPeriod: '2026-07', companyId: 'c1', runType: 'regular', status: 'processed', needsRecalcAt: at },
    { payPeriod: '2026-08', companyId: 'c1', runType: 'regular', status: 'closed', needsRecalcAt: at },
  ];
  const all = { periods: periodsForYear(2026), companyIds: [], cycles: [], statuses: [] };

  it('selecting Reprocess Required narrows to exactly the marked PROCESSED runs', () => {
    const got = applyFilters(rows, { ...all, statuses: [REPROCESS_REQUIRED] });
    expect(got.map((r) => r.payPeriod)).toEqual(['2026-07']);
  });

  it('selecting Processed still returns the stale run too — nothing that understood it changed meaning', () => {
    // The approved plan told the reporter this in as many words: keeping the three stored values is what
    // leaves every existing filter, report and export working unchanged. A build that made the two
    // mutually exclusive would silently hide '2026-07' from the Processed view.
    const got = applyFilters(rows, { ...all, statuses: ['processed'] });
    expect(got.map((r) => r.payPeriod)).toEqual(['2026-06', '2026-07']);
  });

  it('the other filters are untouched, and an unknown status still matches nothing', () => {
    expect(applyFilters(rows, { ...all, statuses: ['draft'] }).map((r) => r.payPeriod)).toEqual(['2026-05']);
    expect(applyFilters(rows, { ...all, statuses: ['closed'] }).map((r) => r.payPeriod)).toEqual(['2026-08']);
    expect(applyFilters(rows, { ...all, statuses: [] })).toHaveLength(4);
    expect(applyFilters(rows, { ...all, statuses: ['nonsense'] })).toEqual([]);
  });
});

// ───────────────── C. the real screen, real run, real mechanism ─────────────────

describe('0b326d5f — the Payroll Process listing renders the state, the count and the way in', () => {
  let base: Base;
  let companyId: string;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    companyId = base.companyId;
    // The gate the Reprocess link rides — the same one the ⋯ row action uses. Without it the link is
    // legitimately absent and the "way in" assertions would pass vacuously.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    // The ledger writes onto a processed run whatever the kernel does with the row afterwards; pinned
    // rather than assumed, because seedBase writes TRUE on any box carrying INDIVIDUAL_TXN_PAY_ENABLED.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', false);
    const a = await entitledCtx(base);
    scope.s = { ...adminCtx(base), entitlements: a.entitlements };
    scope.scopeIds = [companyId];
  });

  let ic = 0;
  /** One payroll-ready employee. `icNumber` is unique per tenant, so each hire gets its own. */
  async function hire(name: string): Promise<string> {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.replace(/\W/g, '')}${randomUUID()}@acme.test` },
      companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-06-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4200, effectiveFrom: '2025-06-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `9001010123${String(ic++).padStart(2, '0')}` });
    return e.employmentId;
  }

  /** The batch row as stored — read as OWNER so no assertion can be shaped by an RLS accident. */
  async function batchRow(batchId: string) {
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    return row;
  }

  /** Render the listing for the whole of 2026 (?m=all), and hand back what it put on screen. */
  async function renderList(status?: string) {
    const tree = await PayrollListPage({
      searchParams: Promise.resolve({ year: '2026', m: 'all', ...(status ? { status } : {}) }),
    });
    return {
      text: collectText(tree),
      hrefs: collectHrefs(tree),
      statusOptions: statusOptionsOf(tree),
      row: (batchId: string) => {
        const cells = rowTextFor(tree, batchId);
        // A row that was not found reads as an empty array, and every `not.toContain` below would then
        // pass for the wrong reason. Fail loudly instead.
        expect(cells.length, `no table row rendered for batch ${batchId}`).toBeGreaterThan(0);
        return cells;
      },
      tree,
    };
  }

  it('a processed run whose inputs moved reads "Reprocess Required" INSTEAD of "Processed", with its count and a way in', async () => {
    const a = adminCtx(base);
    const one = await hire('Stale One');
    const two = await hire('Stale Two');
    const { batchId } = await createBatch(a, { companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    // Clean first: the badge must be earned by the mark, not printed by every processed run.
    const clean = await renderList();
    expect(clean.row(batchId)).toContain('status.processed');
    expect(clean.row(batchId)).not.toContain('status.reprocessRequired');

    // THE REAL MECHANISM — a one-off transaction keyed onto a run that is already processed.
    await createIndividualTxn(a, { batchId, employmentId: one, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await createIndividualTxn(a, { batchId, employmentId: two, kind: 'earning', txnDate: '2026-05-11', amount: 60 });
    const marked = await batchRow(batchId);
    expect(marked.status, 'the STORED status must stay processed — this is a display state').toBe('processed');
    expect(marked.needsRecalcAt).not.toBeNull();

    const shown = await renderList();
    expect(shown.row(batchId)).toContain('status.reprocessRequired');
    // INSTEAD of, not as well as: a surviving "Processed" pill in the SAME ROW would mean the cell is
    // stacking two contradictory statements about one run.
    expect(shown.row(batchId)).not.toContain('status.processed');
    // The count comes off recalc_employment_ids — two employees were touched, so it says two.
    expect(shown.row(batchId)).toContain('reprocessAffected({"n":2})');
    // …and the way in is the selective reprocess, which reads that same column and arrives pre-ticked.
    expect(shown.hrefs.some((h) => h.startsWith(`/payroll/${batchId}/reprocess?from=`))).toBe(true);
  });

  it('the count follows the run: clearing SOME employments drops it, clearing the LAST returns the run to Processed', async () => {
    const a = adminCtx(base);
    const one = await hire('Partial One');
    const two = await hire('Partial Two');
    const { batchId } = await createBatch(a, { companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    await createIndividualTxn(a, { batchId, employmentId: one, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await createIndividualTxn(a, { batchId, employmentId: two, kind: 'earning', txnDate: '2026-05-11', amount: 60 });
    expect((await renderList()).row(batchId)).toContain('reprocessAffected({"n":2})');

    // A selective reprocess covering ONE of the two — the real clear path.
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [one], reason: 'first only' } });
    const half = await renderList();
    expect(half.row(batchId)).toContain('status.reprocessRequired');
    expect(half.row(batchId)).toContain('reprocessAffected({"n":1})');
    expect(half.row(batchId)).not.toContain('reprocessAffected({"n":2})');

    // …and the LAST one. The mark and the id set are always written together, so the run goes back to
    // reading Processed on its own — no separate "mark it resolved" step, which is what the reporter asked.
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [two], reason: 'second too' } });
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
    const done = await renderList();
    expect(done.row(batchId)).toContain('status.processed');
    expect(done.row(batchId)).not.toContain('status.reprocessRequired');
    expect(done.row(batchId).some((s) => s.startsWith('reprocessAffected('))).toBe(false);
  });

  it('a CLOSED run never shows it, whatever the flag says — Closed stays protected', async () => {
    const a = adminCtx(base);
    const one = await hire('Closed One');
    const { batchId } = await createBatch(a, { companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    // Marked by the real mechanism first — so the row genuinely carries the flag rather than being handed
    // a hand-written timestamp.
    await createIndividualTxn(a, { batchId, employmentId: one, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    expect((await batchRow(batchId)).needsRecalcAt).not.toBeNull();
    // …and CLOSED WITH THE MARK STILL ON IT. Not through `closeBatch`, which refuses exactly this
    // (BatchNeedsRecalculationError) — that refusal is the point of the mechanism and is pinned by
    // test/payroll-txn-edit-after-processing.test.ts. The flip is written directly because the DB's own
    // 0011/0173 trigger refuses ANY write to a row that is ALREADY closed (it fires on OLD.status), so a
    // closed row can only ever acquire this combination in the same statement that closes it.
    //
    // WHY ASSERT A STATE THE APP WILL NOT PRODUCE TODAY: the reporter's requirement is unconditional —
    // "it shall not override Closed status automatically (Closed remains protected)". The display rule
    // has to hold whatever left the flag there — a future unlock path, a history import, a data fix —
    // rather than only while `closeBatch` happens to be the sole way in.
    await owner.db
      .update(schema.payrollBatch)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(schema.payrollBatch.id, batchId));
    const closed = await batchRow(batchId);
    expect(closed.status).toBe('closed');
    expect(closed.needsRecalcAt, 'the fixture must actually leave the flag set, or this case is vacuous').not.toBeNull();
    expect((closed.recalcEmploymentIds ?? []) as string[]).toEqual([one]);

    const shown = await renderList();
    expect(shown.row(batchId)).toContain('status.closed');
    expect(shown.row(batchId)).not.toContain('status.reprocessRequired');
    expect(shown.row(batchId).some((s) => s.startsWith('reprocessAffected('))).toBe(false);
  });

  it('the status filter OFFERS the new state and can actually select it — no chip the filter cannot reach', async () => {
    const a = adminCtx(base);
    const one = await hire('Filter One');
    const clean = await createBatch(a, { companyId, payPeriod: '2026-04' });
    const stale = await createBatch(a, { companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: clean.batchId });
    await generatePayslips(a, { batchId: stale.batchId });
    await createIndividualTxn(a, {
      batchId: stale.batchId,
      employmentId: one,
      kind: 'earning',
      txnDate: '2026-05-10',
      amount: 50,
    });

    const unfiltered = await renderList();
    expect(unfiltered.statusOptions?.map((o) => o.value)).toEqual([
      'draft',
      'processed',
      'closed',
      REPROCESS_REQUIRED,
    ]);
    expect(unfiltered.hrefs.some((h) => h.startsWith(`/payroll/${clean.batchId}?`))).toBe(true);
    expect(unfiltered.hrefs.some((h) => h.startsWith(`/payroll/${stale.batchId}?`))).toBe(true);

    // Selecting it narrows the grid to the marked run…
    const narrowed = await renderList(REPROCESS_REQUIRED);
    expect(narrowed.hrefs.some((h) => h.startsWith(`/payroll/${stale.batchId}?`))).toBe(true);
    expect(narrowed.hrefs.some((h) => h.startsWith(`/payroll/${clean.batchId}?`))).toBe(false);

    // …while Processed still returns BOTH, which is the promise the plan made to the reporter.
    const processed = await renderList('processed');
    expect(processed.hrefs.some((h) => h.startsWith(`/payroll/${stale.batchId}?`))).toBe(true);
    expect(processed.hrefs.some((h) => h.startsWith(`/payroll/${clean.batchId}?`))).toBe(true);
  });
});

// ─────────────────────────── D. the copy exists in all six catalogs ───────────────────────────

describe('0b326d5f — the new labels resolve in every locale', () => {
  const ROOT = path.resolve(__dirname, '..');
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const KEYS = ['payroll.list.status.reprocessRequired', 'payroll.list.reprocessAffected', 'payroll.list.reprocessBadgeNote'];
  const catalog = (loc: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
  const getPath = (obj: Record<string, unknown>, dotted: string): unknown =>
    dotted
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

  it('all three keys exist, and no locale carries the English copy through', () => {
    const en = catalog('en');
    for (const key of KEYS) {
      expect(getPath(en, key), `en: ${key}`).toBeTruthy();
      for (const loc of LOCALES.filter((l) => l !== 'en')) {
        const v = getPath(catalog(loc), key);
        expect(v, `${loc}: ${key}`).toBeTruthy();
        expect(v, `${loc}: ${key} is the English string copied through`).not.toBe(getPath(en, key));
      }
    }
  });

  it('the counted label carries the {n} plural in every locale, so no catalog prints a bare number', () => {
    for (const loc of LOCALES) {
      const v = getPath(catalog(loc), 'payroll.list.reprocessAffected') as string;
      expect(v, `${loc}: reprocessAffected must be an ICU plural on n`).toMatch(/\{n, plural,/);
      expect(v, `${loc}: reprocessAffected needs an 'other' category`).toContain('other {');
    }
  });

  /**
   * THE ACTUAL RENDER CHECK for this copy, and the reason it is here rather than left to a dev-server
   * eyeball: `MISSING_MESSAGE` and a malformed ICU plural both pass tsc, pass `next build` and return
   * 200. The keys above prove the strings EXIST; this proves the six catalogs FORMAT — through the real
   * next-intl translator, at the real plural counts the screen can produce (1, and more than 1).
   */
  it.each(LOCALES)('locale %s formats all three, at n = 1 and n = 2', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'payroll.list' });
    for (const n of [1, 2]) {
      const counted = t('reprocessAffected', { n });
      // next-intl renders MISSING_MESSAGE rather than throwing, so the absence has to be asserted.
      expect(counted, `${locale}: reprocessAffected(n=${n})`).not.toContain('MISSING_MESSAGE');
      expect(counted, `${locale}: reprocessAffected(n=${n}) must print the count`).toContain(String(n));
    }
    expect(t('status.reprocessRequired')).not.toContain('MISSING_MESSAGE');
    expect(t('status.reprocessRequired').length).toBeGreaterThan(0);
    expect(t('reprocessBadgeNote')).not.toContain('MISSING_MESSAGE');
    expect(t('reprocessBadgeNote').length).toBeGreaterThan(0);
  });

  it('payrollStatusEnum is STILL exactly the three stored values — this build added no fourth', () => {
    expect([...schema.payrollStatusEnum.enumValues].sort()).toEqual(['closed', 'draft', 'processed']);
    expect(schema.payrollStatusEnum.enumValues).not.toContain(REPROCESS_REQUIRED);
  });
});
