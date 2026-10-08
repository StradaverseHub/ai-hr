/**
 * r413 (item 79f3f64d, step 2) — the event-selection screen for forms about one person, and the proof that
 * moving CP22 onto it changed nothing CP22 produces.
 *
 *   1. THE LIST IS THE WORKLIST, NARROWED. `complianceWorklist` with no `form` is what the directory's foot
 *      has always shown; with `form` it is that list's subset; the name search only hides.
 *   2. THE SCREEN draws the people with the event, says why an empty list is empty, and offers no Continue.
 *   3. CONTINUE goes to the catalog's own preview path; nobody chosen comes back with the refusal.
 *   4. CP22's PDF IS BYTE-IDENTICAL to main@f62d68f3's renderer on the same record (dates normalised), and
 *      `cp22Particulars` is textually main's — so the document the new path ends at is the old one.
 *   5. THE CP22A PREVIEW refuses another company's leaver with a real 404.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { complianceWorklist, cp22Particulars } from '../core/reporting';
import { MY_OFFICIAL_ARTWORK, MY_PLANNED_FORMS, MY_STATUTORY_LINKS } from '../localization/my/reports';

let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  getLocale: async () => 'en',
}));

import { renderToStaticMarkup } from 'react-dom/server';
import EventPage from '../app/payroll/statutory-forms/event/page';
import { GET as continueGET } from '../app/payroll/statutory-forms/event/continue/route';
import Cp22aPreviewPage from '../app/payroll/cp22a/[employmentId]/preview/page';
import { renderCp22Pdf } from '../lib/cp22-pdf';

const ROOT = path.resolve(__dirname, '..');
/** The commit this round was cut from. The no-change claims below are made AGAINST it, by name. */
const BASELINE = 'f62d68f3';
const atBaseline = (file: string) => execFileSync('git', ['show', `${BASELINE}:${file}`], { cwd: ROOT, encoding: 'utf8' });
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Today in KL-shaped ISO, offset by n days — the worklist's window is relative to the tenant's clock. */
const dayOffset = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const stable = async (bytes: Uint8Array): Promise<string> => {
  const doc = await PDFDocument.load(bytes);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  return Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
};

const thrown = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'did not throw';
};

let b: Base;
let joinerId: string;
let leaverId: string;
const TODAY = dayOffset(0);

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const a = adminCtx(b);
  await owner.db.insert(schema.companyStatutoryMy).values({ tenantId: b.tenantId, companyId: b.companyId, lhdnEmployerNo: 'E 1234567890' });
  const joiner = await hireEmployee(a, {
    person: { fullName: 'Daniel Tan', primaryEmail: `daniel_${randomUUID()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: dayOffset(-10),
  });
  joinerId = joiner.employmentId;
  const leaver = await hireEmployee(a, {
    person: { fullName: 'Siti Nurhaliza', primaryEmail: `siti_${randomUUID()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  leaverId = leaver.employmentId;
  await owner.db
    .update(schema.employment)
    .set({ terminatedOn: dayOffset(20), terminationType: 'retired' })
    .where(eq(schema.employment.id, leaverId));
  scope = { s: a, scopeIds: [b.companyId] };
});

describe('r413 · the list is the compliance worklist, narrowed', () => {
  it('without `form` it is byte-for-byte the list the directory has always shown; with it, the subset', async () => {
    const a = adminCtx(b);
    const all = await complianceWorklist(a, { companyId: b.companyId, today: TODAY });
    expect(all.map((w) => [w.form, w.name]).sort()).toEqual([
      ['CP22', 'Daniel Tan'],
      ['CP22A', 'Siti Nurhaliza'],
    ]);
    expect(await complianceWorklist(a, { companyId: b.companyId, today: TODAY, form: 'CP22A' })).toEqual(
      all.filter((w) => w.form === 'CP22A'),
    );
    expect(await complianceWorklist(a, { companyId: b.companyId, today: TODAY, form: 'CP22' })).toEqual(
      all.filter((w) => w.form === 'CP22'),
    );
  });

  it('the name search is a case-insensitive substring, and it can only hide', async () => {
    const a = adminCtx(b);
    const hit = await complianceWorklist(a, { companyId: b.companyId, today: TODAY, nameQuery: 'NURHAL' });
    expect(hit.map((w) => w.name)).toEqual(['Siti Nurhaliza']);
    expect(await complianceWorklist(a, { companyId: b.companyId, today: TODAY, nameQuery: 'zzz' })).toEqual([]);
  });
});

/**
 * VERIFIER FIX — A DEATH'S DEADLINE IS NOT "LEAVING DATE − 30". CP22A [Pin.1/2023]'s own instruction:
 * "sekurang-kurangnya 30 hari sebelum tarikh pemberhentian … atau dalam tempoh 30 hari selepas dimaklumkan
 * kematian seseorang pekerja". The date the employer is told is not recorded, so no date is computed.
 * NON-VACUITY: remove the `terminationType === 'death'` branch in complianceWorklist and every assertion
 * below fails (the row gets leaving date − 30 and a computed status).
 */
describe('r413 · a death is due 30 days after the employer is TOLD — no computed date', () => {
  beforeEach(async () => {
    await owner.db.update(schema.employment).set({ terminationType: 'death', terminatedOn: dayOffset(-5) }).where(eq(schema.employment.id, leaverId));
  });

  it('the worklist row carries no due date and the on_notice status; a retirement still gets leaving − 30', async () => {
    const a = adminCtx(b);
    const [death] = await complianceWorklist(a, { companyId: b.companyId, today: TODAY, form: 'CP22A' });
    expect(death).toMatchObject({ employmentId: leaverId, eventDate: dayOffset(-5), dueBy: null, status: 'on_notice' });
    await owner.db.update(schema.employment).set({ terminationType: 'retired' }).where(eq(schema.employment.id, leaverId));
    const [retired] = await complianceWorklist(a, { companyId: b.companyId, today: TODAY, form: 'CP22A' });
    expect(retired).toMatchObject({ dueBy: dayOffset(-35), status: 'overdue' });
  });

  it('the event screen prints the reason, never the leaving date − 30', async () => {
    const html = renderToStaticMarkup(await EventPage({ searchParams: Promise.resolve({ form: 'my.cp22a', companyId: b.companyId }) }));
    expect(html).toContain('Siti Nurhaliza');
    expect(html).toContain('data-due-on-notice');
    expect(html).toContain('dueOnNotice');
    expect(html).toContain('status_on_notice');
    const wrong = dayOffset(-35);
    expect(html).not.toContain(`${wrong.slice(8, 10)}/${wrong.slice(5, 7)}/${wrong.slice(0, 4)}`);
  });

  // ⚠️ r418 (item 57ef8cf9) — REVERSED: the directory's own worklist table is GONE (the reporter asked), so the
  // event screen above is the one place this word is printed. Pinned both ways, so the word cannot quietly
  // come back on the directory as a date, nor vanish from the event screen.
  it('the directory carries no worklist table any more; the event screen is where the word is said', () => {
    const src = code(fs.readFileSync(path.join(ROOT, 'app/payroll/statutory-forms/page.tsx'), 'utf8'));
    expect(src.length).toBeGreaterThan(5000);
    expect(src).not.toContain('w.dueBy');
    expect(src).not.toContain('data-due-on-notice');
    const ev = code(fs.readFileSync(path.join(ROOT, 'app/payroll/statutory-forms/event/page.tsx'), 'utf8'));
    expect(ev).toContain('data-due-on-notice');
    expect(ev).toContain("tf('dueOnNotice')");
  });
});

describe('r413 · the screen', () => {
  it('lists the leavers for CP22A — name, event, dates, status word and a select — and nobody else', async () => {
    const html = renderToStaticMarkup(await EventPage({ searchParams: Promise.resolve({ form: 'my.cp22a', companyId: b.companyId }) }));
    expect(html).toContain('Siti Nurhaliza');
    expect(html).not.toContain('Daniel Tan');
    expect(html).toContain(`value="${leaverId}"`);
    expect(html).toContain('event_CP22A');
    for (const col of ['colName', 'colEvent', 'colEventDate', 'colDueBy', 'colStatus', 'colSelect']) expect(html).toContain(col);
    expect(html).toContain(`action="/payroll/statutory-forms/event/continue"`);
  });

  it('lists the joiners for CP22 on the same screen', async () => {
    const html = renderToStaticMarkup(await EventPage({ searchParams: Promise.resolve({ form: 'my.cp22', companyId: b.companyId }) }));
    expect(html).toContain('Daniel Tan');
    expect(html).not.toContain('Siti Nurhaliza');
    expect(html).toContain('event_CP22');
  });

  it('says why an empty list is empty and disables Continue — no blank form is reachable', async () => {
    const html = renderToStaticMarkup(
      await EventPage({ searchParams: Promise.resolve({ form: 'my.cp22a', companyId: b.companyId, q: 'nobody' }) }),
    );
    expect(html).toContain('data-event-empty');
    expect(html).toContain('emptySearch');
    expect(html).toMatch(/<button data-event-continue="true" disabled=""/);
  });

  it('404s a form that is not a form about one person, and never honours an out-of-scope company', async () => {
    expect(await thrown(EventPage({ searchParams: Promise.resolve({ form: 'my.cp39' }) }))).toBe('NEXT_NOT_FOUND');
    const [fc] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Foreign Sdn Bhd', country: 'MY' })
      .returning({ id: schema.company.id });
    const html = renderToStaticMarkup(await EventPage({ searchParams: Promise.resolve({ form: 'my.cp22a', companyId: fc.id }) }));
    // The foreign id is ignored; the admin's own company is what is listed.
    expect(html).toContain('Siti Nurhaliza');
    expect(html).not.toContain(`value="${fc.id}"`);
  });
});

describe('r413 · Continue', () => {
  const go = (q: Record<string, string>) =>
    thrown(continueGET(new Request(`http://localhost/payroll/statutory-forms/event/continue?${new URLSearchParams(q)}`)));

  it('sends CP22 to its UNCHANGED review screen and CP22A to its viewer — the catalog’s paths', async () => {
    expect(await go({ form: 'my.cp22', employmentId: joinerId })).toBe(`NEXT_REDIRECT:/payroll/cp22/${joinerId}/preview`);
    expect(await go({ form: 'my.cp22a', employmentId: leaverId })).toBe(`NEXT_REDIRECT:/payroll/cp22a/${leaverId}/preview`);
  });

  it('brings the operator back, company kept, when nobody was chosen', async () => {
    const msg = await go({ form: 'my.cp22a', companyId: b.companyId });
    expect(msg).toBe(`NEXT_REDIRECT:/payroll/statutory-forms/event?form=my.cp22a&companyId=${b.companyId}&refusal=none_selected`);
  });

  it('is a 404 for a form that is not one of these', async () => {
    const res = await continueGET(new Request(`http://localhost/payroll/statutory-forms/event/continue?form=my.cp39&employmentId=${leaverId}`));
    expect(res.status).toBe(404);
  });
});

describe('r413 · CP22 moved onto the screen and its document did not change', () => {
  /**
   * THE BYTES. The same record through main@f62d68f3's renderer and through this branch's must be the same
   * file (creation/modification dates normalised — pdf-lib stamps the clock). main's renderer is read out of
   * git into node_modules/.cache, where pdf-lib resolves, and imported as it stood.
   * NON-VACUITY: change CP22_DEFAULT_FONT_SIZE in lib/cp22-fields.ts to 8.5 and this fails.
   */
  it('renders the joiner’s CP22 byte-identically to the baseline renderer', async () => {
    const dir = path.join(ROOT, 'node_modules', '.cache', `r413-cp22-baseline-${process.pid}`, 'lib');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cp22-pdf.ts'), atBaseline('lib/cp22-pdf.ts'));
    fs.writeFileSync(path.join(dir, 'cp22-fields.ts'), atBaseline('lib/cp22-fields.ts'));
    try {
      const baseline = (await import(path.join(dir, 'cp22-pdf.ts'))) as typeof import('../lib/cp22-pdf');
      const data = (await cp22Particulars(adminCtx(b), { employmentId: joinerId, today: TODAY }))!;
      expect(data).not.toBeNull();
      const template = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public', 'forms', 'cp22-pin-1-2021.pdf')));
      const [now, then] = await Promise.all([renderCp22Pdf(template, data), baseline.renderCp22Pdf(template, data)]);
      const [a, z] = [await stable(now), await stable(then)];
      expect(a.length).toBeGreaterThan(100_000);
      expect(a === z).toBe(true);
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it('reads the record with the baseline’s own `cp22Particulars` — the slice is found, long and identical', () => {
    const slice = (src: string) => {
      const start = src.indexOf('export function cp22Particulars(');
      const end = src.indexOf('\n}\n', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return src.slice(start, end);
    };
    const now = slice(fs.readFileSync(path.join(ROOT, 'core/reporting.ts'), 'utf8'));
    const then = slice(atBaseline('core/reporting.ts'));
    expect(now.length).toBeGreaterThan(5000);
    expect(now).toBe(then);
  });

  it('leaves the CP22 review screen, its routes and its renderer byte-identical to the baseline', () => {
    for (const f of [
      'lib/cp22-pdf.ts',
      'lib/cp22-fields.ts',
      'lib/cp22-review.ts',
      'lib/cp22-template.ts',
      'app/payroll/cp22/[employmentId]/preview/page.tsx',
      'app/payroll/cp22/[employmentId]/pdf/route.ts',
      'app/payroll/cp22/[employmentId]/text/route.ts',
      'public/forms/cp22-pin-1-2021.pdf',
    ]) {
      expect(fs.readFileSync(path.join(ROOT, f), 'latin1') === execFileSync('git', ['show', `${BASELINE}:${f}`], { cwd: ROOT, encoding: 'latin1' }), f).toBe(true);
    }
  });
});

describe('r413 · the CP22A preview page', () => {
  /** NON-VACUITY: delete `|| !scopeIds.includes(particulars.companyId)` from the page and this renders. */
  it('is a real 404 for another company’s leaver, and renders the viewer for its own', async () => {
    const [fc] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Foreign Sdn Bhd', country: 'MY' })
      .returning({ id: schema.company.id });
    const props = () => ({ params: Promise.resolve({ employmentId: leaverId }), searchParams: Promise.resolve({ a6: 'compulsory' }) });
    scope = { s: adminCtx(b), scopeIds: [fc.id] };
    expect(await thrown(Cp22aPreviewPage(props()))).toBe('NEXT_NOT_FOUND');
    scope = { s: adminCtx(b), scopeIds: [b.companyId] };
    const html = renderToStaticMarkup(await Cp22aPreviewPage(props()));
    expect(html).toContain('data-statutory-pdf-viewer');
    expect(html).toContain('aspect-[612/792]');
    // The typed answer rides into the frame and the download.
    expect(html).toContain(`/payroll/cp22a/${leaverId}/pdf?a6=compulsory&amp;inline=1`);
    expect(html).toContain('data-cp22a-blanks');
  });

  it('page and PDF route both run the company-scope check (source guard; slice found and long)', () => {
    for (const f of ['app/payroll/cp22a/[employmentId]/preview/page.tsx', 'app/payroll/cp22a/[employmentId]/pdf/route.ts']) {
      const src = code(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      expect(src.length, f).toBeGreaterThan(800);
      expect(src, f).toMatch(/scopeIds\.includes\(particulars\.companyId\)/);
      expect(src, f).toContain('scopedAdmin()');
    }
  });
});

describe('r413 · the catalog', () => {
  it('CP22A left MY_PLANNED_FORMS and joined MY_STATUTORY_LINKS at the same shelf position', () => {
    expect(MY_PLANNED_FORMS.map((p) => p.id)).not.toContain('lhdn.cp22a');
    const cp22a = MY_STATUTORY_LINKS.find((l) => l.id === 'my.cp22a')!;
    expect(cp22a).toBeDefined();
    expect(cp22a.shelfOrder).toBe(10);
    expect(cp22a.fidelity).toBe('official');
    expect(cp22a.event).toEqual({ form: 'CP22A', previewPath: '/payroll/cp22a/{employmentId}/preview' });
    expect(MY_STATUTORY_LINKS.find((l) => l.id === 'my.cp22')!.event).toEqual({
      form: 'CP22',
      previewPath: '/payroll/cp22/{employmentId}/preview',
    });
    // r415 — CP21 [Pin.1/2025] joined as the third (test/r415-cp21-particulars.test.ts pins its entry).
    expect(MY_OFFICIAL_ARTWORK.map((o) => o.id)).toEqual(['my.cp22', 'my.cp22a', 'my.cp21']);
  });
});
