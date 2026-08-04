/**
 * 38f1fd40 — the Entitlement step's Adjustments sub-step is removed, and Run Earned Accrual is re-homed.
 *
 * THE TRAP THIS EXISTS FOR. The sub-step held TWO tools, and the ticket only named one. Besides the
 * One-Off / Festive Leave Grant it also hosted **Run Earned Accrual** — the button that generates earned
 * leave days for a leave year — parked there because it was treated as an entitlement adjustment. After
 * 962077a8 cleared the page header, that sub-step became its ONLY reachable mount. Deleting the sub-step
 * as literally requested would have taken the only way to generate earned leave with it, silently: no
 * type error, no failing test, and a green render, because a slot that is never rendered looks exactly
 * like a slot that has nothing to show. Same class as the trap 4b0e76ae hit.
 *
 * So this file asserts REACHABILITY, not merely existence — the r106 lesson: a service test passes
 * happily while nothing renders the button.
 *
 * The second guard here is the persisted-UI-state one, and it is the only regression in this change that
 * NOTHING else can see. `entitlementSubStep` lives in localStorage under `leaveTypeCards:<id>`. A browser
 * sitting on 'adjustments' when this ships would fail key validation and snap back to sub-step 1 with no
 * explanation. It is per-browser, so no test and no render can observe a user stranded by its absence —
 * only this assertion stands between them and that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** Comments are not code — r134/r135/r136 each produced a guard that failed against CORRECT code by
 *  matching a file's own prose. Strip commentary before asserting on structure. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

const PANEL = 'components/leave-type-panel.tsx';
const PAGE = 'app/admin/leave/entitlements/page.tsx';

describe('38f1fd40 — the Adjustments sub-step is gone', () => {
  it('the Entitlement step has exactly two sub-steps, and none of them is adjustments', () => {
    const src = stripComments(read(PANEL));
    expect(src).toContain("const ENTITLEMENT_SUB_STEP_KEYS = ['schemes', 'service'] as const;");
    // The render branch and the title-map entry must go with it, not merely the key list.
    expect(src).not.toContain("entitlementSubStep === 'adjustments'");
    expect(src).not.toContain("adjustments: 'entitlementStep.adjustments'");
  });

  it('RUN EARNED ACCRUAL IS STILL REACHABLE — mounted exactly once, inside the SERVICE sub-step', () => {
    const src = stripComments(read(PANEL));
    // Exactly once: a second mount would double-render the dialog; zero is the trap this file exists for.
    expect(src.split('{accrualSection}').length - 1, 'accrualSection must be rendered exactly once').toBe(1);
    // And it must sit in the SERVICE branch. Sliced from that branch's own guard to the end of the
    // Entitlement step, so a future edit that moves it back into a deleted branch fails here.
    const serviceAt = src.indexOf("entitlementSubStep === 'service'");
    const accrualAt = src.indexOf('{accrualSection}');
    expect(serviceAt, 'the service sub-step branch must exist').toBeGreaterThan(-1);
    expect(accrualAt, 'accrualSection must render after the service branch opens').toBeGreaterThan(serviceAt);
    // It rides beside the Preview Scenario tool, which is the home the plan chose.
    expect(src.indexOf('{previewScenarioSection}')).toBeGreaterThan(serviceAt);
    // The page still composes it and still passes it — a slot nobody supplies renders nothing.
    const page = stripComments(read(PAGE));
    expect(page).toContain('const accrualSection = (');
    expect(page).toContain('<EarnedAccrualDialog');
    expect(page).toContain('accrualSection={accrualSection}');
  });

  it('the page header is STILL clear — 962077a8 is not undone by re-homing the button', () => {
    // The header was deliberately emptied at the reporter's request. Putting the accrual button back
    // there would have been the easy fix and would have reverted a shipped decision.
    const page = stripComments(read(PAGE));
    const header = page.slice(page.indexOf('<PageHeader'), page.indexOf('/>', page.indexOf('actions={')));
    expect(header.length).toBeGreaterThan(30);
    expect(header).not.toContain('EarnedAccrualDialog');
  });

  it('A STORED SUB-STEP OF adjustments RESOLVES TO service — the invisible regression', () => {
    const src = stripComments(read(PANEL));
    // The retired-key constant must exist AND be wired into the remap. Either half alone is useless:
    // a constant nobody reads, or a remap with nothing to match.
    expect(src).toContain("const RETIRED_ADJUSTMENTS_SUB_STEP = 'adjustments';");
    expect(src).toContain('parsed.entitlementSubStep === RETIRED_ADJUSTMENTS_SUB_STEP');
    // The pre-existing retired key (bc9be1e8's 'policies') must survive alongside it — this change adds
    // a second retired key, it does not replace the first.
    expect(src).toContain("const RETIRED_COMPANY_ENTITLEMENTS_SUB_STEP = 'policies';");
    expect(src).toContain('parsed.entitlementSubStep === RETIRED_COMPANY_ENTITLEMENTS_SUB_STEP');
  });

  it('the festive grant tool and its whole service surface are gone', () => {
    expect(exists('components/festive-grant-card.tsx'), 'the card file must be deleted').toBe(false);
    for (const [rel, symbol] of [
      [PAGE, 'FestiveGrantCard'],
      [PAGE, 'festiveGrantSection'],
      [PANEL, 'festiveGrantSection'],
      ['core/admin.ts', 'export function listAdHocLeaveGrants'],
      ['core/leave.ts', 'export async function grantAdHocLeave'],
      ['core/leave.ts', 'export class AdHocLeaveGrantError'],
      ['app/admin/actions.ts', 'export async function grantAdHocLeaveAction'],
    ] as const) {
      expect(stripComments(read(rel)).includes(symbol), `${rel} still carries ${symbol}`).toBe(false);
    }
  });

  it('what the removal must NOT have taken with it', () => {
    const page = stripComments(read(PAGE));
    // festiveCompanies / canGroupWide feed EarnedAccrualDialog; companyNameById names benefit-scheme
    // companies. All three merely LOOK festive-grant-shaped and are consumed elsewhere.
    for (const kept of ['festiveCompanies', 'canGroupWide', 'companyNameById']) {
      expect(page.includes(kept), `${kept} must survive — it has another consumer`).toBe(true);
    }
  });

  it('locale keys: the retired ones go, the Leave Balance Summary line STAYS', () => {
    for (const loc of LOCALES) {
      const cat = JSON.parse(read(`messages/${loc}.json`));
      expect(cat.admin?.leave?.entitlementStep?.adjustments, `${loc}: the sub-step title must go`).toBeUndefined();
      expect(
        Object.keys(cat.admin?.leave ?? {}).filter((k) => k.startsWith('festive')),
        `${loc}: the festive key block must go`,
      ).toEqual([]);
      // A DIFFERENT reader that merely shares the word: the balance breakdown's Adjustments line.
      expect(cat.leave?.breakdown?.field?.adjustments, `${loc}: the balance line must survive`).toBeTruthy();
    }
  });
});
