/**
 * a1d82340 rev 3 — the TP1 self-relief bridge is REACHABLE.
 *
 * THE FAULT. `tp1_relief` is what an employee submits; `payroll_input.tp1_deduction` is what
 * generatePayslips actually reads. The only bridge between them is `prefillTp1FromSelfRelief`, exposed
 * as `prefillTp1Action` — and NO screen rendered that action. Five of the six prefill actions on the
 * batch screen had a button and this one did not, so an employee could submit their relief, HR could see
 * it on the relief screen, and it could never reach a payslip.
 *
 * r91 reported the symptom as "bound to no form", which was right in substance: the action existed and
 * was wired to the service, but nothing invoked it. The precise version is what makes it findable again.
 *
 * SOURCE-LEVEL, because the defect is one of REACHABILITY. A service test would have passed throughout —
 * the bridge works, and always did. What was missing was a caller, and the only honest assertion about a
 * missing caller is about the wiring.
 *
 * 7076f8af — THE SCREEN THIS GUARD WATCHES MOVED, AND THE GUARD MOVED WITH IT, UNWEAKENED. The six
 * bridges were extracted out of app/payroll/[batchId]/page.tsx into app/payroll/adjustments-panel.tsx,
 * a shared server component now rendered on the run flow's Review step and on a screen under
 * Transactions. Every assertion below is the same assertion; only the file it reads changed. Two were
 * ADDED rather than relaxed, because relocation introduces a failure the original could not have: a
 * panel that renders every button but that no page renders at all would have satisfied the old test
 * exactly as well as the real thing, so the panel's own two hosts are asserted too. This is the guard
 * that caught the relocation mid-build, which is the whole reason it exists.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PANEL = read('app/payroll/adjustments-panel.tsx');
const ACTIONS = read('app/payroll/actions.ts');
/** The two pages that render the panel. Neither may quietly stop doing so. */
const PANEL_HOSTS = ['app/payroll/process/page.tsx', 'app/payroll/transactions/adjustments/page.tsx'];

/** Every prefill action the adjustment panel offers. The point is that NONE is orphaned. */
const PREFILL_ACTIONS = [
  'prefillOvertimeAction',
  'prefillShiftDifferentialAction',
  'prefillClaimsAction',
  'prefillLoansAction',
  'prefillTp1Action',
  'prefillFixedZakatAction',
];

describe('no prefill action is left unreachable', () => {
  it.each(PREFILL_ACTIONS)('%s is exported by the actions module', (name) => {
    expect(ACTIONS).toContain(`export async function ${name}(`);
  });

  // The assertion that would have caught this on the day it shipped.
  it.each(PREFILL_ACTIONS)('%s is rendered by the adjustment panel', (name) => {
    expect(PANEL, `${name} exists but no screen invokes it`).toContain(`action={${name}}`);
  });

  // …and the panel itself is rendered. A panel nobody mounts is an orphaned bridge with extra steps.
  it.each(PANEL_HOSTS)('%s renders the adjustment panel', (host) => {
    expect(read(host), `${host} no longer mounts the adjustment panel`).toContain('<PayrollAdjustmentsPanel');
  });
});

describe('the TP1 bridge specifically', () => {
  it('connects tp1_relief to the payroll input the payslip reads', () => {
    expect(ACTIONS).toContain('prefillTp1FromSelfRelief(s, { batchId })');
  });

  // Regular runs only, like the loan reservation: an additional/off-cycle run pays its bonus and does
  // not carry the month's declared reliefs, so offering the button there would invite a double-count.
  it('is offered on regular runs only', () => {
    const i = PANEL.indexOf('action={prefillTp1Action}');
    expect(i).toBeGreaterThan(0);
    const before = PANEL.slice(Math.max(0, i - 700), i);
    expect(before).toContain('isRegular &&');
  });

  it('has a label in all six catalogs', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      expect(read(`messages/${loc}.json`), `${loc} missing prefillTp1`).toContain('"prefillTp1"');
    }
  });
});
