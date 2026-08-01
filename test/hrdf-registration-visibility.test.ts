/**
 * Feedback efece4ce (re-fix) — "HRDF not calculated and not displayed".
 *
 * The levy itself is NOT broken, and this file deliberately does not touch it: hrdfLevy/hrdfSubject are
 * pinned by test/hrdf-levy.test.ts and test/hrdf-subject.test.ts, and a verified production run
 * (2026-08, Chin Hin Construction Engineering) carries hrdf = 56.00. What was broken is that every way
 * the product could have TOLD the reporter why they saw nothing was silent:
 *
 *   1. An employee can be set "Subject to HRDF = Yes" while their company has no HRDF Contribution Rate.
 *      hrdfSubject honours the explicit flag, then hrdfLevy rates 'not_registered' to 0 — the tick is
 *      accepted and discarded, with no message anywhere. (Asserted below as the CONTRADICTION the screen
 *      now has to warn about; it is the existing, correct behaviour of the calculators.)
 *   2. The payroll surfaces hid the HRDF figure whenever it was 0, so "this company is not registered"
 *      and "the calculation never ran" rendered identically — as nothing.
 *   3. Nothing listed the companies with no statutory record at all, which is how six of eight ended up
 *      unregistered without anyone noticing.
 *
 * So the guards here are presentation guards: (a) the employee Bank & Statutory screen warns on the
 * contradiction WITHOUT re-introducing the 57840a6e defect (the company band must never reach the
 * select's defaultValue); (b) both payroll surfaces state "not registered" instead of hiding a zero;
 * (c) the Organization screen lists companies with no statutory record; (d) i18n in all six locales.
 *
 * Source-static, following the (g)/(h) precedent in test/hrdf-subject.test.ts: these are render-only
 * changes over data the pages already fetch, so there is no new behaviour to drive through the DB.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hrdfLevy, hrdfSubject } from '../localization/my/payroll';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** Walk a dotted i18n path; undefined if any hop is missing. */
const at = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

describe('HRDF silent contradiction (efece4ce) — the calculators are right, the screens were mute', () => {
  it('an explicit "Subject to HRDF = Yes" on an unregistered company is subject, yet levies nothing', () => {
    // Both halves are correct in isolation, and neither is changed by this item. Their COMBINATION is
    // what the employee screen must now warn about, so pin it: if this ever stops holding, the warning
    // is either wrong or unnecessary and must be revisited rather than left rendering a stale claim.
    expect(hrdfSubject(true, 'not_registered')).toBe(true);
    expect(hrdfLevy(4500, 'not_registered')).toBe(0);
    // The same employee on a registered company does levy — the warning is about registration, not the tick.
    expect(hrdfLevy(4500, 'mandatory')).toBeGreaterThan(0);
    expect(hrdfLevy(4500, 'optional')).toBeGreaterThan(0);
  });
});

describe('(a) employee Bank & Statutory — the contradiction is stated, not swallowed', () => {
  const PAGE = read('app/admin/personnel/[employmentId]/page.tsx');
  const card = PAGE.slice(PAGE.indexOf('const othersStatutoryCard'), PAGE.indexOf('const tp3Card'));

  it('warns only when the stored value is an explicit Yes AND the company is unregistered', () => {
    expect(PAGE).toContain('companyStatutory.get(s, emp.companyId)');
    expect(PAGE).toContain("const companyHrdfUnregistered = (companyHrdf?.hrdfStatus ?? 'not_registered') === 'not_registered'");
    expect(card).toContain('statutory?.subjectToHrdf === true && companyHrdfUnregistered');
    expect(card).toContain("{t('subjectToHrdfCompanyNotRegistered')}");
  });

  it('does NOT regress 57840a6e: the company band never reaches the select', () => {
    // The 57840a6e defect was the company band feeding the control's initial state, which turned an
    // untouched card into a permanent explicit No. The warning reads the band for DISPLAY only — the
    // select's defaultValue must still derive from the stored per-employee value and nothing else.
    expect(card).toContain(
      "defaultValue={statutory?.subjectToHrdf == null ? '' : statutory.subjectToHrdf ? 'yes' : 'no'}",
    );
    const select = card.slice(card.indexOf('<select'), card.indexOf('</select>'));
    expect(select).not.toContain('companyHrdf');
    expect(card).not.toContain('type="checkbox"');
  });

  it('warns rather than blocks — the save path is untouched', () => {
    // Refusing the save would strand HR who set employees up before the company registration lands, and
    // the stored flag is honest: it starts levying the moment the rate is set. Only the render changed.
    const ACTIONS = read('app/admin/personnel/[employmentId]/actions.ts');
    const fn = ACTIONS.slice(
      ACTIONS.indexOf('export async function setOthersStatutoryAction'),
      ACTIONS.indexOf('export async function setEmployeeClockingLocationsAction'),
    );
    expect(fn).toContain("hrdfChoice === 'yes' ? true : hrdfChoice === 'no' ? false : null");
    expect(fn).not.toContain('hrdfStatus');
  });
});

describe('(b) payroll surfaces — "not registered" is said, not implied by a blank', () => {
  it('the batch summary always carries an HRDF tile, worded when the company is unregistered', () => {
    const PAGE = read('app/payroll/[batchId]/page.tsx');
    // The old gate — tile only when the total was > 0 — is exactly what made an unregistered company
    // indistinguishable from a failed calculation.
    expect(PAGE).not.toContain("if (Number(totals.hrdfEmployer) > 0) tiles.push(['totalHrdf'");
    expect(PAGE).toContain("['totalHrdf', hrdfRegistered ? rm(totals.hrdfEmployer) : t('totalHrdfNotRegistered')]");
    expect(PAGE).toContain('companyStatutory.get(s, batch.companyId)');
  });

  it('the Transaction History breakdown always draws its HRDF line', () => {
    const TABLE = read('app/payroll/transaction-view/history-table.tsx');
    expect(TABLE).not.toContain('{Number(b.employerContributions.hrdf) > 0 && (');
    expect(TABLE).toContain("t('view.history.hrdfNotRegistered')");
    expect(TABLE).toContain('hrdfRegistered.has(r.companyId)');
    // The registration set is resolved server-side and passed in — the client table must not fetch.
    expect(TABLE).toContain('hrdfRegisteredCompanyIds: string[]');
    const VIEW = read('app/payroll/transaction-view/page.tsx');
    expect(VIEW).toContain("r.hrdfStatus !== 'not_registered'");
    // What matters is that the resolved registration set REACHES the table. Matched on the prop rather
    // than on the whole element, so 862ed0ad renaming the rows variable (History became the landing tab
    // and its read is now capped, so the table renders `shownHistoryRows`) does not read as an HRDF
    // regression — while dropping the prop still does.
    expect(VIEW).toMatch(/<HistoryTable\s+rows=\{\w+\}\s+hrdfRegisteredCompanyIds=\{hrdfRegisteredCompanyIds\}\s*\/>/);
  });
});

describe('(c) Organization — the companies with no statutory record are listed', () => {
  const PAGE = read('app/admin/organization/page.tsx');

  it('lists active Malaysian companies missing a statutory row, from the data already fetched', () => {
    expect(PAGE).toContain('const missingStatutory = companies.filter(');
    // Archived companies run no payroll and non-MY companies have no MY statutory row by design —
    // listing either would be a false alarm that trains the operator to ignore the card.
    expect(PAGE).toContain("(c) => !c.archivedAt && c.country === 'MY' && !statBy.has(c.id)");
    expect(PAGE).toContain("{t('statutoryMissingTitle')}");
    expect(PAGE).toContain("{t('statutoryMissingHint')}");
  });

  it('is read-only — it names the gaps, it does not pick a rate on the operator\'s behalf', () => {
    const cardStart = PAGE.indexOf('{missingStatutory.length > 0 && (');
    expect(cardStart).toBeGreaterThan(-1);
    const cardEnd = PAGE.indexOf('<Card data-tour="people-org-companies">', cardStart);
    const cardMarkup = PAGE.slice(cardStart, cardEnd);
    expect(cardMarkup).not.toContain('<form');
    expect(cardMarkup).not.toContain('Action');
  });
});

describe('(d) i18n — every new string in all six locales', () => {
  it('carries the four new keys, non-empty, in each locale', () => {
    const keys = [
      'people.detail.subjectToHrdfCompanyNotRegistered',
      'payroll.batch.totalHrdfNotRegistered',
      'payroll.transactions.view.history.hrdfNotRegistered',
      'admin.organization.statutoryMissingTitle',
      'admin.organization.statutoryMissingHint',
    ];
    for (const loc of LOCALES) {
      const msg = JSON.parse(read(`messages/${loc}.json`));
      for (const k of keys) {
        const v = at(msg, k);
        expect(typeof v, `messages/${loc}.json missing ${k}`).toBe('string');
        expect((v as string).trim().length, `messages/${loc}.json ${k} empty`).toBeGreaterThan(0);
      }
    }
  });
});
