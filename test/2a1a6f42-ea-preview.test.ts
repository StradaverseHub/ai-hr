/**
 * 2a1a6f42 (r331) — THE C.P.8A (EA) PREVIEW, AND THE GATE IT IS NOT ALLOWED TO BE LIGHTER THAN.
 *
 * The reporter asked us to review every statutory form for one that cannot be looked at before it is
 * downloaded. Five of the six already had a preview (Borang A, Borang 8A, CP39, CP22, PCB 2(II)); the EA
 * had none, and its only route was `download/route.ts`. r328 had already put the preview on the SHARED
 * employee picker as two OPTIONAL props and switched it on for PCB 2(II) alone, so this item is the EA
 * screen passing those two props plus `preview/route.ts` — the download's own bytes, served `inline`.
 *
 * FOUR CLAIMS, each a way a preview ships wrong on a document carrying a year of pay, EPF, SOCSO and tax:
 *
 *   1. IT IS THE SAME DOCUMENT, NOT A SECOND RENDITION OF IT. An HTML preview of a statutory form is a
 *      second renderer, and the day the two disagree an operator has approved a page that is not the file
 *      they sent. Pinned by comparing the two responses BYTE FOR BYTE (modulo the PDF's own timestamps).
 *   2. IT IS NOT A LIGHTER SURFACE. Every refusal the download makes, the preview makes — a malformed id,
 *      an empty or oversized selection, an out-of-scope company and an employment that does not exist are
 *      ALL the same bare 404, so the URL enumerates nothing.
 *   3. THE GATE IS WRITTEN ONCE. Both routes are one call into `../shared.ts`; neither carries a copy of
 *      `scopedAdmin`, the shape allowlist or the scope check that could quietly relax on one side.
 *   4. THE SCREEN OFFERS IT, in all six locales, naming its own form's route and not PCB 2(II)'s.
 *
 * ⚠️ WHY `next-intl/server` IS MOCKED HERE, AND WHAT THAT DOES NOT COVER. The EA's label bundle is
 * resolved through `getTranslations({locale, namespace})` and its locale fallback through `getLocale()`;
 * `i18n/request.ts` reads `cookies()`, which throws outside a request. So the mock below resolves BOTH
 * against the REAL `messages/<locale>.json` on disk — the bundles are the shipped words, which is what
 * makes the en/ms comparison below a real comparison rather than a comparison of two stubs. What it does
 * NOT cover is next-intl's own catalogue merging and the renderer's layout against those words;
 * test/ea-pdf.test.ts and test/r219-ea-cp8a-form.test.ts own those claims and run on the real bundles.
 *
 * ⚠️ MEASURED, NOT ASSUMED — THE r209 TWO-PAGE NOTE IS STALE. An old review recorded that every EA render
 * came out as a TWO-page document with an orphaned disclaimer on page 2. It does not: `ensure(30)` is not
 * in lib/ea-pdf.ts at all, test/ea-pdf.test.ts pins "the whole form is ONE page" in all six locales, and
 * the page count asserted below is the count measured through the route itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { employeeEaStatement } from '../core/reporting';
import { MAX_EA_SELECTION } from '../app/payroll/statutory-forms/ea/limits';
import { adminCtx, closeAll, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SHARED = src('app/payroll/statutory-forms/ea/shared.ts');
const PREVIEW_ROUTE = src('app/payroll/statutory-forms/ea/preview/route.ts');
const DOWNLOAD_ROUTE = src('app/payroll/statutory-forms/ea/download/route.ts');
const SCREEN = src('app/payroll/statutory-forms/ea/page.tsx');
const PICKER = src('app/payroll/statutory-forms/ea/employee-picker.tsx');

/**
 * Source with its comments removed. These files EXPLAIN the gate at length — `shared.ts` is named in
 * every header — so a bare grep for `scopedAdmin` matches the prose that says the routes do not call it.
 * The ratchet reads CODE (CLAUDE.md §8: "the ratchet reads comments, so reword a quoted specifier").
 */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The mocked answer from `scopedAdmin`, swapped per case. Set in `beforeEach`. */
let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));

// The real catalogues, resolved without a request. See the header for what this does and does not cover.
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
    dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
  return {
    // The download's fallback when no `lang` was asked for. 'en' is the app's default locale.
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

let b: Base;
let employmentId: string;
let secondEmploymentId: string;
let neighbourCompanyId: string;

const YEAR = '2026';

/** A closed payroll month, so the previewed statement carries a real figure rather than an empty form. */
async function payslipFor(id: string, period: string) {
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
    statutory: { pcb: 412.35, epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9 },
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
  q: { companyId?: string; year?: string; ids?: string[]; lang?: string },
) => {
  const p = new URLSearchParams();
  if (q.companyId !== undefined) p.set('companyId', q.companyId);
  if (q.year !== undefined) p.set('year', q.year);
  for (const id of q.ids ?? []) p.append('id', id);
  if (q.lang !== undefined) p.set('lang', q.lang);
  return new Request(`http://t.local/payroll/statutory-forms/ea/${route}?${p.toString()}`);
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
  const hire = async (name: string) =>
    (
      await hireEmployee(adminCtx(b), {
        person: { fullName: name, primaryEmail: `ea_${randomUUID().slice(0, 8)}@t.local` },
        companyId: b.companyId,
        departmentId: b.deptA,
        employmentType: 'full_time',
        hiredOn: '2020-01-01',
      })
    ).employmentId;
  employmentId = await hire('Preview Subject');
  secondEmploymentId = await hire('Second Subject');
  await payslipFor(employmentId, `${YEAR}-03`);
  await payslipFor(secondEmploymentId, `${YEAR}-04`);
  // A neighbour company in the SAME tenant. RLS lets this admin's context reach it; the route's own
  // `scopeIds` check is what must refuse it. The difference between those two is the point of the
  // out-of-scope case below, so the company has to be reachable for the case to mean anything.
  const [nc] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Neighbour ${randomUUID().slice(0, 6)}`, country: 'MY' })
    .returning({ id: schema.company.id });
  neighbourCompanyId = nc.id;
  scope = { s: ctxFor(), scopeIds: [b.companyId] };
});

describe('2a1a6f42 · the EA preview is the EA download, opened instead of saved', () => {
  it('serves the form INLINE, as a real PDF, one page per ticked employee', async () => {
    const res = await previewGET(url('preview', ok()));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    const cd = res.headers.get('Content-Disposition') ?? '';
    expect(cd, 'a preview is OPENED, not saved').toMatch(/^inline;/);
    expect(cd, 'and it still names the file the operator saves out of the viewer').toContain(
      `filename="ea-${YEAR}-`,
    );
    // Nothing about this response may be cached by a shared proxy: it is named people's tax records.
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString('latin1'), 'a real PDF, not an HTML lookalike').toBe('%PDF-');
    const doc = await PDFDocument.load(body);
    /**
     * ⚠️ AND THIS IS THE r209 NOTE, MEASURED. An old review recorded that every EA render produced TWO
     * pages with an orphaned disclaimer on the second. ONE page per ticked employee is what the route
     * actually returns, so the note is stale and there is no item behind it.
     */
    expect(doc.getPageCount(), 'one statement per ticked employee, one page each').toBe(1);
  });

  it('two ticked people are two statements in ONE file, and the same two the download returns', async () => {
    const both = { companyId: b.companyId, year: YEAR, ids: [employmentId, secondEmploymentId] };
    const res = await previewGET(url('preview', both));
    expect(res.status).toBe(200);
    const doc = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
    expect(doc.getPageCount(), 'two people, two pages — not four').toBe(2);
    // The same person ticked twice is one copy, not two: the ids are de-duplicated before the loop.
    const dup = await previewGET(url('preview', { ...both, ids: [employmentId, employmentId] }));
    expect((await PDFDocument.load(Buffer.from(await dup.arrayBuffer()))).getPageCount()).toBe(1);
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
    // LHDN accepts the C.P.8A in English or Bahasa Malaysia and the two sheets differ by more than one
    // caption, so a language that silently became "whatever the screen was set to" would be a real defect.
    expect(ms, 'the Malay sheet is not the English one').not.toBe(en);
    // An unknown `lang` falls back to the REQUEST locale rather than being handed to next-intl (which
    // throws on an unknown locale and would 500 the route). The request locale is 'en' here.
    expect(await body('zz'), 'an unknown lang is not handed on').toBe(await body(undefined));
    // The filename carries the language only when one was asked for — the download's own rule.
    const named = await previewGET(url('preview', { ...ok(), lang: 'ms' }));
    expect(named.headers.get('Content-Disposition')).toContain(`-ms.pdf"`);
    const unnamed = await previewGET(url('preview', ok()));
    expect(unnamed.headers.get('Content-Disposition')).not.toMatch(/-(en|ms)\.pdf"/);
  });
});

describe('r379 V6 whole-selection readable-fit failure', () => {
  it('keeps the missing-employment 404 gate ahead of fit diagnostics',async()=>{
    await owner.db.update(schema.company).set({addressLine1:'Unfit Complete Address '.repeat(80)}).where(eq(schema.company.id,b.companyId));
    const selection={...ok(),ids:[employmentId,randomUUID()]};
    for(const get of [previewGET,downloadGET]) {
      const res=await get(url('preview',selection));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not found');
    }
  });
  it.each(['preview','download'] as const)('%s refuses the entire two-employee selection without PDF bytes', async disposition => {
    await owner.db.update(schema.company).set({addressLine1:'Bangunan Amanah Pekerja Blok Aras Lapan Belas '.repeat(30)}).where(eq(schema.company.id,b.companyId));
    const selected={...ok(),ids:[employmentId,secondEmploymentId]};
    const res=await(disposition==='preview'?previewGET:downloadGET)(url(disposition,selected));
    expect(res.status).toBe(422);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body=await res.text();
    expect(body).toContain('Preview Subject');
    expect(body).toContain('Employer and authorised officer');
    expect(body).not.toContain('%PDF');
  });
});

describe('2a1a6f42 · a preview is NOT a lighter surface — every refusal is the download’s', () => {
  const bare = async (res: Response, why: string) => {
    expect(res.status, why).toBe(404);
    expect(await res.text(), 'bare — the body must not say WHICH check refused').toBe('Not found');
    expect(res.headers.get('Content-Type'), 'and it must not be a PDF').not.toBe('application/pdf');
  };

  /**
   * ⚠️ THE ONE THIS FILE IS HERE FOR, AND IT IS THE ROUTE'S OWN GUARD RATHER THAN RLS.
   *
   * `scopeIds` is the admin's OWN company scope; an hr_admin grant on ANY company makes `isAdmin` true, so
   * without this check a company-scoped admin could read another company's people's pay, EPF, SOCSO and
   * tax figures by editing the URL. RLS cannot make that distinction — it fences the TENANT, and both
   * companies are in one tenant.
   *
   * WHICH IS WHY THE READ IS TAKEN FIRST, THROUGH THE ROUTE'S OWN CONTEXT. A refusal test that only
   * asserts 404 is green whether the guard fired or the data was simply unreachable. The line before the
   * refusal proves the data IS reachable through `scope.s` — so the 404 below is the route's
   * `scopeIds.includes(companyId)` line and nothing else.
   *
   * NON-VACUITY: delete `if (!scopeIds.includes(companyId)) return notFound();` from
   * app/payroll/statutory-forms/ea/shared.ts and both expectations fail with 200 (verified r331).
   */
  it('an OUT-OF-SCOPE company is a bare 404 on BOTH routes — and the data was reachable', async () => {
    scope = { s: ctxFor(), scopeIds: [neighbourCompanyId] }; // the admin can reach anything BUT this company
    const reachable = await employeeEaStatement(scope.s, {
      employmentId,
      year: YEAR,
      companyId: b.companyId,
    });
    expect(reachable, 'RLS lets this very context read the statement — only the scope check refuses it').toBeTruthy();
    await bare(await previewGET(url('preview', ok())), 'preview must refuse an out-of-scope company');
    await bare(await downloadGET(url('download', ok())), 'download must refuse it too');
  });

  it('a malformed companyId never reaches the database', async () => {
    await bare(await previewGET(url('preview', { ...ok(), companyId: 'not-a-uuid' })), 'malformed companyId');
    await bare(await downloadGET(url('download', { ...ok(), companyId: 'not-a-uuid' })), 'and on the download');
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
    // One under the ceiling is NOT refused by the ceiling — it fails later, on the ids nobody owns. This
    // is what stops the case above from passing for the wrong reason.
    const under = Array.from({ length: MAX_EA_SELECTION }, () => randomUUID());
    const res = await previewGET(url('preview', { ...ok(), ids: under }));
    expect(res.status, 'still 404, but reached the read rather than the ceiling').toBe(404);
  });

  it('an employment with NO statement refuses the WHOLE request, not a file short of people', async () => {
    // A well-formed id nobody owns. The route must not return the one statement it COULD build.
    await bare(
      await previewGET(url('preview', { ...ok(), ids: [employmentId, randomUUID()] })),
      'one missing statement poisons the batch',
    );
  });
});

describe('2a1a6f42 · the gate is written once, so it cannot relax on one side', () => {
  it('neither route carries its own copy of the gate', () => {
    for (const [name, raw] of [
      ['preview/route.ts', PREVIEW_ROUTE],
      ['download/route.ts', DOWNLOAD_ROUTE],
    ] as const) {
      const body = code(raw);
      expect(body, `${name} must not re-implement scopedAdmin`).not.toMatch(/scopedAdmin/);
      expect(body, `${name} must not re-implement the shape allowlist`).not.toMatch(/0-9a-f\]\{8\}/);
      expect(body, `${name} must delegate to ../shared`).toMatch(/eaPdfResponse/);
      expect(body, `${name} needs the Node runtime for pdf-lib`).toMatch(/runtime = 'nodejs'/);
    }
    expect(PREVIEW_ROUTE).toMatch(/eaPdfResponse\(req, 'inline'\)/);
    expect(DOWNLOAD_ROUTE).toMatch(/eaPdfResponse\(req, 'attachment'\)/);
  });

  it('the shared module still holds every check, and renders through the ONE renderer', () => {
    expect(SHARED, 'the company-scope check').toMatch(/scopeIds\.includes\(companyId\)/);
    expect(SHARED, 'the admin gate').toMatch(/scopedAdmin\(\)/);
    expect(SHARED, 'the selection ceiling').toMatch(/MAX_EA_SELECTION/);
    expect(SHARED, 'the lang allowlist').toMatch(/EA_LANGS\.includes/);
    // A SECOND EA renderer is two versions of one statutory form that drift. There is one, and it is the
    // one the employee's own download uses.
    expect(SHARED).toMatch(/renderEaPdf/);
    expect(SHARED).toMatch(/eaPdfLabels/);
    expect(code(PREVIEW_ROUTE), 'the preview must not draw the form itself').not.toMatch(/renderEaPdf/);
  });
});

describe('2a1a6f42 · the screen offers the preview, in every locale, for THIS form', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

  it('passes the picker BOTH props, naming the EA’s own preview route', () => {
    // r402 (item f3cf2444) — Preview goes to the EA's in-app VIEWER, which frames this same inline route
    // (test/r402-statutory-pdf-viewer.test.ts pins the frame's source to it).
    expect(SCREEN).toMatch(/previewAction="\/payroll\/statutory-forms\/ea\/view"/);
    expect(SCREEN).toMatch(/preview: t\('eaPreview'\)/);
    // Its own key, never PCB 2(II)'s: a screen that borrows a string named after another statutory
    // document is the defect r328 fixed in the other direction.
    expect(code(SCREEN), 'the EA screen must not borrow the PCB 2(II) key').not.toMatch(/pcb2iiPreview/);
    expect(code(SCREEN), 'nor open the PCB 2(II) route').not.toMatch(/statutory-forms\/pcb2ii/);
  });

  it('the picker still renders the button only when BOTH props arrive', () => {
    // The mechanism r328 built and this item switched on. It stays conditional, so a future screen on
    // this picker with no preview route still renders no preview button.
    expect(PICKER).toMatch(/previewAction && strings\.preview/);
    expect(PICKER).toMatch(/previewAction\?: string/);
    expect(PICKER).toMatch(/preview\?: string/);
    // ⚠️ r402 (item f3cf2444) — REVERSED: it no longer opens a new tab. The reporter asked for the form to
    // open inside the system; the selection survives because the viewer's Back carries the ticked ids and
    // the picker starts with them ticked (`initialSelected`).
    expect(code(PICKER)).not.toMatch(/formTarget="_blank"/);
    expect(PICKER).toMatch(/initialSelected/);
  });

  it('eaPreview exists in all six locales and names no statutory document', () => {
    for (const loc of LOCALES) {
      const m = JSON.parse(src(`messages/${loc}.json`)).payroll.statutoryForms as Record<string, string>;
      expect(typeof m.eaPreview, `${loc}.eaPreview`).toBe('string');
      expect(m.eaPreview.trim(), `${loc}.eaPreview`).not.toBe('');
      // A one-word verb on a shared control. Naming a form here would be a caption claiming something
      // that is not true of every screen the picker serves (CLAUDE.md §8, shared captions).
      expect(m.eaPreview, `${loc}.eaPreview must not name a form`).not.toMatch(/C\.P\.8A|PCB 2\(II\)/);
      expect(m.eaPreview, `${loc}.eaPreview takes no placeholder`).not.toContain('{');
    }
  });
});
