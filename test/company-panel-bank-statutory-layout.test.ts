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
import { readFileSync } from 'node:fs';
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
 * ⚠️ UPDATED BY 15e5bd93 (r352) — `CARD_SRC` was `StatutoryAuthorityCard`'s source, and that component is
 * gone: the reporter's approved redesign split it along the line its fold used to run down. Several
 * assertions in this file are about WHERE a thing is, so the slice becomes THREE, and every assertion
 * that used to name CARD_SRC now names the half it is really about. Nothing was widened to "the whole
 * panel" to make it pass — an assertion that cannot say which half it means is not a structure guard.
 *
 *   ROW_SRC       the rail entry: the body's FACE. Read-only, no controls, never collapses.
 *   EDITOR_SRC    the workspace pane: the body's fields, all open, and its Clear button.
 *   WORKSPACE_SRC both, for the handful of claims that are about the pair rather than one of them.
 */
const WORKSPACE_SRC = panel.slice(
  panel.indexOf('function StatutoryBodyRow'),
  panel.indexOf('export function CompanyPanel'),
);
const ROW_SRC = panel.slice(panel.indexOf('function StatutoryBodyRow'), panel.indexOf('function StatutoryBodyEditor'));

/**
 * COMMENTS STRIPPED — the r331 aec53564 lesson, and it bites here: `ROW_SRC` runs up to the editor's
 * `function` keyword, so it carries the editor's own doc comment, and that comment EXPLAINS why the form
 * keeps its `action` ("a `<form>` with no action at all would POST to the current URL"). A guard asserting
 * "the face contains no form" would read that sentence and fail on prose about the code. Every assertion
 * below that is about the absence of MARKUP runs on the stripped text.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
const EDITOR_SRC = panel.slice(
  panel.indexOf('function StatutoryBodyEditor'),
  panel.indexOf('export function CompanyPanel'),
);

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
   * behind its Open/Edit. The reporter has now asked for exactly that to go — "the current behaviour
   * opens the settings in a tab/expand-style interface, which makes the information less clear and less
   * convenient to view or edit" — so the eight bodies became a permanent rail and a workspace, and NOTHING
   * in this file expands any more. `authorityOpen` / `authorityClose` are no longer rendered either, which
   * is asserted here because a re-added toggle would most likely reach for them first.
   *
   * The two keys stay in the six catalogues, unused, the way `tabOther` / `tabPayroll` / `tabBankAccount`
   * each did in their turn — and `tabBankAccount` came back. A retired key costs nothing; re-translating
   * a deleted one into six languages costs a round.
   */
  it('has no expand/collapse anywhere in the panel — nothing on it folds (15e5bd93)', () => {
    expect(panel).not.toContain('defaultExpanded');
    expect(panel.match(/aria-expanded/g) ?? [], 'nothing in this file expands').toHaveLength(0);
    expect(panel, 'the per-body Open control is gone').not.toContain("t('authorityOpen')");
    expect(panel, 'and so is its Close').not.toContain("t('authorityClose')");
    // Selection replaced disclosure: the rail marks the chosen body instead of revealing it.
    expect(ROW_SRC, 'the rail row marks the CHOSEN body').toContain("aria-current={selected ? 'true' : undefined}");
  });

  /**
   * ⚠️ UPDATED BY 15e5bd93 — the CLAIM is unchanged and it is the load-bearing one: a body's fields stay
   * in the DOM whether or not you are looking at them. What changed is the condition. It was "collapsed"
   * (`!open`); it is now "not the body the rail has selected" (`!selected`), and the payoff is bigger than
   * before: the tab's ONE Save reads every body's fields out of the DOM, so an unmounted pane would be a
   * body whose edits cannot be saved at all rather than merely one whose half-typed address is lost.
   */
  it('a body the rail has not selected is HIDDEN, never UNMOUNTED', () => {
    expect(WORKSPACE_SRC).toContain("!selected && 'hidden'");
    // The mistake it rules out is `{selected && <form …>}`, which would drop the form from the tree.
    expect(WORKSPACE_SRC, 'no conditional MOUNTING of a body pane').not.toMatch(/\{\s*selected\s*&&\s*[<{]/);
    // …and the panel renders one editor per body, not one editor for the chosen body.
    expect(panel, 'every body gets an editor').toMatch(/STATUTORY_AUTHORITIES\.map\(\(a\) => \(\s*<StatutoryBodyEditor/);
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
   * ⚠️ UPDATED BY 15e5bd93 — one card per authority became one RAIL ROW plus one WORKSPACE EDITOR per
   * authority, so the count claim is asserted twice over rather than dropped. Both maps run over the
   * controlled set, so a body cannot appear in the rail without its editor or the other way round.
   */
  it('renders one rail row AND one workspace editor per authority in the controlled set', () => {
    // Both maps run over the controlled set itself — never over a filtered or sliced copy of it, which is
    // how a body would vanish from one column while staying in the other.
    expect(
      panel.match(/STATUTORY_AUTHORITIES\.map\(\(a\) => \(\s*<StatutoryBody(Row|Editor)/g) ?? [],
      'the rail and the workspace',
    ).toHaveLength(2);
    expect(panel.includes('<StatutoryBodyRow')).toBe(true);
    expect(panel.includes('<StatutoryBodyEditor')).toBe(true);
    // The old one-component shape must not come back with the fold in it.
    // Comments stripped: the new components' own doc comment NAMES the component it replaced, and that
    // record is exactly what must survive (the r331 aec53564 lesson again).
    expect(stripComments(panel), 'the folding card is retired').not.toContain('StatutoryAuthorityCard');
  });

  it('keeps the statutory IDENTITY form alongside it (the two are different things)', () => {
    expect(panel.includes("t('statutoryIdentityMY')")).toBe(true);
    expect(panel.includes("t('authoritiesTitle')")).toBe(true);
  });

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
    it(`${input} is present in the authority form`, () => {
      expect(panel.includes(input)).toBe(true);
    });
  }

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
   * 15e5bd93 (r352) — THE SECOND DOOR TO THE SAME ROW. The Statutory tab's consolidated Save reaches
   * `company_statutory_my` too, so every claim in this block about "the action half" is now a claim about
   * TWO files, and both are asserted. A partial-patch writer with one presence-checked caller and one
   * collapsing caller is a partial-patch writer that still loses data.
   */
  const TAB_ACTION = read('app/admin/organization/statutory-tab-actions.ts');

  it('puts EPF, SOCSO and LHDN filing numbers on their own card, and nobody else', () => {
    const map = panel.slice(panel.indexOf('const MY_FILING_FIELD'), panel.indexOf('function StatutoryBodyRow'));
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
    // The reason SSM may not be filed under a payment card: two statutory files read it.
    expect(read('localization/my/borang-8a.ts')).toContain('companyStatutoryMy.ssmRegistrationNo');
    expect(read('localization/my/socso-eis-file.ts')).toContain('companyStatutoryMy.ssmRegistrationNo');
  });

  it('labels the two numbers so the card says which is which', () => {
    // The reporter's complaint was that a body had one number on its card and a different number for the
    // same body in a list above it, with nothing on screen saying they were different things.
    expect(EDITOR_SRC).toContain("t('authorityFilingSection')");
    expect(EDITOR_SRC).toContain("t('authorityFilingHint')");
    expect(EDITOR_SRC).toContain("t('authorityPaymentSection')");
    expect(EDITOR_SRC).toContain("t('authorityAccountNo')");
    /**
     * 15e5bd93 — THE THREE GROUPS THE REPORTER APPROVED, and the third one is new only as a HEADING. The
     * address run was the one block of this form with no heading at all; the drawing gives it one. Nothing
     * was added, removed, renamed or re-validated — every box under each heading is a box that was there.
     *
     * HRD Corp's first group stays "Registration", not "Filing identity": its control is a band that
     * decides whether the levy is charged, not a number on a filed form, and r226 removed that exact
     * mislabelling once already.
     */
    expect(EDITOR_SRC, 'the address run finally has a heading').toContain("t('authorityAddressSection')");
    expect(EDITOR_SRC).toContain("t('authorityPaymentHint')");
    expect(EDITOR_SRC).toContain("t('authorityAddressHint')");
    expect(EDITOR_SRC, "HRD Corp's band is not filed under a filing-number caption").toContain(
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
    expect(EDITOR_SRC).toContain("t('authorityEisSharesSocso')");
    const map = panel.slice(panel.indexOf('const MY_FILING_FIELD'), panel.indexOf('function StatutoryBodyRow'));
    expect(map, 'EIS gets no second input on the same column').not.toMatch(/\beis:/);
  });

  it('HRD Corp keeps its rate select — moved onto its card, not duplicated', () => {
    expect(EDITOR_SRC).toContain('name="hrdfStatus"');
    // Exactly one hrdfStatus control in the panel: the old flat identity form must not still carry one.
    expect(panel.match(/name="hrdfStatus"/g) ?? [], 'one HRDF control, on the HRD Corp card').toHaveLength(1);
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
     * 15e5bd93 — AND THE SAME ON THE TAB SAVE'S SIDE. It unpacks each card's own FormData and hands it to
     * the same services, so it needs the identical "absent means leave as-is" read. The two helpers are
     * deliberate duplicates (a `'use server'` module cannot export a non-async function, and hoisting this
     * one would move a contract this very case pins by name) — so what stops them drifting is this pair of
     * assertions, not a shared import.
     */
    expect(TAB_ACTION, 'the tab save reads presence too').toContain(
      'function postedField(formData: FormData, key: string)',
    );
    expect(TAB_ACTION).toContain('formData.has(key)');
    expect(TAB_ACTION, 'and never collapses an absent key to a blank').not.toMatch(
      /epfEmployerNo:\s*\(?\w*\.?get\('epfEmployerNo'\)/,
    );
    // Both callers pass the SAME set of names to the writer, so neither can quietly stop patching one.
    for (const field of ['epfEmployerNo', 'socsoEmployerCode', 'lhdnEmployerNo', 'myinvoisTin', 'ssmRegistrationNo']) {
      expect(TAB_ACTION, `the identity section writes ${field} by presence`).toContain(
        `${field}: postedField(fd, '${field}')`,
      );
    }
  });

  it('the card posts its filing field under a name that cannot collide with the address country', () => {
    // `country` is already taken on this form by the authority's postal address (a country NAME from the
    // ISO list). Reusing it for the statutory-pack lookup would post "Malaysia" into packFor().
    expect(EDITOR_SRC).toContain('name="filingCountry"');
    expect(ACTIONS).toContain("formData.get('filingCountry')");
    expect(TAB_ACTION, 'the tab save reads the same flag').toContain("fd.get('filingCountry')");
    expect(EDITOR_SRC).toContain('name="country"'); // the address field, untouched
  });

  /**
   * 15e5bd93 — THE BODY A SECTION WRITES IS THE SECTION ID, NOT THE FORM'S OWN HIDDEN COPY.
   *
   * Nine hidden `authority` inputs in one payload are nine chances for a crafted request to point one
   * body's write at another body's row. The section id has already been checked against the closed
   * vocabulary, so it is the trustworthy value — the same move `companySectionFormData` makes for the
   * company id, and for the same reason. The hidden input stays on the form because the per-body action
   * (still bound, still the writer the submit guard intercepts) reads it.
   */
  it('the tab save takes the authority from the validated section id, not from the payload', () => {
    expect(TAB_ACTION).toContain('async function applyAuthoritySection(s: Session, authority: string, fd: FormData)');
    expect(TAB_ACTION, 'the id is what is written').toContain('authority,');
    expect(TAB_ACTION, 'the hidden copy is never read').not.toContain("fd.get('authority')");
    // The vocabulary is a closed list and an unknown section is refused before anything is written.
    expect(TAB_ACTION).toContain('COMPANY_STATUTORY_TAB_SECTION_ORDER');
    expect(TAB_ACTION).toContain('return { ok: false, saved: [], failedSection: unknown[0]');
    // …and the company is forced from the one trusted top-level value.
    expect(TAB_ACTION).toContain("out.set('companyId', companyId)");
    expect(TAB_ACTION).toContain("if (field === 'companyId' || field === 'id') continue;");
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
    expect(WORKSPACE_SRC, 'the row no longer spans grid columns').not.toContain('xl:col-span-3');
  });

  /**
   * 15e5bd93 — THE LIST IS A RAIL AND IT NEVER COLLAPSES, WITH THE FIELDS BESIDE IT.
   *
   * The reporter's words: the settings open "in a tab/expand-style interface, which makes the information
   * less clear and less convenient to view or edit". The approved drawing
   * (docs/mockups/15e5bd93-statutory-workspace.html) answers it with a permanent left-hand list and a
   * workspace on the right that fills with ALL of the selected body's fields, already open.
   *
   * Pinned at source because the failure mode is a later round "tidying" the two columns back into one
   * stack — which no behavioural test would notice, because every field is in the DOM either way.
   */
  it('the rail and the workspace are two columns, and the rail is a <nav> that is always drawn', () => {
    const pane = panel.slice(panel.indexOf("cn('space-y-4', tab === 'statutory'"), panel.indexOf('{/* end Statutory tab */}'));
    expect(pane, 'two columns on a wide screen, stacked on a narrow one').toContain('flex flex-col gap-4 lg:flex-row');
    expect(pane, 'the rail is a fixed-width column of its own').toContain('lg:w-72');
    expect(pane, 'and it is navigation, not decoration').toMatch(/<nav aria-label=\{t\('authoritiesTitle'\)\}>/);
    expect(pane, 'the workspace takes the rest').toContain('min-w-0 flex-1');
    // The rail is never behind a condition of its own: only `isMY` decides whether the tab has one at all.
    expect(pane, 'the rail is not conditional on a selection').not.toMatch(/\{\s*statutoryBody\s*&&/);
    // Selection is CLIENT state — no per-body route, so no new row in the function-access matrix.
    expect(panel).toContain('const [statutoryBody, setStatutoryBody] = useState<string>(STATUTORY_AUTHORITIES[0])');
  });

  /**
   * 15e5bd93 — ONE SAVE FOR THE WHOLE TAB, and the registrations card is inside it.
   *
   * This is the half that resolves 65b22c00's finding 1 (docs/audits/…): that round consolidated three of
   * the screen's four bucket (a) forms and left the SSM / MyInvois card with its own button, because a
   * scope on this tab would have sat above eight body editors it did not own. The bodies have no Save
   * buttons of their own now, so it does. The card did NOT move off this tab — r226's placement is pinned
   * two describes up and still passes.
   */
  it('the tab has ONE Save, and every card under the bar carries a section marker', () => {
    const pane = panel.slice(panel.indexOf("cn('space-y-4', tab === 'statutory'"), panel.indexOf('{/* end Statutory tab */}'));
    expect(pane).toContain('<TabSaveScope');
    expect(pane).toContain('tabKey="statutory"');
    expect(pane).toContain('saveAction={actions.saveStatutoryTab}');
    // The bar names what it covers AND which bodies moved — see TabSaveScope's `covers` / `sectionLabels`.
    expect(pane).toContain("covers={[t('authoritiesTitle'), t('statutoryIdentityMY')]}");
    expect(pane).toContain('sectionLabels={statutorySectionLabels}');
    // Each body editor is a section named for the body, so a partial failure can say WHICH body failed.
    expect(EDITOR_SRC).toContain('data-save-section={authority}');
    // The registrations card is a section too, and it is the id the server vocabulary declares.
    expect(pane).toContain('data-save-section={STATUTORY_IDENTITY_SECTION}');
    // …and the per-body Save button is gone, which is what "one Save" means.
    expect(panel, 'no per-body Save button').not.toContain("t('authoritySave')");
    expect(panel, 'no second Save on the registrations card').not.toContain("t('saveStatutoryIdentity')");
    // "Clear this authority" DELETES a row: bucket (b), its own button, outside every section marker.
    expect(EDITOR_SRC).toContain("t('authorityClear')");
    const clear = EDITOR_SRC.slice(EDITOR_SRC.indexOf('<form action={removeAction}>'));
    expect(clear, 'the Clear form is not part of the tab Save').not.toContain('data-save-section');
    expect(clear, 'and it keeps its own control').toMatch(/<button\b/);
  });

  /**
   * 15e5bd93 — THE PACK FLAG ON THE REGISTRATIONS CARD IS `filingCountry`, NOT `country`, AND THIS IS A
   * DATA GUARD RATHER THAN A NAMING ONE.
   *
   * `lib/tab-save-dom.ts` `syncCarriedValues` treats a HIDDEN input as a mirror of any VISIBLE control
   * with the same name in a sibling section of the same scope, and copies the visible value into it — the
   * behaviour the personnel cards need. Every statutory body's editor carries a visible `country` for its
   * postal address (a country NAME from the ISO list). So the moment the registrations card joined this
   * scope, a hidden `name="country"` on it would have been overwritten with "Malaysia" and posted into
   * `packFor()`. That is exactly the collision r226 named one file over, which is why the flag reuses the
   * name r226 coined for it.
   */
  it('the registrations card posts its pack flag under a name no address field can collide with', () => {
    const pane = panel.slice(panel.indexOf("cn('space-y-4', tab === 'statutory'"), panel.indexOf('{/* end Statutory tab */}'));
    const form = pane.slice(pane.indexOf('data-save-section={STATUTORY_IDENTITY_SECTION}'), pane.indexOf('</form>'));
    expect(form).toContain('<input type="hidden" name="filingCountry" value="MY" />');
    expect(form, 'a hidden country here would be overwritten by a body address').not.toContain('name="country"');
    // And the consolidated writer reads that name.
    expect(read('app/admin/organization/statutory-tab-actions.ts')).toContain("fd.get('filingCountry')");
  });

  /**
   * ⚠️ SOCSO AND EIS READ AS ONE GROUP AND STAY TWO RECORDS, which is the whole of efe424b0's
   * consolidation. Measured on production: their payment accounts genuinely differ (one company pays
   * SMSB_EIS and SMSB_SOCSO), so a single card backed by SOCSO's row would leave EIS's account on file
   * with no screen able to edit it.
   */
  it('draws EIS beneath SOCSO as a subordinate row, still with its own editor', () => {
    expect(panel, 'EIS is marked subordinate, not filtered out').toContain(
      "subordinate={c.country === 'MY' && a === 'eis'}",
    );
    // NOT removed from the controlled set: the services and the payroll feed still know it.
    expect(STATUTORY_AUTHORITIES).toContain('eis');
    // Indented, and without a second copy of the mark its group head already carries.
    expect(ROW_SRC).toContain("subordinate && 'pl-6'");
    expect(ROW_SRC).toContain('{subordinate ? (');
    // Its own authority value still posts, so its own record is what the form writes.
    expect(EDITOR_SRC).toContain('<input type="hidden" name="authority" value={authority} />');
  });

  it('gives every authority in the controlled set its own icon', () => {
    // A body with no entry falls back rather than rendering a blank tile, and THAT is asserted too — the
    // fallback is what makes adding an authority safe.
    const map = panel.slice(panel.indexOf('const AUTHORITY_ICON'), panel.indexOf('/** One tab trigger'));
    for (const a of STATUTORY_AUTHORITIES) {
      expect(map, `AUTHORITY_ICON.${a}`).toMatch(new RegExp(`\\b${a}:`));
    }
    expect(ROW_SRC).toContain('AUTHORITY_ICON[authority] ?? Landmark');
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
    expect(EDITOR_SRC, 'the summary is not moved into the one-body-at-a-time pane').not.toContain('summary.map(');
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
      // ⚠️ 15e5bd93 — `authorityOpen` / `authorityClose` are RETIRED, not deleted: nothing renders them
      // since the fold went (asserted at the top of this file), and they stay in all six catalogues the
      // way `tabOther`, `tabPayroll` and `tabBankAccount` each did — `tabBankAccount` came back. Keeping
      // them asserted PRESENT is the point: a future round must not tidy away a string this screen has
      // already needed twice.
      for (const k of ['authorityOpen', 'authorityClose', 'authorityValueNotSet']) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
      }
      // 15e5bd93 — the three group headings, and the retired per-body Save captions kept alongside them.
      for (const k of ['authorityAddressSection', 'authorityAddressHint', 'authorityPaymentHint']) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
      }
      for (const k of ['authoritySave', 'saveStatutoryIdentity']) {
        expect(org[k], `${loc}: ${k} is retired, not deleted`).toBeTruthy();
      }
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
    expect(panel).toContain("from './employee-search-field'");
    expect(EDITOR_SRC).toContain('<EmployeeSearchField');
    expect(EDITOR_SRC).toContain('name="signatoryPersonId"');
    // The old control, gone: a bare <select> over every candidate.
    expect(EDITOR_SRC).not.toMatch(/<select name="signatoryPersonId"/);
  });

  it('keeps a signatory who has since LEFT selectable, so an unrelated save cannot wipe them', () => {
    // EmployeeSearchField treats a value that is not in its option list as "no selection" — it would post
    // an empty string and clear the column. The former employee is therefore injected into the list.
    expect(EDITOR_SRC).toContain("t('authoritySignatoryFormer')");
    expect(EDITOR_SRC).toContain('signatoryOptions.unshift');
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
    // The "Paid from" picker on each authority card…
    expect(EDITOR_SRC).toContain("' · ' + bp.debitAccountNo");
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
