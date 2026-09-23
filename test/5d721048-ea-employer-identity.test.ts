/**
 * 5d721048 — THE C.P.8A (EA) CANNOT BE PRINTED UNDER AN EMPLOYER THAT NEVER EMPLOYED THIS PERSON.
 *
 * r328 fixed exactly this on the PCB 2(II) (`localization/my/pcb2ii.ts`, the `employerId !==
 * info.companyId && slips.length === 0` line and the paragraph above it). The EA was left with the
 * identical hole, and it is the bigger document: a whole year of pay, EPF, SOCSO and tax.
 *
 * THE DEFECT, AS MEASURED. `eaStatement` had exactly two refusals — `!info` (no such employment) and
 * `!co` (no such company row). `employerId = p.companyId ?? info.companyId` then took the URL's company
 * on trust. The only thing standing in front of it was `scopedAdmin`'s `scopeIds.includes(companyId)`,
 * and that proves the OPERATOR may see that company — never that the EMPLOYMENT sits in it. Both
 * companies can be in one tenant, so RLS cannot separate them either.
 *
 * ⚠️ IT PRINTS ZEROS, NOT ANOTHER COMPANY'S MONEY, AND THAT IS WHY IT SHIPPED. The slips query already
 * filters `eq(payrollBatch.companyId, employerId)` ("THE FIX", r219), so every figure on the sheet is
 * company-true. What was wrong is that the SHEET EXISTED: the employee's name, identity card number and
 * tax number under the letterhead, E number, address and telephone of a company that never employed
 * them, beside twelve empty boxes. A document asserting a relationship that does not exist, assembled
 * out of two companies' facts, is worse than no document — nothing on the page says so.
 *
 * FOUR STATES, ALL ASSERTED, because two of them are what a careless guard breaks and they are exactly
 * why the rule is not simply `employerId !== info.companyId`:
 *
 *   (a) the employment's OWN company                                     → a form.
 *   (b) a DIFFERENT company that DID pay them in the year — THE TRANSFER  → a form. The prior employer
 *       owes an EA for the months it paid, and that is the whole reason `companyId` is a parameter.
 *   (c) a different in-scope company that never paid them                → nothing; a bare 404.
 *   (d) the OWN company, never paid                                      → still a form, an empty one.
 *       Somebody employed here who has not been run through payroll yet is owed a statement at year end.
 *
 * (b) is built out of a REAL payroll run at each employer either side of a REAL entity transfer, not
 * asserted abstractly: `createBatch` + `generatePayslips` before the move and after it, which is the only
 * fixture in which "the employment's company" and "this employer" are different answers.
 *
 * ⚠️ AND BOTH DOORS GET IT FROM THE READ. r331 (2a1a6f42) factored the EA download and the EA preview
 * onto one gate in `app/payroll/statutory-forms/ea/shared.ts`; both routes are four lines over
 * `eaPdfResponse`, and a null statement becomes `notFound()` at exactly one place there. So the refusal
 * is asserted through BOTH `preview/route.ts` and `download/route.ts` — not because they could differ,
 * but so that the day someone gives the preview a gate of its own, this file says which surface moved.
 *
 * The `next-intl/server` mock is 2a1a6f42's, for its reason: the label bundle resolves through
 * `getTranslations` and `i18n/request.ts` reads `cookies()`, which throws outside a request. The words
 * are the shipped `messages/<locale>.json` on disk.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createMovementEvent } from '../core/movement';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { employeeEaCompanies, employeeEaStatement } from '../core/reporting';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

const ROOT = join(__dirname, '..');

/** The mocked answer from `scopedAdmin`, swapped per case. Set in `beforeEach`. */
let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));

// The real catalogues, resolved without a request. 2a1a6f42's mock verbatim — see this file's header.
vi.mock('next-intl/server', () => {
  const cache = new Map<string, Record<string, unknown>>();
  const cat = (locale: string) => {
    const hit = cache.get(locale);
    if (hit) return hit;
    const parsed = JSON.parse(readFileSync(join(ROOT, `messages/${locale}.json`), 'utf8'));
    cache.set(locale, parsed);
    return parsed;
  };
  const dig = (o: unknown, dotted: string) =>
    dotted
      .split('.')
      .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
  return {
    getLocale: async () => 'en',
    getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => {
      const base = dig(cat(locale), namespace);
      return (key: string, vars?: Record<string, string | number>) => {
        const v = dig(base, key);
        if (typeof v !== 'string') throw new Error(`messages/${locale}.json is missing ${namespace}.${key}`);
        return vars ? v.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : v;
      };
    },
  };
});

import { GET as previewGET } from '../app/payroll/statutory-forms/ea/preview/route';
import { GET as downloadGET } from '../app/payroll/statutory-forms/ea/download/route';

const YEAR = '2026';

let b: Base;
/** The company the employee TRANSFERS INTO. Same tenant, so RLS cannot tell the two apart. */
let coB: string;
let deptB: string;
/** A third company in the same tenant that has never had anything to do with either employee. */
let coStranger: string;
/** Hired at Acme, paid by Acme for January, moved to coB on 1 February, paid by coB for February. */
let transferredId: string;
/** Hired at Acme and never run through payroll. Their own employer still owes them an (empty) form. */
let neverPaidId: string;

const url = (
  route: 'preview' | 'download',
  q: { companyId: string; year?: string; ids: string[] },
) => {
  const p = new URLSearchParams();
  p.set('companyId', q.companyId);
  p.set('year', q.year ?? YEAR);
  for (const id of q.ids) p.append('id', id);
  return new Request(`http://t.local/payroll/statutory-forms/ea/${route}?${p.toString()}`);
};

/** Both doors, asked the same question. The point of r331's shared gate is that these never diverge. */
const bothDoors = async (q: { companyId: string; ids: string[] }) =>
  ({
    preview: await previewGET(url('preview', q)),
    download: await downloadGET(url('download', q)),
  }) as const;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const a = adminCtx(b);

  const [cb] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Beta Sdn Bhd ${randomUUID().slice(0, 6)}`, country: 'MY' })
    .returning({ id: schema.company.id });
  coB = cb.id;
  const [db] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: coB, name: 'Beta Operations' })
    .returning({ id: schema.department.id });
  deptB = db.id;
  const [cs] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Stranger Sdn Bhd ${randomUUID().slice(0, 6)}`, country: 'MY' })
    .returning({ id: schema.company.id });
  coStranger = cs.id;

  const hire = async (name: string) =>
    hireEmployee(a, {
      person: { fullName: name, primaryEmail: `ea5d_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });

  const moved = await hire('Transferred Subject');
  transferredId = moved.employmentId;
  neverPaidId = (await hire('Never Paid Subject')).employmentId;

  // REAL payroll either side of a REAL entity transfer. Nothing about (b) is asserted abstractly: the
  // January payslip is produced by Acme's own run and the February one by Beta's, and `payroll_batch`
  // carries the paying company on each — which is the fact the guard tests against.
  await setCompensation(a, { employmentId: transferredId, basicSalary: 5000, effectiveFrom: '2020-01-01' });
  await setStatutoryProfileMY(a, {
    personId: moved.personId,
    icNumber: '900101015555',
    taxCategory: 1,
    numChildren: 0,
  });

  const janAcme = await createBatch(a, { companyId: b.companyId, payPeriod: `${YEAR}-01` });
  await generatePayslips(a, { batchId: janAcme.batchId });

  await createMovementEvent(adminCtx(b), {
    employmentId: transferredId,
    kind: 'entityTransfer',
    effectiveDate: `${YEAR}-02-01`,
    companyId: coB,
    departmentId: deptB,
    remarks: 'Group restructure',
  });

  const febBeta = await createBatch(adminCtx(b), { companyId: coB, payPeriod: `${YEAR}-02` });
  await generatePayslips(adminCtx(b), { batchId: febBeta.batchId });

  // EVERY company is in the operator's scope, on purpose. The route's own `scopeIds` check must not be
  // what refuses anything below — otherwise this file would be re-testing r331's scope gate and would
  // stay green with the read's guard deleted. What is under test is the READ.
  scope = { s: adminCtx(b), scopeIds: [b.companyId, coB, coStranger] };
});

describe('5d721048 · the fixture really does put one employment under two employers', () => {
  it('January was paid by Acme and February by Beta, and the employment now sits at Beta', async () => {
    const employers = await employeeEaCompanies(adminCtx(b), { employmentId: transferredId, year: YEAR });
    expect(employers.map((c) => c.companyId), 'oldest employer first').toEqual([b.companyId, coB]);
    expect(employers.find((c) => c.isCurrent)?.companyId, 'the employment sits at Beta now').toBe(coB);
    // And the stranger is nowhere in the set the screens can offer — so nothing legitimate asks for it.
    expect(employers.map((c) => c.companyId)).not.toContain(coStranger);
  });
});

describe('5d721048 · the read — four states, and the two a careless guard breaks', () => {
  it('(a) the employment’s OWN company gets a form', async () => {
    const ea = await employeeEaStatement(adminCtx(b), { employmentId: transferredId, year: YEAR, companyId: coB });
    expect(ea, 'Beta employs them, so Beta owes them a statement').toBeTruthy();
    expect(ea!.employerId).toBe(coB);
  });

  /**
   * ⚠️ THE TRANSFER CASE. This is why the rule is not `employerId !== info.companyId`. Acme is NOT where
   * this employment sits any more, and Acme still owes an EA for the month it paid. A guard that tested
   * employer identity alone would delete a real employer's statutory form.
   */
  it('(b) a DIFFERENT company that PAID them in the year gets a form — with its own months on it', async () => {
    const ea = await employeeEaStatement(adminCtx(b), {
      employmentId: transferredId,
      year: YEAR,
      companyId: b.companyId,
    });
    expect(ea, 'Acme paid them in January, so Acme owes them a statement').toBeTruthy();
    expect(ea!.employerId).toBe(b.companyId);
    expect(ea!.employer.name, 'Acme’s own letterhead').toContain('Acme');
    expect(ea!.partB.gross, 'and a real January on it, not an empty sheet').toBeGreaterThan(0);
  });

  /**
   * NON-VACUITY: delete `if (employerId !== info.companyId && slips.length === 0) return null;` from
   * `eaStatement` in localization/my/reports.ts and this returns a statement — the employee's name,
   * identity card number and tax number under a letterhead of a company that never employed them.
   */
  it('(c) a company that neither employs nor paid this person gets NOTHING', async () => {
    const transferred = await employeeEaStatement(adminCtx(b), {
      employmentId: transferredId,
      year: YEAR,
      companyId: coStranger,
    });
    expect(transferred, 'no relationship, so nothing to state').toBeNull();
    // And it is not an artefact of the transfer: someone who never moved is refused the same way.
    const settled = await employeeEaStatement(adminCtx(b), {
      employmentId: neverPaidId,
      year: YEAR,
      companyId: coStranger,
    });
    expect(settled, 'still no relationship').toBeNull();
  });

  /**
   * ⚠️ THE OTHER ONE A CARELESS GUARD BREAKS. "No payslips ⇒ no form" would be a simpler rule and a
   * wrong one: a person employed here all year who has not been run through payroll is owed a statement
   * at year end, and it is an EMPTY one, which is a true document.
   */
  it('(d) the OWN company, never paid, still gets its (empty) form', async () => {
    const ea = await employeeEaStatement(adminCtx(b), {
      employmentId: neverPaidId,
      year: YEAR,
      companyId: b.companyId,
    });
    expect(ea, 'Acme employs them, so Acme owes them a statement').toBeTruthy();
    expect(ea!.employerId).toBe(b.companyId);
    expect(ea!.partB.gross, 'nothing was paid, and the form says so honestly').toBe(0);
    expect(ea!.partD.mtd, 'no payroll ran, so no tax was deducted').toBe(0);
  });

  it('an UNSCOPED read is unchanged — it still means the employer the employment sits at', async () => {
    const ea = await employeeEaStatement(adminCtx(b), { employmentId: transferredId, year: YEAR });
    expect(ea!.employerId, 'the default did not move').toBe(coB);
  });
});

describe('5d721048 · BOTH doors — the refusal lives in the read, so neither route can be the lighter one', () => {
  const bare = async (res: Response, why: string) => {
    expect(res.status, why).toBe(404);
    expect(await res.text(), 'bare — the body must not say WHICH check refused').toBe('Not found');
    expect(res.headers.get('Content-Type'), 'and it must not be a PDF').not.toBe('application/pdf');
  };

  const pdf = async (res: Response, why: string) => {
    expect(res.status, why).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString('latin1'), 'a real PDF, not an HTML lookalike').toBe('%PDF-');
    expect((await PDFDocument.load(body)).getPageCount(), 'one statement per ticked employee').toBe(1);
  };

  it('(a) own company — preview and download both serve the form', async () => {
    const r = await bothDoors({ companyId: coB, ids: [transferredId] });
    await pdf(r.preview, 'preview must serve the current employer’s form');
    await pdf(r.download, 'download must serve it too');
  });

  it('(b) the prior employer that PAID them — preview and download both serve the form', async () => {
    const r = await bothDoors({ companyId: b.companyId, ids: [transferredId] });
    await pdf(r.preview, 'preview must serve the prior employer’s form');
    await pdf(r.download, 'download must serve it too');
  });

  /**
   * NON-VACUITY, AT THE SURFACE. Delete the guard from `eaStatement` and BOTH of these come back 200
   * with a PDF — which is the defect: a hand-edited `companyId` prints a named person's EA under a
   * company that never employed them. The company is deliberately IN SCOPE, so r331's `scopeIds` check
   * has already passed and this is the read refusing, not the route.
   */
  it('(c) an in-scope company that never employed or paid them is a bare 404 on BOTH routes', async () => {
    const r = await bothDoors({ companyId: coStranger, ids: [transferredId] });
    await bare(r.preview, 'preview must refuse an employer with no relationship');
    await bare(r.download, 'download must refuse it too');
  });

  it('(d) own company, never paid — both routes still serve the empty form', async () => {
    const r = await bothDoors({ companyId: b.companyId, ids: [neverPaidId] });
    await pdf(r.preview, 'preview must serve the empty statement');
    await pdf(r.download, 'download must serve it too');
  });

  /**
   * THE PARTIAL-ANSWER RULE, ON THIS GUARD. `shared.ts` refuses the WHOLE request when any ticked
   * employment has no statement, rather than returning a file that is silently short of the people who
   * were ticked. One good id beside one the guard refuses is therefore a 404, not a one-page PDF.
   */
  it('one refused employment poisons the whole selection rather than shipping a short file', async () => {
    // Acme paid `transferredId` in January, so Acme's form for THEM exists; `neverPaidId` sits at Acme
    // too. Both are fine under Acme. Under the stranger neither is, and the file must not come back.
    await pdf((await bothDoors({ companyId: b.companyId, ids: [transferredId] })).preview, 'the good one alone');
    const mixed = await bothDoors({ companyId: coStranger, ids: [transferredId, neverPaidId] });
    await bare(mixed.preview, 'no partial EA file');
    await bare(mixed.download, 'on either route');
  });
});
