/**
 * Feedback 956cec85 — the Statutory Forms home, and what it is deliberately NOT.
 *
 * THE FORMS WERE ALREADY BUILT. localization/my/reports.ts has registered EPF (KWSP), SOCSO + EIS
 * (PERKESO), CP39/PCB (LHDN) and Form E/CP8D for some time; each already lists employee name, IC,
 * agency number, gross, the employee/employer split and totals, and already flags employees MISSING an
 * agency number instead of quietly dropping them from a submission. The EA form exists too. They were
 * live on Payroll > Reports for every one of this tenant's companies.
 *
 * What the reporter asked for — "a new submenu called Statutory Form ... a centralized location" — is a
 * HOME for them. So the page is a directory, and these assertions pin that: it must not grow a second
 * generator for figures the pack already produces, which is the duplication 241817ef spent two rounds
 * undoing.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MY_REPORTS } from '../localization/my/reports';
import { payrollPack } from '../packs/payroll';
import { PAYROLL_NAV_PHASE } from '../packs/payroll/phases';

const ROOT = path.resolve(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'app/payroll/statutory-forms/page.tsx'), 'utf8');
const byId = new Map(MY_REPORTS.map((r) => [r.id, r]));

describe('the pack declares where each form is filed, and by when', () => {
  // Sourced from the reporter's own answer (block_trail, resolved 2026-07-30), not invented. This test
  // is what stops a later edit "tidying" a portal name into something nobody actually submits through.
  it.each([
    ['my.epf', 'EPF (KWSP)', 'i-Akaun (Employer)', 15],
    ['my.socso-eis', 'PERKESO', 'PERKESO ASSIST', 15],
    ['my.cp39', 'LHDN', 'e-PCB / e-Data PCB / e-CP39', 15],
  ])('%s files to %s via %s by day %i of the following month', (id, agency, channel, day) => {
    const sub = byId.get(id as string)?.submission;
    expect(sub?.agency).toBe(agency);
    expect(sub?.channel).toBe(channel);
    expect(sub?.dueDayOfNextMonth).toBe(day);
  });

  // An invented statutory deadline is worse than an absent one: somebody files against it.
  it('leaves the annual Form E deadline unset, because it was never stated', () => {
    expect(byId.get('my.cp8d')?.submission?.dueDayOfNextMonth).toBeNull();
    expect(byId.get('my.cp8d')?.submission?.agency).toBe('LHDN');
  });

  // The overview reconciles; it is not filed anywhere. Absence of `submission` is how the screen knows.
  it('marks the contributions overview as NOT a submission', () => {
    expect(byId.get('my.contributions')?.submission).toBeUndefined();
  });
});

describe('the Statutory Forms page is a directory, not a second generator', () => {
  it('renders only pack entries that are submissions', () => {
    expect(PAGE).toContain('all.filter((r) => r.submission != null)');
  });

  it('links to the existing preview instead of generating anything itself', () => {
    expect(PAGE).toContain('/payroll/reports?companyId=');
    // The tell-tales of a second implementation. None of these belong on a directory page.
    for (const forbidden of ['reportPreview(', 'recordReport(', 'generate(', 'payslip']) {
      expect(PAGE, `page should not itself ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('reads "today" in MYT, so a deadline does not flip a day early overnight', () => {
    expect(PAGE).toContain('todayInKualaLumpur()');
    expect(PAGE).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  });
});

describe('the menu row the reporter actually asked for', () => {
  const NODE = payrollPack.navNodes!.find((n) => n.group === 'admin')!;

  it('exists, and sits after Reports — filing is the last thing you do with a month', () => {
    const hrefs = NODE.children.map((c) => c.href);
    expect(hrefs).toContain('/payroll/statutory-forms');
    expect(hrefs.indexOf('/payroll/statutory-forms')).toBeGreaterThan(hrefs.indexOf('/payroll/reports'));
  });

  // r91's design: a row is placed by declaring a rank, never by splicing it into the literal list.
  it('is placed by a declared rank rather than by its position in the source', () => {
    expect(PAYROLL_NAV_PHASE['/payroll/statutory-forms']).toBeGreaterThan(PAYROLL_NAV_PHASE['/payroll/reports']);
  });
});
