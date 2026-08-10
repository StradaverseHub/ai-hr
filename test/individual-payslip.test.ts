/**
 * Feedback 169e3c24 — Individual Payslip: the admin review screen, its PDF, and the PCB drill-down.
 *
 * REPRODUCE-FIRST FINDING: adjacent screen. The itemised admin breakdown already shipped on Transaction
 * View → History; the entry point, print/PDF before release, YTD and any explanation of the tax figure
 * did not. So the assertions here are about the three things that are genuinely new, and about the ONE
 * thing that must not have changed:
 *
 *   THE ESS RELEASE GATE. `payslipDetail` must still return null for a processed-but-unreleased payslip.
 *   The test proves it on the SAME payslip id the admin read returns, which is the only formulation that
 *   can catch "the gate was widened to let the admin screen work".
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips, payslipDetail } from '../core/payroll';
import {
  currentPcbReliefs,
  listProcessedPayslipsAcross,
  payslipForReview,
  sumPayslipYtd,
} from '../core/payroll-view';
import { explainPcb, type PcbReliefBreakdown } from '../core/pcb-explain';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ───────────────────────────── Pure: the PCB explainer ─────────────────────────────

const CURRENT: PcbReliefBreakdown = {
  individual: 9000, spouse: 0, children: 4000, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 13000,
};

describe('169e3c24 — explaining the PCB figure from what the payslip recorded', () => {
  it('says so plainly when no working was recorded (imported / pre-stamp run)', () => {
    expect(explainPcb({ pcb: 350 }, CURRENT)).toEqual({ kind: 'unavailable', pcb: 350 });
    expect(explainPcb({ pcb: 350, pcbMeta: {} }, CURRENT).kind).toBe('unavailable');
  });

  it('reports the FLAT rate for a non-resident instead of an empty relief table', () => {
    // A flat-rate employee has no reliefs at all. Rendering an empty relief working would read as a gap;
    // it is the correct answer.
    const r = explainPcb({ pcb: 1500, pcbMeta: { nonResident: true, flatRate: 0.3, rate: 0.3 } }, CURRENT);
    expect(r).toEqual({ kind: 'flat', rate: 0.3, nonResident: true, pcb: 1500 });
  });

  it('reports the REP / knowledge-worker incentive rate as flat but NOT non-resident', () => {
    const r = explainPcb({ pcb: 750, pcbMeta: { nonResident: false, flatRate: 0.15, rate: 0.15 } }, CURRENT);
    expect(r).toEqual({ kind: 'flat', rate: 0.15, nonResident: false, pcb: 750 });
  });

  it('reads the payslip’s OWN relief working when it has one', () => {
    const r = explainPcb(
      {
        pcb: 300,
        pcbBonus: 40,
        epfEmployee: 550,
        zakat: 0,
        pcbMeta: {
          month: 7, n: 5, ytdNet: 30000, epfClaimed: 3300, pcbPaid: 1800, P1: 41000, P2: 46000,
          reliefs: { individual: 9000, spouse: 4000, children: 2000, disabledIndividual: 0, disabledSpouse: 0, lp: 120, total: 15000 },
        },
      },
      CURRENT,
    );
    expect(r.kind).toBe('mtd');
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.reliefSource).toBe('snapshot');
    expect(r.reliefs.spouse).toBe(4000); // the run's own position, NOT the CURRENT fixture's 0
    expect(r.reliefs.total).toBe(15000);
    expect(r.chargeableIncome).toBe(41000);
    expect(r.chargeableIncomeWithAdditional).toBe(46000);
    // The split is derived by subtraction from the payslip's own figures, never recomputed, so the panel
    // cannot disagree with the total it explains.
    expect(r.pcbAdditional).toBe(40);
    expect(r.pcbNormal).toBe(260);
    expect(r.pcbNormal + r.pcbAdditional).toBeCloseTo(r.pcb, 2);
  });

  it('falls back to the employee’s CURRENT position for a pre-snapshot run, and SAYS so', () => {
    // This is the case the plan flagged: an employee who has since married or had a child would otherwise
    // see a closed month explained with a relief position that did not exist when it was calculated.
    const r = explainPcb(
      { pcb: 300, lp: 90, pcbMeta: { month: 3, n: 9, ytdNet: 12000, epfClaimed: 1100, pcbPaid: 600, P1: 39000 } },
      CURRENT,
    );
    expect(r.kind).toBe('mtd');
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.reliefSource, 'a silent fallback is the failure this names').toBe('current');
    expect(r.reliefs.total).toBe(13000);
    expect(r.chargeableIncomeWithAdditional).toBeNull();
  });

  it('degrades to zeros rather than throwing when the current position cannot be resolved', () => {
    const r = explainPcb({ pcb: 300, lp: 90, pcbMeta: { month: 3, n: 9, P1: 39000 } }, null);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.reliefSource).toBe('current');
    expect(r.reliefs.total).toBe(0);
    expect(r.reliefs.lp).toBe(90); // still read off the blob, which HAS it
  });
});

describe('5c198931 — the year-to-date column is summed in ONE place', () => {
  // The screen ran this reduce inline and the downloaded payslip carried no YTD at all. Now three
  // surfaces print it, so the arithmetic lives in core/payroll-view.ts and each caller supplies the rows
  // its own fence allows. These assertions pin the arithmetic; the fences are tested further down.
  const rows = [
    { gross: '5000.00', net: '4200.00', statutory: { epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 120 } },
    { gross: '5000.00', net: '4200.00', statutory: { epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 120 } },
  ];

  it('sums the six figures the payslip prints, over the rows it is given', () => {
    expect(sumPayslipYtd(rows)).toEqual({ gross: 10000, epf: 1100, socso: 49.5, eis: 19.8, pcb: 240, net: 8400 });
  });

  it('treats a missing statutory key as zero rather than NaN', () => {
    // A payslip from an older run carries a thinner blob. `Number(undefined)` is NaN, and one NaN would
    // turn a whole column into "—" on a document the employee is meant to reconcile against.
    const thin = sumPayslipYtd([
      { gross: '1000.00', net: '900.00', statutory: {} },
      { gross: '1000.00', net: '900.00', statutory: null },
    ]);
    expect(thin).toEqual({ gross: 2000, epf: 0, socso: 0, eis: 0, pcb: 0, net: 1800 });
    expect(Object.values(thin).every(Number.isFinite)).toBe(true);
  });

  it('an empty year is zeros, not an empty object', () => {
    expect(sumPayslipYtd([])).toEqual({ gross: 0, epf: 0, socso: 0, eis: 0, pcb: 0, net: 0 });
  });
});

// ───────────────────────────── Structural: the gate, the nav, the ratchet ─────────────────────────────

describe('169e3c24 — the ESS release gate is not weakened, and no logo is invented', () => {
  it('the new PDF route does NOT read through payslipDetail', () => {
    const route = read('app/payroll/individual-payslip/[payslipId]/pdf/route.ts');
    // The IMPORTS, not the prose — the file's header explains at length why it must not call payslipDetail,
    // and a naive substring check would fail on its own explanation.
    const imports = route.split('\n').filter((l) => l.trimStart().startsWith('import '));
    expect(imports.join('\n'), 'payslipDetail carries the ESS release gate; the admin route must not import it')
      .not.toContain('payslipDetail');
    expect(route).toContain('payslipForReview');
    expect(route, 'admin + company scope fence').toContain('scopedAdmin');
  });

  it('the ESS route and payslipDetail keep the gate exactly as they had it', () => {
    expect(read('app/me/payslip/[payslipId]/pdf/route.ts')).toContain('payslipDetail');
    const core = read('core/payroll.ts');
    expect(core).toContain("const released = row.status === 'closed'");
    expect(core).toContain('if (!released) return null;');
  });

  it('renders the company’s OWN logo, conditionally, and still builds no logo storage of its own', () => {
    // THIS GUARD CHANGED SIDES IN r168a, AND THE HISTORY MATTERS BECAUSE IT IS WHY IT WAS EVER WRITTEN.
    //
    // 169e3c24's plan asserted "no company logo exists anywhere in the system today". That was already
    // false when it shipped — a `company_logo` bytea side table existed — so this guard was written to
    // pin the ABSENCE and to record that the absence was now a promise to the reporter rather than a
    // technical limit: the plan had told them it would ship without one, and adding it quietly to a
    // document people file would have been a change nobody approved.
    //
    // da4af51f is that approval. So the guard is UPDATED to the new truth rather than deleted — deleting
    // it would drop the half that never expired, which is that this screen must not grow a logo upload,
    // a second copy of the bytes, or storage of its own. It reads what Organization already owns.
    const page = read('app/payroll/individual-payslip/page.tsx');
    const codeOnly = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // (a) STILL no upload, no writer, no second store. The header explains the history at length, so this
    //     is asserted against the code with comments stripped or it fails on its own explanation.
    expect(codeOnly, 'the payslip screen must not upload or write a logo').not.toMatch(
      /uploadLogo|setCompanyLogo|removeCompanyLogo|getCompanyLogo/,
    );

    // (b) It renders the logo through the EXISTING serve route, so the payslip cannot show a different
    //     mark from the rest of the product, and no new endpoint appears for one screen.
    expect(codeOnly, 'the letterhead renders a logo now').toMatch(/<img/);
    expect(codeOnly).toContain('/admin/organization/logo/');

    // (c) CONDITIONALLY. `hasLogo` comes from listCompanies (an EXISTS against the side table, never the
    //     blob). An <img> rendered unconditionally 404s into a broken-image icon on a payslip, which is
    //     worse than the clean text letterhead this used to have — so the condition IS the feature.
    expect(codeOnly).toContain('hasLogo');
    expect(codeOnly).toMatch(/companyHasLogo\s*&&/);
  });

  it('the pack-drift allowlist did not GROW (a ratchet may only shrink)', () => {
    // app/payroll/ is in ALWAYS_ALLOWED, so the new route imports core/payroll-view directly, exactly as
    // transaction-view already does, and needs no entry.
    const drift = read('test/payroll-pack-drift.test.ts');
    expect(drift).toContain("'app/payroll/', //");
    expect(drift).not.toContain('individual-payslip');
  });

  it('the nav row, its rank and its label key are all declared', () => {
    expect(read('packs/payroll/index.ts')).toContain("href: '/payroll/individual-payslip'");
    expect(read('packs/payroll/phases.ts')).toContain("'/payroll/individual-payslip': 5");
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as { nav: Record<string, string>; payroll: Record<string, Record<string, string>> };
      expect(m.nav.payrollIndividualPayslip, `nav.payrollIndividualPayslip in ${loc}`).toBeTruthy();
      const blk = m.payroll.individualPayslip;
      expect(blk, `payroll.individualPayslip in ${loc}`).toBeTruthy();
      // The screen resolves several COMPUTED keys, which the repo's i18n coverage guard cannot see
      // (check C only matches literal keys), so they are pinned here.
      for (const k of [
        'state_draft', 'state_unpublished', 'state_scheduled', 'state_published',
        'employmentType_full_time', 'employmentType_part_time', 'employmentType_contract', 'employmentType_intern',
        'paymentMethod_bank_transfer', 'paymentMethod_cheque', 'paymentMethod_cash',
      ]) {
        expect(blk[k], `payroll.individualPayslip.${k} in ${loc}`).toBeTruthy();
      }
    }
  });

  it('every locale carries the same key set for the new screen (no half-translated block)', () => {
    const keysOf = (loc: string) =>
      Object.keys(
        (JSON.parse(read(`messages/${loc}.json`)) as { payroll: Record<string, Record<string, string>> })
          .payroll.individualPayslip,
      ).sort();
    const en = keysOf('en');
    for (const loc of ['ms', 'ta', 'th', 'vi', 'zh']) expect(keysOf(loc), loc).toEqual(en);
  });
});

describe('5c198931 — one document, printed by both routes', () => {
  const ESS = 'app/me/payslip/[payslipId]/pdf/route.ts';
  const ADMIN = 'app/payroll/individual-payslip/[payslipId]/pdf/route.ts';

  it('both PDF routes resolve their labels from the SAME module', () => {
    // The two routes each hand-assembled a label object. The redesign takes that object past forty
    // fields, and two hand-maintained copies is precisely how the employee's payslip stops being the
    // document the reviewer approved — the failure this board item was raised about.
    for (const f of [ESS, ADMIN]) {
      const route = read(f);
      expect(route, `${f} must resolve labels through the shared module`).toContain('payslipPdfStrings');
      expect(route).toContain('buildPayslipPdfData');
      expect(route).toContain('renderPayslipPdf');
    }
  });

  it('both print the year-to-date column through the shared summation', () => {
    expect(read(ESS)).toContain('sumPayslipYtd');
    expect(read(ADMIN)).toContain('sumPayslipYtd');
    // …and the EMPLOYEE's own copy sums only RELEASED months. An employee must not read a year total
    // containing a run they cannot open; a reviewer legitimately may.
    expect(read(ESS)).toMatch(/r\.released/);
  });

  it('payslipDetail’s new joins are LEFT joins, every one of them', () => {
    // THE ONE REAL RISK IN WIDENING THIS READ. An employee with no current assignment, no grade or no
    // Malaysian statutory row would lose their payslip entirely behind an inner join — a 404 on their own
    // pay, caused by a presentation change.
    const core = read('core/payroll.ts');
    const from = core.indexOf('export function payslipDetail');
    const body = core.slice(from, core.indexOf('export function', from + 10));
    for (const j of ['assignment', 'department', 'position', 'jobGrade', 'employeeStatutoryMy']) {
      expect(body, `${j} must be joined LEFT in payslipDetail`).toMatch(new RegExp(`leftJoin\\(\\s*${j}\\b`));
    }
    expect(body).not.toMatch(/innerJoin\(\s*(assignment|department|position|jobGrade|employeeStatutoryMy)\b/);
  });

  it('the renderer refuses a PNG it cannot trust BEFORE pdf-lib is handed it', () => {
    // pdf-lib's embedPng SPINS rather than throwing on a signature-valid, body-corrupt PNG, and the logo
    // upload validates on magic bytes alone — so such a file is storable and would hang every payslip
    // download for that company. test/payslip-pdf.test.ts carries the behavioural proof.
    const lib = read('lib/payslip-pdf.ts');
    expect(lib).toMatch(/pngIsWellFormed\(logo\.bytes\)\s*\?\s*await doc\.embedPng/);
  });
});

describe('f35f758a — the screen: one search field, cards, and a preview of the REAL file', () => {
  const PAGE = 'app/payroll/individual-payslip/page.tsx';
  const ROUTE = 'app/payroll/individual-payslip/[payslipId]/pdf/route.ts';
  const ESS_PAGE = 'app/me/payslip/[payslipId]/page.tsx';
  /** Comments stripped, for the same reason the logo guard strips them: this file's own prose explains
   *  what was REMOVED, and a naive substring check would fail on the explanation. */
  const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('the employee control is the SHARED search field, inside the filter form, posting employmentId', () => {
    // THREE THINGS, not one — a source guard after an extraction has to prove all of them or it proves
    // nothing: the field exists in the shared component, the page renders that component, and it renders
    // it in the mode that actually posts (a hidden input named employmentId inside the GET form).
    const shared = read('components/employee-search-field.tsx');
    expect(shared, 'the committed selection posts through a hidden input named by the caller').toMatch(
      /<input\s+type="hidden"\s+name=\{name\}/,
    );

    const page = code(PAGE);
    expect(page, 'the screen must use the shared field, not a second control of its own').toContain(
      'EmployeeSearchField',
    );
    expect(page).toMatch(/name="employmentId"/);
    // The field sits INSIDE the GET form, which is what makes its hidden input ride the submit. Sliced
    // between the form open and close rather than searched page-wide.
    const formStart = page.indexOf('<form method="GET"');
    const formEnd = page.indexOf('</form>', formStart);
    expect(formStart, 'the filter form must still be a GET form').toBeGreaterThan(-1);
    expect(formEnd, 'the form slice must not invert — an inverted slice is an empty string that passes')
      .toBeGreaterThan(formStart);
    const form = page.slice(formStart, formEnd);
    expect(form).toContain('EmployeeSearchField');
    expect(form).toContain('viewPayslip'); // the button that runs the filter
  });

  it('the left-hand panel is gone from this screen, cookie and all', () => {
    const page = code(PAGE);
    expect(page).not.toContain('CollapsibleEmployeePanel');
    expect(page).not.toContain('EmployeeScopePanel');
    expect(page, 'the panel was this page’s only cookie reader').not.toContain('PAYSLIP_PANEL_COOKIE');
    // The scope guard the panel sat behind STAYS. Losing it while removing the panel is the regression
    // test/employee-scope-panel-guard.test.ts proves behaviourally; this is the cheap source half.
    expect(page).toMatch(/employees\.some\(\(e\) => e\.employmentId === sp\.employmentId\)/);
  });

  it('Preview frames the SAME route the Download button uses, inline', () => {
    const page = code(PAGE);
    expect(page, 'the preview must be the real file, not a print of the web page').toMatch(/<iframe/);
    expect(page).toContain('?inline=1');
    expect(page, 'the browser-print control is gone').not.toContain('PrintButton');

    const route = read(ROUTE);
    expect(route).toMatch(/inline[\s\S]*attachment|attachment[\s\S]*inline/);
    expect(route, 'a served document must not be sniffed into another type').toContain(
      "'X-Content-Type-Options': 'nosniff'",
    );
    // Nothing pinned Content-Disposition before f35f758a, so a later edit could have made the download
    // inline (or the preview an attachment) with no test noticing.
    expect(route).toMatch(/Content-Disposition['"]\]?:\s*`\$\{inline \? 'inline' : 'attachment'\}/);
    expect(route, 'the sortable period still names the file').toMatch(/payslip-\$\{p\.payPeriod\}/);
  });

  it('the month prints as a NAME on both screens, through the repo’s Intl idiom', () => {
    for (const f of [PAGE, ESS_PAGE]) {
      const src = code(f);
      expect(src, `${f} must format the period as a month name`).toMatch(
        /new Intl\.DateTimeFormat\([^)]*month: 'long'[^)]*timeZone: 'UTC'/,
      );
      expect(src, `${f} must not print the raw stored period`).toContain('monthYear(');
    }
    // And the DOCUMENT pins English, because its embedded font is Latin-1 (a Thai or Tamil month name
    // would print as question marks). The screens do not.
    expect(read('lib/payslip-pdf-strings.ts')).toMatch(/new Intl\.DateTimeFormat\('en',/);
  });

  it('the two internal sentences are off the document and off the EMPLOYEE screen, and stay on the HR one', () => {
    const lib = read('lib/payslip-pdf.ts');
    expect(lib, 'the renderer no longer has a prorated note to print').not.toContain('proratedNote');
    expect(lib).not.toContain('provenanceNote');
    // The renderer must also no longer be able to CLIP anything: `fit()` is what printed the ellipses.
    expect(lib, 'the hard-clipping helper is gone; long text wraps').not.toMatch(/const fit = \(/);

    const ess = code(ESS_PAGE);
    expect(ess, 'the employee’s copy no longer carries the prorated sentence').not.toContain('proratedNote');
    expect(ess, 'nor the ruleset sentence').not.toContain('provenanceFooter');

    // …and the HR-facing screen KEEPS it. That split is the plan's promise to the reporter: whoever is
    // checking a figure can still answer "why did my tax change when my pay did not?".
    expect(code(PAGE), 'the reviewer keeps the provenance line').toContain('provenanceFooter');
  });

  it('every new caption exists in all six catalogs', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const blk = (JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { individualPayslip: Record<string, string> };
      }).payroll.individualPayslip;
      for (const k of [
        'viewPayslip', 'previewDocument', 'previewHint',
        'searchPlaceholder', 'searchAriaLabel', 'searchResultsLabel', 'searchNoMatches', 'searchClear',
      ]) {
        expect(blk[k], `payroll.individualPayslip.${k} in ${loc}`).toBeTruthy();
        // A caption containing {braces} is ICU interpolation, and the page resolves these with a bare
        // t(...) — which would THROW at render and paint the key path on screen.
        expect(blk[k], `payroll.individualPayslip.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });
});

// ───────────────────────────── Behavioural: the admin read ─────────────────────────────

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

/** Hire one employee, fully configured. NO batch — a company+period holds exactly ONE payroll process,
 *  so the run is created once by `pay()` below rather than per employee. */
async function hire(name: string, email: string, ic: string, basic = 5000) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, {
    personId: e.personId,
    icNumber: ic,
    taxCategory: 2,
    numChildren: 2,
    bankName: 'Maybank',
    bankAccountNo: '512345678901',
  });
  return e;
}

/** Run one regular payroll for the whole company in `period`. */
async function pay(period: string) {
  const a = adminCtx(base);
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(a, { batchId });
  return batchId;
}

/** The one payslip this employee holds (after a single run). */
async function slipIdOf(employmentId: string) {
  const rows = await listProcessedPayslipsAcross(adminCtx(base), {
    companyIds: [base.companyId],
    employmentId,
  });
  return rows[0].id;
}

async function hireWithPayslip(name: string, email: string, ic: string, period = '2026-05', basic = 5000) {
  const e = await hire(name, email, ic, basic);
  await pay(period);
  return { ...e, payslipId: await slipIdOf(e.employmentId) };
}

describe('169e3c24 — the admin review read', () => {
  it('returns a processed-but-UNRELEASED payslip that ESS still refuses — the whole point of the screen', async () => {
    const a = adminCtx(base);
    const { payslipId } = await hireWithPayslip('Review Me', 'review.me@acme.test', '900101011401');

    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    expect(row, 'a reviewer must be able to see a run before it is released').not.toBeNull();
    expect(row!.batchStatus).not.toBe('closed');

    // The SAME id through the ESS read: still null, because the batch is not closed-and-released. If this
    // ever passes, the release gate was widened to make the admin screen work.
    expect(await payslipDetail(a, payslipId), 'the ESS release gate must be intact').toBeNull();
  });

  it('fails closed on an empty scope, and on a payslip outside the caller’s companies', async () => {
    const a = adminCtx(base);
    const { payslipId } = await hireWithPayslip('Fenced', 'fenced@acme.test', '900101011402');
    expect(await payslipForReview(a, { companyIds: [], payslipId })).toBeNull();
    // A real company id the caller does not hold ⇒ indistinguishable from "no such payslip".
    expect(
      await payslipForReview(a, { companyIds: ['00000000-0000-0000-0000-0000000000ff'], payslipId }),
    ).toBeNull();
  });

  it('masks the bank account and never returns the full number', async () => {
    const a = adminCtx(base);
    const { payslipId } = await hireWithPayslip('Masked', 'masked@acme.test', '900101011403');
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    expect(row!.bankAccountMasked).toBe('••••8901');
    expect(JSON.stringify(row), 'the full account number must not leave the server').not.toContain('512345678901');
  });

  it('reports the IC as the identity, and marks a passport as a passport', async () => {
    const a = adminCtx(base);
    const { payslipId } = await hireWithPayslip('Ident', 'ident@acme.test', '900101011404');
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    expect(row!.identityNumber).toBe('900101011404');
    expect(row!.identityIsPassport).toBe(false);
  });

  it('year-to-date sums ONLY the chosen employee’s months in the chosen year', async () => {
    const a = adminCtx(base);
    const me = await hire('Ytd Me', 'ytd.me@acme.test', '900101011405', 4000);
    const other = await hire('Ytd Other', 'ytd.other@acme.test', '900101011406', 9000);
    // Two months, both employees in each — one payroll process per company per period.
    await pay('2026-01');
    await pay('2026-02');

    const mine = await listProcessedPayslipsAcross(a, {
      companyIds: [base.companyId],
      year: 2026,
      employmentId: me.employmentId,
    });
    expect(mine.length).toBe(2);
    const gross = mine.reduce((s, r) => s + Number(r.gross), 0);
    expect(gross).toBeCloseTo(8000, 2);
    // …and nothing of the other employee's leaks in.
    expect(mine.some((r) => r.employmentId === other.employmentId)).toBe(false);

    // A different year returns nothing, so a YTD column cannot silently span years.
    expect(
      (await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], year: 2025, employmentId: me.employmentId })).length,
    ).toBe(0);
  });

  it('records the relief working on a fresh run, so the tax panel explains itself', async () => {
    const a = adminCtx(base);
    const { payslipId, employmentId } = await hireWithPayslip('Reliefs', 'reliefs@acme.test', '900101011407');
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    const fallback = await currentPcbReliefs(a, { companyIds: [base.companyId], employmentId, asOf: '2026-05-28' });
    const x = explainPcb(row!.statutory, fallback);
    expect(x.kind).toBe('mtd');
    if (x.kind !== 'mtd') throw new Error('unreachable');
    expect(x.reliefSource, 'a run calculated now records its own relief position').toBe('snapshot');
    // Category 2 with two children: individual + spouse + 2 × perChild, all from the ruleset that ran.
    expect(x.reliefs.individual).toBeGreaterThan(0);
    expect(x.reliefs.spouse).toBeGreaterThan(0);
    expect(x.reliefs.children).toBeGreaterThan(0);
    expect(x.reliefs.total).toBeCloseTo(
      x.reliefs.individual + x.reliefs.spouse + x.reliefs.children + x.reliefs.disabledIndividual + x.reliefs.disabledSpouse,
      2,
    );
  });

  it('the CURRENT-position fallback resolves the same shape from today’s settings', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hireWithPayslip('Fallback', 'fallback@acme.test', '900101011408');
    const r = await currentPcbReliefs(a, { companyIds: [base.companyId], employmentId, asOf: '2026-05-28' });
    expect(r).not.toBeNull();
    expect(r!.individual).toBeGreaterThan(0);
    expect(r!.spouse).toBeGreaterThan(0); // taxCategory 2
    expect(r!.total).toBeCloseTo(r!.individual + r!.spouse + r!.children + r!.disabledIndividual + r!.disabledSpouse, 2);
    // Fails closed on no scope, like every read in that file.
    expect(await currentPcbReliefs(a, { companyIds: [], employmentId, asOf: '2026-05-28' })).toBeNull();
  });
});


describe('5c198931 — the employee’s own payslip is the SAME document as the reviewer’s', () => {
  /** Hire with NO Malaysian statutory row at all — the LEFT-join case. */
  async function hireBare(name: string, email: string) {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 4000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    return e;
  }

  it('the admin read returns the three statutory registration numbers the document prints', async () => {
    const a = adminCtx(base);
    const e = await hire('Numbers', 'numbers@acme.test', '900101011501');
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101011501',
      epfNumber: '12345678',
      socsoNumber: '900101011501',
      taxNumber: 'SG1234567890',
    });
    await pay('2026-06');
    const row = await payslipForReview(a, {
      companyIds: [base.companyId],
      payslipId: await slipIdOf(e.employmentId),
    });
    expect(row!.epfNumber).toBe('12345678');
    expect(row!.socsoNumber).toBe('900101011501');
    expect(row!.taxNumber).toBe('SG1234567890');
  });

  it('payslipDetail carries the widened context once released, and STILL masks the bank account', async () => {
    const a = adminCtx(base);
    const e = await hire('Widened', 'widened@acme.test', '900101011502');
    const batchId = await pay('2026-06');
    const payslipId = await slipIdOf(e.employmentId);

    // Before release the gate still refuses it — widening the SELECT did not widen who may read the row.
    expect(await payslipDetail(a, payslipId), 'the ESS release gate must be intact').toBeNull();
    await closeBatch(a, { batchId });

    const p = await payslipDetail(a, payslipId);
    expect(p, 'a released payslip is readable').not.toBeNull();
    expect(p!.employmentId).toBe(e.employmentId);
    expect(p!.currency, 'the document labels amounts with the company’s own currency').toBeTruthy();
    expect(p!.payDate, 'the payment date the old download never printed').toBeTruthy();
    expect(p!.identityNumber).toBe('900101011502');
    expect(p!.identityIsPassport).toBe(false);
    expect(p!.department).toBeTruthy();
    // Masked in the READ, exactly as payslipForReview masks it: the full number must not leave the
    // server even to the account holder's own browser.
    expect(p!.bankAccountMasked).toBe('••••8901');
    expect(JSON.stringify(p), 'the full account number must not leave the server').not.toContain('512345678901');
  });

  it('an employee with NO Malaysian statutory row still gets their payslip', async () => {
    // The LEFT-join guarantee, behaviourally. An inner join onto employee_statutory_my would 404 this
    // employee's own pay because of a presentation change — the single real risk in widening the read.
    const a = adminCtx(base);
    const e = await hireBare('No Statutory', 'no.statutory@acme.test');
    const batchId = await pay('2026-06');
    const payslipId = await slipIdOf(e.employmentId);

    const review = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    expect(review, 'the reviewer still sees the payslip').not.toBeNull();
    expect(review!.identityNumber).toBeNull();
    expect(review!.epfNumber).toBeNull();

    await closeBatch(a, { batchId });
    const p = await payslipDetail(a, payslipId);
    expect(p, 'and so does the employee').not.toBeNull();
    expect(p!.identityNumber).toBeNull();
    expect(p!.bankAccountMasked).toBeNull();
  });
});
