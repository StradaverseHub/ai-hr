/**
 * 0386b95d (Documents) + 18719ded (Payroll) — the two items are ONE complaint reported twice: a
 * maintenance tab that does not look like the tab next to it. They name the same reference, the
 * Qualification tab, and they were built together so the result cannot drift apart tab by tab, which is
 * exactly how the inconsistency arose in the first place.
 *
 * WHY SOURCE ASSERTIONS. Every one of these sections except Documents and Basic Salary's history table is
 * rendered INLINE inside app/admin/personnel/[employmentId]/page.tsx, a 4100-line server component that
 * loads a dozen tables before it renders anything. Mounting it would exercise data loading, not the
 * layout this item is about — the same reasoning test/personnel-payroll-tab-order.test.ts already uses
 * for the card ORDER on this tab. What a reader SEES is covered by the two DOM files
 * (personnel-documents-tab-dialogs / personnel-payroll-tab-dialogs); this file pins the shape they all
 * share, section by section, against Qualification as the yardstick.
 *
 * The assertions are deliberately written as "the same string as section-qualification uses", not as a
 * description of that string. A future restyle of the Qualification tab that does not carry these along
 * fails here, which is the failure this pair of items exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'app', 'admin', 'personnel', '[employmentId]');
const PAGE = readFileSync(join(DIR, 'page.tsx'), 'utf8');
const DOCS_MANAGER = readFileSync(join(DIR, 'documents-manager.tsx'), 'utf8');
const DOCS_SECTION = readFileSync(join(DIR, 'documents-section.tsx'), 'utf8');
const SALARY_TABLE = readFileSync(join(__dirname, '..', 'components', 'salary-history-table.tsx'), 'utf8');

/** Comments removed, so an assertion about markup is not satisfied (or broken) by prose ABOUT that
 *  markup — this file's own "the <details> fold-out is gone" note is written in the source it checks. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The JSX of one `const <name> = admin … ? ( … ) : null;` card in page.tsx. */
function card(name: string): string {
  const start = PAGE.indexOf(`const ${name} = admin`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = PAGE.indexOf('\n  ) : null;', start);
  expect(end, `${name} has no closing ) : null;`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

// The header strip that carries a section's only Add control. Taken verbatim from section-qualification.
const ADD_STRIP = 'className="flex flex-wrap items-center justify-end gap-2 px-4 py-3"';
// The empty state, likewise.
const EMPTY_STATE = 'className="px-4 pb-4 text-sm text-muted-foreground"';

const PAYROLL_SECTIONS = [
  ['payComponentsCard', 'section-pay-components'],
  ['cp38Card', 'section-cp38'],
  ['compensationCard', 'section-compensation'],
] as const;

describe('Personnel tabs — Documents and Payroll wear the Qualification shape', () => {
  it('the yardstick is still what we think it is: section-qualification has header+count, an Add dialog and a plain table', () => {
    const qual = card('qualificationPanel');
    expect(qual).toContain('<Card id="section-qualification"');
    expect(qual).toContain('count={qualifications.length}');
    expect(qual).toContain(ADD_STRIP);
    expect(qual).toContain('<FamilyFormDialog triggerLabel={t(\'qualification.add\')}');
    expect(qual).toContain('<table className="w-full min-w-[52rem] text-left text-sm">');
  });

  it.each(PAYROLL_SECTIONS)('%s carries the same header strip and Add dialog as Qualification', (name, anchor) => {
    const src = card(name);
    expect(src).toContain(`<Card id="${anchor}"`);
    expect(src).toContain(ADD_STRIP);
    expect(src).toContain('<FamilyFormDialog');
  });

  it.each(PAYROLL_SECTIONS)('%s shows a record count beside its title', (name) => {
    expect(card(name)).toMatch(/<SectionHeader title=\{[^}]+\} count=\{/);
  });

  it('Documents shows the same header+count and Add dialog, and no disclosure anywhere', () => {
    expect(DOCS_SECTION).toContain('<Card id="section-documents"');
    expect(DOCS_SECTION).toMatch(/<SectionHeader title=\{t\('title'\)\} count=\{docs\.length\}/);
    expect(DOCS_MANAGER).toContain(ADD_STRIP);
    expect(DOCS_MANAGER).toContain("<FamilyFormDialog triggerLabel={t('addDocument')}");
    // The reported control must not come back.
    expect(stripComments(DOCS_MANAGER)).not.toContain('<details');
    expect(stripComments(DOCS_MANAGER)).not.toContain('<summary');
  });

  it('no maintenance section on the Documents or Payroll tabs hides its records behind a disclosure', () => {
    // Correction to this item's own build note, which said the Documents Add control was the only
    // <details> on the personnel page. There is a second one — the Direct Superior HISTORY list on the
    // Job tab (section-direct-superior) — and it is deliberately left alone: it discloses a read-only
    // history, not an Add control, and it is on neither tab either item reported. Scoping this assertion
    // to the four sections in scope says so out loud rather than letting a future reader "fix" it.
    for (const name of ['payComponentsCard', 'cp38Card', 'compensationCard', 'qualificationPanel']) {
      expect(stripComments(card(name)), name).not.toContain('<details');
    }
    expect(stripComments(SALARY_TABLE)).not.toContain('<details');
  });

  it('Pay Items and CP38 use the SAME empty-state line as Qualification instead of three different ones', () => {
    for (const name of ['qualificationPanel', 'payComponentsCard', 'cp38Card']) {
      expect(card(name), name).toContain(EMPTY_STATE);
    }
    expect(DOCS_MANAGER).toContain(EMPTY_STATE);
  });

  it('every payroll dialog form carries the STATIC tab tracker (Dialog.Portal escapes the tab shell)', () => {
    // Without this the shell's capture-phase submit listener never sees the form, and a save redirects
    // the admin back to the Profile tab. One per section: Pay Items, CP38, Basic Salary add.
    const trackers = PAGE.match(/<input type="hidden" name="tab" value="payroll" data-tab-tracker="" \/>/g) ?? [];
    expect(trackers.length).toBe(3);
    // …and the Basic Salary EDIT dialog, which lives in the history-table island.
    expect(SALARY_TABLE).toContain('<input type="hidden" name="tab" value="payroll" data-tab-tracker="" />');
    // Documents' four forms (add/edit share one, replace, delete) carry their own.
    expect(DOCS_MANAGER).toContain('<input type="hidden" name="tab" value="documents" data-tab-tracker="" />');
  });
});

describe('18719ded — the restyle did not touch a payroll figure or a guard', () => {
  it('money on the Payroll tab reads through ONE formatter, not a local toFixed', () => {
    // Pay Items and CP38 each used to call Number(x).toFixed(2) on the amount CELL, so the same figure
    // read "12000.00" there and "12,000.00" in Basic Salary two cards up.
    expect(card('payComponentsCard')).toContain('{fmtMoney(Number(pc.amount))}');
    expect(card('cp38Card')).toContain('{fmtMoney(Number(r.amount))}');
    // The formatter is declared ONCE, above the first card that uses it. Two declarations would be the
    // drift starting again.
    expect(PAGE.match(/const fmtMoney = \(n: number\) =>/g) ?? []).toHaveLength(1);
  });

  it('CP38 keeps its processed-batch refusal and its terminate action', () => {
    const cp38 = card('cp38Card');
    // cp38Error === 'processed' is a REAL refusal from the service (Cp38PeriodProcessedError), not a
    // validation hint — it must survive any restyle of this card.
    expect(cp38).toContain("cp38Error === 'processed'");
    expect(cp38).toContain("{t('cp38ProcessedError')}");
    expect(cp38).toContain('action={terminateCp38Action}');
  });

  it('every payroll section still posts to the server action it always posted to', () => {
    expect(PAGE).toContain('action={setEmploymentComponentAction}');
    expect(PAGE).toContain('action={r ? editCp38Action : addCp38Action}');
    expect(PAGE).toContain('action={setCompensationAction}');
    expect(SALARY_TABLE).toContain('action={editCompensationAction}');
    expect(SALARY_TABLE).toContain('action={supersedeCompensationAction}');
  });

  it('Pay Items deliberately has no per-row Edit, and says why', () => {
    // Re-stating an effective-dated pay item inside the month it already runs in leaves BOTH rows inside
    // the kernel's period window (validFrom <= periodEnd AND (validTo IS NULL OR validTo >= periodStart)),
    // so the item is counted twice. The reason is in the source; this pins that the button stays absent.
    const src = card('payComponentsCard');
    expect(src).toContain('NO per-row Edit here, deliberately');
    expect(src).not.toContain("triggerLabel={t('payComponentEdit')}");
  });
});
