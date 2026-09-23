/**
 * 72b100cd (r331) — THE RECEIPT / TRANSACTION DETAILS SCREEN, and the one writer underneath it.
 *
 * WHAT THIS ITEM ACTUALLY WAS. The record, the year-at-a-time read and the writer all shipped in r321:
 * `pcb_payment` (migration 0476) is keyed by MONTH, `pcbPaymentsForYear` has always read a whole year
 * into a Map, and `recordPcbPayment` has always upserted one slot. What was missing was a PLACE — the
 * only door was the bottom of the CP39 screen, for the one month that screen had open. So this round is
 * a SCREEN over an existing service, and every claim below is about the screen or about keeping the
 * service singular; none of it re-tests the service, which test/72b100cd-pcb-payment.test.ts owns.
 *
 * THE FIVE CLAIMS
 *
 *   1. ⚠️ ONE WRITER. The obvious way to build a second screen is to give it a second server action, and
 *      two writers of a money-adjacent record is how two screens come to disagree about what an employer
 *      paid a tax authority. The action moved UP to app/payroll/pcb-payment-actions.ts and BOTH screens
 *      import that exact file; a source scan asserts no other module under app/ or core/ writes the
 *      table. (The guard shape 8cd601d0 used the week before: comment-stripped source, because these
 *      files explain the rule at length and a bare grep matches the prose.)
 *   2. TWENTY-FOUR SLOTS, TWELVE MONTHS, IN ORDER. January through December, MTD and CP38 apart. The
 *      order is DERIVED from the year rather than read out of the query, which is stronger than an
 *      ORDER BY: a month with no row cannot fall out of the list, because nothing about the list comes
 *      from the rows.
 *   3. AN ABSENT RECEIPT IS NOT AN EMPTY ONE. A month with no row says NOT RECORDED in words. An empty
 *      input alone is ambiguous between "nobody keyed this" and "somebody keyed nothing", and on the
 *      form this feeds an absent box asserts nothing while a zero asserts the money does not exist
 *      (CLAUDE.md §8).
 *   4. ⚠️ AN OUT-OF-SCOPE COMPANY IS A BARE 404, AND IT IS THIS PAGE'S GUARD THAT REFUSES. A receipt
 *      names one company's payment to LHDN. The last describe proves the refusal is NOT RLS doing the
 *      work: the foreign company is in the SAME TENANT and the same context reads its payment row
 *      happily one line earlier (§8 — "a green refusal test may be pinning RLS, not your guard").
 *   5. THE CP39 BOXES STAY. The plan tells the reporter that path still works, and it is a path somebody
 *      uses today.
 *
 * ⚠️ MULTI-NAMESPACE FILE, SO i18n CHECK C IS BLIND TO IT. The screen takes its field labels from
 * `payroll.cp39Form` (the receipt-number, payment-date, MTD, CP38 and Save labels are facts about the
 * payment and true on both screens) and its own sentences from `payroll.statutoryForms`. Two namespaces
 * in one file means test/i18n-coverage.test.ts check C skips it ENTIRELY, static keys included — so the
 * locale describe below resolves every key the page uses in all six locales, which is stricter than the
 * check it stands in for.
 *
 * FILE-LEVEL MOCKS: `scopedAdmin` is a fake whose answer is swapped per case; `notFound()` throws;
 * `getTranslations` ECHOES KEY NAMES, so the strings asserted below are keys where they mean sentences —
 * the real sentences are proved to exist by the locale describe and to render by the §8 dev-server check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { todayInKualaLumpur } from '../lib/hr-date';
import { pcbPaymentsForYear, recordPcbPayment } from '../core/pcb-payment';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped: these files explain the one-writer rule in prose a grep would match. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SCREEN = 'app/payroll/statutory-forms/pcb2ii/receipts/page.tsx';
const ACTIONS = 'app/payroll/pcb-payment-actions.ts';
const PICKER = 'app/payroll/statutory-forms/pcb2ii/page.tsx';
const CP39 = 'app/payroll/cp39/preview/page.tsx';
const ROUTE = '/payroll/statutory-forms/pcb2ii/receipts';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** The mocked answer from `scopedAdmin`, swapped per case. Set in `beforeEach`. */
let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// Keys, not sentences — so an assertion below names the key the screen must use, and a reworded string
// cannot quietly turn a test green or red. `values` are appended so a placeholder that never arrives is
// visible as a missing value rather than as identical output.
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  getLocale: async () => 'en',
}));

import { renderToStaticMarkup } from 'react-dom/server';
import ReceiptsPage from '../app/payroll/statutory-forms/pcb2ii/receipts/page';
import { recordPcbPaymentAction } from '../app/payroll/pcb-payment-actions';

let b: Base;
let foreignCompanyId: string;

/** DERIVED FROM THE TENANT'S CLOCK, never written down: the screen opens on the KL year. */
const YEAR = todayInKualaLumpur().slice(0, 4);

const ctxFor = (): SessionContext => adminCtx(b);

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup((await ReceiptsPage({ searchParams: Promise.resolve(sp) })) as never);

/** Every TOP-LEVEL <form> in the markup, so "is this one inside that one" is answerable. */
function formBlocks(markup: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (const m of markup.matchAll(/<form[\s>]|<\/form>/g)) {
    const at = m.index ?? 0;
    if (m[0] === '</form>') {
      depth -= 1;
      if (depth === 0) out.push(markup.slice(start, at));
    } else {
      if (depth === 0) start = at;
      depth += 1;
    }
  }
  return out;
}

/** The one slot form for a month and a stream, found by its own hidden inputs. */
function slot(markup: string, periodKey: string, kind: 'mtd' | 'cp38'): string {
  const found = formBlocks(markup).filter(
    (f) => f.includes(`value="${periodKey}"`) && f.includes(`value="${kind}"`),
  );
  expect(found, `exactly one ${kind} slot for ${periodKey}`).toHaveLength(1);
  return found[0];
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [fc] = await owner.db
    .insert(schema.company)
    // SAME TENANT on purpose — see the RLS describe at the bottom. A different tenant would be refused
    // by RLS and would prove nothing about this page's own guard.
    .values({ tenantId: b.tenantId, legalName: 'Neighbour Sdn Bhd' })
    .returning({ id: schema.company.id });
  foreignCompanyId = fc.id;
  scope = { s: ctxFor(), scopeIds: [b.companyId] };
});

// ───────────────────────────── 1. ONE WRITER ─────────────────────────────

describe('72b100cd · one writer of pcb_payment, imported by both screens', () => {
  /** Every first-party source file, so "who else writes this table" is a whole-repo answer. */
  function sources(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    };
    for (const d of ['app', 'core', 'lib', 'packs', 'localization']) walk(path.join(ROOT, d));
    return out.sort();
  }

  /**
   * ⚠️ THE GUARD THIS ROUND EXISTS FOR. A second `.insert(pcbPayment)` or `.update(pcbPayment)` anywhere
   * is a second definition of what a recorded payment IS — a second trim rule, a second period check, a
   * second event. The upsert in core/pcb-payment.ts is the only one.
   */
  it('exactly ONE module inserts or updates the table, and it writes exactly once', () => {
    const writers = sources().filter((f) =>
      /\.(insert|update)\(\s*(schema\.)?pcbPayment\b/.test(code(read(f))),
    );
    expect(writers, `unexpected writer(s) of pcb_payment:\n${writers.join('\n')}`).toEqual([
      'core/pcb-payment.ts',
    ]);
    // …and ONCE inside it. A second statement in the one writer is the same defect a file away: the
    // upsert is the whole contract (one box per company, month and stream), so a plain insert beside it
    // would be a path that appends where the form can only print one.
    const service = code(read('core/pcb-payment.ts'));
    expect(service.match(/\.(insert|update)\(\s*pcbPayment\b/g)).toHaveLength(1);
    expect(service, 'and that one write is the upsert').toMatch(/onConflictDoUpdate/);
  });

  /** And exactly one module under app/ calls it — the shared server action, not a screen. */
  it('exactly ONE server action calls recordPcbPayment', () => {
    const callers = sources().filter(
      (f) => f.startsWith('app/') && /\brecordPcbPayment\s*\(/.test(code(read(f))),
    );
    expect(callers, `unexpected caller(s) of recordPcbPayment:\n${callers.join('\n')}`).toEqual([ACTIONS]);
    expect(code(read(ACTIONS)), 'and it is a server action').toMatch(/^'use server';/);
  });

  /**
   * THE TWO SCREENS RESOLVE TO THE SAME FILE. Asserted by RESOLVING each screen's relative specifier
   * against its own directory rather than by comparing the two strings: the specifiers differ (different
   * depths) and a future move that broke the sharing would still leave both strings looking plausible.
   */
  it('the CP39 screen and the receipts screen import the SAME action module', () => {
    const resolved = (rel: string) => {
      const m = code(read(rel)).match(/import \{ recordPcbPaymentAction \} from '([^']+)'/);
      expect(m, `${rel} imports the shared action`).not.toBeNull();
      return path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), m![1])).replace(/\\/g, '/');
    };
    expect(resolved(CP39)).toBe(ACTIONS.replace(/\.ts$/, ''));
    expect(resolved(SCREEN)).toBe(ACTIONS.replace(/\.ts$/, ''));
  });

  /** The old per-screen home must not come back as a copy beside the shared one. */
  it('no per-screen copy of the action survives under app/payroll/cp39', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/payroll/cp39/actions.ts'))).toBe(false);
  });

  /**
   * BOTH DOORS ARE REVALIDATED BY THE ONE WRITER. If the action refreshed only the screen that
   * submitted, keying a month here would leave a stale month in the CP39 screen's cache — the two
   * screens disagreeing, arriving through the cache rather than through a second writer.
   */
  it('the writer revalidates BOTH screens, from literals', () => {
    const body = code(read(ACTIONS));
    expect(body).toContain("'/payroll/cp39/preview'");
    expect(body).toContain(`'${ROUTE}'`);
    expect(body, 'nothing from the form reaches revalidatePath').not.toMatch(/revalidatePath\(\s*(String|formData)/);
  });
});

// ───────────────────────── 2. THE SHAPE OF THE SCREEN ─────────────────────────

describe('72b100cd · twelve months, two streams, in order', () => {
  it('renders 24 slots — January to December, MTD and CP38, ascending', async () => {
    const markup = await render({ companyId: b.companyId, year: YEAR });

    const seen = [...markup.matchAll(/name="periodKey" value="(\d{4}-\d{2})"/g)].map((m) => m[1]);
    // TWELVE MONTHS IN ORDER IS THE WHOLE POINT of the screen, so it is asserted as a sequence and not
    // as a set: a year whose rows arrive out of order must still read January first.
    expect(seen).toEqual(MONTHS.flatMap((mm) => [`${YEAR}-${mm}`, `${YEAR}-${mm}`]));
    expect(formBlocks(markup).filter((f) => f.includes('name="periodKey"')), '24 slots').toHaveLength(24);

    for (const mm of MONTHS) {
      expect(slot(markup, `${YEAR}-${mm}`, 'mtd')).toContain('name="receiptRef"');
      expect(slot(markup, `${YEAR}-${mm}`, 'cp38')).toContain('name="paidOn"');
    }
  });

  /**
   * THE ORDER IS THE SCREEN'S, NOT THE QUERY'S. Rows keyed in reverse must still render forwards — which
   * is what "derive the twelve months from the year" buys over trusting a read to come back sorted.
   */
  it('the month order survives rows inserted backwards', async () => {
    for (const mm of [...MONTHS].reverse()) {
      await recordPcbPayment(ctxFor(), {
        companyId: b.companyId,
        periodKey: `${YEAR}-${mm}`,
        kind: 'mtd',
        receiptRef: `R-${mm}`,
        paidOn: todayInKualaLumpur(),
      });
    }
    const markup = await render({ companyId: b.companyId, year: YEAR });
    const seen = [...markup.matchAll(/name="periodKey" value="\d{4}-(\d{2})"/g)].map((m) => m[1]);
    expect(seen).toEqual(MONTHS.flatMap((mm) => [mm, mm]));
  });

  /** A GET filter and 24 POST slots, all siblings: a nested form is dropped by the browser. */
  it('no form is nested inside another', async () => {
    const markup = await render({ companyId: b.companyId, year: YEAR });
    expect(formBlocks(markup), 'one filter + 24 slots').toHaveLength(25);
    for (const f of formBlocks(markup)) {
      expect(f.slice(1), 'a top-level form contains no <form>').not.toMatch(/<form[\s>]/);
    }
  });

  /** The screen opens on the TENANT's year when none was asked for — not the host's UTC year. */
  it('defaults to the Kuala Lumpur year, and honours a year that was asked for', async () => {
    expect(await render({ companyId: b.companyId })).toContain(`value="${YEAR}-01"`);
    const other = String(Number(YEAR) - 3);
    expect(await render({ companyId: b.companyId, year: other })).toContain(`value="${other}-01"`);
    // A junk year falls back rather than producing twelve months of "20xx-01".
    expect(await render({ companyId: b.companyId, year: '20xx' })).toContain(`value="${YEAR}-01"`);
  });
});

// ─────────────────── 3. ABSENT IS NOT EMPTY, AND IT IS SAID IN WORDS ───────────────────

describe('72b100cd · a month with no row is NOT RECORDED, not a blank box', () => {
  it('an unkeyed slot says so, and offers an empty input rather than a value', async () => {
    const markup = await render({ companyId: b.companyId, year: YEAR });
    expect(
      [...markup.matchAll(/pcb2iiReceiptsNotRecorded/g)],
      'nothing is recorded yet, so all 24 say so',
    ).toHaveLength(24);
    expect(markup, 'and none of them claims to be recorded').not.toContain('pcb2iiReceiptsRecorded"');
    const s = slot(markup, `${YEAR}-04`, 'mtd');
    // ⚠️ NOT `value="0.00"`, NOT a placeholder that could be mistaken for a reference: an absent receipt
    // asserts nothing, and the screen must not put words in the operator's mouth.
    expect(s).not.toMatch(/name="receiptRef"[^>]*value="[^"]/);
    expect(s).not.toMatch(/name="paidOn"[^>]*value="[^"]/);
  });

  it('a keyed slot shows its reference and date, and flips to RECORDED', async () => {
    const paidOn = todayInKualaLumpur();
    await recordPcbPayment(ctxFor(), {
      companyId: b.companyId,
      periodKey: `${YEAR}-04`,
      kind: 'cp38',
      receiptRef: 'LHDN/CP38/7781',
      paidOn,
    });
    const markup = await render({ companyId: b.companyId, year: YEAR });
    const s = slot(markup, `${YEAR}-04`, 'cp38');
    expect(s).toContain('value="LHDN/CP38/7781"');
    expect(s).toContain(`value="${paidOn}"`);
    expect(s).toContain('pcb2iiReceiptsRecorded');
    // ITS NEIGHBOUR IS UNTOUCHED — the two streams are receipted separately and the form prints them in
    // different columns, so one being keyed must not imply the other.
    expect(slot(markup, `${YEAR}-04`, 'mtd')).toContain('pcb2iiReceiptsNotRecorded');
    expect([...markup.matchAll(/pcb2iiReceiptsNotRecorded/g)]).toHaveLength(23);
    // The header counts what is actually there, out of the ruled 24.
    expect(markup).toContain('pcb2iiReceiptsCount:{&quot;recorded&quot;:1,&quot;total&quot;:24}');
  });

  /** Only the year asked for: last December is not this January. */
  it('a neighbouring year’s receipt does not leak into this one', async () => {
    await recordPcbPayment(ctxFor(), {
      companyId: b.companyId,
      periodKey: `${Number(YEAR) - 1}-12`,
      kind: 'mtd',
      receiptRef: 'LAST-YEAR',
      paidOn: todayInKualaLumpur(),
    });
    const markup = await render({ companyId: b.companyId, year: YEAR });
    expect(markup).not.toContain('LAST-YEAR');
    expect([...markup.matchAll(/pcb2iiReceiptsNotRecorded/g)]).toHaveLength(24);
  });
});

// ───────────────── 4. THE CONTRACT BETWEEN THE SCREEN AND THE ACTION ─────────────────

/**
 * THE DEFECT CLASS THIS PINS: a form whose hidden field names drift from what the action reads posts a
 * green-looking save that writes nothing (or writes the wrong month). It lives in the contract between
 * two files, so it is pinned across both — the FormData below is built from the fields the RENDERED slot
 * actually carries, not from what this test believes they are called.
 */
describe('72b100cd · what the slot posts is what the writer reads', () => {
  it('submitting a rendered slot writes that month, that stream, and nothing else', async () => {
    const markup = await render({ companyId: b.companyId, year: YEAR });
    const s = slot(markup, `${YEAR}-07`, 'mtd');

    const fd = new FormData();
    for (const m of s.matchAll(/<input type="hidden" name="([a-zA-Z]+)" value="([^"]*)"/g)) fd.set(m[1], m[2]);
    expect([...fd.keys()].sort(), 'the slot carries its own identity').toEqual(['companyId', 'kind', 'periodKey']);
    // The two editable boxes are the operator's; they are on the form and they are EMPTY on an unkeyed
    // month, which is what the round trip below fills in.
    expect(s).toMatch(/name="receiptRef"/);
    expect(s).toMatch(/name="paidOn"/);
    fd.set('receiptRef', 'LHDN-000777');
    fd.set('paidOn', todayInKualaLumpur());

    await recordPcbPaymentAction(fd);

    const rows = await owner.db
      .select({ period: schema.pcbPayment.periodKey, kind: schema.pcbPayment.kind, ref: schema.pcbPayment.receiptRef })
      .from(schema.pcbPayment)
      .where(eq(schema.pcbPayment.companyId, b.companyId));
    expect(rows).toEqual([{ period: `${YEAR}-07`, kind: 'mtd', ref: 'LHDN-000777' }]);

    // …and the screen now shows it, which is the round trip the reporter actually asked for.
    expect(slot(await render({ companyId: b.companyId, year: YEAR }), `${YEAR}-07`, 'mtd')).toContain(
      'value="LHDN-000777"',
    );
  });

  /** The action re-guards the company even though the slot's hidden input is this screen's own. */
  it('a hand-edited companyId in the posted form is refused by the action, not honoured', async () => {
    const fd = new FormData();
    fd.set('companyId', foreignCompanyId);
    fd.set('periodKey', `${YEAR}-07`);
    fd.set('kind', 'mtd');
    fd.set('receiptRef', 'SHOULD-NOT-LAND');
    await expect(recordPcbPaymentAction(fd)).rejects.toThrow(/not one you may record/);
    const rows = await owner.db
      .select({ id: schema.pcbPayment.id })
      .from(schema.pcbPayment)
      .where(eq(schema.pcbPayment.companyId, foreignCompanyId));
    expect(rows).toHaveLength(0);
  });
});

// ───────────────── 5. THE GATE, AND WHOSE GATE IT IS ─────────────────

describe('72b100cd · an out-of-scope company is a bare 404 from THIS page’s guard', () => {
  /**
   * ⚠️ NON-VACUITY, AND THE §8 QUESTION "IS THIS RLS OR MY GUARD". The neighbour company is in the SAME
   * TENANT, and the first two expectations below read its payment row through the very context the page
   * uses — RLS lets it through. So the 404 that follows can only be this page's own scope check.
   *
   * Verified by hand (r331): delete `if (requested && !scopeIds.includes(requested)) notFound();` from
   * the page and this case renders 200 markup carrying NEIGHBOUR-1.
   */
  it('refuses a company this admin may not administer — and it is not RLS doing it', async () => {
    await recordPcbPayment(ctxFor(), {
      companyId: foreignCompanyId,
      periodKey: `${YEAR}-02`,
      kind: 'mtd',
      receiptRef: 'NEIGHBOUR-1',
      paidOn: todayInKualaLumpur(),
    });
    const visible = await pcbPaymentsForYear(ctxFor(), { companyId: foreignCompanyId, year: Number(YEAR) });
    expect(visible.get(`${YEAR}-02|mtd`)?.receiptRef, 'RLS does NOT refuse this read').toBe('NEIGHBOUR-1');

    scope = { s: ctxFor(), scopeIds: [b.companyId] }; // …but the admin's scope does not include it
    await expect(render({ companyId: foreignCompanyId, year: YEAR })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  /** A company id that is not a company at all is the SAME refusal — the URL enumerates nothing. */
  it('an unknown or malformed companyId is the same 404', async () => {
    for (const companyId of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
      await expect(render({ companyId, year: YEAR })).rejects.toThrow('NEXT_NOT_FOUND');
    }
  });

  /** ABSENT is a different question from FOREIGN: nothing was asked for, so a default is shown. */
  it('no companyId at all shows the first company this admin administers', async () => {
    const markup = await render({});
    expect(markup).toContain(`value="${b.companyId}"`);
    expect(markup).not.toContain(foreignCompanyId);
  });

  it('the page guards itself and is on the statutory shelf’s existing column', () => {
    expect(code(read(SCREEN)), 'scopedAdmin, not isAdmin').toContain('scopedAdmin()');
    expect(REGISTERED_ROUTES.has(ROUTE), `${ROUTE} has a matrix column`).toBe(true);
    const perms = read('lib/permissions.ts');
    const payrollAt = perms.indexOf("screenKey: 'payroll'");
    const nextAt = perms.indexOf('screenKey:', payrollAt + 1);
    expect(perms.slice(payrollAt, nextAt), 'on the SAME column as the rest of the shelf').toContain(`'${ROUTE}'`);
  });

  /**
   * A server action reaching a client island as a prop is a 500 at runtime while tsc, the suite and
   * `next build` all stay green. This screen has no client island at all, which is the strongest form.
   */
  it('renders no client island, so nothing crosses the server→client boundary', () => {
    const src = read(SCREEN);
    expect(src).not.toContain("'use client'");
    const imports = [...code(src).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports.filter((i) => i.startsWith('.') || i.startsWith('@/'))) {
      const base = spec.startsWith('@/') ? path.join(ROOT, spec.slice(2)) : path.resolve(path.dirname(path.join(ROOT, SCREEN)), spec);
      const file = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => `${base}${e}`).find((p) => fs.existsSync(p));
      if (file) expect(fs.readFileSync(file, 'utf8').slice(0, 40), `${spec} is a server module`).not.toContain('use client');
    }
  });
});

// ───────────────── 6. THE CP39 PATH THE REPORTER WAS PROMISED ─────────────────

describe('72b100cd · the CP39 boxes stay, and they write the same record', () => {
  it('the CP39 screen still renders both streams and posts to the shared action', () => {
    const src = code(read(CP39));
    expect(src, 'the payment form is still there').toContain('action={recordPcbPaymentAction}');
    expect(src).toContain("t('pcbPaymentTitle')");
    expect(src).toMatch(/\bmtd\b/);
    expect(src).toMatch(/\bcp38\b/);
  });

  it('a receipt keyed on either screen is the one row both read', async () => {
    // Keyed exactly as the CP39 screen posts it…
    const fd = new FormData();
    fd.set('companyId', b.companyId);
    fd.set('periodKey', `${YEAR}-09`);
    fd.set('kind', 'mtd');
    fd.set('receiptRef', 'FROM-CP39');
    fd.set('paidOn', todayInKualaLumpur());
    await recordPcbPaymentAction(fd);

    // …and read by the year screen, which is the same table through the same service.
    expect(slot(await render({ companyId: b.companyId, year: YEAR }), `${YEAR}-09`, 'mtd')).toContain(
      'value="FROM-CP39"',
    );
    const rows = await owner.db
      .select({ id: schema.pcbPayment.id })
      .from(schema.pcbPayment)
      .where(and(eq(schema.pcbPayment.companyId, b.companyId), eq(schema.pcbPayment.periodKey, `${YEAR}-09`)));
    expect(rows, 'ONE row, not one per screen').toHaveLength(1);
  });

  /** The screen is reachable from the form that prints what it maintains. */
  it('the PCB 2(II) screen links here, carrying the company and year it has open', () => {
    const src = code(read(PICKER));
    expect(src).toContain(`/payroll/statutory-forms/pcb2ii/receipts?companyId=`);
    expect(src).toContain("t('pcb2iiReceiptsLink')");
    expect(src, 'the link carries the year, or the receipts screen would default to another one').toMatch(
      /receipts\?companyId=\$\{encodeURIComponent\(companyId\)\}&year=/,
    );
  });
});

// ───────────────── 7. THE LOCALES i18n CHECK C CANNOT SEE ─────────────────

describe('72b100cd · every string this screen uses resolves in all six locales', () => {
  /** The keys the page asks for, read out of the page rather than listed by hand. */
  const used = () => {
    const src = code(read(SCREEN));
    const shelf = [...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
    const pay = [...src.matchAll(/\btPay\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
    return { shelf: [...new Set(shelf)], pay: [...new Set(pay)] };
  };

  it('the page really does draw on both namespaces (so check C really is skipping it)', () => {
    const { shelf, pay } = used();
    expect(shelf.length, 'its own sentences').toBeGreaterThan(5);
    expect(pay.length, 'and the CP39 screen’s field labels, reused verbatim').toBeGreaterThan(3);
  });

  it('every key resolves to a non-empty string in every locale', () => {
    const { shelf, pay } = used();
    for (const loc of LOCALES) {
      const json = JSON.parse(read(`messages/${loc}.json`));
      for (const [ns, keys] of [
        [json.payroll.statutoryForms, shelf],
        [json.payroll.cp39Form, pay],
      ] as const) {
        for (const k of keys) {
          expect(typeof ns[k], `${loc} · ${k}`).toBe('string');
          expect(String(ns[k]).trim(), `${loc} · ${k} is blank`).not.toBe('');
        }
      }
    }
  });

  it('the placeholders the page passes are the placeholders the strings declare', () => {
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)).payroll.statutoryForms;
      for (const ph of ['{company}', '{year}']) {
        expect(m.pcb2iiReceiptsSubtitle, `${loc}.pcb2iiReceiptsSubtitle keeps ${ph}`).toContain(ph);
      }
      for (const ph of ['{recorded}', '{total}']) {
        expect(m.pcb2iiReceiptsCount, `${loc}.pcb2iiReceiptsCount keeps ${ph}`).toContain(ph);
      }
      // A statutory screen must name its own form. Two rounds on this shelf shipped the EA's name on a
      // PCB 2(II) screen, and the form CODE is identical in every language.
      expect(m.pcb2iiReceiptsBack, `${loc}.pcb2iiReceiptsBack names this form`).toContain('PCB 2(II)');
      expect(m.pcb2iiReceiptsHint, `${loc}.pcb2iiReceiptsHint names this form`).toContain('PCB 2(II)');
      expect(m.pcb2iiReceiptsHint, `${loc}.pcb2iiReceiptsHint must not name the EA`).not.toContain('C.P.8A');
      // ⚠️ AND IT MUST NOT PROMISE A ZERO. An empty box asserts nothing; 0.00 asserts the money does not
      // exist, and the hint is the sentence that tells the operator which one a blank month produces.
      expect(m.pcb2iiReceiptsHint, `${loc}.pcb2iiReceiptsHint states what a blank month prints`).toContain('0.00');
    }
  });
});
