/**
 * 0d02d4a1 (r340) — THE e-DATA PCB (CP39) ROW ON PAYMENT SUBMISSION IS DOWNLOADABLE, AND IT IS THE SAME
 * FILE THE SHIPPED REPORT ROUTE ALREADY HANDS OVER.
 *
 * The item's headline promise to the reporter was one sentence: "The e-Data PCB (CP39) row on Payment
 * Submission becomes downloadable." The writer was never the gap — it ships, and `/payroll/reports` serves
 * it. The gap was that the shelf is country-neutral and had no honest way to ask a country pack for a file,
 * so the row was listed `available: false` for a round while another screen handed over the identical bytes.
 *
 * WHAT THIS FILE PROVES, in the plan's own order:
 *   (a) THE BYTES ARE THE SAME BYTES. An EQUALITY against `cp39FileForBatch` — the exact function
 *       `app/payroll/reports/cp39-file/route.ts` calls — never a re-derivation. A test that rebuilt the
 *       expected 136-character lines here would share whatever mistake the shelf made; `lib/kwsp-borang-a-
 *       file.ts` records that transposing two adjacent nine-wide fields once produced "a file of the right
 *       length whose own totals still agreed, and 214 tests stayed green".
 *   (b) THE FILE NAME IS EXHIBIT 4'S, from the writer's one definition of it.
 *   (c) THE LAYOUT DID NOT MOVE ON ITS WAY THROUGH THE NEW SEAM — header 57, detail 136, the mandatory
 *       eleven-digit TIN at positions 2–12.
 *   (d) GENERATING WRITES NOTHING — no artefact row, no domain event.
 *   (e) A COMPANY MISSING ITS LHDN E-NUMBER IS REFUSED IN WORDS, and so is an employee with no tax number.
 *   (f) THE PROVENANCE DID NOT MOVE: still `specification-sample`. Making a row downloadable is not
 *       evidence about its bytes, and the naming is asserted so an upgrade needs a filed specimen.
 *   (g) THE ROW WAS LIT WITHOUT ADDING PACK DEBT — nothing under the shelf names a pack, and the drift
 *       allowlist is untouched.
 *   (h) THE SEAM IS REAL, NOT A HARD-WIRED CALL — the same company in a jurisdiction whose pack declares
 *       no such file is refused, which a directly-wired Malaysian builder would happily have served.
 *
 * ⚠️ (h) IS THE ONE THAT MAKES ALL THE OTHERS MEAN SOMETHING. Everything else here would pass just as well
 * if the registry imported the MY writer directly — which is exactly what the drift ratchet forbids and
 * what the previous round's `available: false` was protecting.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { count, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const scope: { s: unknown; scopeIds: string[] } = { s: null, scopeIds: [] };
// The registry's builders resolve the caller through this one module — `scopedAdmin`, never `isAdmin`.
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));

import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips } from '../core/payroll';
// The SHIPPED path, imported directly. A test file may name the pack (test/ is not scanned by the drift
// ratchet); the point of this import is that the module under test does NOT need it.
import { cp39FileForBatch } from '../localization/my/cp39-file';
import { requirePackFor } from '../localization/registry';
import {
  SUBMISSION_FORMATS,
  submissionFormat,
  type SubmissionBuild,
} from '../app/payroll/payment-submission/registry';

/** The registry id AND the key the employer's pack is asked for. One string, two sides of a seam. */
const LHDN = 'my.lhdn.cp39-edata';
const PERIOD = '2026-07';
/** Exhibit 4's naming convention: ten-digit employer number, two-digit month, `_`, four-digit year. */
const LHDN_NAME = /^\d{10}(0[1-9]|1[0-2])_\d{4}\.txt$/;

let b: Base;

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

/** Exhibit 5's own worked employer number, which normalises to 0090891510. */
async function registerEmployer() {
  await setCompanyStatutoryMY(adminCtx(b), {
    companyId: b.companyId,
    epfEmployerNo: '019632261',
    socsoEmployerCode: 'B1234567890',
    lhdnEmployerNo: 'E 908915-10',
  });
}

let seq = 0;
/** One employee complete enough for the CP39 file: a 12-digit MyKad and a tax number. */
async function hire(name: string, salary: number, opts: { taxNumber?: string } = {}) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `cp39_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: salary, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, {
    personId: E.personId,
    icNumber: `86020810${String(6000 + seq).padStart(4, '0')}`,
    epfNumber: String(27955667 + seq),
    // '' is how an employee with NO tax number on file is spelled — the column is nullable and the
    // Create Employee wizard leaves it blank for anyone who has not registered with LHDN yet.
    taxNumber: opts.taxNumber ?? String(20203040 + seq),
    taxCategory: 1,
    numChildren: 0,
  });
  return E;
}

async function runPayroll() {
  const a = adminCtx(b);
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
  await generatePayslips(a, { batchId: batch.batchId });
}

/** Build one format through the registry, exactly as the download route does. */
function build(id: string, query = new URLSearchParams()): Promise<SubmissionBuild> {
  const f = submissionFormat(id);
  if (!f) throw new Error(`no such format: ${id}`);
  if (!f.available) throw new Error(`${id} declares no builder — the row is not downloadable`);
  return f.build({ companyId: b.companyId, periodKey: PERIOD, query });
}

function bytesOf(r: SubmissionBuild): string {
  if (!r.ok) throw new Error(`expected bytes, got ${r.status}: ${r.message}`);
  return r.bytes;
}

describe('0d02d4a1 — the row is downloadable at all', () => {
  it('the LHDN entry declares a builder, which is the whole deliverable of the item', () => {
    const lhdn = submissionFormat(LHDN);
    expect(lhdn, 'the row must be listed').toBeTruthy();
    expect(lhdn!.available, 'an unavailable row has no download — this is the promise to the reporter').toBe(
      true,
    );
    // The discriminated union means this is a TYPE-level guarantee too: no `build` exists when unavailable.
    if (lhdn!.available) expect(typeof lhdn!.build).toBe('function');
  });
});

describe('0d02d4a1 (a)(b)(c) — the same bytes, the same name, the same layout', () => {
  beforeEach(async () => {
    await registerEmployer();
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600);
    await hire('ANG PEI YEE', 4200);
    await runPayroll();
  });

  it('(a) byte-identical to what the shipped report route produces for the same month', async () => {
    const throughShelf = bytesOf(await build(LHDN));
    // The SHIPPED path, called directly.
    const throughRoute = await cp39FileForBatch(adminCtx(b), { companyId: b.companyId, periodKey: PERIOD });
    expect(throughShelf).toBe(throughRoute.content);
    expect(throughShelf.length, 'an empty string would satisfy an equality and nothing else').toBeGreaterThan(
      0,
    );
    // …and it really is this month's two employees, not an empty file that happens to match.
    expect(throughShelf.split('\r\n').filter((l) => l.startsWith('D'))).toHaveLength(2);
  });

  it('(b) named the way Exhibit 4 names it, from the writer’s one definition', async () => {
    const r = await build(LHDN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 0090891510 (Exhibit 5's "E 908915-10") + 07 + _ + 2026.
    expect(r.filename).toBe('009089151007_2026.txt');
    expect(r.filename).toMatch(LHDN_NAME);
    const throughRoute = await cp39FileForBatch(adminCtx(b), { companyId: b.companyId, periodKey: PERIOD });
    expect(r.filename, 'two surfaces must not name one month’s file differently').toBe(throughRoute.filename);
    expect(r.contentType).toBe('text/plain; charset=us-ascii');
  });

  it('(c) header is 57 characters, every detail record 136, TIN at positions 2–12', async () => {
    const lines = bytesOf(await build(LHDN)).split('\r\n').filter((l) => l.length > 0);
    const [header, ...details] = lines;
    expect(header.startsWith('H')).toBe(true);
    expect(header, 'Exhibit 4 fixes the header at 57 characters').toHaveLength(57);
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) {
      expect(d.startsWith('D')).toBe(true);
      expect(d, 'Exhibit 4 fixes the detail record at 136 characters').toHaveLength(136);
      // Field 11: the tax identification number, mandatory in 2026 and eleven digits wide.
      expect(d.slice(1, 12)).toMatch(/^\d{11}$/);
    }
    // No delimiters anywhere: the format is fixed position (reporter's expected behaviour 6).
    expect(bytesOf(await build(LHDN))).not.toMatch(/[,\t;|]/);
  });

  it('(d) generating it records NOTHING — no artefact row, no domain event', async () => {
    // Read as the OWNER: a count taken as the app role with no tenant context returns 0 through RLS, which
    // would make this pass without measuring anything (CLAUDE.md §5).
    const counts = async () => {
      const [a] = await owner.db.select({ n: count() }).from(schema.statutoryReport);
      const [e] = await owner.db.select({ n: count() }).from(schema.domainEvent);
      return { artefacts: a.n, events: e.n };
    };
    const before = await counts();
    expect(bytesOf(await build(LHDN)).length).toBeGreaterThan(0);
    const after = await counts();
    // ⚠️ THE SHIPPED REPORT ROUTE DOES RECORD ONE on every download. That behaviour is ITS own; this shelf
    // produces the same bytes and asserts nothing was filed with anybody by producing them.
    expect(after.artefacts, 'generating a file must not record an artefact').toBe(before.artefacts);
    expect(after.events, 'generating a file must not append a domain event').toBe(before.events);
  });
});

describe('0d02d4a1 (e) — a month that cannot be filed is REFUSED in words, never half-filed', () => {
  it('no LHDN E-number on the company: 422 naming the number that is missing', async () => {
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600);
    await runPayroll();
    const r = await build(LHDN);
    expect(r.ok, 'a file with no employer number is not a file').toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.message, 'the refusal must name WHAT is missing, not say "error"').toMatch(/E-number/i);
    // A refusal must not be mistakable for the file: no record separators, no bytes property.
    expect(r).not.toHaveProperty('bytes');
    expect(r.message).not.toContain('\r\n');
  });

  it('an employee with no tax number: 422 naming the employee', async () => {
    await registerEmployer();
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600, { taxNumber: '' });
    await runPayroll();
    const r = await build(LHDN);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.message).toMatch(/AHMAD MUHAIMIN BIN OSMAN/);
  });

  it('no payroll run for the month: 422 rather than an empty file with a valid header', async () => {
    await registerEmployer();
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600);
    const r = await build(LHDN);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.message).toMatch(/payroll/i);
  });

  it('a company OUTSIDE the caller’s scope gets the bare 404, like one that does not exist', async () => {
    await registerEmployer();
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600);
    await runPayroll();
    scope.scopeIds = [];
    const r = await build(LHDN);
    expect(r.ok, 'the shelf must not export a company this admin does not administer').toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('a malformed company id or period resolves to the same bare 404', async () => {
    const f = submissionFormat(LHDN);
    expect(f?.available).toBe(true);
    if (!f?.available) return;
    for (const p of [
      { companyId: 'not-a-uuid', periodKey: PERIOD },
      { companyId: b.companyId, periodKey: '2026-13' },
      { companyId: b.companyId, periodKey: '2026-7' },
    ]) {
      const r = await f.build({ ...p, query: new URLSearchParams() });
      expect(r.ok, `${p.companyId} / ${p.periodKey} must not resolve`).toBe(false);
      if (!r.ok) expect(r.status).toBe(404);
    }
  });
});

describe('0d02d4a1 (h) — the file comes through the PACK SEAM, not a hard-wired Malaysian call', () => {
  beforeEach(async () => {
    await registerEmployer();
    await hire('AHMAD MUHAIMIN BIN OSMAN', 5600);
    await runPayroll();
  });

  it('the same month, in a jurisdiction whose pack declares no such file, is refused', async () => {
    // Everything about this company's DATA still supports the file — the E-number, the payslips and the tax
    // numbers are all in place, and the assertion above proves the file builds. Only the employer's
    // JURISDICTION changes. A registry that imported the writer directly would still serve it here.
    expect(bytesOf(await build(LHDN)).length).toBeGreaterThan(0);
    await owner.db
      .update(schema.company)
      .set({ country: 'SG' })
      .where(eq(schema.company.id, b.companyId));
    const r = await build(LHDN);
    expect(r.ok, 'no pack for SG declares this file, so there is nothing to hand over').toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('the pack really declares the key the registry asks for — both sides of the seam pinned', () => {
    const files = requirePackFor('MY').paymentFiles;
    expect(files, 'the MY pack must declare its payment files').toBeTruthy();
    expect(Object.keys(files!), `the pack must answer to ${LHDN}`).toContain(LHDN);
    // …and the registry entry's id must BE that key, or the screen offers a button the pack cannot serve.
    expect(SUBMISSION_FORMATS.map((f) => f.id)).toContain(LHDN);
  });
});

describe('0d02d4a1 (f)(g) — lit WITHOUT an upgraded provenance claim and WITHOUT new pack debt', () => {
  it('(f) the provenance is still `specification-sample` — downloadable is not evidence', () => {
    // Asserted BY NAME so that relabelling this `filed-file` without a real filed specimen turns it red.
    expect(submissionFormat(LHDN)?.verification).toBe('specification-sample');
  });

  it('(g) no file on the Payment Submission shelf names a country pack', () => {
    const dir = new URL('../app/payroll/payment-submission/', import.meta.url);
    for (const file of ['registry.ts', 'pack-file.ts', 'page.tsx', 'download-dialog.tsx', 'download/route.ts']) {
      const src = readFileSync(new URL(file, dir), 'utf8');
      // The ratchet itself does not strip comments; this guard is about the CODE, so it does.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} must reach a pack only through the registry seam`).not.toContain('localization/my');
    }
  });

  it('(g) the drift allowlist was not grown to light this row', () => {
    const allow = JSON.parse(
      readFileSync(new URL('./pack-drift-allowlist.json', import.meta.url), 'utf8'),
    ) as Record<string, string[] | string>;
    // The ratchet only ever shrinks (ADR-0080 D1/D7). One audited entry of genuine debt remains, and no
    // Payment Submission file appears anywhere in either set.
    expect(allow['localization/my']).toEqual(['localization/statutory-pack/ingest.ts']);
    const listed = [...(allow['localization/my'] as string[]), ...(allow['localization/my.pack-ui'] as string[])];
    expect(listed.filter((f) => f.includes('payment-submission'))).toEqual([]);
  });
});
