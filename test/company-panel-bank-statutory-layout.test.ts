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

/** The StatutoryAuthorityCard component's source only — several assertions are about WHERE a thing is. */
const CARD_SRC = panel.slice(
  panel.indexOf('function StatutoryAuthorityCard'),
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
   * RETIRED: the blanket ban on `aria-expanded` anywhere in the file. The reporter's approved card
   * redesign puts one statutory body's FOURTEEN-FIELD EDITOR behind its card's Open/Edit — which is the
   * opposite trade from the four folds rev 1 removed, because the card face already states the body's
   * name, purpose and configured status with no click at all. So the ban narrows from "none" to "exactly
   * one, and it belongs to the statutory card": a re-added disclosure on the panel, a tab or a bank
   * account still fails here.
   */
  it('has no outer expand/collapse — the panel IS the page body', () => {
    expect(panel).not.toContain('defaultExpanded');
    expect(panel.match(/aria-expanded/g) ?? [], 'exactly ONE expandable thing in this file').toHaveLength(1);
    expect(CARD_SRC, 'and it is the statutory card Open/Edit').toContain('aria-expanded={open}');
  });

  it('the statutory editor is HIDDEN when collapsed, never UNMOUNTED', () => {
    // This is what keeps the fold honest: every field stays in the DOM (so a half-typed address survives
    // a collapse, and the render guard can still count all nine forms), and only CSS hides it. The
    // mistake it rules out is `{open && <form …>}`, which would drop the form from the tree entirely.
    expect(CARD_SRC).toContain("!open && 'hidden'");
    expect(CARD_SRC).not.toMatch(/\{\s*open\s*&&/);
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

  it('KEEPS the tabs — the fix flattens the folds, it does not flatten the screen', () => {
    // Tabs group a large screen; they do not gate it, and every tab stays mounted (hidden by CSS) so
    // an in-progress edit survives a tab switch. Collapsing these into one long scroll would be a
    // different, unrequested change.
    //
    // 3c2f55d7 rev 2 — the SET changed, on the reporter's instruction: General | Statutory | Other.
    // "Bank Account" stops being a tab of its own and becomes a section of Other, next to the default
    // payroll cycle, the group parent and archive/delete. (`tabBankAccount` stays in the six catalogues
    // unused, the way `tabPayroll` did after 94ae7e1f renamed that tab — the area still exists.)
    expect(panel).toContain('role="tablist"');
    expect(panel).toContain('role="tab"');
    for (const k of ['tabGeneral', 'tabStatutory', 'tabOther']) {
      expect(panel, k).toContain(`t('${k}')`);
    }
    expect(panel, 'Bank Account is a SECTION now, not a tab').not.toContain("t('tabBankAccount')");
    // The bank editor did not go anywhere — it moved under Other, in full.
    expect(panel).toContain("t('bankProfilesTitle')");
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
  it('renders one card per authority in the controlled set', () => {
    expect(panel.includes('STATUTORY_AUTHORITIES.map')).toBe(true);
    expect(panel.includes('<StatutoryAuthorityCard')).toBe(true);
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
 * Item 3c2f55d7 rev 2 — the statutory bodies read as CARDS.
 *
 * The complaint the redesign answers: nine authorities, each rendered as the same fourteen-field block,
 * one under the other. Nothing on screen told an HR admin which block was EPF and which was PTPTN except
 * a line of small text, so finding the right one meant scrolling and reading. The card face now carries
 * an icon, the body's name, a one-line description of what it is, and whether it has been configured —
 * and the form opens underneath on request.
 */
describe('Statutory tab: each body is a card (3c2f55d7 rev 2)', () => {
  it('renders a grid of cards, not a stack of forms', () => {
    expect(panel, 'the authority list is a responsive grid').toMatch(/grid grid-cols-1 gap-3 sm:grid-cols-2/);
    // An opened card takes the whole row so the form has somewhere to lay out.
    expect(CARD_SRC).toContain('sm:col-span-2');
  });

  it('gives every authority in the controlled set its own icon', () => {
    // A body with no entry falls back rather than rendering a blank tile, and THAT is asserted too — the
    // fallback is what makes adding an authority safe.
    const map = panel.slice(panel.indexOf('const AUTHORITY_ICON'), panel.indexOf('/** One tab trigger'));
    for (const a of STATUTORY_AUTHORITIES) {
      expect(map, `AUTHORITY_ICON.${a}`).toMatch(new RegExp(`\\b${a}:`));
    }
    expect(CARD_SRC).toContain('AUTHORITY_ICON[authority] ?? Landmark');
  });

  it('shows name, description and status on the card FACE — before any click', () => {
    const face = CARD_SRC.slice(0, CARD_SRC.indexOf('aria-expanded'));
    expect(face).toContain('t(`authority_${authority}` as never)');
    expect(face).toContain('t(`authorityDesc_${authority}` as never)');
    expect(face).toContain("t('authorityConfigured')");
    expect(face).toContain("t('authorityNotConfigured')");
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
      for (const k of ['authorityOpen', 'authorityClose']) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
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
    expect(CARD_SRC).toContain('<EmployeeSearchField');
    expect(CARD_SRC).toContain('name="signatoryPersonId"');
    // The old control, gone: a bare <select> over every candidate.
    expect(CARD_SRC).not.toMatch(/<select name="signatoryPersonId"/);
  });

  it('keeps a signatory who has since LEFT selectable, so an unrelated save cannot wipe them', () => {
    // EmployeeSearchField treats a value that is not in its option list as "no selection" — it would post
    // an empty string and clear the column. The former employee is therefore injected into the list.
    expect(CARD_SRC).toContain("t('authoritySignatoryFormer')");
    expect(CARD_SRC).toContain('signatoryOptions.unshift');
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
    expect(CARD_SRC).toContain("' · ' + bp.debitAccountNo");
    // …and the heading over each saved account under Other.
    expect(panel).toContain('{myBankLabel(bp.bank)} · {bp.debitAccountNo} · {bp.currency}');
  });

  it('the EMPLOYEE-facing masks elsewhere stay exactly as they were', () => {
    expect(read('app/me/page.tsx'), 'app/me still masks an employee account').toContain('`•••• ${no.slice(-4)}`');
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

  it('takes every caption pre-translated, so the i18n key check still sees them on the panel', () => {
    expect(island).not.toContain('useTranslations');
    for (const k of ['logoEdit', 'logoHint', 'logoUpload', 'logoReplace', 'logoRemove', 'logoNone', 'logoPreviewPending']) {
      expect(panel, k).toContain(`t('${k}')`);
      for (const loc of LOCALES) expect(orgOf(loc)[k], `${loc}: ${k}`).toBeTruthy();
    }
  });
});
