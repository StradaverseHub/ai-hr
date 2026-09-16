/**
 * r292 defect 2 — THE ANOMALY THRESHOLDS ARE DISCLOSED WHERE THE FINDINGS ARE READ.
 *
 * WHAT WAS WRONG. `payroll_anomaly_config` has 0 rows on production and no admin screen writes it, so all
 * 2,359 anomaly findings were classified by the placeholders in `core/payroll-anomaly.ts` — numbers that
 * file itself says "nobody should mistake for empirical" — and nothing on the screen where an operator
 * works those findings said so. docs/CUSTOMER-DEPLOYMENT-READINESS.md §2.4 allows two outcomes: make them
 * editable, or disclose them as arbitrary.
 *
 * THIS IS THE DISCLOSURE ARM, and the argument is in core/payroll-anomaly.ts above `thresholdResolver`.
 * The short form: the thresholds are ALREADY editable (company row → tenant row → code default, no deploy
 * needed) — what is missing is a form, not a mechanism; a form would not make the numbers empirical; and
 * `core/control-tower.ts` derives `thresholdsTuned` from `count(payroll_anomaly_config) > 0` and refuses to
 * print a staffing headcount while it is false, so shipping a form would let the first admin who saved
 * anything at all unlock a headcount projection backed by a number with no more evidence than the
 * placeholder. Disclosure removes the untruth; a settings screen would dress it up.
 *
 * THREE SECTIONS.
 *
 *   §A ENGINE AGREEMENT — the disclosure is DERIVED, so it can only ever name the numbers the evaluator
 *      really used. Pinned from both ends: a saved config value is what the engine classifies by AND what
 *      the disclosure reports. One shared resolver, so the two cannot diverge.
 *   §B RENDER, UNTUNED — the real page against a real database. A 200 is not a render check and a source
 *      scan is not one either (CLAUDE.md §8); the claim is visual, so the markup is read. `getTranslations`
 *      is next-intl's REAL translator with `onError` rethrowing, which is what makes a FORMATTING_ERROR on
 *      `{pct}` a FAILURE here rather than a raw key rendered into the page.
 *   §C RENDER, CONFIGURED — save a threshold and the "shipped default" tag and the whole placeholder
 *      paragraph are GONE from the same screen. This is what separates a derived disclosure from a static
 *      banner: a banner would still be there, and would then be the new untruth.
 *
 * ⚠️ FILE-LEVEL MOCKS, the house shape (test/r279-balance-health-row.test.ts): requireAdmin() returns the
 * module-level ADMIN; next-intl's server API is the real `createTranslator` over messages/en.json;
 * next/cache and next/navigation are inert. Server components are `async` and react-dom/server cannot
 * render one, so `settle()` awaits every async component before `renderToStaticMarkup`.
 *
 * NON-VACUITY (builder-run, verifier-re-derivable): delete the disclosure block from a copy of
 * app/payroll/[batchId]/anomalies/page.tsx and §B's three render cases and §C's configured case all fail on
 * the missing sentence; make `thresholdsInForce` ignore the config row and §A's agreement case and §C fail.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  evaluateBatchAnomalies,
  thresholdsInForce,
  UNTUNED_DEFAULT_PARAMS,
} from '../core/payroll-anomaly';
import { todayInKualaLumpur } from '../lib/hr-date';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** `effective_from` is NOT NULL with a CURRENT_DATE default the drizzle type does not know about. Derived
 *  from the clock, never a hardcoded date (CLAUDE.md §8): a fixed one eventually becomes a future date. */
const EFFECTIVE_FROM = todayInKualaLumpur();

let ADMIN: SessionContext;
vi.mock('../lib/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz')>()),
  requireAdmin: async () => ADMIN,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const messages = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getLocale: async () => 'en',
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        // ⚠️ LOAD-BEARING: next-intl swallows MISSING_MESSAGE and FORMATTING_ERROR and hands back the key.
        // A bare t() on an ICU string renders the raw key and a jsdom guard reading messages/en.json would
        // never notice — that shipped undetected earlier this session past sixteen guards.
        onError: (e) => {
          throw e;
        },
      }),
  };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AnomaliesPage from '../app/payroll/[batchId]/anomalies/page';

const EN = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8')) as {
  anomaly: Record<string, string>;
};
/** One catalogue leaf, asserted to BE a string so a vanished key cannot make a `toContain` vacuous. */
const an = (key: string): string => {
  expect(typeof EN.anomaly[key], `anomaly.${key} must be a string`).toBe('string');
  return EN.anomaly[key];
};
/** Strip <script> before counting — the RSC payload carries the whole catalogue (CLAUDE.md §8). */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');

const isAsync = (t: unknown): boolean =>
  typeof t === 'function' && (t as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';
async function settle(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settle)) as Promise<ReactNode>;
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (isAsync(el.type)) return settle(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  if (el.props && el.props.children !== undefined) return cloneElement(el, { children: await settle(el.props.children) });
  return node;
}
function toMarkup(tree: ReactNode): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      timeZone: 'Asia/Kuala_Lumpur',
      messages: EN as never,
      children: tree as never,
    }),
  );
}
const renderPage = async (batchId: string): Promise<string> =>
  visible(
    toMarkup(
      await settle(
        await AnomaliesPage({ params: Promise.resolve({ batchId }), searchParams: Promise.resolve({}) }),
      ),
    ),
  );

const PERIOD = '2026-05';
let b: Base;
let a: SessionContext;

async function makeEmp(name: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({
      tenantId: b.tenantId,
      personId: p.id,
      companyId: b.companyId,
      hiredOn: '2020-01-01',
      paymentMethod: 'bank_transfer',
    })
    .returning({ id: schema.employment.id });
  await owner.db.insert(schema.employeeStatutoryMy).values({
    tenantId: b.tenantId,
    personId: p.id,
    bankName: 'Maybank',
    bankAccountNo: '1234567890',
  });
  return e.id;
}

async function makeBatch(period = PERIOD) {
  const [pp] = await owner.db
    .insert(schema.payPeriod)
    .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'open' })
    .returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      payPeriodId: pp.id,
      payPeriod: period,
      batchDate: `${period}-28`,
      status: 'processed',
    })
    .returning({ id: schema.payrollBatch.id });
  return batch.id;
}

/** A clean payslip plus the day of attendance that keeps `pay-without-attendance` quiet (engine test). */
async function addPayslip(batchId: string, employmentId: string, netPay = '4200.00', attendanceDate = '2026-05-04') {
  await owner.db
    .insert(schema.attendance)
    .values({ tenantId: b.tenantId, employmentId, attendanceDate, workedMinutes: 480 });
  await owner.db.insert(schema.payslip).values({
    tenantId: b.tenantId,
    batchId,
    employmentId,
    basicSalary: '5000.00',
    grossPay: '5000.00',
    totalDeductions: '800.00',
    netPay,
    employerCost: '5700.00',
    daysWorked: '31.00',
    statutory: { epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 215 },
  });
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
  ADMIN = a;
});

// ────────────────────────────── §A · ENGINE AGREEMENT ──────────────────────────────

describe('r292 §A — the disclosure names the numbers the engine actually used', () => {
  it('with no config row, both the engine and the disclosure are on the shipped placeholders', async () => {
    const batchId = await makeBatch();
    await addPayslip(batchId, await makeEmp('Untuned'));

    const p = await thresholdsInForce(a, { batchId });
    expect(p.anyUntuned).toBe(true);
    expect(p.thresholds.map((t) => t.detectorId).sort()).toEqual(['batch-swing', 'net-swing']);
    for (const th of p.thresholds) expect(th.source).toBe('untuned_default');
    // The numbers are the constants the engine classifies by — not a second copy written into the screen.
    expect(p.thresholds.find((t) => t.detectorId === 'net-swing')!.params).toEqual(
      UNTUNED_DEFAULT_PARAMS['net-swing'],
    );
    expect(p.thresholds.find((t) => t.detectorId === 'batch-swing')!.params).toEqual(
      UNTUNED_DEFAULT_PARAMS['batch-swing'],
    );
  });

  it('a SAVED threshold is the one the engine reads AND the one the disclosure reports', async () => {
    // The prior cycle a net swing is measured against.
    const employmentId = await makeEmp('Swinger');
    const priorBatch = await makeBatch('2026-04');
    await addPayslip(priorBatch, employmentId, '4200.00', '2026-04-06');
    const batchId = await makeBatch(PERIOD);
    await addPayslip(batchId, employmentId, '3400.00'); // −19.05%: inside 30, outside 5

    // Placeholder 30% ⇒ nothing to see. This is the control that makes the flip below mean something.
    const before = await evaluateBatchAnomalies(a, { batchId });
    expect(before.review + before.block).toBe(0);
    expect((await thresholdsInForce(a, { batchId })).anyUntuned).toBe(true);

    await owner.db.insert(schema.payrollAnomalyConfig).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      detectorId: 'net-swing',
      enabled: true,
      params: { netSwingPct: 5 },
      effectiveFrom: EFFECTIVE_FROM,
    });

    // ENGINE: the saved 5 is what classified this run.
    const after = await evaluateBatchAnomalies(a, { batchId });
    expect(after.review + after.block).toBe(1);

    // DISCLOSURE: the same saved 5, reported as configured — one resolver, so they cannot disagree.
    const p = await thresholdsInForce(a, { batchId });
    const net = p.thresholds.find((t) => t.detectorId === 'net-swing')!;
    expect(net.source).toBe('configured');
    expect(net.params.netSwingPct).toBe(5);
    // …and the untouched detector is still honestly labelled a placeholder.
    expect(p.thresholds.find((t) => t.detectorId === 'batch-swing')!.source).toBe('untuned_default');
    expect(p.anyUntuned).toBe(true);
  });

  it('a row that only DISABLES a detector has tuned nothing, and is not called configured', async () => {
    const batchId = await makeBatch();
    await addPayslip(batchId, await makeEmp('Disabled'));
    await owner.db.insert(schema.payrollAnomalyConfig).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      detectorId: 'net-swing',
      enabled: false,
      params: {},
      effectiveFrom: EFFECTIVE_FROM,
    });
    const p = await thresholdsInForce(a, { batchId });
    expect(p.thresholds.find((t) => t.detectorId === 'net-swing')!.source).toBe('untuned_default');
  });
});

// ────────────────────────────── §B · RENDER, UNTUNED ──────────────────────────────

describe('r292 §B — the disclosure renders on the screen where the findings are read', () => {
  it('the exceptions screen carries the thresholds, their numbers, and the placeholder warning', async () => {
    const batchId = await makeBatch();
    await addPayslip(batchId, await makeEmp('Rendered'));
    await evaluateBatchAnomalies(a, { batchId }); // the strip only renders once the checks have run

    const html = await renderPage(batchId);

    // The heading and the full placeholder paragraph — the sentence a customer must not be able to miss.
    expect(html).toContain(an('thresholdsHeading'));
    expect(html).toContain(an('thresholdsUntuned'));
    expect(an('thresholdsUntuned')).toMatch(/no empirical basis/i);
    // Both thresholds, with their real numbers resolved through ICU rather than a raw key.
    expect(html).toContain(`Pay change for one employee: ${UNTUNED_DEFAULT_PARAMS['net-swing'].netSwingPct}%`);
    expect(html).toContain(`Pay change for the whole run: ${UNTUNED_DEFAULT_PARAMS['batch-swing'].batchSwingPct}%`);
    // Each tagged as a shipped default, and NOT as something anyone set.
    expect(html).toContain(an('thresholdSourceDefault'));
    expect(html).not.toContain(an('thresholdSourceConfigured'));
    // No raw key and no next-intl error string anywhere in the visible markup.
    for (const k of ['thresholdsHeading', 'thresholdNetSwing', 'thresholdBatchSwing', 'thresholdsUntuned'])
      expect(html, `anomaly.${k} rendered as its key`).not.toContain(`anomaly.${k}`);
    expect(html).not.toMatch(/FORMATTING_ERROR|MISSING_MESSAGE/);
  });

  it('it sits ABOVE the queue, so nobody works the findings without passing it', async () => {
    const batchId = await makeBatch();
    await addPayslip(batchId, await makeEmp('Ordering'));
    await evaluateBatchAnomalies(a, { batchId });

    const html = await renderPage(batchId);
    const disclosureAt = html.indexOf(an('thresholdsUntuned'));
    const coverageAt = html.indexOf(an('coverageHelp'));
    const breakerAt = html.indexOf(an('circuitBreakerHeading'));
    expect(disclosureAt).toBeGreaterThan(-1);
    // Inside the measurement strip (after the coverage note) and before the run-level check card, which is
    // itself above the queue. Position asserted as a RELATION between rendered landmarks, not an offset.
    expect(disclosureAt).toBeGreaterThan(coverageAt);
    expect(disclosureAt).toBeLessThan(breakerAt);
  });

  it('the disclosure is not on a screen with no findings to qualify', async () => {
    // A batch whose checks have never run shows the "run it" card and nothing to caveat. Asserting the
    // absence here is what stops the case above from passing on a page that prints it unconditionally.
    const batchId = await makeBatch();
    await addPayslip(batchId, await makeEmp('NeverRun'));
    const html = await renderPage(batchId);
    expect(html).toContain(an('neverRun'));
    expect(html).not.toContain(an('thresholdsHeading'));
  });
});

// ────────────────────────────── §C · RENDER, CONFIGURED ──────────────────────────────

describe('r292 §C — and it stops calling a threshold a placeholder once one is configured', () => {
  it('a saved threshold renders as set-for-this-company, and the warning is gone', async () => {
    const batchId = await makeBatch();
    await addPayslip(batchId, await makeEmp('Tuned'));
    for (const detectorId of ['net-swing', 'batch-swing'])
      await owner.db.insert(schema.payrollAnomalyConfig).values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        detectorId,
        enabled: true,
        params: detectorId === 'net-swing' ? { netSwingPct: 12 } : { batchSwingPct: 7 },
        effectiveFrom: EFFECTIVE_FROM,
      });
    await evaluateBatchAnomalies(a, { batchId });

    const html = await renderPage(batchId);
    // The configured numbers, not the placeholders.
    expect(html).toContain('Pay change for one employee: 12%');
    expect(html).toContain('Pay change for the whole run: 7%');
    expect(html).not.toContain('Pay change for one employee: 30%');
    expect(html).toContain(an('thresholdSourceConfigured'));
    expect(html).not.toContain(an('thresholdSourceDefault'));
    // THE POINT OF A DERIVED DISCLOSURE: the placeholder paragraph disappears by itself. A hand-written
    // banner would still be here, and would be the new untruth.
    expect(html).not.toContain(an('thresholdsUntuned'));
    // …while the heading stays, because "which numbers judged this run" is worth knowing either way.
    expect(html).toContain(an('thresholdsHeading'));
  });

  it('an archived config row stops counting as configured', async () => {
    const batchId = await makeBatch();
    await addPayslip(batchId, await makeEmp('Archived'));
    const [row] = await owner.db
      .insert(schema.payrollAnomalyConfig)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        detectorId: 'net-swing',
        enabled: true,
        params: { netSwingPct: 12 },
        effectiveFrom: EFFECTIVE_FROM,
      })
      .returning({ id: schema.payrollAnomalyConfig.id });
    await owner.db
      .update(schema.payrollAnomalyConfig)
      .set({ archivedAt: new Date() })
      .where(eq(schema.payrollAnomalyConfig.id, row.id));
    await evaluateBatchAnomalies(a, { batchId });

    const html = await renderPage(batchId);
    expect(html).toContain('Pay change for one employee: 30%');
    expect(html).toContain(an('thresholdsUntuned'));
  });
});
