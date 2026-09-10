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

/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2). The panel became three files, so what this guard reads is
 * their concatenation — the property it pins is about the leave TYPE screen, not about one filename, and
 * pinning it to a file that no longer exists would have taken the guard out rather than moved it.
 */
const PANEL_FILES = ['app/admin/leave-config/types/page.tsx', 'app/admin/leave-config/types/leave-type-tabs.tsx', 'app/admin/leave-config/types/leave-type-sub-forms.tsx'];
const PAGE = 'app/admin/leave-config/types/page.tsx';

describe('38f1fd40 — the Adjustments sub-step is gone', () => {
  // 6e9a126e RELEASE THREE — the Entitlement step no longer HAS sub-steps. It is a pointer to Entitlement
  // Tables plus Run Earned Accrual, so ENTITLEMENT_SUB_STEP_KEYS is gone with the sub-flow. Asserting the
  // shape of a bar that does not render would be asserting an implementation that no longer exists.


  // 6e9a126e RELEASE THREE — Run Earned Accrual is still reachable and still mounted exactly once, but no
  // longer 'inside the SERVICE sub-step' because that sub-step is gone with the Entitlement sub-flow.
  // Pinning it to a removed branch would pin the wrong thing.

  it('the page header is STILL clear — 962077a8 is not undone by re-homing the button', () => {
    // The header was deliberately emptied at the reporter's request. Putting the accrual button back
    // there would have been the easy fix and would have reverted a shipped decision.
    const page = stripComments(read(PAGE));
    const header = page.slice(page.indexOf('<PageHeader'), page.indexOf('/>', page.indexOf('actions={')));
    expect(header.length).toBeGreaterThan(30);
    expect(header).not.toContain('EarnedAccrualDialog');
  });

  // 6e9a126e RELEASE THREE — RETIRED_ADJUSTMENTS_SUB_STEP migrated a stored 'adjustments' onto 'service'.
  // Both are gone: the Entitlement step persists no sub-step at all now, so a stored value is ignored
  // wholesale rather than remapped. There is no invisible regression left to guard.

  it('the festive grant tool and its whole service surface are gone', () => {
    expect(exists('components/festive-grant-card.tsx'), 'the card file must be deleted').toBe(false);
    for (const [rel, symbol] of [
      [PAGE, 'FestiveGrantCard'],
      [PAGE, 'festiveGrantSection'],
      ...PANEL_FILES.map((f) => [f, 'festiveGrantSection'] as const),
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
    // 6e9a126e RELEASE THREE — NARROWED FROM THREE SYMBOLS TO TWO, and the reason is in this test's
    // OWN comment above: companyNameById "names benefit-scheme companies". Release three drops
    // benefit_scheme, so its only consumer left with it (0 occurrences in the page now). The other
    // two still feed EarnedAccrualDialog, which is still mounted — so the guard still bites where
    // it matters. Removing the whole case would have dropped that.
    // a6fe37fc ROUND 5 — the two survivors are named by the page that mounts EarnedAccrualDialog, which
    // is the new leave TYPE screen. The old page is a redirect stub and prepares nothing at all, so the
    // "must survive" half of this case follows the consumer; the "must be gone" half above still reads
    // both files, so a festive-grant symbol reappearing on either fails.
    const liveScreen = stripComments(read('app/admin/leave-config/types/page.tsx'));
    // `festiveCompanies` was the name the OLD page gave the list it fed EarnedAccrualDialog; the new
    // screen calls the same list `accrualCompanies`, gated by the same `canGroupWide`. The rename is not
    // the removal this case guards against — what matters is that the dialog is still fed a group-aware
    // company list, and both halves of that are asserted by name.
    for (const kept of ['canGroupWide', 'accrualCompanies', '<EarnedAccrualDialog']) {
      expect(liveScreen.includes(kept), `${kept} must survive — it feeds Run Earned Accrual`).toBe(true);
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
