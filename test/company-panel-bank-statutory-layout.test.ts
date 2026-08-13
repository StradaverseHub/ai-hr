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

  it('has no outer expand/collapse either — the panel IS the page body', () => {
    expect(panel).not.toContain('defaultExpanded');
    expect(panel).not.toContain('aria-expanded');
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
    expect(panel).toContain('role="tablist"');
    expect(panel).toContain('role="tab"');
    for (const k of ['tabGeneral', 'tabBankAccount', 'tabStatutory']) {
      expect(panel, k).toContain(`t('${k}')`);
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
