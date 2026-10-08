/**
 * Attendance Information tab (feedback 1fbe9891) — the Personnel (Admin) employee-detail page must expose
 * a dedicated "Attendance Information" tab that consolidates the attendance-related master data previously
 * split across two tabs: Work Location + Shift Arrangement (Employment / `job` tab) and Clocking Locations
 * & Geofencing (Others tab). The three section cards are relocated WHOLE — the const definitions
 * (locationCard/setLocationAction, defaultShiftCard/setDefaultShiftAction, clockingCard/
 * setEmployeeClockingLocationsAction + setGeofencingAction — since r423 the ONE setClockingControlAction)
 * stay byte-identical; only the render reference
 * moves. The Employment and Others tabs must no longer render the relocated cards.
 *
 * A source-static test (precedent: test/personnel-bank-statutory-tab.test.ts, test/me-tabs.test.ts) is the
 * cheapest guard against a future refactor silently un-relocating a card or dropping the new tab. It also
 * pins the i18n label present in all six locales so tab navigation never renders a raw key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const TABS = fs.readFileSync(path.resolve(__dirname, '../components/personnel-tabs.tsx'), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// Slice out the panels object body so we can assert WHICH panel each card lives in, not just that the
// reference exists somewhere on the page (the const definitions also mention the card names).
function panelBody(key: string): string {
  const start = PAGE.indexOf(`${key}: (`);
  if (start === -1) {
    // Single-node panel form: `key: someCard,`
    const single = PAGE.indexOf(`${key}: `);
    return single === -1 ? '' : PAGE.slice(single, PAGE.indexOf('\n', single));
  }
  // Balance the fragment from the opening `(` to its matching `),`.
  const from = PAGE.indexOf('(', start);
  return PAGE.slice(from, PAGE.indexOf('    ),', from) + 6);
}

describe('Personnel — Attendance Information tab (1fbe9891)', () => {
  it('registers the attendance tab in the tab strip', () => {
    expect(PAGE.includes("{ key: 'attendance', label: t('tabs.attendance') }")).toBe(true);
    // The union type the tab array is annotated with must include the key too.
    expect(PAGE.includes("'attendance'")).toBe(true);
  });

  it('positions the attendance tab immediately after Employment (job)', () => {
    const jobIdx = PAGE.indexOf("{ key: 'job', label: t('tabs.job') }");
    const attIdx = PAGE.indexOf("{ key: 'attendance', label: t('tabs.attendance') }");
    const bankIdx = PAGE.indexOf("{ key: 'bankStatutory', label: t('tabs.bankStatutory') }");
    expect(jobIdx).toBeGreaterThan(-1);
    expect(attIdx).toBeGreaterThan(jobIdx);
    expect(bankIdx).toBeGreaterThan(attIdx);
  });

  it('mirrors the new key in the ClientTabs PersonnelTabKey union', () => {
    expect(TABS.includes("'attendance'")).toBe(true);
  });

  it('renders all three attendance cards inside the attendance panel', () => {
    const att = panelBody('attendance');
    expect(att.includes('{locationCard}')).toBe(true);
    expect(att.includes('{defaultShiftCard}')).toBe(true);
    expect(att.includes('{clockingCard}')).toBe(true);
  });

  it('relocates Work Location + Shift Arrangement OUT of the Employment (job) tab', () => {
    const job = panelBody('job');
    expect(job.includes('{locationCard}')).toBe(false);
    expect(job.includes('{defaultShiftCard}')).toBe(false);
    // Employment tab still renders the superior + delegations cards. (assignmentHistoryCard and
    // transferTerminateCards later relocated to the Career Movement tab by feedback 5296d984 — see
    // test/personnel-career-movement-tab.test.ts; the job tab no longer renders them. Feedback
    // dce55aff replaced the Reporting Lines card with the Direct Superior card.)
    expect(job.includes('{directSuperiorCard}')).toBe(true);
    expect(job.includes('{delegationsCard}')).toBe(true);
  });

  it('relocates Clocking & Geofencing OUT of the Others tab', () => {
    const others = panelBody('others');
    expect(others.includes('{clockingCard}')).toBe(false);
    // Others tab still renders its remaining cards.
    expect(others.includes('{changeHistoryCard}')).toBe(true);
    expect(others.includes('{dataPrivacyCard}')).toBe(true);
    expect(others.includes('{reviewCard}')).toBe(true);
  });

  it('preserves the relocated cards WHOLE — const defs + their server-action <form>s untouched', () => {
    // Work Location card + its action.
    expect(PAGE.includes('const locationCard = admin ?')).toBe(true);
    expect(PAGE.includes('setLocationAction')).toBe(true);
    // Shift arrangement card + its action.
    expect(PAGE.includes('const defaultShiftCard = admin')).toBe(true);
    expect(PAGE.includes('setDefaultShiftAction')).toBe(true);
    // Clocking + geofencing card: r423 merged its two forms into ONE section with ONE writer (the switch
    // and the locations it needs are one rule), so the two old actions must be GONE, not merely unused.
    expect(PAGE.includes('const clockingCard = admin')).toBe(true);
    expect(PAGE.includes('action={setClockingControlAction} data-save-section="clocking"')).toBe(true);
    expect(PAGE.includes('setEmployeeClockingLocationsAction')).toBe(false);
    expect(PAGE.includes('setGeofencingAction')).toBe(false);
    expect(PAGE.includes('data-save-section="geofencing"')).toBe(false);
    // Anchor ids stay so the Attendance module / deep-links keep working.
    expect(PAGE.includes('id="section-location"')).toBe(true);
    expect(PAGE.includes('id="section-default-shift"')).toBe(true);
    expect(PAGE.includes('id="section-clocking-location"')).toBe(true);
  });

  // ── 18504ca6 — the Shift arrangement card gains an Effective date and a Shift history list ──────────
  //
  // The reporter's complaint is a SIDE-BY-SIDE one: the Location card asks when, the Shift arrangement card
  // directly below it does not. So the guard is that both cards keep asking, on the same tab, and that the
  // shift card's date reaches the server action under the name the action reads.
  it('the Shift arrangement card asks for an Effective date, like the Location card above it', () => {
    expect(PAGE.includes('defaultEffectiveFrom={today}')).toBe(true);
    // The Location card's own effective date is untouched — the symmetry is the point.
    expect(PAGE.includes("<Field label={t('effectiveDate')}>")).toBe(true);
    const FIELDS = fs.readFileSync(
      path.resolve(__dirname, '../components/employee-shift-fields.tsx'),
      'utf8',
    );
    // Same field name the action reads off the FormData, and required so a blank cannot be posted.
    expect(FIELDS.includes("name=\"effectiveFrom\"")).toBe(true);
    expect(FIELDS.includes('type="date"')).toBe(true);
    expect(FIELDS.includes("t('shiftEffectiveDateLabel')")).toBe(true);
  });

  it('renders the Shift history list under the card, with its five columns', () => {
    expect(PAGE.includes('shiftArrangementHistory')).toBe(true);
    expect(PAGE.includes("t('shiftHistoryTitle')")).toBe(true);
    expect(PAGE.includes("t('shiftHistoryEmpty')")).toBe(true);
    for (const col of ['Effective', 'Previous', 'New', 'ChangedBy', 'ChangedOn']) {
      expect(PAGE.includes(`t('shiftHistoryCol${col}')`), `missing column shiftHistoryCol${col}`).toBe(true);
    }
  });

  it('the shift-arrangement keys resolve in all six locales (no raw key, no missing ICU argument)', () => {
    const KEYS = [
      'shiftEffectiveDateLabel',
      'shiftEffectiveDateHint',
      'shiftEffectiveDateInvalid',
      'shiftEffectiveBeforeStart',
      'shiftBackInsertRefused',
      'shiftHistoryTitle',
      'shiftHistoryEmpty',
      'shiftHistoryColEffective',
      'shiftHistoryColPrevious',
      'shiftHistoryColNew',
      'shiftHistoryColChangedBy',
      'shiftHistoryColChangedOn',
      'shiftHistoryRecordedOnRelease',
      'requiredField',
    ];
    for (const loc of LOCALES) {
      const msg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      );
      const detail = msg?.people?.detail ?? {};
      for (const k of KEYS) {
        expect(typeof detail[k], `messages/${loc}.json missing people.detail.${k}`).toBe('string');
        expect(detail[k].length, `messages/${loc}.json people.detail.${k} is empty`).toBeGreaterThan(0);
      }
      // Both refusals carry ONE placeholder, {date}, and the action always passes it. A placeholder that
      // drifted out of a translation would silently drop the date the admin needs to act on.
      for (const k of ['shiftBackInsertRefused', 'shiftEffectiveBeforeStart']) {
        expect(detail[k], `messages/${loc}.json people.detail.${k} lost its {date}`).toContain('{date}');
      }
    }
  });

  it('has the tabs.attendance label in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      );
      const label = msg?.people?.detail?.tabs?.attendance;
      expect(typeof label, `messages/${loc}.json missing people.detail.tabs.attendance`).toBe(
        'string',
      );
      expect(label.length, `messages/${loc}.json attendance label is empty`).toBeGreaterThan(0);
    }
  });
});
