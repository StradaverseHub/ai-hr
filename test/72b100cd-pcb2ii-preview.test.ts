/**
 * 72b100cd (r328) — THE PCB 2(II) PREVIEW, AND THE GATE IT IS NOT ALLOWED TO BE LIGHTER THAN.
 *
 * r323 shipped the screen, the picker and `download/route.ts`. What the reporter was actually missing was
 * the LOOK: pick the people, press Download, and a file arrives with no way to check it first. r328 adds
 * `preview/route.ts`, which serves the download's OWN bytes with `Content-Disposition: inline`.
 *
 * FOUR CLAIMS, each a way a preview ships wrong on a document carrying tax numbers and identity cards:
 *
 *   1. IT IS THE SAME DOCUMENT, NOT A SECOND RENDITION OF IT. An HTML preview of a statutory form is a
 *      second renderer, and the day the two disagree an operator has approved a page that is not the file
 *      they sent. Pinned by comparing the two responses BYTE FOR BYTE (modulo the PDF's own timestamps).
 *   2. IT IS NOT A LIGHTER SURFACE. Every refusal the download makes, the preview makes — a malformed id,
 *      an empty or oversized selection, an out-of-scope company, a foreign company and an employment with
 *      no statement are ALL the same bare 404, so the URL enumerates nothing.
 *   3. THE GATE IS WRITTEN ONCE. Both routes are one call into `../shared.ts`; neither carries a copy of
 *      `scopedAdmin`, the shape allowlist or the scope check that could quietly relax on one side.
 *   4. THE BUTTON NAMES THIS FORM. r323 labelled the PCB 2(II) submit with the EA's key ("Generate
 *      C.P.8A (EA)") — the wrong statutory document's name on a statutory screen, which is the exact
 *      defect this screen's own empty state was written to avoid.
 *
 * ⚠️ AND THE DIAGNOSIS THE ITEM TURNED ON (see the bottom describe). The reporter reported no employee
 * list and therefore no Select all. The controls are all there; what is empty is the POPULATION, which is
 * `reportPreview(my.cp8d)` — payslip-derived, and shared verbatim with the C.P.8A (EA). The demo tenant
 * has no payslips at all, so both screens show their empty state on identical data. That is correct
 * behaviour of a shared read, and it is pinned HERE so nobody "fixes" it inside the PCB 2(II) screen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { upsertCompanyStatutoryAuthority } from '../core/statutory-authority';
import { createMovementEvent } from '../core/movement';
import { pcb2iiStatement } from '../localization/my/pcb2ii';
import { MAX_EA_SELECTION } from '../app/payroll/statutory-forms/ea/limits';
import { adminCtx, closeAll, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SHARED = src('app/payroll/statutory-forms/pcb2ii/shared.ts');
const PREVIEW_ROUTE = src('app/payroll/statutory-forms/pcb2ii/preview/route.ts');
const DOWNLOAD_ROUTE = src('app/payroll/statutory-forms/pcb2ii/download/route.ts');
const SCREEN = src('app/payroll/statutory-forms/pcb2ii/page.tsx');
const EA_SCREEN = src('app/payroll/statutory-forms/ea/page.tsx');
/** The picker BOTH screens use. r328 put the preview on it as two optional props; r331 switched the EA on. */
const PICKER = src('app/payroll/statutory-forms/ea/employee-picker.tsx');
const SEED = src('db/seed.ts');

/**
 * Source with its comments removed. These files EXPLAIN the gate at length — `shared.ts` is named in
 * every header — so a bare grep for `scopedAdmin` matches the prose that says the routes do not call it.
 * The ratchet reads CODE (CLAUDE.md §8: "the ratchet reads comments, so reword a quoted specifier").
 */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The mocked answer from `scopedAdmin`, swapped per case. Set in `beforeEach`. */
let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));

import { GET as previewGET } from '../app/payroll/statutory-forms/pcb2ii/preview/route';
import { GET as downloadGET } from '../app/payroll/statutory-forms/pcb2ii/download/route';

let b: Base;
let employmentId: string;
let foreignCompanyId: string;
let foreignDeptId: string;

const YEAR = '2026';

/** A closed payroll month carrying a PCB figure, so the previewed sheet has a real number on it. */
async function payslipFor(id: string, period: string, pcb: number, payer?: string) {
  const companyId = payer ?? b.companyId;
  const [pp] = await owner.db
    .insert(schema.payPeriod)
    .values({ tenantId: b.tenantId, companyId, period, status: 'open' })
    .returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId,
      payPeriodId: pp.id,
      payPeriod: period,
      runSeq: 1,
      runType: 'regular',
      batchDate: `${period}-28`,
      status: 'closed',
    })
    .returning({ id: schema.payrollBatch.id });
  await owner.db.insert(schema.payslip).values({
    tenantId: b.tenantId,
    batchId: batch.id,
    employmentId: id,
    basicSalary: '5000.00',
    grossPay: '5000.00',
    totalDeductions: '1000.00',
    netPay: '4000.00',
    employerCost: '5600.00',
    statutory: { pcb },
  });
}

/** The admin whose grant covers ONE company — the shape db/client.ts publishes as app.grants. */
const ctxFor = (): SessionContext => ({
  tenantId: b.tenantId,
  userId: b.adminUserId,
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: b.companyId }],
  entitlements: harnessSnapshot(b.tenantId),
});

const url = (
  route: 'preview' | 'download',
  q: { companyId?: string; year?: string; ids?: string[]; lang?: string; selectedDate?: string },
) => {
  const p = new URLSearchParams();
  if (q.companyId !== undefined) p.set('companyId', q.companyId);
  if (q.year !== undefined) p.set('year', q.year);
  p.set('selectedDate', q.selectedDate ?? '2027-02-28');
  for (const id of q.ids ?? []) p.append('id', id);
  if (q.lang !== undefined) p.set('lang', q.lang);
  return new Request(`http://t.local/payroll/statutory-forms/pcb2ii/${route}?${p.toString()}`);
};

const ok = () => ({ companyId: b.companyId, year: YEAR, ids: [employmentId] });

/**
 * The PDF, made byte-comparable between two renders.
 *
 * ⚠️ BLANKING `D:\d{14}` IN THE RAW BYTES IS NOT ENOUGH, AND THAT IS WHY THIS IS NOT A ONE-LINER.
 * `pdf-lib`'s `save()` defaults to `useObjectStreams: true`, so the Info dictionary — CreationDate and
 * ModDate with it — lands INSIDE A DEFLATE STREAM, where a text regex cannot reach. Two renders that
 * straddle a second therefore differ by a few bytes inside a compressed block, and the raw comparison
 * fails. r331 measured exactly that and said so ("the delta is pdf-lib's timestamp inside a deflate
 * stream"); the regex was written anyway. It then passed three gates by luck and went red under gate
 * load in r334 chunk 5.
 *
 * So: reload, stamp both dates to a constant, and re-save WITHOUT object streams, which puts the whole
 * document back in the clear where a difference in CONTENT is still a difference.
 */
const stable = async (buf: Buffer): Promise<string> => {
  const doc = await PDFDocument.load(buf);
  const fixed = new Date(0);
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);
  return Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const officer = await hireEmployee(adminCtx(b), { person: { fullName: 'Configured PCB officer', primaryEmail: `officer_${randomUUID()}@pcb.test` }, companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, employmentType: 'full_time', hiredOn: '2020-01-01' });
  await upsertCompanyStatutoryAuthority(adminCtx(b), { companyId: b.companyId, authority: 'lhdn', signatoryPersonId: officer.personId });
  const hire = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Preview Subject', primaryEmail: `pv_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  employmentId = hire.employmentId;
  await payslipFor(employmentId, `${YEAR}-03`, 412.35);
  const [fc] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Foreign ${randomUUID().slice(0, 6)}`, country: 'MY' })
    .returning({ id: schema.company.id });
  foreignCompanyId = fc.id;
  const [fd] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: foreignCompanyId, name: 'Foreign Ops' })
    .returning({ id: schema.department.id });
  foreignDeptId = fd.id;
  const otherOfficer = await hireEmployee(adminCtx(b), { person: { fullName: 'Company B officer', primaryEmail: `officer_b_${randomUUID()}@pcb.test` }, companyId: foreignCompanyId, departmentId: foreignDeptId, employmentType: 'full_time', hiredOn: '2020-01-01' });
  await upsertCompanyStatutoryAuthority(adminCtx(b), { companyId: foreignCompanyId, authority: 'lhdn', signatoryPersonId: otherOfficer.personId });
  scope = { s: ctxFor(), scopeIds: [b.companyId] };
});

describe('72b100cd · the preview is the download, opened instead of saved', () => {
  it('serves the form INLINE, as a real PDF, one page per ticked employee', async () => {
    const res = await previewGET(url('preview', ok()));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    const cd = res.headers.get('Content-Disposition') ?? '';
    expect(cd, 'a preview is OPENED, not saved').toMatch(/^inline;/);
    expect(cd, 'and it still names the file the operator saves out of the viewer').toContain(
      `filename="pcb2ii-${YEAR}-`,
    );
    // Nothing about this response may be cached by a shared proxy: it is one named person's tax record.
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString('latin1'), 'a real PDF, not an HTML lookalike').toBe('%PDF-');
    const doc = await PDFDocument.load(body);
    expect(doc.getPageCount(), 'one statement per ticked employee').toBe(1);
  });

  /**
   * THE CLAIM THIS FILE EXISTS FOR. If the preview were drawn by a second renderer these bytes would
   * differ, and the operator would be approving a document that is not the one they send. They are the
   * same bytes; only the disposition header differs.
   */
  it('is BYTE FOR BYTE the document the download produces — only the disposition differs', async () => {
    const [p, d] = await Promise.all([previewGET(url('preview', ok())), downloadGET(url('download', ok()))]);
    expect(p.status).toBe(200);
    expect(d.status).toBe(200);
    const [pb, db] = [Buffer.from(await p.arrayBuffer()), Buffer.from(await d.arrayBuffer())];
    expect(await stable(pb)).toBe(await stable(db));
    expect(d.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    // Same file NAME too — a previewed form and a downloaded one land on disk identically.
    const nameOf = (h: string | null) => (h ?? '').replace(/^(inline|attachment); /, '');
    expect(nameOf(p.headers.get('Content-Disposition'))).toBe(nameOf(d.headers.get('Content-Disposition')));
  });

  it('honours the lang allowlist and NEVER echoes an unknown one', async () => {
    const body = async (lang?: string) =>
      stable(Buffer.from(await (await previewGET(url('preview', { ...ok(), lang }))).arrayBuffer()));
    const en = await body('en');
    const ms = await body('ms');
    // LHDN publishes two sheets and they differ by more than translation (MTD vs PCB as a column head).
    expect(ms, 'the Malay sheet is not the English one').not.toBe(en);
    expect(await body('zz'), 'an unknown lang falls back to English, it is not handed on').toBe(en);
    expect(await body(undefined), 'and so does an absent one').toBe(en);
  });
});

describe('72b100cd · a preview is NOT a lighter surface — every refusal is the download’s', () => {
  const bare = async (res: Response, why: string) => {
    expect(res.status, why).toBe(404);
    expect(await res.text(), 'bare — the body must not say WHICH check refused').toBe('Not found');
    expect(res.headers.get('Content-Type'), 'and it must not be a PDF').not.toBe('application/pdf');
  };

  /**
   * ⚠️ THE ONE THIS FILE IS HERE FOR. `scopeIds` is the admin's OWN company scope; an hr_admin grant on
   * ANY company makes `isAdmin` true, so without this check a company-scoped admin could read another
   * company's people's tax numbers and identity card numbers by editing the URL.
   *
   * NON-VACUITY: delete the `if (!scopeIds.includes(companyId)) return notFound();` line from
   * app/payroll/statutory-forms/pcb2ii/shared.ts and this expectation fails with 200 (verified r328).
   */
  it('an OUT-OF-SCOPE company is a bare 404 on BOTH routes', async () => {
    scope = { s: ctxFor(), scopeIds: [foreignCompanyId] }; // the admin can reach anything BUT this company
    await bare(await previewGET(url('preview', ok())), 'preview must refuse an out-of-scope company');
    await bare(await downloadGET(url('download', ok())), 'download must refuse it too');
  });

  it('a FOREIGN company the scope wrongly names still yields nothing — the statement is company-pinned', async () => {
    // Even if a scope were compromised, the read is pinned to THIS company: the employment's statement
    // does not belong to `foreignCompanyId`, so there is nothing to render and the answer is the 404.
    scope = { s: ctxFor(), scopeIds: [b.companyId, foreignCompanyId] };
    await bare(
      await previewGET(url('preview', { companyId: foreignCompanyId, year: YEAR, ids: [employmentId] })),
      'an employment that is not this company’s',
    );
  });

  it('a malformed companyId never reaches the database', async () => {
    await bare(await previewGET(url('preview', { ...ok(), companyId: 'not-a-uuid' })), 'malformed companyId');
  });

  it('a malformed employment id never reaches the database', async () => {
    await bare(await previewGET(url('preview', { ...ok(), ids: ['nope'] })), 'malformed id');
  });

  it('a malformed year is refused', async () => {
    await bare(await previewGET(url('preview', { ...ok(), year: '20xx' })), 'malformed year');
  });

  it('an EMPTY selection produces nothing rather than an empty document', async () => {
    await bare(await previewGET(url('preview', { ...ok(), ids: [] })), 'no ids');
  });

  it('a selection over the shared ceiling is refused, at the same number the picker advertises', async () => {
    const ids = Array.from({ length: MAX_EA_SELECTION + 1 }, () => randomUUID());
    await bare(await previewGET(url('preview', { ...ok(), ids })), 'over MAX_EA_SELECTION');
  });

  it('an employment with NO statement refuses the WHOLE request, not a file short of people', async () => {
    // A well-formed id nobody owns. The route must not return the one statement it COULD build.
    await bare(
      await previewGET(url('preview', { ...ok(), ids: [employmentId, randomUUID()] })),
      'one missing statement poisons the batch',
    );
  });
});

describe('72b100cd · the gate is written once, so it cannot relax on one side', () => {
  it('neither route carries its own copy of the gate', () => {
    for (const [name, raw] of [
      ['preview/route.ts', PREVIEW_ROUTE],
      ['download/route.ts', DOWNLOAD_ROUTE],
    ] as const) {
      const body = code(raw);
      expect(body, `${name} must not re-implement scopedAdmin`).not.toMatch(/scopedAdmin/);
      expect(body, `${name} must not re-implement the shape allowlist`).not.toMatch(/0-9a-f\]\{8\}/);
      expect(body, `${name} must delegate to ../shared`).toMatch(/pcb2iiPdfResponse/);
    }
    expect(PREVIEW_ROUTE).toMatch(/pcb2iiPdfResponse\(req, 'inline'\)/);
    expect(DOWNLOAD_ROUTE).toMatch(/pcb2iiPdfResponse\(req, 'attachment'\)/);
  });

  it('the shared module still holds every check, and renders through the ONE renderer', () => {
    expect(SHARED, 'the company-scope check').toMatch(/scopeIds\.includes\(companyId\)/);
    expect(SHARED, 'the admin gate').toMatch(/scopedAdmin\(\)/);
    expect(SHARED, 'the selection ceiling').toMatch(/MAX_EA_SELECTION/);
    expect(SHARED, 'the lang allowlist').toMatch(/LANGS\.includes/);
    // A SECOND PCB 2(II) renderer is two versions of one statutory form that drift. There is one.
    expect(SHARED).toMatch(/renderPcb2iiPdf/);
    expect(code(PREVIEW_ROUTE), 'the preview must not draw the form itself').not.toMatch(/renderPcb2iiPdf/);
  });

  /**
   * ⚠️ UPDATED BY 2a1a6f42 (r331), NOT DELETED — AND THIS IS THE REASON.
   *
   * r328 pinned "the C.P.8A (EA) screen is UNCHANGED": the preview landed as two OPTIONAL props on the
   * shared picker, the EA passed neither, and the assertion was `EA_SCREEN` must NOT contain
   * `previewAction`. That was a true statement about r328's blast radius, and it was never a statement
   * that the EA should not have a preview — r331 is the item that gives it one, because the EA turned out
   * to be the ONE form on the statutory shelf with no preview at all.
   *
   * So the claim is retargeted rather than dropped (CLAUDE.md §8: a guard pinning a decision you are
   * reversing is updated, not deleted). What r328 actually cared about survives intact and is what is
   * asserted now: the picker is SHARED and each screen points it at ITS OWN route. A screen that named the
   * other form's preview route would hand an operator another statutory document under this one's heading,
   * which is the failure the rest of this file exists for.
   */
  it('each screen points the shared picker at ITS OWN preview route', () => {
    // r402 (item f3cf2444) — each screen's Preview now goes to ITS OWN in-app viewer, which frames that
    // form's own inline route; the "own route, never the other form's" claim is unchanged.
    expect(SCREEN, 'the PCB 2(II) screen').toMatch(
      /previewAction="\/payroll\/statutory-forms\/pcb2ii\/view"/,
    );
    expect(EA_SCREEN, 'the C.P.8A (EA) screen, from r331 on').toMatch(
      /previewAction="\/payroll\/statutory-forms\/ea\/view"/,
    );
    // Neither may point at the other's document.
    expect(code(SCREEN), 'the PCB 2(II) screen must not open the EA').not.toMatch(
      /previewAction="\/payroll\/statutory-forms\/ea\//,
    );
    expect(code(EA_SCREEN), 'the EA screen must not open the PCB 2(II)').not.toMatch(
      /previewAction="\/payroll\/statutory-forms\/pcb2ii\//,
    );
    // And the props stay OPTIONAL on the picker: no button unless BOTH arrive, which is what let r328
    // ship the mechanism without touching the EA and let r331 switch it on without touching the picker.
    expect(PICKER, 'the button is rendered only when a route AND a label arrive').toMatch(
      /previewAction && strings\.preview/,
    );
    expect(PICKER, 'previewAction is optional').toMatch(/previewAction\?: string/);
    expect(PICKER, 'and so is the label').toMatch(/preview\?: string/);
  });
});

describe('72b100cd · the button names THIS form', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

  it('the PCB 2(II) screen no longer labels its submit with the EA’s key', () => {
    expect(code(SCREEN), 'r323 passed eaGenerate — "Generate C.P.8A (EA)" on the PCB 2(II) screen').not.toMatch(
      /t\('eaGenerate'\)/,
    );
    expect(SCREEN).toMatch(/t\('pcb2iiGenerate'\)/);
    expect(SCREEN).toMatch(/t\('pcb2iiPreview'\)/);
    // The page's own subtitle too: `eaPickPeople` reads "tick the people whose EA you need".
    expect(code(SCREEN), 'the header sentence must not name the EA either').not.toMatch(/t\('eaPickPeople'/);
    expect(SCREEN).toMatch(/t\('pcb2iiPickPeople'/);
  });

  /**
   * THE RULE, APPLIED TO THE WHOLE SCREEN RATHER THAN TO THE THREE KEYS THAT WERE WRONG. Every string the
   * PCB 2(II) screen still borrows from the EA must be FORM-AGNOSTIC — "Select all", "Department",
   * "{count} selected". A borrowed string that names a document names the WRONG document here, which is
   * CLAUDE.md §8's shared-caption rule ("may say only what is true of every member") on a tax form.
   */
  it('no EA-named key the screen still borrows mentions a statutory document', () => {
    const en = JSON.parse(src('messages/en.json')).payroll.statutoryForms as Record<string, string>;
    const borrowed = [...new Set([...code(SCREEN).matchAll(/t\('(ea[A-Za-z]+)'/g)].map((m) => m[1]))];
    expect(borrowed.length, 'the screen does share the EA picker’s strings').toBeGreaterThan(5);
    for (const k of borrowed) {
      expect(en[k], `messages/en.json is missing ${k}`).toBeTypeOf('string');
      expect(en[k], `${k} names the EA on the PCB 2(II) screen`).not.toMatch(/\bEA\b|C\.P\.8A/);
    }
  });

  it('both new keys exist in all six locales, and the download one names PCB 2(II), never the EA', () => {
    for (const loc of LOCALES) {
      const m = JSON.parse(src(`messages/${loc}.json`)).payroll.statutoryForms as Record<string, string>;
      expect(typeof m.pcb2iiPreview, `${loc}.pcb2iiPreview`).toBe('string');
      expect(m.pcb2iiPreview.trim(), `${loc}.pcb2iiPreview`).not.toBe('');
      expect(m.pcb2iiPickPeople, `${loc}.pcb2iiPickPeople must name this form`).toContain('PCB 2(II)');
      expect(m.pcb2iiPickPeople, `${loc}.pcb2iiPickPeople keeps both placeholders`).toContain('{company}');
      expect(m.pcb2iiPickPeople, `${loc}.pcb2iiPickPeople keeps both placeholders`).toContain('{year}');
      expect(typeof m.pcb2iiGenerate, `${loc}.pcb2iiGenerate`).toBe('string');
      // The form CODE is the same in every language; the wrong document's name is the defect.
      expect(m.pcb2iiGenerate, `${loc}.pcb2iiGenerate must name this form`).toContain('PCB 2(II)');
      expect(m.pcb2iiGenerate, `${loc}.pcb2iiGenerate must not name the EA`).not.toContain('C.P.8A');
    }
  });
});

/**
 * ⚠️ THE DIAGNOSIS, PINNED — WHY THE REPORTER SAW NO LIST AND THEREFORE NO "SELECT ALL".
 *
 * The picker's population is `reportPreview(my.cp8d)`, which is PAYSLIP-DERIVED (localization/my/reports.ts
 * `loadYearRows`: payslip ⋈ payroll_batch on company + `pay_period LIKE '<year>-%'`). It is the SAME read
 * the C.P.8A (EA) screen uses, declared by the catalog as `populationReportId`, and it is correct:
 * test/entity-transfer-statutory-forms.test.ts already pins "no payslips, so no CP8D rows" beside "employed,
 * unpaid, still a headcount".
 *
 * The demo tenant has NO payslips — `db/seed.ts` TRUNCATEs `payroll_batch` and `payslip` and never inserts
 * one. So the empty year is DATA, not a defect, and the empty state already says so in words. Pinned here
 * because the tempting wrong fix is to widen the population inside the PCB 2(II) screen, which would offer
 * a tax document with twelve empty months under a named person who was never paid.
 */
describe('72b100cd · why the list was empty, and where the answer is NOT', () => {
  it('the demo seeder plants no payroll at all, so cp8d has nothing to list', () => {
    expect(SEED, 'the seeder wipes them…').toMatch(/'payroll_batch', 'payslip'/);
    expect(SEED, '…and never inserts a payroll batch').not.toMatch(/insert\(\s*schema\.payrollBatch/);
    expect(SEED, '…nor a payslip').not.toMatch(/insert\(\s*schema\.payslip/);
  });

  it('the PCB 2(II) screen takes its population from the CATALOG, not from a hardcoded report id', () => {
    // Hardcoding `my.cp8d` here would be the app naming one jurisdiction's report; widening the population
    // here would be the second implementation of "who did this employer pay this year".
    expect(SCREEN).toMatch(/entry\.populationReportId/);
    expect(code(SCREEN), 'no form id is written down on this screen').not.toMatch(/'my\.cp8d'/);
  });

  it('the empty state tells the operator WHY, in its own document’s name', () => {
    const en = JSON.parse(src('messages/en.json')).payroll.statutoryForms as Record<string, string>;
    expect(SCREEN).toMatch(/t\('pcb2iiNoneForYear'/);
    expect(en.pcb2iiNoneForYear, 'it names the cause, not just the absence').toMatch(/payroll/i);
    expect(en.pcb2iiNoneForYear, 'and this form, not the EA').toContain('PCB 2(II)');
  });
});

/**
 * ⚠️ r328 — THE DEFECT THIS ITEM FOUND, AND IT IS IN THE SHARED READ, NOT ON THE SCREEN.
 *
 * `pcb2iiStatement` takes a `companyId` so that "what THIS employer deducted" is answerable after an
 * Entity Transfer. r323 honoured it for the E number, the payslips and the receipts — and took the
 * employer's NAME AND ADDRESS from the employment's CURRENT company. Those are the same company for
 * everyone who has never transferred, which is why it shipped green, and they are different companies for
 * precisely the case the parameter exists for.
 *
 * Every assertion below is on the SPLIT, because the pre-fix code passed every single-company test —
 * the same reason test/entity-transfer-statutory-forms.test.ts gives for the EA one file away.
 */
describe('72b100cd · the employer block names the employer the form speaks for', () => {
  /** Paid by A in January, transferred to B on 1 February. A's form and B's form are different forms. */
  async function transferred() {
    await payslipFor(employmentId, `${YEAR}-01`, 250.5);
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'entityTransfer',
      effectiveDate: `${YEAR}-02-01`,
      companyId: foreignCompanyId,
      departmentId: foreignDeptId,
      remarks: 'Group restructure',
    });
  }

  it("the OLD employer's form carries the OLD employer's name — not the company they moved to", async () => {
    await transferred();
    await owner.db.update(schema.company).set({ phone: '03-11111111' }).where(eq(schema.company.id, b.companyId));
    await owner.db.update(schema.company).set({ phone: '03-22222222' }).where(eq(schema.company.id, foreignCompanyId));
    const form = await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR, selectedDate: '2027-02-28', companyId: b.companyId });
    expect(form, 'A paid them in January, so A owes them a statement').toBeTruthy();
    // THE POINT. Before the fix this read 'Foreign …' — B's letterhead over A's deducted months.
    expect(form!.employerNameAddress, 'A’s own name').toContain('Acme');
    expect(form!.officerPhone, 'A’s own employer telephone despite transfer to B').toBe('03-11111111');
    expect(form!.employerNameAddress, 'and never B’s').not.toContain('Foreign');
    expect(form!.months[0].mtd, 'January, deducted by A').toBe(250.5);
    expect(form!.months[1].mtd, 'February belongs to B, not to this sheet').toBeNull();
  });

  it("the NEW employer's form carries the NEW employer's name, and none of the old one's months", async () => {
    await transferred();
    await owner.db.update(schema.company).set({ phone: '03-11111111' }).where(eq(schema.company.id, b.companyId));
    await owner.db.update(schema.company).set({ phone: '03-22222222' }).where(eq(schema.company.id, foreignCompanyId));
    const form = await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR, selectedDate: '2027-02-28', companyId: foreignCompanyId });
    expect(form, 'B employs them now, so B’s statement exists even before B runs payroll').toBeTruthy();
    expect(form!.employerNameAddress).toContain('Foreign');
    expect(form!.officerPhone).toBe('03-22222222');
    expect(form!.officerName).toBe('Company B officer');
    expect(form!.officerDesignation).toBe('');
    expect(form!.employerNameAddress).not.toContain('Acme');
    expect(form!.months.every((m) => m.mtd === null), 'B has deducted nothing yet').toBe(true);
  });

  /**
   * NON-VACUITY: remove `if (employerId !== info.companyId && slips.length === 0) return null;` from
   * localization/my/pcb2ii.ts and this returns a form — the employee's name, identity card number and tax
   * number under a letterhead of a company that never employed them (verified r328).
   */
  it('a company that neither employs nor paid this person gets NO form at all', async () => {
    const form = await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR, selectedDate: '2027-02-28', companyId: foreignCompanyId });
    expect(form, 'no relationship, so nothing to state').toBeNull();
  });
});


describe('r379 · required date and batch preparation refusal', () => {
  it('missing or impossible selected date refuses both doors without a PDF', async () => {
    for (const selectedDate of ['', '2027-02-29', '2027-13-01', '2027-01-01T00:00:00Z']) {
      for (const route of ['preview', 'download'] as const) {
        const response = await (route === 'preview' ? previewGET : downloadGET)(url(route, { ...ok(), selectedDate }));
        expect(response.status).toBe(303);
        expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('selectedDate');
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(await response.text()).toBe('');
      }
    }
  });
  it('missing selected-company configured officer refuses the whole batch on both doors', async () => {
    await upsertCompanyStatutoryAuthority(adminCtx(b), { companyId: b.companyId, authority: 'lhdn', signatoryPersonId: null });
    for (const route of ['preview', 'download'] as const) {
      const response = await (route === 'preview' ? previewGET : downloadGET)(url(route, ok()));
      expect(response.status).toBe(303);
      const back = new URL(response.headers.get('Location')!);
      expect(back.searchParams.get('error')).toBe('signatory');
      expect(back.searchParams.get('selectedDate')).toBe('2027-02-28');
      expect(await response.text()).toBe('');
    }
  });
});


describe('r379 · all subject scopes precede preparation refusal', () => {
  it('invalid date or missing officer followed by an unknown ID stays a generic 404', async () => {
    for (const selectedDate of ['', '2027-02-28']) {
      if (selectedDate) await upsertCompanyStatutoryAuthority(adminCtx(b), { companyId: b.companyId, authority: 'lhdn', signatoryPersonId: null });
      for (const route of ['preview', 'download'] as const) {
        const response = await (route === 'preview' ? previewGET : downloadGET)(url(route, { ...ok(), selectedDate, ids: [employmentId, randomUUID()] }));
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('Not found');
        expect(response.headers.get('Location')).toBeNull();
      }
    }
  });
  it('an unfit first visible name followed by an unknown ID stays a generic 404', async () => {
    const [subject] = await owner.db.select({ personId: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, employmentId));
    await owner.db.update(schema.person).set({ fullName: 'Complete unfit name '.repeat(80) }).where(eq(schema.person.id, subject.personId));
    for (const route of ['preview', 'download'] as const) {
      const response = await (route === 'preview' ? previewGET : downloadGET)(url(route, { ...ok(), ids: [employmentId, randomUUID()] }));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
      expect(response.headers.get('Location')).toBeNull();
    }
  });
});


it('r379 · an unfit visible field refuses an otherwise authorized whole batch with a field-specific workflow error', async () => {
  const next = await hireEmployee(adminCtx(b), { person: { fullName: 'Second valid subject', primaryEmail: `second_${randomUUID()}@pcb.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  const [subject] = await owner.db.select({ personId: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, employmentId));
  await owner.db.update(schema.person).set({ fullName: 'Complete unfit name '.repeat(80) }).where(eq(schema.person.id, subject.personId));
  for (const route of ['preview', 'download'] as const) {
    const response = await (route === 'preview' ? previewGET : downloadGET)(url(route, { ...ok(), ids: [employmentId, next.employmentId] }));
    expect(response.status).toBe(303);
    const back = new URL(response.headers.get('Location')!);
    expect(back.searchParams.get('error')).toBe('fit');
    expect(back.searchParams.get('field')).toBe('employeeName');
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).not.toBe('application/pdf');
  }
});
