/**
 * 20f6c6a8 — CLAIMS (a), (c) and (d) OF THE PAYMENT SUBMISSION MODULE, against a real payroll month.
 *
 *   (a) the EPF and SOCSO files this shelf hands over are BYTE-IDENTICAL to the ones the shipped screens
 *       already hand over, and still have the shape of the customer files the format was read off;
 *   (c) generating a file writes NOTHING — no artefact row, no domain event;
 *   (d) a company with no statutory identifiers gets a REFUSAL, not a malformed file.
 *
 * Claim (b) — the registry drives the screen — is in test/payment-submission-screen-seam.test.ts, which
 * needs a varying registry and no database.
 *
 * ⚠️ (a) IS THE ONE THAT PROTECTS MONEY, AND IT IS WRITTEN AS AN EQUALITY BETWEEN TWO PATHS RATHER THAN
 * AS A RE-DERIVATION. The trap this module could most plausibly fall into is re-implementing the
 * row→record mapping on its way to the file: `lib/perkeso-socso-file.ts` records that FOUR of its six
 * numeric boxes are six characters wide and ADJACENT, and `lib/kwsp-borang-a-file.ts` records that
 * transposing two nine-wide fields once produced "a file of the right length whose own totals still
 * agreed, and 214 tests stayed green". A test that rebuilt the expected bytes here would share whatever
 * mistake the module made. Comparing against the SHIPPED loader — the exact function
 * `app/payroll/borang-a/file/route.ts` and `app/payroll/borang-8a/file/route.ts` call — cannot.
 *
 * The fixtures stay in the picture: `test/kwsp-borang-a-file.test.ts` and `test/perkeso-socso-file.test.ts`
 * pin those loaders' writers to `test/fixtures/kwsp-borang-a-epforma2.txt` and
 * `test/fixtures/perkeso-brg8a.txt` byte for byte, so registry == loader == the customer's real file. The
 * shape assertions below read their numbers OUT OF THE FIXTURES rather than restating them, so a fixture
 * replaced by a different real file re-aims this test instead of silently disagreeing with it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const scope: { s: unknown; scopeIds: string[] } = { s: null, scopeIds: [] };
// The registry and both shared loaders resolve the caller through this one module, so mocking it here
// covers all three. It is the SAME fence the screens use: `scopedAdmin`, never `isAdmin`.
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));

import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { loadBorangAFile } from '../app/payroll/borang-a/shared';
import { loadBorang8AFile } from '../app/payroll/borang-8a/shared';
import {
  SUBMISSION_FORMATS,
  formatsInGroup,
  submissionFormat,
  type SubmissionBuild,
} from '../app/payroll/payment-submission/registry';

const PERIOD = '2026-07';
let b: Base;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  scope.s = adminCtx(b);
  scope.scopeIds = [b.companyId];
});

/** Give the company every statutory identifier the three formats need. */
async function registerEmployer() {
  await setCompanyStatutoryMY(adminCtx(b), {
    companyId: b.companyId,
    epfEmployerNo: '019632261',
    socsoEmployerCode: 'B1234567890',
    lhdnEmployerNo: 'E 908915-10',
  });
  await owner.db
    .update(schema.company)
    .set({ addressLine1: 'Level 12, Menara Satu', city: 'Kuala Lumpur', state: 'Wilayah Persekutuan', postcode: '50450' })
    .where(eq(schema.company.id, b.companyId));
}

let seq = 0;
/** One employee complete enough for ALL THREE files: EPF member no, 12-digit MyKad and a tax number. */
async function hire(name: string, salary: number) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `ps_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: salary, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, {
    personId: E.personId,
    // Derived from the sequence so two employees never collide on the tenant-unique IC index.
    icNumber: `86020810${String(5000 + seq).padStart(4, '0')}`,
    epfNumber: String(17955667 + seq),
    taxNumber: String(10203040 + seq),
    taxCategory: 1,
    numChildren: 0,
  });
  return E;
}

/** Run the month so every format has figures to read. */
async function runPayroll() {
  const a = adminCtx(b);
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
  await generatePayslips(a, { batchId: batch.batchId });
}

/** Build one format through the registry, exactly as the download route does. */
function build(id: string, query = new URLSearchParams()): Promise<SubmissionBuild> {
  const f = submissionFormat(id);
  if (!f) throw new Error(`no such format: ${id}`);
  if (!f.available) throw new Error(`${id} declares no builder`);
  return f.build({ companyId: b.companyId, periodKey: PERIOD, query });
}

/** Narrow a build to its bytes, failing with the refusal's own words when it did not succeed. */
function bytesOf(r: SubmissionBuild): string {
  if (!r.ok) throw new Error(`expected bytes, got ${r.status}: ${r.message}`);
  return r.bytes;
}

describe('20f6c6a8 (a) — the shelf hands over the SAME bytes the shipped screens do', () => {
  beforeEach(async () => {
    await registerEmployer();
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600);
    await hire('ANG PEI YEE', 4200);
    await runPayroll();
  });

  it('EPF: byte-identical to what the Borang A file route produces for the same month', async () => {
    const throughShelf = bytesOf(await build('my.epf.borang-a'));
    // THE SHIPPED PATH, called directly — the same function app/payroll/borang-a/file/route.ts calls.
    const throughRoute = await loadBorangAFile({
      companyId: b.companyId,
      periodKey: PERIOD,
      query: new URLSearchParams(),
    });
    expect(throughRoute.ok, 'the shipped path must itself produce a file for this month').toBe(true);
    if (!throughRoute.ok) return;
    expect(throughShelf).toBe(throughRoute.text);
    expect(throughShelf.length, 'an empty string would satisfy an equality and nothing else').toBeGreaterThan(0);
  });

  it('SOCSO: byte-identical to what the Borang 8A file route produces for the same month', async () => {
    const throughShelf = bytesOf(await build('my.socso.perkeso-assist'));
    const throughRoute = await loadBorang8AFile({
      companyId: b.companyId,
      periodKey: PERIOD,
      query: new URLSearchParams(),
    });
    expect(throughRoute.ok, 'the shipped path must itself produce a file for this month').toBe(true);
    if (!throughRoute.ok) return;
    expect(throughShelf).toBe(throughRoute.text);
    expect(throughShelf.length).toBeGreaterThan(0);
  });

  it('EPF: the emitted file still has the SHAPE of the customer file the layout was read off', () => {
    // Numbers taken FROM the fixture, not restated: 129 characters a line, CRLF between lines and none
    // after the last, records 00 / 01 / 02… / 99.
    const sample = fixture('kwsp-borang-a-epforma2.txt');
    const sampleLines = sample.split('\r\n');
    const width = sampleLines[0].length;
    expect(width, 'the fixture itself must be the fixed-width file this asserts against').toBe(129);
    return build('my.epf.borang-a').then((r) => {
      const lines = bytesOf(r).split('\r\n');
      expect(new Set(lines.map((l) => l.length)), `every line is ${width} characters`).toEqual(new Set([width]));
      expect(lines[0].slice(0, 2)).toBe(sampleLines[0].slice(0, 2));
      expect(lines[1].slice(0, 2)).toBe(sampleLines[1].slice(0, 2));
      expect(lines[lines.length - 1].slice(0, 2)).toBe(sampleLines[sampleLines.length - 1].slice(0, 2));
      expect(bytesOf(r).endsWith('\r\n'), 'the accepted file ends at the last character of its 99 record').toBe(false);
    });
  });

  it('SOCSO: the emitted file still has the SHAPE of the customer file the layout was read off', async () => {
    const sample = fixture('perkeso-brg8a.txt');
    const width = sample.split('\r\n')[0].length;
    expect(width, 'the fixture itself must be the fixed-width file this asserts against').toBe(278);
    const lines = bytesOf(await build('my.socso.perkeso-assist')).split('\r\n');
    expect(new Set(lines.map((l) => l.length)), `every record is ${width} characters`).toEqual(new Set([width]));
  });

  it('LHDN: the e-Data file is the one the shipped reader produces, header + one line per employee', async () => {
    const bytes = bytesOf(await build('my.lhdn.cp39-edata'));
    const lines = bytes.split('\r\n').filter((l) => l.length > 0);
    // Exhibit 4's two record widths. Asserted so this shelf cannot start emitting a different layout.
    expect(lines[0][0]).toBe('H');
    expect(lines[0]).toHaveLength(57);
    for (const d of lines.slice(1)) {
      expect(d[0]).toBe('D');
      expect(d).toHaveLength(136);
    }
    expect(lines.slice(1)).toHaveLength(2);
  });

  it('the shelf names each file what the shipped route names it', async () => {
    const epf = await build('my.epf.borang-a');
    const socso = await build('my.socso.perkeso-assist');
    expect(epf.ok && epf.filename).toMatch(/^kwsp-borang-a-019632261-202608\.txt$/);
    // `perkesoUploadFilename`'s own shape — the helper the shipped PERKESO route calls.
    expect(socso.ok && socso.filename).toMatch(/^perkeso-socso-B1234567890-\d{6}\.txt$/);
  });
});

describe('20f6c6a8 (c) — generating a file writes NOTHING', () => {
  beforeEach(async () => {
    await registerEmployer();
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600);
    await runPayroll();
  });

  /** Read as the OWNER: a count taken as the app role with no tenant context returns 0 through RLS. */
  async function counts() {
    const one = async (t: string) => {
      const r = await owner.db.execute(sql.raw(`select count(*)::int as n from ${t}`));
      return Number((r as unknown as { rows: { n: number }[] }).rows[0].n);
    };
    return { artefacts: await one('statutory_report'), events: await one('domain_event') };
  }

  it('no statutory_report row and no domain event, for every format on the shelf', async () => {
    const before = await counts();
    for (const f of SUBMISSION_FORMATS) {
      if (!f.available) continue;
      const r = await f.build({ companyId: b.companyId, periodKey: PERIOD, query: new URLSearchParams() });
      expect(r.ok, `${f.id} must produce a file for this month: ${r.ok ? '' : r.message}`).toBe(true);
    }
    const after = await counts();
    // BOTH counts, because they are two different ways of recording the same false claim: an artefact row
    // says "this return exists", a domain event says "somebody filed it". Generating asserts neither.
    expect(after.artefacts, 'generating a file must not record an artefact').toBe(before.artefacts);
    expect(after.events, 'generating a file must not append a domain event').toBe(before.events);
  });

  it('nothing on the payroll run changes status when its files are generated', async () => {
    const statusBefore = await owner.db
      .select({ id: schema.payrollBatch.id, status: schema.payrollBatch.status })
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.companyId, b.companyId))
      .orderBy(schema.payrollBatch.id);
    for (const f of SUBMISSION_FORMATS) {
      if (f.available) await f.build({ companyId: b.companyId, periodKey: PERIOD, query: new URLSearchParams() });
    }
    const statusAfter = await owner.db
      .select({ id: schema.payrollBatch.id, status: schema.payrollBatch.status })
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.companyId, b.companyId))
      .orderBy(schema.payrollBatch.id);
    expect(statusAfter).toEqual(statusBefore);
  });

  it('the module never imports the artefact recorder, which is what makes the above a property', () => {
    // The two shipped `/payroll/reports/*` file routes DO record on download. This module deliberately
    // does not, and a count is a snapshot: this guard is what stops the import coming back.
    for (const file of ['registry.ts', 'download/route.ts', 'page.tsx']) {
      const src = readFileSync(new URL(`../app/payroll/payment-submission/${file}`, import.meta.url), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} must not record a report`).not.toContain('recordFileReport');
      expect(code, `${file} must not record a report`).not.toContain('recordReport');
      expect(code, `${file} must not mark anything filed`).not.toContain('markReportFiled');
      // The OWNED definition of "filed" lives in db/schema.ts. This module must neither read it nor
      // grow a second one.
      expect(code, `${file} must not restate "filed"`).not.toContain('STATUTORY_FILED_STATUSES');
    }
  });
});

describe('20f6c6a8 (d) — a company with no statutory numbers is REFUSED, not given a malformed file', () => {
  beforeEach(async () => {
    // Deliberately NO registerEmployer(): no EPF employer reference, no SOCSO employer code, no LHDN
    // E-number. Everything else about the month is ordinary.
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600);
    await runPayroll();
  });

  it('every format refuses, and none of them returns bytes', async () => {
    for (const f of SUBMISSION_FORMATS) {
      if (!f.available) continue;
      const r = await f.build({ companyId: b.companyId, periodKey: PERIOD, query: new URLSearchParams() });
      expect(r.ok, `${f.id} must refuse without a statutory identifier`).toBe(false);
      if (r.ok) continue;
      // A refusal an operator can act on: 4xx, and words rather than a stack trace.
      expect(r.status, `${f.id} refusal must be a client error`).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.message.length, `${f.id} must say what is wrong`).toBeGreaterThan(10);
      // ⚠️ THE POINT OF THE CLAIM: nothing that could be mistaken for the file comes back. A
      // fixed-width record has no way to say "this value did not fit", so a refusal must not be a file.
      expect(r).not.toHaveProperty('bytes');
      expect(r.message).not.toContain('\r\n');
    }
  });

  it('the refusal NAMES the missing identifier rather than saying "error"', async () => {
    const epf = await build('my.epf.borang-a');
    expect(epf.ok).toBe(false);
    if (!epf.ok) expect(epf.message).toMatch(/Borang A|employer/i);

    const lhdn = await build('my.lhdn.cp39-edata');
    expect(lhdn.ok).toBe(false);
    if (!lhdn.ok) expect(lhdn.message).toMatch(/E-number|LHDN/i);
  });

  it('a company OUTSIDE the caller’s scope is refused the same way a missing one is', async () => {
    await registerEmployer();
    scope.scopeIds = [];
    for (const f of SUBMISSION_FORMATS) {
      if (!f.available) continue;
      const r = await f.build({ companyId: b.companyId, periodKey: PERIOD, query: new URLSearchParams() });
      expect(r.ok, `${f.id} must not export a company outside the caller's scope`).toBe(false);
      if (!r.ok) expect(r.status, `${f.id} must answer the bare not-found`).toBe(404);
    }
  });
});

describe('20f6c6a8 — the registry itself', () => {
  it('declares LHDN first on the government shelf, then EPF, then SOCSO', () => {
    expect(formatsInGroup('governmentStatutory').map((f) => f.id)).toEqual([
      'my.lhdn.cp39-edata',
      'my.epf.borang-a',
      'my.socso.perkeso-assist',
    ]);
  });

  it('carries no salary or bank-statutory format in this round', () => {
    expect(formatsInGroup('salary')).toEqual([]);
    expect(formatsInGroup('bankStatutory')).toEqual([]);
  });

  it('every format states its PROVENANCE, and states it truthfully', () => {
    for (const f of SUBMISSION_FORMATS) {
      expect(f.verification, `${f.id} must declare what stands behind its bytes`).toBeTruthy();
    }
    // The two with a real filed file in test/fixtures/, and the one without. Asserted by NAME so that
    // relabelling LHDN as `filed-file` without adding a filed specimen turns this red.
    expect(submissionFormat('my.epf.borang-a')?.verification).toBe('filed-file');
    expect(submissionFormat('my.socso.perkeso-assist')?.verification).toBe('filed-file');
    expect(submissionFormat('my.lhdn.cp39-edata')?.verification).toBe('specification-sample');
  });

  it('every format’s labels exist in ALL SIX catalogues, not only English', () => {
    // i18n/request.ts deep-merges each locale over English, so a key missing from a locale renders the
    // ENGLISH string rather than MISSING_MESSAGE — invisible on a render check. Presence is asserted here.
    const locales = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
    const catalogues = Object.fromEntries(
      locales.map((l) => [
        l,
        JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), 'utf8')).payroll
          .paymentSubmission as Record<string, string>,
      ]),
    );
    for (const f of SUBMISSION_FORMATS) {
      const keys = [f.labelKey, f.descriptionKey, ...(f.available ? [] : [f.unavailableReasonKey])];
      for (const key of keys) {
        for (const l of locales) {
          expect(catalogues[l]?.[key], `payroll.paymentSubmission.${key} is missing from ${l}.json`).toBeTruthy();
        }
      }
    }
  });

  it('an unknown format id resolves to nothing — it arrives off a URL', () => {
    expect(submissionFormat('my.epf.borang-a')).toBeDefined();
    for (const bad of ['', 'nope', '../registry', 'my.epf.borang-a ']) {
      expect(submissionFormat(bad), `${bad} must not resolve`).toBeUndefined();
    }
  });

  it('the download route dispatches through the registry and branches on no authority', () => {
    const src = readFileSync(new URL('../app/payroll/payment-submission/download/route.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('submissionFormat(');
    expect(code).toContain('format.build(');
    for (const literal of ['my.epf', 'my.socso', 'my.lhdn', 'KWSP', 'PERKESO', 'LHDN']) {
      expect(code, `the route must not name ${literal}`).not.toContain(literal);
    }
  });
});
