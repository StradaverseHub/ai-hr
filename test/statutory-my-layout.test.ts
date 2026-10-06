/**
 * Personnel (Admin) → Statutory (Malaysia) screen layout redesign (feedback 7524eda1),
 * updated for R24 40ef71a0: the Statutory (Malaysia) card was relocated into its own dedicated
 * "Bank & Statutory" tab. The card definition (const statutoryCard) is unchanged — only its render
 * location moved from the Payroll tab to the Bank & Statutory tab.
 *
 * The single `setStatutoryAction` form is a FULL-ROW overwrite, so every named input must stay mounted
 * at all times — a field absent from the POST silently wipes stored data.
 *
 * This is a DB-free static-source guard (same style as `test/personnel-links.test.ts`). It fails loudly
 * if a future edit (a) removes statutory from the Bank & Statutory tab, (b) drops one of the required
 * statutory inputs (the full-overwrite wipe trap), or (c) reintroduces a zakat input (undoing 58755260).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const page = read('app/admin/personnel/[employmentId]/page.tsx');
const identityTaxCard = read('components/identity-tax-card.tsx');

/**
 * Item 35b7af0a group 4 moved EPF Number + EPF Citizenship out of this page and into a shared field group
 * rendered by BOTH this screen and the Create New Employee wizard. The inputs did not change — in
 * `mode="form"` the group still emits plain `name` + `defaultValue` inputs, and it is still rendered inside
 * the single <form action={setStatutoryAction}>, so the full-row overwrite still carries them.
 *
 * The wipe guard therefore FOLLOWS the fields into the component rather than dropping the two assertions.
 * Dropping them is the tempting fix and the wrong one: these are the assertions that catch a field
 * vanishing from the POST, which silently wipes stored data. Extraction is not deletion, so the guard has
 * to learn where the inputs went. The `mode="form"` check below is the other half — a controlled-mode
 * render would emit `value`/`onChange` and NO `name`, quietly leaving the field out of the overwrite while
 * the raw string `name="epfNumber"` still existed in the component file.
 */
const epfRegistrationFields = read('components/epf-registration-fields.tsx');
// 35b7af0a group 7 — SOCSO/EIS moved into a shared group, exactly as EPF did at group 4. Its source
// joins the wipe-guard corpus below for the same reason: the inputs still POST, they are just declared
// one file across.
const socsoEisFields = read('components/socso-eis-fields.tsx');
const statutoryFormSources = page + epfRegistrationFields + socsoEisFields;

describe('Statutory (Malaysia) layout: lives in the Bank & Statutory tab', () => {
  it('renders {bankCard} + {statutoryCard} in the bankStatutory tab panel, with Identity/Tax merged into statutoryCard', () => {
    // R24 40ef71a0 relocated statutory into its own Bank & Statutory tab. Item ef720d3a split the bank fields
    // into a dedicated Bank Information card. Item 8b5334db split the tax fields into an Identification & Tax card.
    // R45 df09f22a then MERGED that Identity/Tax card into statutoryCard as a nested "Income Tax (PCB)" section
    // (income tax is a Malaysia statutory item), so it is no longer a standalone panel entry — the
    // <IdentityTaxCard embedded> island is now rendered inside the statutoryCard definition.
    const start = page.indexOf('bankStatutory: (');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf('),', start);
    const panel = page.slice(start, end);
    expect(panel.includes('{bankCard}')).toBe(true);
    expect(panel.includes('{statutoryCard}')).toBe(true);
    expect(panel.includes('{identityTaxCard}')).toBe(false);
    // The Identity/Tax island still exists, now embedded inside statutoryCard.
    expect(page.includes('<IdentityTaxCard')).toBe(true);
    expect(page.includes('embedded')).toBe(true);
  });

  it('keeps the remaining payroll cards in the payroll tab panel', () => {
    const start = page.indexOf('payroll: (');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf('),', start);
    const panel = page.slice(start, end);

    for (const token of [
      '{payComponentsCard}',
      '{cp38Card}',
      '{encashmentCard}',
      '{payrollPolicyCard}',
      '{compensationCard}',
    ]) {
      expect(panel.indexOf(token), `${token} should exist in the payroll panel`).toBeGreaterThan(-1);
    }
  });

  it('keeps Compensation as a standalone card (no longer bundled with statutory)', () => {
    expect(page.includes('const statutoryCard')).toBe(true);
    expect(page.includes('const compensationCard')).toBe(true);
    // The old merged const must be gone.
    expect(page.includes('compAndStatutoryCards')).toBe(false);
  });
});

describe('Statutory (Malaysia) layout: every statutory input stays mounted (full-overwrite wipe guard)', () => {
  const requiredInputs = [
    'name="employmentId"',
    'name="personId"',
    'name="epfNumber"',
    'name="socsoNumber"',
    // Item ef720d3a — bankName/bankAccountNo moved OUT of this full-overwrite form into the dedicated Bank
    // Information card. Item 8b5334db — icNumber/taxNumber/taxCategory/numChildren/isResident moved OUT too:
    // IC to its own Profile-tab form (setIcAction) and the tax fields to the dedicated Identification & Tax card
    // (setTaxAction). setStatutoryAction now passes those stored values through unchanged so they can't be wiped.
    // Item a7271737 — the Subject-to-SOCSO and Subject-to-EIS checkboxes were consolidated INTO the
    // SOCSO/EIS category selects (the single per-scheme control); setStatutoryAction derives the legacy
    // subject_to_socso / eis_eligible booleans from these on save, so it's the selects that must stay mounted.
    'name="socsoCategory"',
    'name="eisCategory"',
    'name="epfCitizenship"',
    'name="tp3Year"',
    'name="tp3NetRemuneration"',
    'name="tp3EpfClaimed"',
    'name="tp3PcbPaid"',
  ];

  /**
   * A field is mounted whether it is written as a JSX attribute (`name="epfNumber"`) or as a form-mode
   * prop object that a shared field group spreads onto the input (`name: 'epfNumber'`, 35b7af0a group 4).
   * Both compile to the same posted input, so both satisfy the wipe guard; accepting only the first
   * spelling would fail every future field extraction for a purely cosmetic reason.
   */
  const isMounted = (attr: string): boolean => {
    const field = attr.slice('name="'.length, -1);
    return (
      statutoryFormSources.includes(`name="${field}"`) ||
      statutoryFormSources.includes(`name: '${field}'`)
    );
  };

  for (const input of requiredInputs) {
    it(`${input} is still present in the statutory form`, () => {
      expect(isMounted(input)).toBe(true);
    });
  }

  it('renders the shared EPF field group in form mode, inside the setStatutoryAction form', () => {
    // Both halves matter. The group must be rendered here at all (otherwise the two EPF inputs are simply
    // absent from the POST no matter what the component file contains), and it must be rendered in FORM
    // mode (controlled mode emits value/onChange and no `name`, so the full-row overwrite would wipe both
    // columns while every string assertion above still passed).
    const at = page.indexOf('<EpfRegistrationFields');
    expect(at, '<EpfRegistrationFields is rendered by the statutory card').toBeGreaterThan(-1);
    const tag = page.slice(at, page.indexOf('/>', at));
    expect(tag, 'rendered in form mode, not controlled mode').toContain('mode="form"');

    const formStart = page.lastIndexOf('<form action={setStatutoryAction}', at);
    expect(formStart, 'the group sits inside the setStatutoryAction form').toBeGreaterThan(-1);
    expect(
      page.indexOf('</form>', formStart),
      'the group is rendered before that form closes',
    ).toBeGreaterThan(at);
  });

  it('renders the shared SOCSO/EIS group in form mode, inside the setStatutoryAction form', () => {
    // 35b7af0a group 7, and the SAME three facts the EPF assertion above checks — because the string
    // assertions alone are now satisfiable by the component file while the page renders nothing, or
    // renders it in controlled mode, which emits value/onChange and NO `name`. On a full-row overwrite
    // that silently clears socso_number, socso_category and eis_category. This is a wipe guard: it must
    // get harder when a field is extracted, not softer.
    const at = page.indexOf('<SocsoEisFields');
    expect(at, '<SocsoEisFields is rendered by the statutory card').toBeGreaterThan(-1);
    const tag = page.slice(at, page.indexOf('/>', at));
    expect(tag, 'rendered in form mode, not controlled mode').toContain('mode="form"');

    const formStart = page.lastIndexOf('<form action={setStatutoryAction}', at);
    expect(formStart, 'the group sits inside the setStatutoryAction form').toBeGreaterThan(-1);
    expect(
      page.indexOf('</form>', formStart),
      'the group is rendered before that form closes',
    ).toBeGreaterThan(at);
  });
});

describe('Identification & Tax card (item 8b5334db): IC relocated to Profile, tax fields in the dedicated card', () => {
  it('IC has its own Profile-tab form (setIcAction) with the icNumber input', () => {
    // Item e3ce0d4d — the IC form lives in the nationality-conditional IdentityFields client
    // component; the Profile tab wires it via setIcAction={setIcAction}.
    expect(page.includes('setIcAction={setIcAction}')).toBe(true);
    const identity = read('components/personnel-identity.tsx');
    expect(identity.includes('action={setIcAction}')).toBe(true);
    // 35b7af0a group 8 — the INPUT moved into the shared identity group (the wizard renders the same one),
    // so the three facts that keep this form posting are checked where each of them now lives: the named
    // input exists in the shared component, this form renders that component, and it renders it in the
    // mode that posts. Dropping any one of them silently turns a Save into a no-op.
    expect(read('components/identity-fields.tsx').includes('name="icNumber"')).toBe(true);
    expect(identity.includes('<IdentityNumberField')).toBe(true);
    expect(identity.match(/<IdentityNumberField[\s\S]*?\/>/)![0].includes('mode="form"')).toBe(true);
  });

  it('the Identification & Tax card carries the tax inputs (setTaxAction)', () => {
    expect(page.includes('action={setTaxAction}') || identityTaxCard.includes('action={action}')).toBe(true);
    // taxCategory is NOT in this list any more — 35b7af0a group 6 extracted it into a shared component so
    // the Create Employee wizard renders the identical control. It is asserted separately below.
    for (const input of ['name="taxNumber"', 'name="taxResidency"', 'name="numChildren"', 'name="employerBearsTax"']) {
      expect(identityTaxCard.includes(input), `${input} should exist in identity-tax-card.tsx`).toBe(true);
    }
    // childReliefMode is NOT in the list above any more — item a72610af extracted it, with the two OKU
    // selects, into components/tax-relief-fields.tsx so the Create New Employee draft renders the
    // identical controls. THE CARD STILL POSTS ALL THREE, which is what is asserted here: the card
    // renders the shared controls in `form` mode, and the shared file is what carries their names. A
    // control that stopped posting would turn this card's Save into a silent no-op for that field.
    const reliefGroup = read('components/tax-relief-fields.tsx');
    expect(identityTaxCard).toContain('<ChildReliefModeField mode="form"');
    expect(identityTaxCard).toContain('<DisabledReliefField mode="form" field="disabledIndividual"');
    expect(identityTaxCard).toContain('<DisabledReliefField mode="form" field="disabledSpouse"');
    expect(reliefGroup, 'the shared group posts childReliefMode in form mode')
      .toContain("name: props.name ?? 'childReliefMode'");
    expect(reliefGroup, 'and posts each OKU claim under its own field name').toContain('name: props.field');
  });

  /**
   * ⚠️ A GUARD THAT READS ONE FILE'S SOURCE BREAKS WHEN A FIELD IS EXTRACTED INTO A COMPONENT, AND THE
   * TEMPTING FIX DELETES THE PROTECTION. This is the r159 lesson applied to its own next occurrence.
   *
   * `name="taxCategory"` stopped appearing in identity-tax-card.tsx when group 6 moved the control into
   * components/tax-category-field.tsx. Dropping the assertion would have been wrong: this is a card whose
   * action reads the field out of FormData, so a field that stops posting silently stops being saved.
   *
   * Following the string alone would also be wrong — the component contains the name whether or not the
   * card still renders it, and the component's `controlled` mode emits value/onChange with NO name at all.
   * So the guard needs all THREE facts, exactly as r159 recorded:
   *   ① the field exists in the component,
   *   ② the card renders that component,
   *   ③ it renders it in the mode that actually posts.
   */
  it('the extracted Tax Category still POSTS from this card (all three facts, per r159)', () => {
    const field = read('components/tax-category-field.tsx');
    expect(field.replace(/\s/g, '').includes("name={props.name??'taxCategory'}"), '① the field exists in the component').toBe(
      true,
    );
    expect(field, 'the mapped integer posts through a hidden input').toMatch(/<input\b[^>]*type="hidden"[^>]*name=\{props\.name\s*\?\?\s*'taxCategory'\}[^>]*value=\{numeric\}/);
    expect(field, 'the detailed circumstance also posts in form mode').toMatch(/name=\{props\.mode\s*===\s*'form'\s*\?\s*'taxCircumstance'\s*:\s*undefined\}/);
    expect(identityTaxCard.includes('<TaxCategoryField'), '② the card renders the component').toBe(true);
    const call = identityTaxCard.match(/<TaxCategoryField[\s\S]*?\/>/);
    expect(call, 'the card must render TaxCategoryField').not.toBeNull();
    expect(call![0].includes('mode="form"'), '③ in the mode that posts, not the controlled one').toBe(true);
  });

  it('exposes the four Income Tax Resident options incl. the new REP / Knowledge Worker statuses', () => {
    // r393 (685d2380 step 3b) — the options moved one file further, into components/tax-residency-field.tsx,
    // so the Create New Employee draft offers the same choices; the card renders that select in FORM mode
    // (test/r393-draft-statutory.dom.test.tsx §5 pins the markup byte for byte). Asserted where each now lives.
    const residency = read('components/tax-residency-field.tsx');
    expect(identityTaxCard).toContain('<TaxResidencySelect key={taxContextKey} mode="form"');
    for (const v of ['value="resident"', 'value="non_resident"', 'value="rep"', 'value="knowledge_worker"']) {
      expect(residency.includes(v), `${v} should exist in the residency select`).toBe(true);
    }
    expect(residency).toContain("name={none?undefined:'taxResidency'}");
  });
});

describe('Statutory (Malaysia) layout: grouped section headers exist', () => {
  // Item 5a461b99 put SOCSO & EIS in its own bordered card (socsoEisCardTitle). Item 8b5334db — the identity/tax
  // group left the statutory form for its own card, so only the SOCSO/EIS header remains on this form.
  for (const key of ['socsoEisCardTitle']) {
    it(`uses the ${key} group label`, () => {
      expect(page.includes(`t('${key}')`)).toBe(true);
    });
  }
});

describe('Statutory (Malaysia) layout: zakat inputs stay relocated (58755260 invariant)', () => {
  for (const zakat of [
    'name="zakatActive"',
    'name="zakatAmount"',
    'name="zakatEffectiveFrom"',
    'name="zakatEffectiveTo"',
  ]) {
    it(`does not reintroduce ${zakat}`, () => {
      expect(page.includes(zakat)).toBe(false);
    });
  }
});
