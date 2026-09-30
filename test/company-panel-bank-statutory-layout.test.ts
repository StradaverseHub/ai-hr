/**
 * R46 orgbank (84719377) — Company panel Bank Account + Statutory tab structure.
 *
 * A DB-free static-source guard (same style as test/statutory-my-layout.test.ts). It fails loudly if a
 * future edit undoes one of this item's deliberate decisions:
 *   (a) reintroduces the hardcoded 4-entry BANK_LABEL instead of the shared MY bank master,
 *   (b) re-renders the Payment rail (IBG / RENTAS) select the reporter asked to have hidden,
 *   (c) drops one of the bank-account or statutory-authority inputs,
 *   (d) stops listing every authority in the controlled set.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import { MY_BANKS, DISBURSEMENT_CAPABLE_BANKS } from '../lib/my-banks';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const panel = read('components/company-panel.tsx');
const en = JSON.parse(read('messages/en.json')) as { admin: { organization: Record<string, string> } };

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const orgOf = (loc: string) =>
  (JSON.parse(read(`messages/${loc}.json`)) as { admin: { organization: Record<string, string> } }).admin
    .organization;

/**
 * ⚠️ UPDATED THREE TIMES NOW — r352, REVISION 2 (r353) AND REVISION 3 (r355) — AND EVERY TIME THE SLICES
 * MOVED WITH THE CODE RATHER THAN WIDENING TO "the whole panel". An assertion that cannot say which half it
 * means is not a structure guard.
 *
 * r352 split `StatutoryAuthorityCard` (one component, one fold) into a rail ROW and a workspace EDITOR,
 * both in components/company-panel.tsx. r353 was the reporter contesting that: the editor left the panel for
 * a DEDICATED SCREEN, as one of eight always-visible cards. r355 IS THE REPORTER CONTESTING THAT TOO, and
 * this time they drew the layout themselves — a table of rows, and one body's fields on a screen of their
 * own. So the slices are:
 *
 *   ROW_SRC    components/company-panel.tsx — the body's read-only row on the Statutory tab. Text, a
 *              summary of what is on file, and ONE link out. Never a field. UNCHANGED by r355.
 *   SCREEN     components/statutory-setup-screen.tsx — THE WHOLE SCREEN: the read-only identity card,
 *              every body as its own card, and one Save scope over the lot.
 *   CARD_SRC   the `StatutoryBodyCard` slice of that same file — ONE body: its three groups, its
 *              thirteen posted names and its Clear button. r355 had it as a file of its own behind a
 *              per-body route; rev 4 (r371) folds it back in because the reporter contested that route
 *              as "an unnecessary intermediate page". A SLICE again, so a claim about the card cannot be
 *              satisfied by the identity card above it.
 *   DISPLAY    lib/statutory-authority-display.ts — the marks, the r226 filing-field map and (new in r355)
 *              `statutoryRowStatus`, all read by more than one screen so they cannot disagree about a body.
 *
 * ⚠️ NOTHING HERE WAS DELETED BECAUSE ITS SUBJECT MOVED. Every claim r352 made about EDITOR_SRC is made
 * about CARD_SRC below, and the reasoning that went with it is carried across verbatim wherever the rule
 * is unchanged. Where a claim's TRUTH reversed (the per-body Save button, the "Open settings" caption, the
 * eight always-visible cards, the one-card-at-a-time lock) the case asserts the new fact and QUOTES the old
 * one — CLAUDE.md §8: a guard pinning a decision you are reversing is updated, not deleted.
 */
const screen = read('components/statutory-setup-screen.tsx');
const SCREEN = screen;
const DISPLAY = read('lib/statutory-authority-display.ts');
/** The company action file, needed by cases in more than one describe block below. */
const ACTIONS_SRC = read('app/admin/actions.ts');
const ROW_SRC = panel.slice(
  panel.indexOf('function StatutoryBodyRow'),
  panel.indexOf('export function CompanyPanel'),
);
/**
 * ⚠️ RE-POINTED TWICE AND A SLICE AGAIN (15e5bd93 rev 4, r371). r353 had the editor as a
 * `StatutoryBodyCard` inside the setup screen; r355 made it a file of its own behind a per-body route;
 * the reporter contested that route and it is DELETED, so the card is back inside the screen.
 *
 * Sliced to the component boundary, deliberately: the screen file now also holds the read-only identity
 * card and the scope wiring, and a claim about "the body's card" that could be satisfied by either of
 * those is not a structure guard. The slice runs to `StatutorySetupScreen`, and it is asserted non-empty
 * below so a renamed component cannot make every claim in it vacuously true.
 */
const CARD_SRC = screen.slice(
  screen.indexOf('function StatutoryBodyCard'),
  screen.indexOf('export function StatutorySetupScreen'),
);
/** The read-only identity card at the top of the same screen — NOT part of any body's card. */
const IDENTITY_SRC = screen.slice(screen.indexOf('function IdentityCard'), screen.indexOf('function StatutoryBodyCard'));

/**
 * COMMENTS STRIPPED — the r331 aec53564 lesson, and it still bites: these slices run to the next
 * component's `function` keyword, so they carry that component's doc comment, and those comments discuss
 * the very markup some assertions below assert the ABSENCE of (a `<form>`, an `<input>`). A guard reading
 * prose about the code would fail on the prose. Every assertion about absent MARKUP runs on stripped text.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

/**
 * Item 3c2f55d7 — Organization / Company Setup: an opened company has nothing left to unfold.
 *
 * The request said "remove the company-selection dropdown from the opened company page". There is no
 * such dropdown — Open goes straight to /admin/organization/[companyId] and the sections there were
 * already tabs. What the reporter was actually hitting is that the panel folded in FOUR places after
 * the company had already been chosen: the panel itself, each statutory authority, each saved bank
 * account, and the "add a bank account" form.
 *
 * This block pins the flattening at SOURCE level rather than through a render, because that is where
 * the failure mode lives: a disclosure is re-added by someone tidying a long tab, and every behavioural
 * test still passes (the content is present in the DOM either way — `<details>` hides it with CSS, not
 * by unmounting). Only the shape says so.
 *
 * NOT pinned here, deliberately: the group-structure fold on the LISTING page, which is a separate and
 * still-current decision — see test/organization-group-structure-collapse.test.ts.
 */
describe('an opened company has nothing left to unfold (3c2f55d7)', () => {
  it('renders no details/summary disclosure anywhere in the panel', () => {
    // The explanatory comments in the panel deliberately spell "details/summary" without angle
    // brackets so that this guard cannot be satisfied — or tripped — by prose about itself.
    expect(panel).not.toMatch(/<details\b/);
    expect(panel).not.toMatch(/<summary\b/);
    expect(panel).not.toContain('group-open:'); // the CSS half of a details/summary toggle
  });

  /**
   * ⚠️ UPDATED BY 3c2f55d7 rev 2 — NOT deleted (AGENTS.md rule 18: a guard may pin the very decision you
   * are reversing; update the case, never drop it).
   *
   * STILL TRUE, and still the point: the PANEL itself has no expand/collapse. You arrived by opening this
   * company; the panel is the page body and it does not fold. `defaultExpanded` must not come back.
   *
   * ⚠️ UPDATED AGAIN BY 15e5bd93 (r352), AND THE BAN GOES BACK TO "NONE" — which is TIGHTER than either
   * previous version, not looser. 3c2f55d7 rev 2 narrowed rev 1's blanket ban to "exactly one, and it
   * belongs to the statutory card", because that round kept one fold: a body's fourteen-field editor
   * behind its Open/Edit. The reporter asked for exactly that to go — "the current behaviour opens the
   * settings in a tab/expand-style interface, which makes the information less clear and less convenient
   * to view or edit" — so NOTHING in this file expands any more.
   *
   * ⚠️ UPDATED A THIRD TIME BY 15e5bd93 REVISION 2 (r353), AND ONE HALF FLIPS. r352 also asserted that
   * `authorityOpen` / `authorityClose` were no longer RENDERED, on the reasoning that a re-added toggle
   * would reach for them first. `authorityOpen` is rendered again — as an `<a>`, because the reporter's
   * first approved point is that "Open Settings" becomes a link to a real page. The ban is on a
   * DISCLOSURE, not on the words, so the case now asserts the link AND the absence of anything that could
   * hide or reveal. `authorityClose` stays unrendered: only a fold ever needed it.
   *
   * This is the second time a "retired" key on this screen has come back, after `tabBankAccount`. Both
   * were kept in the six catalogues unused rather than deleted, and both were needed again within a few
   * rounds. A retired key costs nothing; re-translating a deleted one into six languages costs a round.
   */
  it('has no expand/collapse anywhere in the panel — nothing on it folds (15e5bd93)', () => {
    expect(panel).not.toContain('defaultExpanded');
    expect(panel.match(/aria-expanded/g) ?? [], 'nothing in this file expands').toHaveLength(0);
    expect(panel, 'and no Close, which only a fold ever needed').not.toContain("t('authorityClose')");
    /**
     * ⚠️ `authorityOpen` IS RENDERED AGAIN, AND THAT IS THE REVERSAL r353 IS FOR — r352's version of this
     * case asserted `not.toContain("t('authorityOpen')")` because the per-body fold it captioned was gone.
     * The reporter's rev-2 instruction is that "Open Settings" becomes a link to a REAL PAGE, so the
     * caption comes back as an `<a>`, not as a toggle. The two claims are not in tension and the guard has
     * to be able to tell them apart: what is banned is a DISCLOSURE, not the words.
     */
    expect(ROW_SRC, 'the row offers Open settings').toContain("t('authorityOpen')");
    expect(ROW_SRC, 'as a LINK to the dedicated screen, not a toggle').toContain('<Link');
    expect(ROW_SRC, 'and it carries no onClick that could hide or reveal anything').not.toContain('onClick');
    expect(panel, 'the selection accent went with the workspace it chose between').not.toContain('aria-current={');
  });

  /**
   * ⚠️ REVERSED TWICE, AND EACH OLD CLAIM'S OWN REASON IS WHY IT COULD BE REVERSED. Both are quoted here
   * rather than paraphrased, because this is the third round to touch the same mechanism.
   *
   *   · r352 ASSERTED `!selected && 'hidden'` — all eight body panes stayed MOUNTED and were hidden with
   *     CSS. Load-bearing for exactly one reason, which that case stated: "the tab's ONE Save reads every
   *     body's fields out of the DOM, so an unmounted pane would be a body whose edits cannot be saved at
   *     all."
   *   · r353 REVERSED that to `{editing ? (` plus `disabled={locked}` plus
   *     `const [editing, setEditing] = useState<string | null>(null)`, because with a Save on each card
   *     nothing walked the DOM any more, so a mounted-but-closed form would have made Cancel a lie — and
   *     the disabled Edit buttons stopped one card's Edit unmounting another's dirty form.
   *
   * ⚠️ r355 REMOVES THE STATE AND THE LOCK ENTIRELY, AND THE REASON IS THE SAME ONE, SPENT. The reporter's
   * sketch puts ONE body on a screen of its own, so there is no second form anywhere near the first: nothing
   * to lock, nothing to discard by accident, and no client state to hold. `?mode=` decides the shape, Cancel
   * is a LINK, and leaving the route is the discard. Every r353 spelling is asserted GONE rather than merely
   * unused, because `useState` left behind on a screen that no longer branches on it is how the next round
   * re-adds half a feature.
   */
  it('there is no view/edit at all: every card is one open form, decided by nothing', () => {
    /**
     * ⚠️ THE CLAIM THIS CASE MADE IN r355, QUOTED SO THE REVERSAL IS ON THE RECORD: "view/edit is the
     * URL, not client state, and the list holds no form at all" — `?mode=edit` mounted the form,
     * anything else mounted a `<dl>`, and the list carried no writer. The reporter has since called the
     * page that shape needed "an unnecessary intermediate page". There is no mode, no second shape and
     * nothing to decide; the card IS the form, and that is asserted rather than the absence of a lock.
     */
    // The r352 spelling must not come back: it describes a Cancel that does not cancel.
    expect(SCREEN, 'the CSS-hidden pane is gone').not.toContain("!selected && 'hidden'");
    expect(panel, 'no statutory workspace survives on the tab').not.toContain('data-statutory-workspace');
    expect(CARD_SRC, 'the card slice really matched a component').toBeTruthy();

    const code = stripComments(SCREEN);
    // NO MODE, IN EITHER SPELLING. r355's two shapes and r353's open-card state are both gone, asserted
    // as ABSENT rather than merely unused: a branch left behind on a screen that no longer takes it is
    // how the next round re-adds half a feature.
    expect(code, 'the r355 mode branch is gone').not.toContain("const editing = mode === 'edit';");
    expect(code, 'and the read-only summary it fed').not.toMatch(/\) : \(\s*<dl/);
    expect(code, 'the r353 open-card state is gone, not merely unused').not.toContain('useState');
    expect(code, 'and so is the lock it fed').not.toContain('disabled={locked}');
    expect(code, 'no Cancel link per body, because there is no per-body page to leave').not.toContain(
      'data-statutory-cancel-link',
    );
    expect(stripComments(CARD_SRC), 'nothing resets client state on Cancel').not.toContain('onCancel');

    // AND THE POSITIVE HALF: one open form per body, marked as a saved section of the one scope.
    expect(CARD_SRC, 'the card is a form').toContain('data-statutory-form={authority}');
    expect(CARD_SRC, 'and the screen Save owns it').toContain('data-save-section={authority}');
    expect(SCREEN, 'through the scope the General tab already uses').toContain('<TabSaveScope');
  });

  it('drops the fold-only labels rather than leaving them to rot in six catalogues', () => {
    // bankAccountEdit / bankAccountCollapse were the "Edit"/"Close" affordance on the two bank folds
    // and were REMOVED from all six locales with their last caller. i18n-check enforces parity, not
    // usefulness, so a dead key survives a green build forever unless something says otherwise.
    expect(panel).not.toContain('bankAccountEdit');
    expect(panel).not.toContain('bankAccountCollapse');
    expect(en.admin.organization.bankAccountEdit).toBeUndefined();
    expect(en.admin.organization.bankAccountCollapse).toBeUndefined();
  });

  /**
   * ⚠️ UPDATED BY r226 — NOT deleted (AGENTS.md rule 18).
   *
   * STILL TRUE, and still the point of this case: the panel is TABBED, the tabs are not a disclosure,
   * every tab stays mounted, and the bank editor is never cut down — wherever it lives, it lives WHOLE.
   * Those assertions are unchanged.
   *
   * REVERSED, on the reporter's written instruction: the tab SET. 94ae7e1f shipped General | Bank
   * Account | Statutory; 3c2f55d7 rev 2 removed the Bank Account tab and folded the bank details into an
   * "Other" tab, and this case pinned that removal (`not.toContain("t('tabBankAccount')")`). r226 puts
   * the tab back in slot two and retires "Other" rather than renaming it — "Other" held four unrelated
   * things, and a tab called "Bank Account" containing "Delete this company" is worse than the problem.
   * The three non-bank sections moved to General, and this case now pins THAT, so the next round cannot
   * quietly lose them in the shuffle. (`tabOther` stays in the six catalogues unused, the way
   * `tabPayroll` and `tabBankAccount` each did in their turn.)
   */
  it('KEEPS the tabs — General | Bank Account | Statutory (r226 restored slot two)', () => {
    expect(panel).toContain('role="tablist"');
    expect(panel).toContain('role="tab"');
    for (const k of ['tabGeneral', 'tabBankAccount', 'tabStatutory']) {
      expect(panel, k).toContain(`t('${k}')`);
    }
    expect(panel, '"Other" is retired, not renamed').not.toContain("t('tabOther')");
    // The bank editor did not go anywhere — it moved back onto its own tab, in full.
    expect(panel).toContain("t('bankProfilesTitle')");
    // …and the three things that were never bank are on GENERAL now, not filed under a bank heading.
    // Matched on the PANE opener, not the bare `tab === 'x'`, which also occurs up in the tab bar.
    const paneOf = (k: string) => panel.indexOf(`cn('space-y-4', tab === '${k}'`);
    const general = paneOf('general');
    const endGeneral = panel.indexOf('{/* end General tab */}');
    expect(general).toBeGreaterThan(-1);
    expect(endGeneral).toBeGreaterThan(general);
    expect(paneOf('bank'), 'Bank Account is a pane of its own again').toBeGreaterThan(endGeneral);
    const generalPane = panel.slice(general, endGeneral);
    for (const k of ['defaultPayrollCycle', 'groupParent', 'deleteCompanyTitle']) {
      expect(generalPane, `${k} moved to General`).toContain(`t('${k}')`);
    }
  });

  it('keeps every heading the folds used to carry, so nothing readable became unreadable', () => {
    // Each summary row was also the section's LABEL. Flattening must not have taken the label with it.
    expect(panel).toContain("t('authorityConfigured')");
    expect(panel).toContain("t('authorityNotConfigured')");
    expect(panel).toContain("t('bankPrimary')");
    expect(panel).toContain("t('bankAccountAdd')");
  });
});

describe('Bank Account tab: one shared Malaysian bank master', () => {
  it('no longer carries its own hardcoded bank label map', () => {
    expect(panel.includes('const BANK_LABEL')).toBe(false);
  });

  it('renders the picker from the shared master (lib/my-banks)', () => {
    expect(panel.includes("from '@/lib/my-banks'")).toBe(true);
    expect(panel.includes('DISBURSEMENT_CAPABLE_BANKS.map')).toBe(true);
    expect(panel.includes('DISBURSEMENT_UNSUPPORTED_BANKS.map')).toBe(true);
  });

  it('separates banks with no salary-file format into a labelled group', () => {
    // The trap this guards: widening the picker without widening the file builders lets a company save a
    // profile that only fails at file-build time. The group label is how the screen says so up front.
    expect(panel.includes("t('bankNoFileFormatGroup')")).toBe(true);
    expect(en.admin.organization.bankNoFileFormatGroup).toBeTruthy();
  });
});

describe('shared Malaysian bank master (lib/my-banks)', () => {
  it('is materially wider than the four banks the old enum allowed', () => {
    expect(MY_BANKS.length).toBeGreaterThan(20);
  });

  it('keeps the four legacy enum values as the first four keys (no data migration needed)', () => {
    expect(MY_BANKS.slice(0, 4).map((b) => b.key)).toEqual(['maybank', 'cimb', 'public_bank', 'rhb']);
  });

  it('gives every bank a 2-digit BNM routing code and a unique key', () => {
    for (const b of MY_BANKS) expect(b.code, b.key).toMatch(/^\d{2}$/);
    expect(new Set(MY_BANKS.map((b) => b.key)).size).toBe(MY_BANKS.length);
  });

  it('marks exactly the banks whose bulk salary-file format is implemented', () => {
    // Extending this set means teaching the file builders that bank's layout at the same time.
    expect(DISBURSEMENT_CAPABLE_BANKS.map((b) => b.key)).toEqual(['maybank', 'cimb', 'public_bank', 'rhb']);
  });
});

describe('Bank Account tab: payment rail hidden, column kept', () => {
  it('does not render the IBG / RENTAS select', () => {
    expect(panel.includes('value="RENTAS"')).toBe(false);
    expect(panel.includes('name="txnType"')).toBe(false);
  });

  it('still documents why the column stays', () => {
    expect(panel.includes('RENTAS')).toBe(true); // the explanatory comment, not a control
  });
});

describe('Bank Account tab: the account form keeps every field mounted', () => {
  for (const input of [
    'name="bank"',
    'name="accountLabel"',
    'name="corporateId"',
    'name="debitAccountNo"',
    'name="accountName"',
    'name="accountType"',
    'name="branch"',
    'name="swiftCode"',
    'name="currency"',
    'name="orgName"',
    'name="isPrimary"',
  ]) {
    it(`${input} is present`, () => {
      expect(panel.includes(input)).toBe(true);
    });
  }

  it('posts the row id when editing a saved account (identity is the id, not (company, bank))', () => {
    expect(panel.includes('<input type="hidden" name="id" value={p.id} />')).toBe(true);
  });
});

describe('Statutory tab: per-authority payment setup', () => {
  /**
   * ⚠️ UPDATED TWICE AND ASSERTED ON BOTH SCREENS. 3c2f55d7 rev 2 had one card per authority; r352 split
   * it into a rail ROW plus a workspace EDITOR, both on the panel; r353 moved the editor to a dedicated
   * screen as a CARD. Through all three the claim is the same and it is what matters: every body in the
   * controlled set is drawn, and no body can appear in one place and vanish from the other.
   *
   * Both maps still run over `STATUTORY_AUTHORITIES` itself — never over a filtered or sliced copy, which
   * is how a body would quietly leave one screen.
   */
  it('renders one read-only row per authority on the tab, and one TABLE row per authority on the list', () => {
    expect(
      panel.match(/STATUTORY_AUTHORITIES\.map\(\(a\) => \(\s*<StatutoryBodyRow/g) ?? [],
      "the tab's read-only list",
    ).toHaveLength(1);
    /**
     * ⚠️ REVERSED BY REVISION 3, AND THE REVERSAL IS STRICTLY TIGHTER THAN WHAT IT REPLACES.
     *
     * r353 ASSERTED `STATUTORY_AUTHORITIES.filter(`, `cardFor('socso')`, `cardFor('eis', true)` and
     * `!(perkesoGroup && a === 'eis')`. That filter existed for ONE reason, which that case stated: the cards
     * were laid out in a TWO-COLUMN GRID, where the third card lands under the FIRST, so EIS had to be pulled
     * out of the map and re-drawn inside SOCSO's own grid cell to be "under SOCSO" in the picture rather than
     * only in the reading order.
     *
     * A TABLE is one column of rows and `STATUTORY_AUTHORITIES` already orders EIS immediately after SOCSO, so
     * the whole controlled set maps straight through and EIS is merely INDENTED. That removes the one shape
     * that can silently drop a body: a `.filter()` over the controlled set. Hence the assertion is now that
     * there is no filter at all, which no previous version of this case could make.
     */
    // ⚠️ COMMENTS STRIPPED, AND THIS IS THE r331 aec53564 LESSON LANDING ON THE ROUND THAT CITES IT. The
    // screen's own header QUOTES the r353 spellings this case asserts the absence of — that record is exactly
    // what CLAUDE.md §12 asks to survive, and a bare `toContain` would read it as the code still being there.
    const listCode = stripComments(SCREEN);
    expect(listCode, 'the cards run over the controlled set itself').toContain('STATUTORY_AUTHORITIES.map((a) => (');
    expect(listCode, 'nothing is filtered out of it any more').not.toContain('STATUTORY_AUTHORITIES.filter(');
    expect(listCode, 'and nothing is sliced').not.toContain('STATUTORY_AUTHORITIES.slice(');
    expect(listCode, 'the r353 re-draw is gone with the grid that needed it').not.toContain("cardFor('eis', true)");
    expect(SCREEN, 'while the note recording what it replaced is KEPT').toContain("cardFor('eis', true)");
    // The old one-component shape must not come back with the fold in it. Comments stripped: the current
    // components' doc comments NAME what they replaced, and that record is exactly what must survive
    // (the r331 aec53564 lesson).
    expect(stripComments(panel), 'the folding card is retired').not.toContain('StatutoryAuthorityCard');
    expect(stripComments(screen), 'and it did not come back on the screen').not.toContain('StatutoryAuthorityCard');
  });

  /**
   * ⚠️ THE PER-BODY ROUTE IS DELETED, AND A STALE MATRIX ENTRY FAILS THE GATE EXACTLY AS A MISSING ONE
   * DOES (15e5bd93 rev 4, r371).
   *
   * r355 added `/admin/organization/[companyId]/statutory/[authority]` and this case pinned its two
   * validated inputs: the company through `scopedAdmin()` + `listCompanies({ adminOnly: true })`, and the
   * body through `isStatutoryAuthority`, because `authority` went into a heading, a message key and —
   * through `failStatutoryBody` — a redirect PATH. The reporter contested that page as "an unnecessary
   * intermediate page". Every body is a card on `…/statutory` now.
   *
   * So the claim REVERSES and is asserted in three places at once, because "the route is gone" and "the
   * route is still there but unregistered" look identical from any one of them:
   *   · the page.tsx is off disk;
   *   · its entry is REMOVED from the exact-set `routes` array (test/function-access.test.ts compares
   *     REGISTERED_ROUTES against the guarded page.tsx files on disk in BOTH directions, so a stale entry
   *     is a red gate);
   *   · the redirect helper that built a path out of a body is gone, which is the safety half: no posted
   *     value reaches a path from this flow any more, so there is nothing left to validate.
   */
  it('deletes the per-body route, its matrix entry and the redirect that built a path from a body', () => {
    expect(
      existsSync(join(root, 'app/admin/organization/[companyId]/statutory/[authority]/page.tsx')),
      'the intermediate page is off disk',
    ).toBe(false);
    const perms = read('lib/permissions.ts');
    expect(perms, 'and OUT of the exact-set routes array, not merely unreachable').not.toContain(
      "'/admin/organization/[companyId]/statutory/[authority]'",
    );
    expect(perms, 'while the one statutory route keeps its column').toContain(
      "'/admin/organization/[companyId]/statutory',",
    );
    // THE SURVIVING ROUTE STILL RUNS THE SAME COMPANY GUARD — the door that is left must not be an
    // easier door. test/organization-list-detail.test.ts RUNS the refusal; this pins it at the source.
    const listPage = read('app/admin/organization/[companyId]/statutory/page.tsx');
    expect(listPage, 'the company guard').toContain('await scopedAdmin()');
    expect(listPage).toContain("listCompanies(s, { includeArchived: true, adminOnly: true })");
    expect(listPage, 'and its refusal').toContain('if (!c) notFound();');
    // NO MODE IS READ FROM THE ADDRESS ANY MORE, so there is no closed list left to get wrong.
    expect(listPage, 'no mode in the query').not.toContain('rawMode');
    // THE REDIRECT HALF. `failStatutoryBody` built `…/statutory/<body>?mode=edit`; it is gone with the
    // page, and every refusal in this flow now goes to the screen that holds the form.
    const redirects = read('app/admin/_redirects.ts');
    expect(stripComments(redirects), 'no helper builds a path out of a body').not.toContain(
      'export function failStatutoryBody',
    );
    expect(stripComments(redirects)).not.toContain('export function companyStatutoryBodyPath');
    expect(redirects, 'though the note recording why it is gone is KEPT').toContain('failStatutoryBody');
    expect(stripComments(ACTIONS_SRC), 'and nothing calls it').not.toContain('failStatutoryBody(e,');
    expect(stripComments(redirects), 'the refusal that remains is the screen itself').toContain(
      'export function failStatutorySetup',
    );
  });

  it('keeps the statutory IDENTITY form on the tab, alongside the list (the two are different things)', () => {
    expect(panel.includes("t('statutoryIdentityMY')")).toBe(true);
    expect(panel.includes("t('authoritiesTitle')")).toBe(true);
  });

  /**
   * ⚠️ ALL THIRTEEN POSTED FIELD NAMES, RE-POINTED AT THE SCREEN THAT NOW POSTS THEM — NOT DROPPED AND
   * NOT WEAKENED. This loop ran against `panel` while the editor lived there. The body's form is on
   * components/statutory-setup-screen.tsx now, so that is where the loop reads; a field that went missing
   * in the move is the single most likely way this round loses a customer's setting, and it would pass
   * every behavioural test (the save succeeds, it just writes `null`).
   *
   * Still asserted NEGATIVELY against the panel below, so a field cannot be satisfied by a leftover copy
   * on a screen that no longer writes.
   */
  for (const input of [
    'name="authority"',
    'name="accountNo"',
    'name="bankProfileId"',
    'name="addressLine1"',
    'name="addressLine2"',
    'name="addressLine3"',
    'name="city"',
    'name="state"',
    'name="postcode"',
    'name="country"',
    'name="phone"',
    'name="email"',
    'name="signatoryPersonId"',
  ]) {
    it(`${input} is present in the authority form on the dedicated screen`, () => {
      expect(CARD_SRC.includes(input), input).toBe(true);
    });
  }

  it('and the panel posts none of them any more — the tab is read-only about the bodies', () => {
    const statutoryPane = panel.slice(
      panel.indexOf("cn('space-y-4', tab === 'statutory'"),
      panel.indexOf('{/* end Statutory tab */}'),
    );
    // The registrations card is the ONE writer left on this tab, so its own two boxes are expected.
    for (const input of [
      'name="authority"',
      'name="accountNo"',
      'name="bankProfileId"',
      'name="signatoryPersonId"',
      'name="hrdfStatus"',
      'name="addressLine1"',
      'name="email"',
    ]) {
      expect(statutoryPane, `${input} moved off the tab`).not.toContain(input);
    }
    expect(statutoryPane, 'what remains is SSM').toContain('name="ssmRegistrationNo"');
    expect(statutoryPane, 'and MyInvois').toContain('name="myinvoisTin"');
    expect(stripComments(ROW_SRC), 'a row renders no field at all').not.toMatch(/<input\b/);
    expect(stripComments(ROW_SRC), 'and no form').not.toMatch(/<form\b/);
  });

  it('has an en label for every authority (dynamic keys are invisible to the i18n coverage test)', () => {
    for (const a of STATUTORY_AUTHORITIES) {
      expect(en.admin.organization[`authority_${a}`], `authority_${a}`).toBeTruthy();
    }
  });
});

/**
 * r226 — each body's FILING identity moved onto that body's own card, and the move is guarded at the
 * point where it can silently go wrong.
 *
 * The hazard this whole block exists for: `company_statutory_my` is ONE row holding five numbers, and it
 * used to be written by ONE form as a full-row overwrite. Splitting it across five forms without changing
 * the writer would have made saving the EPF card blank SOCSO, LHDN, MyInvois and SSM — with no error, a
 * 200, and a green suite, because nothing renders the four values it just destroyed. So the partial-patch
 * writer and the presence-checked reads are pinned here alongside the layout.
 */
describe('Statutory tab: one body, one card, both of its numbers (r226)', () => {
  const CS = read('localization/my/company-statutory.ts');
  const ACTIONS = read('app/admin/actions.ts');
  /**
   * ⚠️ THERE ARE TWO CALLERS OF THE PARTIAL-PATCH IDENTITY WRITER AGAIN, AND THE r353 CLAIM THAT THERE
   * MUST BE ONE IS REVERSED HERE RATHER THAN DELETED (15e5bd93 rev 4, r371).
   *
   * r352 opened a SECOND DOOR to `company_statutory_my`: a consolidated Save reaching the partial-patch
   * writer alongside `setCompanyStatutoryAuthorityAction`. r353 deleted it and this case read, in full:
   * "there is ONE caller of the partial-patch identity writer again, not a dormant second one", asserting
   * `existsSync(app/admin/organization/statutory-tab-actions.ts) === false`.
   *
   * ⚠️ THE HAZARD THAT CLAIM NAMED WAS NEVER "two callers"; IT WAS "a partial-patch writer with one
   * presence-checked caller and one COLLAPSING caller". Reading an absent key as `''` is what blanks the
   * other four numbers on the row. The reporter has asked for one Save over every body on one screen, so
   * the second caller is back by design — and what this case pins is the property that actually protects
   * the data: BOTH callers read through a presence check, and neither is dormant.
   *
   * It also pins that the second door is REACHED, not merely present. An unreferenced `'use server'`
   * writer of this row is the original hazard wearing a different hat.
   */
  const TAB_ACTION = read('app/admin/organization/statutory-tab-actions.ts');
  it('has two callers of the partial-patch identity writer, both presence-checked, neither dormant', () => {
    expect(
      existsSync(join(root, 'app/admin/organization/statutory-tab-actions.ts')),
      'the consolidated statutory action is restored from r352 (d991c149)',
    ).toBe(true);
    expect(
      existsSync(join(root, 'lib/company-statutory-tab-sections.ts')),
      'and so is the section vocabulary it validates against',
    ).toBe(true);

    /**
     * ⚠️ THE ABSENT-vs-EMPTY RULE, ASSERTED ON BOTH CALLERS, VERBATIM. `company_statutory_my` is ONE row
     * holding five numbers written by a PARTIAL PATCH: an ABSENT key means "leave the stored value
     * alone" and `''` means "the operator cleared this box". Reading an absent key as `''` is the r226
     * data loss, and on a screen carrying all eight bodies at once it is reachable on EVERY Save.
     */
    const PRESENCE_CHECK = 'return formData.has(key) ? String(formData.get(key) ?? \'\') : undefined;';
    expect(ACTIONS, 'the per-body action').toContain(PRESENCE_CHECK);
    expect(TAB_ACTION, 'and the screen-wide one, with the same three lines').toContain(PRESENCE_CHECK);
    expect(TAB_ACTION, 'the four filing keys go through it').toContain("postedField(fd, 'epfEmployerNo')");
    expect(TAB_ACTION).toContain("postedField(fd, 'socsoEmployerCode')");
    expect(TAB_ACTION).toContain("postedField(fd, 'lhdnEmployerNo')");

    /**
     * ⚠️ ONLY DIRTY SECTIONS ARE WRITTEN, AND THIS IS THE ONE LINE THAT PREVENTS THE WORST OUTCOME OF
     * THIS ROUND. A Save that wrote all eight bodies would CREATE a `company_statutory_authority` row
     * for every one of them and flip every "Not set up" card to "Set up" — eight statutory bodies
     * registered because somebody fixed a postcode. Pinned at the source here and RUN against a real
     * database in test/organization-statutory-card-save.test.ts.
     */
    expect(TAB_ACTION, 'a section nobody touched is skipped').toContain(
      'if (!requested.includes(section)) continue;',
    );
    // The vocabulary is exactly the eight bodies, so a crafted payload naming another section is refused
    // before anything is written.
    expect(TAB_ACTION).toContain('const unknown = requested.filter((x) => !order.includes(x));');
    expect(TAB_ACTION).toContain('if (unknown.length > 0) {');
    const vocab = read('lib/company-statutory-tab-sections.ts');
    expect(vocab, 'the eight bodies and nothing else').toContain(
      'export const COMPANY_STATUTORY_TAB_SECTION_ORDER = [...STATUTORY_AUTHORITIES] as const;',
    );
    // The company is forced from the ONE trusted top-level value, never from a section's hidden copy.
    expect(TAB_ACTION).toContain("if (field === 'companyId' || field === 'id') continue;");
    expect(TAB_ACTION).toContain("out.set('companyId', companyId);");
    // …and so is the AUTHORITY: eight hidden copies in one payload are eight chances to point one body's
    // write at another body's row.
    expect(TAB_ACTION, 'the section id decides the body').toContain(
      'await applyAuthoritySection(s, section, fd);',
    );

    // NOT DORMANT: the screen's route binds it, by reference, from the `'use server'` module.
    const listPage = read('app/admin/organization/[companyId]/statutory/page.tsx');
    expect(stripComments(listPage), 'the screen reaches it').toContain(
      "import { saveCompanyStatutoryTabAction } from '../../statutory-tab-actions';",
    );
    expect(stripComments(listPage)).toContain('saveStatutoryScreen: saveCompanyStatutoryTabAction,');
    // ADR-0080 D9/D11 — through the PACK FACADE, so no pack-drift allowlist entry is needed or added.
    expect(TAB_ACTION, 'the facade, not core/statutory-authority').toContain(
      "import { upsertCompanyStatutoryAuthority } from '@/packs/payroll/service';",
    );
    expect(TAB_ACTION).not.toContain("from '@/core/statutory-authority'");
    // THE COMPANY PANEL STILL HAS NO SCOPE OF ITS OWN: this round restored one action, not the r352 tab.
    expect(stripComments(panel), 'nothing on the panel reaches for a tab-wide statutory save').not.toContain(
      'saveStatutoryTab',
    );
    expect(panel, 'and the note recording that removal is KEPT').toContain('saveStatutoryTab');
  });

  it('puts EPF, SOCSO and LHDN filing numbers on their own card, and nobody else', () => {
    // ⚠️ THE MAP MOVED TO lib/statutory-authority-display.ts (r353) and the slice moved with it. It is
    // shared now because TWO components read it — the panel's read-only row and the screen's card — and two
    // copies could disagree about what EPF's filing number is called, which is the r226 fault in miniature.
    const map = DISPLAY.slice(DISPLAY.indexOf('const MY_FILING_FIELD'));
    expect(map).toContain("epf: { name: 'epfEmployerNo'");
    expect(map).toContain("socso: { name: 'socsoEmployerCode'");
    expect(map).toContain("lhdn: { name: 'lhdnEmployerNo'");
    // SSM and MyInvois are NOT bodies you pay a contribution to and are not in STATUTORY_AUTHORITIES.
    // The plan told the reporter they would stay in the identity list; this is that promise, asserted.
    expect(map, 'SSM gets no card').not.toContain('ssmRegistrationNo');
    expect(map, 'MyInvois gets no card').not.toContain('myinvoisTin');
    for (const a of ['ssm', 'myinvois']) {
      expect(STATUTORY_AUTHORITIES as readonly string[]).not.toContain(a);
    }
  });

  it('keeps SSM and MyInvois on the Statutory tab, where the two files that read SSM expect them', () => {
    expect(panel).toContain("t('statutoryIdentityMY')");
    expect(panel).toContain('name="ssmRegistrationNo"');
    expect(panel).toContain('name="myinvoisTin"');
    /**
     * ⚠️ 15e5bd93 rev 2 — AND THE DEDICATED SCREEN READS THEM WITHOUT OWNING THEM. Approved point 1 puts
     * the two numbers in that screen's heading so an operator can check them without coming back; neither
     * gets a card and neither gets an input there, because neither is a body an employer pays a
     * contribution to. One owner, one editor — which is the whole reason they never got a card in r226.
     */
    /**
     * ⚠️ RE-POINTED BY REVISION 3. r353 asserted these two on the setup PAGE, because that round printed them
     * in the PageHeader's description. The reporter's rev-3 sketch puts them in a "Statutory Identity (MY)"
     * CARD at the top of the screen body, beside the four filing identifiers, so the claim moves to the
     * component that now prints them — and the page is asserted NOT to, so the two cannot both do it.
     */
    const setupPage = read('app/admin/organization/[companyId]/statutory/page.tsx');
    expect(screen, 'the identity card prints SSM').toContain('statutory?.ssmRegistrationNo');
    expect(screen, 'and MyInvois').toContain('statutory?.myinvoisTin');
    expect(setupPage, 'and the page heading no longer repeats them').not.toContain('statutory?.ssmRegistrationNo');
    expect(setupPage, 'nor MyInvois').not.toContain('statutory?.myinvoisTin');
    expect(screen, 'but the list has no SSM input').not.toContain('name="ssmRegistrationNo"');
    expect(screen, 'and no MyInvois input').not.toContain('name="myinvoisTin"');
    expect(CARD_SRC, 'nor does the body screen').not.toContain('name="ssmRegistrationNo"');
    expect(CARD_SRC).not.toContain('name="myinvoisTin"');
    // The reason SSM may not be filed under a payment card: two statutory files read it.
    expect(read('localization/my/borang-8a.ts')).toContain('companyStatutoryMy.ssmRegistrationNo');
    expect(read('localization/my/socso-eis-file.ts')).toContain('companyStatutoryMy.ssmRegistrationNo');
  });

  it('labels the two numbers so the card says which is which', () => {
    // The reporter's complaint was that a body had one number on its card and a different number for the
    // same body in a list above it, with nothing on screen saying they were different things.
    expect(CARD_SRC).toContain("t('authorityFilingSection')");
    expect(CARD_SRC).toContain("t('authorityFilingHint')");
    expect(CARD_SRC).toContain("t('authorityPaymentSection')");
    expect(CARD_SRC).toContain("t('authorityAccountNo')");
    /**
     * 15e5bd93 — THE THREE GROUPS THE REPORTER APPROVED, and the third one is new only as a HEADING. The
     * address run was the one block of this form with no heading at all; the drawing gives it one. Nothing
     * was added, removed, renamed or re-validated — every box under each heading is a box that was there.
     *
     * HRD Corp's first group stays "Registration", not "Filing identity": its control is a band that
     * decides whether the levy is charged, not a number on a filed form, and r226 removed that exact
     * mislabelling once already.
     */
    expect(CARD_SRC, 'the address run finally has a heading').toContain("t('authorityAddressSection')");
    expect(CARD_SRC).toContain("t('authorityPaymentHint')");
    expect(CARD_SRC).toContain("t('authorityAddressHint')");
    expect(CARD_SRC, "HRD Corp's band is not filed under a filing-number caption").toContain(
      "showHrdf ? t('authorityRegistrationSection') : t('authorityFilingSection')",
    );
    for (const loc of LOCALES) {
      const org = orgOf(loc);
      for (const k of [
        'authorityFilingSection',
        'authorityFilingHint',
        'authorityPaymentSection',
        'authorityPaymentHint',
        'authorityAddressSection',
        'authorityAddressHint',
        'authorityRegistrationSection',
        'authorityRegistrationHint',
        'authorityEisSharesSocso',
      ]) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
      }
    }
  });

  it('says out loud that EIS files under the SOCSO code rather than showing an empty box', () => {
    // Two inputs writing socsoEmployerCode would be two controls fighting over one column, and the card
    // saved second would win. An empty EIS box would read as a number somebody forgot. So: a sentence.
    expect(CARD_SRC).toContain("t('authorityEisSharesSocso')");
    const map = DISPLAY.slice(DISPLAY.indexOf('const MY_FILING_FIELD'));
    expect(map, 'EIS gets no second input on the same column').not.toMatch(/\beis:/);
  });

  it('HRD Corp keeps its rate select — on its own screen, and nowhere else in the product', () => {
    // EXACTLY ONE hrdfStatus control. r353 asserted the count on components/statutory-setup-screen.tsx,
    // where the editors were; r355 moved the editors to their own file, so the count moves with them and the
    // LIST is asserted to carry none. Two controls over one column is the fault r226 removed, and a second
    // copy on a screen that cannot save would be worse than the first.
    expect(CARD_SRC.match(/name="hrdfStatus"/g) ?? [], 'one HRDF control, on the body card').toHaveLength(1);
    expect(
      (screen.match(/name="hrdfStatus"/g) ?? []).length,
      'and exactly one on the whole screen — the card is drawn eight times, from ONE `showHrdf` branch',
    ).toBe(1);
    expect(CARD_SRC, 'gated to HRD Corp alone').toContain("const showHrdf = filingCountry === 'MY' && authority === 'hrdf';");
    expect(IDENTITY_SRC, 'the identity card PRINTS the rate and does not edit it').not.toContain('name="hrdfStatus"');
    expect(panel, 'and the panel carries none').not.toContain('name="hrdfStatus"');
  });

  /**
   * THE DATA-LOSS GUARD. Everything above is layout; this is the part that loses customer data if it is
   * undone. Do not "simplify" the writer back to `p.x ?? null` — see localization/my/company-statutory.ts.
   */
  it('the identity writer is a PARTIAL PATCH, so one card cannot blank another body’s number', () => {
    expect(CS, 'the full-row overwrite is gone').not.toMatch(/epfEmployerNo:\s*p\.epfEmployerNo \?\? null/);
    expect(CS, 'only the fields the caller named are written').toContain('if (p[f] !== undefined) values[f]');
    // The action half: a key the form did not carry must arrive as undefined, not as ''.
    expect(ACTIONS).toContain('function postedField(formData: FormData, key: string)');
    expect(ACTIONS).toContain('formData.has(key)');
    expect(ACTIONS, 'the collapsing read is gone from the statutory action').not.toContain(
      "epfEmployerNo: (formData.get('epfEmployerNo') as string) || undefined",
    );
    /**
     * ⚠️ r352 ASSERTED THIS OF A SECOND FILE TOO, AND THAT FILE IS GONE (r353) — see the case at the top
     * of this block, which pins its deletion rather than letting the claim simply evaporate.
     *
     * The five NAMES it checked are checked here instead, on the one caller that remains. That is what the
     * r352 half was really for: `company_statutory_my` holds five numbers written through one partial patch,
     * and a caller that quietly stops naming one of them stops being able to CLEAR it — a defect with a
     * 200, a green suite and nothing on screen to show it.
     */
    for (const field of ['epfEmployerNo', 'socsoEmployerCode', 'lhdnEmployerNo', 'myinvoisTin', 'ssmRegistrationNo']) {
      expect(ACTIONS, `the identity write reads ${field} by presence`).toContain(
        `${field}: postedField(formData, '${field}')`,
      );
    }
    // And the body's own filing half, which `setCompanyStatutoryAuthorityAction` writes alongside the
    // payment setup, reads by presence for exactly the same reason.
    const authorityAction = ACTIONS.slice(
      ACTIONS.indexOf('export async function setCompanyStatutoryAuthorityAction'),
      ACTIONS.indexOf('export async function removeCompanyStatutoryAuthorityAction'),
    );
    for (const field of ['epfEmployerNo', 'socsoEmployerCode', 'lhdnEmployerNo']) {
      expect(authorityAction, `a body patches ${field} by presence`).toContain(
        `${field}: postedField(formData, '${field}')`,
      );
    }
  });

  it('the card posts its filing field under a name that cannot collide with the address country', () => {
    /**
     * `country` is already taken on this form by the authority's postal address (a country NAME from the
     * ISO list). Reusing it for the statutory-pack lookup posts "Malaysia" into `packFor()`, which is not
     * hypothetical: it killed EVERY identity save with "No statutory pack for Malaysia" during r352.
     *
     * ⚠️ KEPT THROUGH r353 EVEN THOUGH THE CONSOLIDATED SCOPE THAT TRIGGERED IT IS GONE. Two reasons, and
     * the second is the load-bearing one: `setCompanyStatutoryAuthorityAction` reads `filingCountry` as its
     * contract, and the dedicated screen still puts a body's FILING control and its VISIBLE postal
     * `country` on one form — so the two names must stay two names wherever a future scope wraps them.
     */
    expect(CARD_SRC).toContain('name="filingCountry"');
    expect(ACTIONS).toContain("formData.get('filingCountry')");
    expect(CARD_SRC).toContain('name="country"'); // the address field, untouched
    // Both names on ONE form is the condition the rename exists for; asserting it keeps the case honest
    // about why it is still here rather than reading as a leftover.
    const form = CARD_SRC.slice(CARD_SRC.indexOf('data-statutory-form={authority}'), CARD_SRC.indexOf('</form>'));
    expect(form, 'the pack flag').toContain('name="filingCountry"');
    expect(form, 'and the postal country, on the same form').toContain('name="country"');
  });

  /**
   * ⚠️ REPLACED BY 15e5bd93 REVISION 2 (r353). r352 asserted that the consolidated save took the body
   * from the VALIDATED SECTION ID rather than from the form's own hidden `authority`, because nine hidden
   * `authority` inputs in one payload were nine chances for a crafted request to point one body's write at
   * another body's row — and likewise for nine hidden company ids.
   *
   * That payload does not exist any more: each card posts its OWN form, so there is one `authority` and one
   * `companyId` per request and no section vocabulary to validate against. The threat the old case named
   * does not disappear with it, though — it moves down a layer, to the service. So the claim is re-pointed
   * at the thing that actually refuses a bad body now, which is where it should have been asserted all
   * along for the per-body action (that action has been bound since R46 and nothing pinned this about it).
   */
  it('a posted authority is validated by the service, and a posted company cannot be another company', () => {
    // The ROW the service writes is keyed by (company, authority) and it refuses an authority outside the
    // controlled set. core/statutory-authority.ts is the one writer; the action does not pre-trust the
    // string, it hands it over to be checked.
    const core = read('core/statutory-authority.ts');
    expect(core, 'the authority code is validated, not trusted').toContain('isStatutoryAuthority');
    // The COMPANY is refused by RLS as well as by the read — test/organization-list-detail.test.ts runs
    // the refusal for both organization routes; this only pins that the action reads ONE company id from
    // the form rather than accepting a per-section copy.
    const authorityAction = ACTIONS.slice(
      ACTIONS.indexOf('export async function setCompanyStatutoryAuthorityAction'),
      ACTIONS.indexOf('export async function removeCompanyStatutoryAuthorityAction'),
    );
    expect(authorityAction).toContain("const companyId = String(formData.get('companyId'));");
    expect(authorityAction, 'and it passes that one id to the service').toContain('companyId,');
    /**
     * THE `returnTo` MARKER IS A CLOSED-LIST LITERAL, NEVER A PATH. It decides which of two screens the
     * redirect goes to, so echoing a posted string would be a query-injection hole in the one place a path
     * and a query string meet — the rule `companyTab` was written for. `okStatutorySetup` builds the
     * address from the company id alone.
     */
    expect(ACTIONS).toContain("function fromStatutorySetupScreen(fd: FormData)");
    expect(ACTIONS).toContain("=== STATUTORY_SETUP_RETURN");
    expect(read('app/admin/_redirects.ts'), 'the path is built, not posted').toContain(
      'export function companyStatutoryPath(companyId: string)',
    );
  });
});

/**
 * Item 3c2f55d7 rev 2 — the statutory bodies read as CARDS.
 *
 * The complaint the redesign answers: nine authorities, each rendered as the same fourteen-field block,
 * one under the other. Nothing on screen told an HR admin which block was EPF and which was PTPTN except
 * a line of small text, so finding the right one meant scrolling and reading. The card face now carries
 * an icon, the body's name, a one-line description of what it is, and whether it has been configured —
 * and the form opens underneath on request.
 */
describe('Statutory tab: each body is a row (3c2f55d7 rev 2, relaid out by efe424b0)', () => {
  /**
   * efe424b0 (r327) — UPDATED, NOT DELETED. This asserted a responsive GRID of cards, which is what
   * 3c2f55d7 rev 2 built and what this file has pinned since. The reporter asked for the opposite in
   * these words: "displayed as a structured list rather than individual large boxes, allowing
   * administrators to quickly identify, access, and manage each statutory setting."
   *
   * The claim the describe block is really about is unchanged and still asserted below — each body is a
   * FACE you can read before clicking (mark, name, description, status) with its form opening on
   * request, rather than fourteen identical field blocks stacked up. What changed is that the faces are
   * rows in one divided list instead of tiles in a grid, so the border and the rounding moved from each
   * entry to the list, and an opened entry no longer needs to span columns it no longer has.
   *
   * ⚠️ UPDATED AGAIN BY 15e5bd93 (r352) — the divided list is still the shape, and it is now PERMANENT.
   * efe424b0's list still had to choose between showing you eight rows and showing you one body's fields;
   * the list is now a left RAIL that never collapses, beside a workspace that holds the fields. So this
   * case gains the two halves of that, and keeps everything it asserted before.
   */
  it('renders one divided list of rows, not a grid and not a stack of forms', () => {
    expect(panel, 'the authority list is one divided list').toMatch(/divide-y divide-border\/60 rounded-lg border/);
    expect(panel, 'the grid is gone').not.toMatch(/grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3/);
    // No column spanning on the ROW WRAPPER, because there are no columns to span. Targeted at the
    // card's own `open && 'sm:col-span-2 xl:col-span-3'` rather than the bare string: `sm:col-span-2`
    // is also how a wide FIELD lays out inside the three-column form, and that is untouched.
    expect(ROW_SRC, 'the row no longer spans grid columns').not.toContain('xl:col-span-3');
    /**
     * ⚠️ REVERSED BY REVISION 3, AND IT PUTS efe424b0 BACK IN CHARGE OF BOTH SCREENS.
     *
     * r353 ASSERTED `'grid items-start gap-3 lg:grid-cols-2'` on the dedicated screen, with this reasoning:
     * "THE GRID CAME BACK… efe424b0's objection was to 'individual large boxes' you had to scroll past to find
     * a body; the drawing for rev 2 shows two columns of cards, all visible at once, which is the opposite
     * complaint answered."
     *
     * The reporter contested that drawing and drew a TABLE. So efe424b0's words — "displayed as a structured
     * list rather than individual large boxes" — now describe BOTH surfaces, and the grid is asserted gone
     * from the one screen it had come back on. The house table constants are used rather than a hand-written
     * class string, which is the drift lib/../components/ui.tsx `tableWrapCls` exists to prevent.
     */
    /**
     * ⚠️ REVERSED AGAIN BY REVISION 4, AND THIS TIME BECAUSE THE TABLE WAS MEASURED.
     *
     * r355 asserted, in this very place: "the list is a real table" plus the four house table constants
     * (`tableWrapCls`, `theadCls`, `thCls`, `tbodyCls`), on the reasoning that the reporter had drawn a
     * table and the shared constants prevent drift.
     *
     * Rendered at 1280 / 1024 / 820 CSS px, that table laid out 1038–1330px inside a 996–1264px box. The
     * body description carried `truncate`, whose `white-space: nowrap` fixes a cell's min-content at the
     * whole 132-character string, so the first column took 786px of a ~1000px table and the Action column
     * went off the right-hand edge — the `Action` heading rendered as "AC", "View" as "V", and the Edit
     * link was not painted at all. `tableWrapCls`'s `overflow-x-auto` is what HID that: a scroller with no
     * affordance, which is why a green suite and a 200 both missed it.
     *
     * So the table is gone, and with it the one wrapper on this screen that could hide a control.
     */
    // ⚠️ COMMENTS STRIPPED, AND THIS IS THE r331 aec53564 LESSON LANDING ON THE ROUND THAT CITES IT —
    // caught by a static replay of these claims before the gate ran. The screen's header NAMES every
    // spelling this case asserts the absence of (`<table>`, the four house constants, `overflow-x-auto`),
    // because CLAUDE.md §12 asks that record to survive; a bare `toContain` reads the record as the code.
    const noComments = stripComments(SCREEN);
    expect(SCREEN, 'the grid of cards is gone').not.toContain('grid items-start gap-3 lg:grid-cols-2');
    expect(noComments, 'and so is the table that overflowed its container').not.toMatch(/<table\b/);
    for (const cls of ['tableWrapCls', 'theadCls', 'thCls', 'tbodyCls']) {
      expect(noComments, `${cls} is gone with the table`).not.toContain(cls);
      expect(SCREEN, `while the note recording that ${cls} was removed is KEPT`).toContain(cls);
    }
    expect(noComments, 'nothing on this screen scrolls sideways').not.toContain('overflow-x-auto');
    // ⚠️ THE SHARED CONSTANTS THEMSELVES ARE UNTOUCHED — every other admin table keeps the house look.
    // Removing them from ONE screen is the fix; editing the constant would restyle forty.
    expect(read('components/ui.tsx'), 'the house table look is not restyled for one module').toContain(
      "export const tableWrapCls = 'overflow-x-auto rounded-md border border-border';",
    );
  });

  /**
   * ⚠️ THE TWO STATUS COLUMNS ARE TWO FACTS, DERIVED IN ONE PLACE — new in revision 3, and the plan promised
   * the reporter this precisely rather than printing a column that looks like information and is really an
   * echo:
   *
   *     Payment Setup = a `company_statutory_authority` row exists for that body
   *     Status        = it is actually contributing
   *
   * For seven bodies these coincide, because there is no per-body enable/disable fact in the schema and
   * INVENTING one is what CLAUDE.md §8 forbids. For HRD Corp they genuinely differ: `hrdf_status` decides
   * whether the levy is charged at all, so "Configured + Inactive" is a real reachable state.
   *
   * Pinned at SOURCE as well as on the render (test/statutory-setup-screen-render.test.ts) because the failure
   * mode is a later round "simplifying" the second column into the first — which would pass every render
   * assertion on a fixture where the two happen to agree.
   */
  it('derives Payment Setup and Status in ONE place, and only HRD Corp reads the band', () => {
    // ONE derivation, in lib/ so the screen and the guards read the same function.
    expect(DISPLAY, 'the shared derivation exists').toContain('export function statutoryRowStatus(');
    expect(DISPLAY, 'Payment Setup is the record, for every body').toContain('configured: hasRecord');
    expect(DISPLAY, 'and Status diverges for HRD Corp alone').toContain(
      "contributing: authority === 'hrdf' ? (hrdfStatus ?? 'not_registered') !== 'not_registered' : hasRecord",
    );
    /**
     * THE ROW READS THE DERIVATION AND DOES NOT RE-DERIVE EITHER COLUMN.
     *
     * ⚠️ SLICED TO THE ROW COMPONENT, AND THE FIRST WRITING OF THIS CASE GOT IT WRONG IN A WAY WORTH
     * RECORDING: asserted against the whole file, "the screen never tests `=== 'not_registered'`" FAILED, and
     * correctly. The IDENTITY CARD does test it, legitimately — it prints HRD Corp's band as a CAPTION ("No
     * Contribution" / "1.0%" / "0.5%"), which is a different fact from the Status column and must say "Not set"
     * where the Status column says Inactive. So the claim is about the ROW, which is the thing that must not
     * grow a second derivation of a column it is handed.
     */
    expect(CARD_SRC, 'the card is found').toBeTruthy();
    expect(CARD_SRC, 'and it READS the derivation').toContain('statutoryRowStatus(authority, !!row,');
    expect(stripComments(CARD_SRC), 'rather than re-testing the band itself').not.toContain("=== 'not_registered'");
    /**
     * ⚠️ ONLY THE `configured` HALF IS READ NOW, AND THE OTHER HALF DID NOT VANISH (rev 4, r371). The two
     * COLUMNS went with the table; each card carries one word, Set up / Not set up, meaning "a
     * `company_statutory_authority` row exists" — identically for all eight bodies, which is the only
     * thing a shared caption may say (CLAUDE.md §8). HRD Corp's separate fact, whether it contributes at
     * all, is the Contribution Rate SELECT on its own card, which is where it is chosen. The derivation
     * stays whole and shared so a future reader cannot invent a second answer to "is this set up".
     */
    expect(CARD_SRC, 'one word, from the one derivation').toContain('const { configured } = statutoryRowStatus(');
    expect(CARD_SRC, 'the word itself').toContain("t('statutoryCardSetUp')");
    expect(CARD_SRC).toContain("t('statutoryCardNotSetUp')");
    expect(SCREEN, 'and the two-column vocabulary is off the screen').not.toContain("t('authorityStatusActive')");
    expect(SCREEN).not.toContain("t('authorityStatusInactive')");
    expect(CARD_SRC, 'while the fact that column carried is the control beneath it').toContain('name="hrdfStatus"');
    // The HRDF half is payroll's own rule, not a UI guess. Both lines are what make it checkable.
    const payroll = read('core/payroll.ts');
    expect(payroll, 'a missing identity row resolves to not_registered').toContain(
      "coStat?.hrdfStatus ?? 'not_registered'",
    );
    expect(payroll, 'and the levy is charged only when it is not').toContain(
      "hrdfChargeable = hrdfStatus !== 'not_registered'",
    );
    // ⚠️ NO SWITCH WAS INVENTED. There is no per-body enable/disable column, so nothing may post one.
    for (const src of [SCREEN, CARD_SRC]) {
      expect(src, 'no enable/disable control').not.toContain('name="enabled"');
      expect(src).not.toContain('name="active"');
      expect(src).not.toContain('role="switch"');
    }
  });

  /**
   * ⚠️ REPLACES r352'S "the rail and the workspace are two columns" (15e5bd93 rev 2, r353).
   *
   * r352 read the reporter's complaint — the settings open "in a tab/expand-style interface, which makes
   * the information less clear and less convenient to view or edit" — and answered it with a permanent rail
   * plus a workspace INSIDE this tab. The reporter contested that: "Do not expand the statutory settings
   * directly within the existing Statutory tab… The preferred approach is a dedicated full-width screen."
   *
   * So the two columns on THIS tab are now the company's own registrations card and the read-only list of
   * bodies. Everything r352 pinned about the list that is still true is still pinned: it is a <nav>, it is
   * always drawn, and it is never behind a condition of its own. What is added is the half the reporter
   * asked for — each row LINKS to the dedicated screen — and the half that has to be asserted negatively,
   * that no editor came with it.
   *
   * Pinned at source because the failure mode is a later round "tidying" the fields back onto the tab,
   * which no behavioural test on the screen would notice at all.
   */
  it('the tab is the registrations card beside a read-only list that LINKS to the dedicated screen', () => {
    const pane = panel.slice(panel.indexOf("cn('space-y-4', tab === 'statutory'"), panel.indexOf('{/* end Statutory tab */}'));
    expect(pane, 'two columns on a wide screen, stacked on a narrow one').toContain('flex flex-col gap-4 lg:flex-row');
    expect(pane, 'the registrations card is a fixed-width column of its own').toContain('lg:w-72');
    expect(pane, 'and the list is navigation, not decoration').toMatch(/<nav aria-label=\{t\('authoritiesTitle'\)\}>/);
    expect(pane, 'the list takes the rest').toContain('min-w-0 flex-1');
    // Never behind a condition of its own: only `isMY` decides whether the tab has a list at all.
    expect(pane, 'the list is not conditional on a selection').not.toMatch(/\{\s*statutoryBody\s*&&/);
    // THE LINK, which is approved point 1. Built from the company id the pane already holds — one address
    // for every row, because there is no route per authority.
    expect(pane).toContain('setupHref={`/admin/organization/${c.id}/statutory`}');
    expect(ROW_SRC, 'and the row renders it as a link').toContain('href={setupHref}');
    // NO SELECTION STATE ANY MORE: it chose between workspaces that are not here.
    expect(panel, 'the workspace selection is gone').not.toContain('setStatutoryBody');
  });

  /**
   * ⚠️ REPLACES r352'S "the tab has ONE Save, and every card under the bar carries a section marker".
   *
   * That case was the half that resolved 65b22c00's finding 1: the audit left the SSM / MyInvois card with
   * its own button because a scope on this tab would have sat above eight body editors it did not own, and
   * r352 took the Save buttons off those editors so the bar DID own them.
   *
   * r353 is the reporter contesting the editors' presence on the tab at all. With them gone the scope has
   * one two-field card left to own, which is the "worse than none" finding 1 named in the same breath — so
   * the card takes its own Save back and the scope goes. Both halves are asserted, because "the bar
   * disappeared" and "the card lost its Save" look identical from the outside and only one of them is right.
   */
  it('the tab has NO consolidated Save, and the registrations card submits itself', () => {
    const pane = panel.slice(panel.indexOf("cn('space-y-4', tab === 'statutory'"), panel.indexOf('{/* end Statutory tab */}'));
    expect(pane, 'no scope over one card').not.toContain('<TabSaveScope');
    expect(pane, 'and no statutory tab key for one to key on').not.toContain('tabKey="statutory"');
    // Comments stripped for the same reason the case above gives: the retirement note names the prop.
    expect(stripComments(panel), 'the action prop is gone with it').not.toContain('saveStatutoryTab');
    expect(stripComments(panel), 'and so is the section-label map it needed').not.toContain(
      'statutorySectionLabels',
    );
    // THE CARD'S OWN SAVE IS BACK — the retired caption returning to service, not a new string.
    expect(pane, 'bucket (a) with its own control again').toContain("t('saveStatutoryIdentity')");
    expect(pane, 'as a real submit').toMatch(/<Button type="submit"/);
    // NO SECTION MARKERS LEFT ON THIS TAB. A marker with no scope above it is inert, and inert markup that
    // looks like a contract is how the next round re-adds half a feature.
    expect(pane, 'no marker survives the scope').not.toContain('data-save-section');
    // THE GENERAL TAB'S SCOPE IS UNTOUCHED: this round removed one scope, not the pattern.
    expect(panel, "General's Save bar stays").toContain('tabKey="general"');
    /**
     * ⚠️ AND THE PER-CARD SAVE IS GONE AGAIN (15e5bd93 rev 4, r371). r353 gave each body its own Save and
     * this case asserted `t('authoritySave')` on the card; r355 kept it on the per-body page. The
     * reporter's expected_function has said the same thing throughout and we have never built it:
     * "Provide one Save button for the entire Statutory Payment Setup screen… Save all changes together…
     * remain on the same screen." The dedicated SCREEN now has the scope, so the card has no Save at all
     * — which is the r352 arrangement, restored on the surface the reporter actually asked for.
     */
    expect(CARD_SRC, 'no Save on the card').not.toContain("t('authoritySave')");
    expect(CARD_SRC, 'and no Cancel on it either').not.toContain("t('authorityCancel')");
    expect(SCREEN, 'ONE Save for the screen').toContain("saveLabel: t('statutoryScreenSave')");
    expect(SCREEN, 'and a Cancel that LEAVES rather than reverting in place').toContain(
      "leave: { href: backHref, label: t('statutoryScreenCancel') }",
    );
    expect(SCREEN, 'through the scope the General tab already uses').toContain('<TabSaveScope');
    expect(SCREEN, 'keyed to this screen').toContain('tabKey="statutory"');
    // "Clear this authority" DELETES a row: bucket (b), its own form, its own control, and it MOVED with
    // the editor rather than being dropped — it is the only way to clear a body's payment setup.
    expect(CARD_SRC).toContain("t('authorityClear')");
    const clear = CARD_SRC.slice(CARD_SRC.indexOf('action={actions.removeStatutoryAuthority}'));
    expect(clear, 'the Clear form is a form of its own').toMatch(/<button\b/);
    expect(clear, 'and it is not inside the card Save').not.toContain("t('authoritySave')");
  });

  /**
   * ⚠️ THE PACK FLAG ON THE REGISTRATIONS CARD IS `filingCountry`, NOT `country`, AND IT STAYS THAT WAY
   * AFTER r353 REMOVED THE SCOPE THAT FORCED IT. This is a DATA guard, not a naming one, and it is kept
   * deliberately rather than reverted — which is the whole reason the case is worth reading.
   *
   * `lib/tab-save-dom.ts` `syncCarriedValues` treats a HIDDEN input as a mirror of any VISIBLE control with
   * the same name in a sibling section of the same scope, and copies the visible value into it — the
   * behaviour the personnel cards need. Every statutory body's editor carries a visible `country` for its
   * postal address (a country NAME from the ISO list). The moment r352 put the registrations card in that
   * scope, its hidden `name="country"` was overwritten with "Malaysia" and posted into `packFor()`: EVERY
   * identity save died with "No statutory pack for Malaysia".
   *
   * The card is outside a scope again, so that exact door is shut. The name stays for two reasons. ONE:
   * `setCompanyStatutoryAction` reads `country` and defaults an absent one to 'MY', which is the only value
   * this MY-only card ever posted — so `filingCountry` is not merely harmless, it is what makes the default
   * the live path. TWO: the SAME collision is live on the dedicated screen, where a body's filing control
   * and its visible postal `country` are on one form; one name for one concept, on both screens.
   */
  it('the registrations card posts its pack flag under a name no address field can collide with', () => {
    const pane = panel.slice(panel.indexOf("cn('space-y-4', tab === 'statutory'"), panel.indexOf('{/* end Statutory tab */}'));
    const form = pane.slice(pane.indexOf('action={actions.setStatutory}'), pane.indexOf('</form>'));
    expect(form).toContain('<input type="hidden" name="filingCountry" value="MY" />');
    expect(form, 'a hidden country here would be overwritten by a body address').not.toContain('name="country"');
    // The action that receives it still defaults an absent `country` to MY rather than throwing.
    expect(ACTIONS_SRC, 'the MY-only default is the live path').toContain(
      "const country = String(formData.get('country') ?? 'MY');",
    );
  });

  /**
   * ⚠️ SOCSO AND EIS READ AS ONE GROUP AND STAY TWO RECORDS, which is the whole of efe424b0's
   * consolidation. Measured on production: their payment accounts genuinely differ (one company pays
   * SMSB_EIS and SMSB_SOCSO), so a single card backed by SOCSO's row would leave EIS's account on file
   * with no screen able to edit it.
   */
  it('draws EIS beneath SOCSO as a subordinate row AND a subordinate card, each with its own record', () => {
    expect(panel, 'EIS is marked subordinate, not filtered out').toContain(
      "subordinate={c.country === 'MY' && a === 'eis'}",
    );
    // NOT removed from the controlled set: the services and the payroll feed still know it.
    expect(STATUTORY_AUTHORITIES).toContain('eis');
    // THE TAB'S LIST: indented, and without a second copy of the mark its group head already carries.
    expect(ROW_SRC).toContain("subordinate && 'pl-6'");
    expect(ROW_SRC).toContain('{subordinate ? (');
    /**
     * ⚠️ RE-POINTED BY REVISION 3, AND THE MECHANISM GOT SIMPLER RATHER THAN WEAKER.
     *
     * r353 ASSERTED `subordinate && 'ml-6'` on the card plus
     * `/cardFor\('socso'\)[\s\S]{0,120}cardFor\('eis', true\)/` on the screen, because the drawing was a
     * TWO-COLUMN GRID: the third card lands under the FIRST, so EIS had to be re-drawn inside SOCSO's own grid
     * cell or it would have been indented under EPF.
     *
     * The rev-3 list is a TABLE. `STATUTORY_AUTHORITIES` already orders EIS immediately after SOCSO, so ROW
     * ADJACENCY carries the relationship — asserted here on the controlled set itself, which is a stronger
     * claim than a class string — and the indent only shows it.
     *
     * The BODY SCREEN has no subordinate case at all, on purpose: EIS is the only body on its own screen, so
     * there is no group head above it to carry the PERKESO mark once, and indenting a page against nothing
     * would be decoration. The relationship lives on the list, which is where it is legible.
     */
    expect(
      STATUTORY_AUTHORITIES[STATUTORY_AUTHORITIES.indexOf('socso') + 1],
      'the controlled set puts EIS immediately after SOCSO, which is what a table row order means',
    ).toBe('eis');
    /**
     * ⚠️ RE-POINTED A THIRD TIME, AND THE INDENT IS GONE WITH THE TABLE IT LIVED IN (rev 4, r371). r353
     * asserted `subordinate && 'ml-6'` on a card in a two-column grid; r355 asserted `subordinate &&
     * 'pl-6'` on a table cell. There is no table and no grid: eight full-width cards in the controlled
     * set's order, so ADJACENCY alone carries the relationship — which is asserted on the controlled set
     * itself above, a stronger claim than any class string — and EIS says in WORDS whose code it files
     * under, which is stronger still and survives every future layout.
     */
    expect(stripComments(SCREEN), 'no indent flag survives the table').not.toContain('subordinate');
    expect(SCREEN, 'though the note recording what it replaced is KEPT').toContain('subordinate');
    expect(CARD_SRC, 'EIS says whose code it files under, in words').toContain("t('authorityEisSharesSocso')");
    expect(CARD_SRC, 'gated to EIS alone').toContain(
      "const sharesSocsoCode = filingCountry === 'MY' && authority === 'eis';",
    );
    // TWO RECORDS, NOT ONE: its own authority value still posts, so its own row is what the card writes,
    // and its own section id is what the one Save keys on.
    expect(CARD_SRC).toContain('<input type="hidden" name="authority" value={authority} />');
    expect(CARD_SRC, 'and its own saved section').toContain('data-save-section={authority}');
  });

  it('gives every authority in the controlled set its own icon', () => {
    // A body with no entry falls back rather than rendering a blank tile, and THAT is asserted too — the
    // fallback is what makes adding an authority safe.
    // ⚠️ MOVED TO lib/statutory-authority-display.ts (r353): two components draw a body now, and two
    // copies of the mark table would let one screen show PERKESO where the other showed a Lucide fallback.
    const map = DISPLAY.slice(DISPLAY.indexOf('const AUTHORITY_ICON'), DISPLAY.indexOf('WHICH FILING NUMBER'));
    for (const a of STATUTORY_AUTHORITIES) {
      expect(map, `AUTHORITY_ICON.${a}`).toMatch(new RegExp(`\\b${a}:`));
    }
    // The fallback is applied wherever a MARK is drawn, which is what makes adding an authority safe.
    expect(ROW_SRC).toContain('AUTHORITY_ICON[authority] ?? Landmark');
    expect(CARD_SRC).toContain('AUTHORITY_ICON[authority] ?? Landmark');
    // ⚠️ REVERSED BY rev 4 (r371). r355's four-column TABLE drew no mark at all — "their table is four
    // text columns" — and this case asserted `not.toContain('AUTHORITY_ICON')` on the screen. The table
    // is gone; every body is a CARD again, headed by its own mark, so the fallback has to be here too.
    // Exactly one drawing of it on the screen: the card is one component rendered eight times.
    expect((SCREEN.match(/AUTHORITY_ICON\[authority\] \?\? Landmark/g) ?? []).length, 'one fallback').toBe(1);
  });

  /**
   * ⚠️ UPDATED BY 15e5bd93 — the FACE slice was "everything in the card before `aria-expanded`", i.e.
   * everything above the Open control. There is no Open control any more, so the face is the whole rail
   * row: `ROW_SRC`. That is the same claim about a tighter subject — the row component contains nothing
   * BUT the face, so this can no longer be satisfied by something living further down the card.
   */
  it('shows name, description and status on the rail row FACE — before any click', () => {
    const face = stripComments(ROW_SRC);
    expect(face).toContain('t(`authority_${authority}` as never)');
    expect(face).toContain('t(`authorityDesc_${authority}` as never)');
    expect(face).toContain("t('authorityConfigured')");
    expect(face).toContain("t('authorityNotConfigured')");
  });

  /**
   * ⚠️ EXTENDED BY ITEM 3783fd87 — the face now carries the VALUES, not only the status.
   *
   * "Configured / Not set up" answered whether a body had a row. It did not answer WHICH employer
   * number is on file or WHICH bank account pays it, so the only way to learn either was to open the
   * body — and comparing two meant opening both and remembering the first. The approved plan's words:
   * one card per authority "showing what is set without opening anything — the employer number and the
   * bank account it is paid from — and saying plainly where nothing is set yet".
   *
   * The three captions are asserted SEPARATELY and on the FACE slice because collapsing them into one
   * anonymous "employer number" is precisely the fault r226 was raised for: a body has TWO different
   * numbers and the screen has to say which is which.
   *
   * ⚠️ 15e5bd93 (r352) KEPT THIS ON THE FACE ON PURPOSE, and it is the assertion that says so. The new
   * layout moves a body's FIELDS into a workspace beside the rail, so the obvious edit is to let the rail
   * row carry only a name and a Configured chip and let the values live in the (now always-open) fields.
   * That would undo this item: the promise made to the same reporter was that you can read what is set on
   * EVERY body at once, because comparing two used to mean opening both and remembering the first — and
   * the workspace shows one body at a time. So the summary stays on the rail row, and the face slice is
   * now `ROW_SRC`, which contains nothing but the face.
   */
  it('shows the employer number and the paying bank account on the FACE too (3783fd87)', () => {
    const face = stripComments(ROW_SRC);
    // The summary is built once and rendered on the face; both halves are pinned.
    expect(ROW_SRC, 'the at-a-glance summary is derived').toContain('const summary:');
    expect(face, 'the summary is rendered on the rail row').toContain('summary.map(');
    // …and it is NOT quietly relocated into the workspace, where only one body is ever visible.
    /**
     * ⚠️ THE ONE ASSERTION IN THIS FILE MOST AT RISK FROM REVISION 3, PINNED IN THREE PLACES.
     *
     * r352 asserted the summary was NOT moved into the workspace (which showed one body at a time). r353's
     * screen showed all eight bodies at once, so the summary lived on both surfaces.
     *
     * ⚠️ THE rev-3 LIST HAS FOUR COLUMNS AND THE SUMMARY IS NOT ONE OF THEM — that is the reporter's own
     * sketch, and it is the thing that could quietly undo 3783fd87. It does not, and this is where that is
     * argued rather than assumed:
     *   · THE PANEL'S STATUTORY TAB still carries the whole summary on every row's face, which is where
     *     3783fd87's promise was made and where it is asserted above. Untouched by r355.
     *   · THE IDENTITY CARD at the top of the list carries the three FILING numbers and HRD Corp's band for
     *     every body at once — the half of the summary the reporter specifically asked to see before editing.
     *   · THE BODY SCREEN carried the full `<dl>` in VIEW mode, before Edit, not after.
     * What is still forbidden is the summary being reachable ONLY by opening a body, and all three pin that.
     *
     * ⚠️ THE THIRD BULLET IS REVERSED BY rev 4 (r371) AND THE PROMISE IS KEPT A BETTER WAY. That `<dl>`
     * was measured: it declared `grid-cols-[auto_1fr]` and then gave every row `col-span-2 flex …
     * justify-between`, cancelling the grid — 767–926px of dead space between a caption and its value at
     * 1280, three different value edges, and the correspondence address `truncate`d to the literal "…"
     * the reporter drew. It is gone with view mode, and what replaces it is stronger than a summary: every
     * value is in its own labelled BOX, already open, with nothing to click and nothing cut off.
     */
    expect(stripComments(SCREEN), 'the view-mode summary is gone with view mode').not.toContain('const summary:');
    expect(stripComments(SCREEN), 'and so is the grid it cancelled per row').not.toContain('grid-cols-[auto_1fr]');
    expect(CARD_SRC, 'every fact is a labelled box instead').toContain("<Field label={t('authorityAccountNo')}>");
    expect(CARD_SRC).toContain("<Field label={t('authorityBankAccount')}>");
    // The identity card, which is what puts the filing numbers of EVERY body on one screen with no click.
    expect(SCREEN, 'the screen has an identity card').toContain('data-statutory-identity');
    expect(SCREEN, 'built from the SHARED filing map, so it cannot omit a body that has a number').toContain(
      'MY_FILING_FIELD[a]',
    );
    expect(SCREEN, 'and it reads the same hrdf band rather than inventing a caption').toContain('hrdfBandKey');
    // The FILING number, under the body's own caption (epfEmployerNo / socsoEmployerCode / lhdnENumber).
    expect(ROW_SRC).toContain('label: t(filing.labelKey as never)');
    expect(ROW_SRC).toContain('value: statutory?.[filing.name] || null');
    // The PAYMENT reference and the bank account that pays it.
    expect(ROW_SRC).toContain("label: t('authorityAccountNo')");
    expect(ROW_SRC).toContain("label: t('authorityBankAccount')");
    expect(ROW_SRC).toContain("bankProfiles.find((bp) => bp.id === r?.bankProfileId)");
    // "Not set" where nothing is on file — an absent value says so rather than rendering an empty gap.
    expect(face).toContain("t('authorityValueNotSet')");
    // HRD Corp's band is shown only when the identity row CARRIES one. Payroll resolves a missing row to
    // 'not_registered', but printing "Not registered" for a company with no row at all would assert a
    // registration decision nobody made (§8: an absent box asserts nothing).
    expect(ROW_SRC).toContain("statutory?.hrdfStatus === 'not_registered'");
    expect(ROW_SRC).toContain('hrdfBandKey ? t(hrdfBandKey as never) : null');
    // READ-ONLY. The face must not grow a second set of controls over the same columns — the editor
    // below is the only writer, and `company_statutory_authority` is also what the EA officer block and
    // the CP39 preparer block read (localization/my/reports.ts).
    expect(face, 'the face renders text, never a second input').not.toMatch(/<input\b/);
    expect(face, 'the face renders text, never a second form').not.toMatch(/<form\b/);
  });

  it('carries a DESCRIPTION for every authority in all six locales (dynamic keys, added by hand)', () => {
    // authority_* and authorityDesc_* are both computed at render time, so test/i18n-coverage.test.ts
    // cannot see either. Adding an authority means adding BOTH strings to SIX files or the card renders
    // MISSING_MESSAGE — behind a 200, a green suite and a clean build.
    for (const loc of LOCALES) {
      const org = orgOf(loc);
      for (const a of STATUTORY_AUTHORITIES) {
        expect(org[`authority_${a}`], `${loc}: authority_${a}`).toBeTruthy();
        expect(org[`authorityDesc_${a}`], `${loc}: authorityDesc_${a}`).toBeTruthy();
      }
      // 3783fd87 — `authorityValueNotSet` is the face's "nothing on file yet". It is a STATIC key, so
      // test/i18n-coverage.test.ts check C sees it; it is listed here anyway because this is the file
      // that owns what the card says, and a reader adding an authority reads this list, not that one.
      //
      // ⚠️ 15e5bd93 rev 2 — `authorityOpen` IS IN SERVICE AGAIN (the tab's "Open settings" link) and
      // `authoritySave` / `saveStatutoryIdentity` ARE TOO (the editor's Save and the registrations card's).
      // All three were RETIRED by r352 and kept in all six catalogues rather than deleted, the way
      // `tabOther`, `tabPayroll` and `tabBankAccount` each were — and this is the second round in a row
      // where a kept key came back. The list stays as a presence check either way: a string this screen has
      // needed, stopped needing, and needed again must not be tidied away between rounds.
      //
      // ⚠️ REVISION 3 (r355) RETIRES TWO MORE AND KEEPS THEM FOR THE SAME REASON.
      // `statutoryScreenEditingHint` and `authorityEditing` explained r353's one-card-at-a-time lock — the
      // disabled Edit buttons that stopped one card's Edit unmounting another card's dirty form. One body per
      // ROUTE means there is no second form to discard, so the lock is gone and both strings are unrendered.
      // Asserted PRESENT here and asserted UNRENDERED in the two render guards, which is the pair
      // `authorityClose` has carried since r352. Retire a key, never delete it: three of the five kept this
      // way have already come back.
      for (const k of ['authorityOpen', 'authorityClose', 'authorityValueNotSet', 'statutoryScreenEditingHint',
        'authorityEditing']) {
        expect(org[k], `${loc}: ${k} is kept, in service or retired`).toBeTruthy();
      }
      // 15e5bd93 — the three group headings, which moved to the dedicated screen with the form.
      for (const k of ['authorityAddressSection', 'authorityAddressHint', 'authorityPaymentHint']) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
      }
      for (const k of ['authoritySave', 'saveStatutoryIdentity']) {
        expect(org[k], `${loc}: ${k} is in service again`).toBeTruthy();
      }
      // 15e5bd93 rev 2 — the strings the dedicated screen needed. Static keys, so
      // test/i18n-coverage.test.ts check C sees them too; listed here because this is the file that owns
      // what these screens say, and `authoritySavedToast` carries an ICU argument that must survive
      // translation (a locale that dropped `{body}` would show a confirmation naming nothing).
      for (const k of [
        'statutoryScreenTitle',
        'backToStatutoryTab',
        'authorityEdit',
        'authorityEditing',
        'authorityCancel',
        'authoritySavedToast',
        'statutoryScreenEditingHint',
      ]) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
      }
      expect(org.authoritySavedToast, `${loc}: the confirmation names the body`).toContain('{body}');
      /**
       * ⚠️ RETIRED IN PLACE, IN ALL SIX CATALOGUES, AND ASSERTED PRESENT RATHER THAN ASSERTED GONE.
       *
       * r355 introduced eleven strings for the reporter's own table layout and this loop required them.
       * r371 removes the table, the View link and the per-body page — but NOT the strings.
       * i18n/request.ts deep-merges each locale over English, so dropping a key from en.json alone leaves
       * a Malay reader the OLD sentence; and a retired string costs nothing while re-translating a
       * deleted one into six languages costs a round. `authorityOpen`, `authorityClose`, `tabOther` and
       * `tabBankAccount` were each retired this way and two of the four have already come back.
       *
       * test/statutory-setup-screen-render.test.ts asserts the other half — that none of them REACHES
       * the screen — so "kept" cannot quietly become "still rendered".
       */
      for (const k of [
        'statutoryColBody',
        'statutoryColPaymentSetup',
        'statutoryColStatus',
        'statutoryColAction',
        'authorityView',
        'authorityStatusActive',
        'authorityStatusInactive',
        'backToStatutorySetup',
        'statutoryIdentityHint',
        'statutoryBodyViewCaption',
        'statutoryBodyEditCaption',
      ]) {
        expect(org[k], `${loc}: ${k} is retired, not deleted`).toBeTruthy();
      }
      /**
       * 15e5bd93 REVISION 4 (r371) — THE NINE NEW STRINGS THE ONE SCREEN NEEDS: the screen-wide Save and
       * Cancel, the unsaved-changes prompt's title, body and three buttons, and the per-card status word.
       * Static keys, so check C sees them as well; listed here because this is the file that owns what
       * these screens say, and because FIVE of them are only rendered when the reader tries to LEAVE
       * with something unsaved — a locale that lost one throws a MISSING_MESSAGE mid-navigation, which no
       * render check on the screen itself would ever reach.
       */
      for (const k of [
        'statutoryScreenSave',
        'statutoryScreenCancel',
        'statutoryUnsavedTitle',
        'statutoryUnsavedBody',
        'statutoryUnsavedCancel',
        'statutoryUnsavedDiscard',
        'statutoryUnsavedSave',
        'statutoryCardSetUp',
        'statutoryCardNotSetUp',
      ]) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
      }
      // ⚠️ THE TWO STATUS VALUES MUST NOT BE THE TWO PAYMENT-SETUP VALUES. They answer different questions and
      // a translator handed one pair twice would make the two columns look like one fact in that locale, which
      // is the exact impression the r355 plan promised the reporter we would not create. Both pairs are
      // retired with the table, and the claim is kept so a future round that brings either back inherits it.
      expect(org.authorityStatusActive, `${loc}: Active is not Configured`).not.toBe(org.authorityConfigured);
      expect(org.authorityStatusInactive, `${loc}: Inactive is not Not-set-up`).not.toBe(org.authorityNotConfigured);
      /**
       * ⚠️ AND THE THREE LEAVE-PROMPT BUTTONS MUST BE THREE DIFFERENT SENTENCES. The reporter listed Save
       * & Leave / Discard & Leave / Cancel by name; a translator handed two of them the same string
       * would give that locale a dialog with two identical buttons, one of which throws work away.
       */
      expect(new Set([org.statutoryUnsavedCancel, org.statutoryUnsavedDiscard, org.statutoryUnsavedSave]).size,
        `${loc}: the three leave choices are three different sentences`).toBe(3);
    }
  });
});

/**
 * Item 3c2f55d7 rev 2 — the authorised signatory is SEARCHABLE, and the company scope is unchanged.
 *
 * The reporter asked for a searchable employee dropdown (by Employee ID or name) and, in passing, for
 * "the complete employee list". The approved plan keeps the list COMPANY-SCOPED: the service refuses to
 * newly appoint anyone who is not an active employee of this company (core/statutory-authority.ts), so a
 * tenant-wide picker would only offer choices that fail on save. Widening it is a rule change, not a UI
 * change, and is deliberately not done here.
 */
describe('Statutory tab: the signatory picker', () => {
  it('is the shared searchable employee field, not a plain select', () => {
    // ⚠️ ON THE BODY CARD (r353 moved it off the panel; r355 onto the per-body page; r371 back onto the
    // one screen with that page's deletion). The PANEL is still asserted not to have it, rather than
    // assumed: a leftover control there would be a second signatory picker over one column.
    expect(SCREEN).toContain("from './employee-search-field'");
    expect(CARD_SRC).toContain('<EmployeeSearchField');
    expect(CARD_SRC).toContain('name="signatoryPersonId"');
    // The old control, gone: a bare <select> over every candidate.
    expect(CARD_SRC).not.toMatch(/<select name="signatoryPersonId"/);
    expect(panel, 'the panel has no signatory control at all').not.toContain('EmployeeSearchField');
    /**
     * `fieldLabel` IS ON THE PROP, and as of rev 4 (r371) the reason is live again rather than defensive.
     * r353 and r355 kept it while the form sat OUTSIDE any `TabSaveScope`, on the grounds that
     * lib/tab-save-dom.ts `hiddenInputIsUserFacing` and `controlDisplay` need it. This screen has a
     * consolidated Save, so the walker really does read this control: without the pair, a
     * signatory-only edit on any of eight cards leaves the bar reading "No unsaved changes", Save
     * disabled, and the admin's pick thrown away on the next navigation — silently, which is exactly the
     * defect r352 found. §4 of test/15e5bd93-statutory-screen.dom.test.tsx is its only direct coverage.
     */
    expect(CARD_SRC, 'the searchable field still declares its caption').toContain(
      "fieldLabel={t('authoritySignatory')}",
    );
    expect(read('components/employee-search-field.tsx')).toContain('data-field-label={fieldLabel}');
    expect(read('lib/tab-save-dom.ts')).toContain('export function hiddenInputIsUserFacing');
  });

  it('keeps a signatory who has since LEFT selectable, so an unrelated save cannot wipe them', () => {
    // EmployeeSearchField treats a value that is not in its option list as "no selection" — it would post
    // an empty string and clear the column. The former employee is therefore injected into the list.
    expect(CARD_SRC).toContain("t('authoritySignatoryFormer')");
    expect(CARD_SRC).toContain('signatoryOptions.unshift');
    // ⚠️ THE VIEW-MODE HALF OF THIS CLAIM IS RETIRED WITH VIEW MODE (rev 4, r371). r355 asserted
    // `signatories.find(...)?.name ?? t('authoritySignatoryFormer')` on the read-only `<dl>`, so a
    // departed signatory was NAMED rather than shown as "Not set" or as a bare person id. There is no
    // `<dl>`; the same tolerance now lives in the picker itself, where it is stronger — the injected
    // option is what the operator SEES in the combobox and what the hidden input keeps posting.
    expect(CARD_SRC, 'the departed person is injected as a real option').toContain(
      "signatoryOptions.unshift({ value: r.signatoryPersonId, name: t('authoritySignatoryFormer')",
    );
    expect(CARD_SRC, 'and the condition is that they are no longer a candidate').toContain(
      '!signatories.some((sg) => sg.personId === r.signatoryPersonId)',
    );
  });

  it('carries the five search captions in all six locales', () => {
    for (const loc of LOCALES) {
      const org = orgOf(loc);
      for (const k of [
        'signatorySearchPlaceholder',
        'signatorySearchLabel',
        'signatorySearchResults',
        'signatoryNoMatches',
        'signatoryClear',
      ]) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
      }
    }
  });
});

/**
 * Item 3c2f55d7 rev 2 — the COMPANY's own bank account number is shown in full.
 *
 * It was rendered as `•••• 8901` in two places on this admin-only screen. That is an employee-facing
 * habit applied where it does not belong: the number is the company's own debit account, the screen is
 * reachable only by an admin of that company (RLS), and an admin routing EPF to the right account needs
 * to read the whole thing. The masks on EMPLOYEE bank details elsewhere are a different decision and are
 * asserted here to be untouched — this item unmasks ONE screen, not the product.
 */
describe('Bank Account: the company debit account is not masked here', () => {
  it('the panel no longer truncates a debit account number', () => {
    expect(panel).not.toContain('••••');
    expect(panel).not.toContain('debitAccountNo.slice(-4)');
  });

  it('both display spots print the whole number', () => {
    // The "Paid from" picker on each authority card — on the dedicated screen since r353, in BOTH the
    // edit-mode <select> and the view-mode summary, and unmasked in each.
    expect(CARD_SRC).toContain("' · ' + bp.debitAccountNo");
    expect(screen, 'and the screen masks nothing either').not.toContain('••••');
    expect(screen).not.toContain('debitAccountNo.slice(-4)');
    // …and the heading over each saved account under Other.
    expect(panel).toContain('{myBankLabel(bp.bank)} · {bp.debitAccountNo} · {bp.currency}');
  });

  it('the EMPLOYEE-facing masks elsewhere stay exactly as they were', () => {
    // r260 (9583deac stage two): the employee-side mask MOVED — the four-digit literal now lives in
    // lib/profile-requestable-fields.ts `maskAccountNumber`, because /me has to mask the master value
    // and the pending requested value the same way and two copies of that rule would have drifted.
    // Both halves are asserted, so this stays a check that the mask EXISTS and is APPLIED on /me,
    // rather than a check that one file still contains a string.
    expect(
      read('lib/profile-requestable-fields.ts'),
      'the shared employee-account mask (maskAccountNumber) still truncates to four digits',
    ).toContain('`•••• ${String(no).slice(-4)}`');
    expect(read('app/me/page.tsx'), 'app/me still masks an employee account').toContain(
      'maskAccountNumber(st.bankAccountNo)',
    );
    // …and the pending value drawn beside it is masked by the same function, not printed in full.
    expect(
      read('app/me/request-change-card.tsx'),
      'a pending account number on /me is masked by the same rule as the master one',
    ).toContain('formatProposedValue(field, value, t, { mask: true })');
    expect(read('lib/audit-format.ts'), 'the audit formatter still masks sensitive values').toContain(
      '`•••• ${s.slice(-4)}`',
    );
  });
});

/**
 * Item 3c2f55d7 rev 2 — the company logo is edited the way the Personnel profile photo is.
 *
 * Same pencil-trigger popover (components/photo-edit-menu.tsx), moved to the TOP of the General tab, plus
 * the one thing the Personnel photo does not do: the picked file is PREVIEWED before it is saved. Storage,
 * the PNG/JPG rule and the 2 MB limit are server-side and untouched (test/company-logo.test.ts).
 */
describe('General tab: the company logo', () => {
  const island = read('components/company-logo.tsx');

  it('is the FIRST thing on the General tab', () => {
    const general = panel.indexOf("tab === 'general'");
    const logo = panel.indexOf('<CompanyLogoEdit');
    const details = panel.indexOf('action={actions.updateCompany}');
    expect(logo).toBeGreaterThan(general);
    expect(logo, 'logo above the company-information form').toBeLessThan(details);
  });

  it('reuses the Personnel photo affordance rather than inventing a second one', () => {
    expect(island).toContain("from './photo-edit-menu'");
    expect(island).toContain('<PhotoEditMenu');
  });

  it('previews the chosen file before saving, and never submits the preview', () => {
    expect(island).toContain('URL.createObjectURL');
    expect(island, 'the previous object URL is released').toContain('URL.revokeObjectURL');
    // The preview is local state; only the file input is posted, to the unchanged server action.
    expect(island).toContain('name="logo"');
    expect(island).toContain('accept="image/png,image/jpeg"');
  });

  /**
   * The popover renders its children behind `{open && …}` and its backdrop is `fixed inset-0`, so closing
   * it — including by clicking anywhere outside — unmounts the file input and discards the pick. A preview
   * that survived that left the reader looking at an unsaved image told to press a button that was no
   * longer on screen. The BEHAVIOUR is pinned by test/company-logo-edit.dom.test.tsx; this only keeps the
   * wiring from being quietly dropped.
   */
  it('drops the preview when the edit popover closes', () => {
    expect(island, 'the island tears the preview down').toContain('clearPreview');
    expect(island, 'and hands that teardown to the popover').toContain('onClose={clearPreview}');
    expect(read('components/photo-edit-menu.tsx'), 'the popover fires onClose on every close path').toMatch(
      /onClose\?\.\(\)/,
    );
  });

  it('takes every caption pre-translated, so the i18n key check still sees them on the panel', () => {
    expect(island).not.toContain('useTranslations');
    for (const k of ['logoEdit', 'logoHint', 'logoUpload', 'logoReplace', 'logoRemove', 'logoNone', 'logoPreviewPending']) {
      // logoPreviewPending takes an argument, so match the lookup, not a bare `t('key')`.
      expect(panel, k).toContain(`t('${k}'`);
      for (const loc of LOCALES) expect(orgOf(loc)[k], `${loc}: ${k}`).toBeTruthy();
    }
  });

  /**
   * The preview caption used to read "press Save to apply" — but the form's submit is captioned Upload
   * logo / Replace logo, and the only "Save" on the General tab belongs to the company-details form, which
   * does not touch the logo. The caption now interpolates whichever submit caption is actually rendered.
   */
  it('the preview caption names the submit button that is really on screen', () => {
    expect(panel).toMatch(
      /t\('logoPreviewPending',\s*\{\s*action:\s*c\.hasLogo \? t\('logoReplace'\) : t\('logoUpload'\),?\s*\}\)/,
    );
    for (const loc of LOCALES) {
      expect(orgOf(loc).logoPreviewPending, `${loc}: names the control`).toContain('{action}');
      expect(orgOf(loc).logoPreviewPending, `${loc}: no phantom Save`).not.toMatch(/\bSave\b/);
    }
  });
});
