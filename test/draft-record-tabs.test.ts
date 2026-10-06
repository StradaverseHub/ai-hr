/**
 * A DRAFT IS THE SAME SCREEN AS THE EMPLOYEE IT BECOMES — item 759dfc7d, work item 2.
 *
 * THE REPORTER'S OBJECTION, IN THEIR OWN TERMS. Creating an employee opened a five-step form with its own
 * step names; the same person, once activated, opened a record with eleven tabs, different section names
 * and a different layout. Two screens to learn for one employee. The plan's promise is narrow and
 * checkable: "the same tabs as an active employee, with the same section names, fields, dropdowns and
 * validation" — plus a Draft label on the record, save at any point, nothing validated until Activate,
 * and the screen still saying what is outstanding.
 *
 * WHY THIS FILE IS MOSTLY ABOUT WORDS. "The same section names" is the half of that promise that no
 * rendering test can hold on its own: a screen renders one locale, and this product ships six. A tab
 * label copied by hand into `people.wizard` would look right in English forever and drift the first time
 * somebody edits the record's Malay label. So each of the eleven strings the draft borrows is pinned
 * EQUAL, in all six locales, to the `people.detail` key the activated record reads. Editing one and not
 * the other fails here.
 *
 * WHAT IS PINNED WHERE:
 *   §1  the tab vocabulary — DRAFT_TABS is the record's own tab keys, which tabs a draft must not get,
 *       and WHERE A DRAFT REOPENS: the stored step, and the `?tab=` a shared link names
 *   §2  the words — wizard.tabs.* === detail.tabs.*, wizard.sections.* === the record's own card titles
 *   §3  the Draft status label, in every locale, and the wizard-only strings that had to survive
 *
 * The screen itself — that these tabs actually render, that a value typed on one survives a switch to
 * another, and that Save works with the record half-empty — is test/draft-record-tabs.dom.test.tsx.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DRAFT_TABS, missingByTab, openingTab, stepKey, stepNumber } from '../lib/employee-draft-schema';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`));

const WIZARD = 'app/admin/personnel/new/wizard.tsx';
const RECORD = 'app/admin/personnel/[employmentId]/page.tsx';

// ── §1 the vocabulary ─────────────────────────────────────────────────────────────────────────────
describe('§1 a draft uses the ACTIVE RECORD\'S tab keys, and only the five it is entitled to', () => {
  it('every DRAFT_TABS key is a tab the activated record actually has', () => {
    // Read from the record's own tab list rather than from a hand-copied array: this is the thing that
    // would rot. If somebody renames `bankStatutory` on the employee screen, a draft tab pointing at the
    // old key stops being "the same tab" and this fails.
    const record = read(RECORD);
    const recordTabs = [...record.matchAll(/\{ key: '(\w+)', label: t\('tabs\.(\w+)'\) \}/g)].map((m) => m[1]);
    expect(recordTabs.length, 'the record\'s tab list could not be read — has its shape changed?')
      .toBeGreaterThanOrEqual(11);
    for (const k of DRAFT_TABS) expect(recordTabs, `draft tab ${k}`).toContain(k);
  });

  it('the six tabs a draft does NOT get are named, and named for a reason', () => {
    // Four of them describe things that have HAPPENED to an employment, and a draft deliberately has no
    // employment for them to have happened to. Qualification and Others follow activation too — the plan
    // says so and invites the reporter to reject it if they want Qualification earlier, so if that
    // conversation happens this list is where the answer lands.
    for (const absent of ['careerMovement', 'attendance', 'leave', 'documents', 'qualification', 'others']) {
      expect(DRAFT_TABS as readonly string[], absent).not.toContain(absent);
    }
    expect(DRAFT_TABS).toEqual(['profile', 'job', 'bankStatutory', 'payroll', 'family']);
  });

  it('the ONE completeness rule speaks the tab vocabulary, and the server re-runs that same rule', () => {
    // `missingByTab` is the rule the browser uses to say what a tab still needs AND the rule
    // `completeEmployeeDraft` re-runs (through `missingForCreation`) before it creates anything. Moving
    // the screen onto tabs must not have produced a second, screen-shaped copy of it.
    expect(Object.keys(missingByTab({}))).toEqual([...DRAFT_TABS]);
    expect(read('core/employee-draft.ts')).toContain('missingForCreation(data)');
    expect(read('lib/employee-draft-schema.ts')).toContain('return DRAFT_TABS.flatMap((k) => byTab[k]);');
  });

  it('the stored step NUMBERS did not move when the keys were renamed', () => {
    // `employee_draft.current_step` is full of numbers written by the old five-step form, and there is no
    // migration in this change. `employment` → `job` and `statutory` → `bankStatutory` are renames of the
    // KEY only: each kept its number, 5 stays retired on Payroll, and Family stays 6.
    expect([stepNumber('profile'), stepNumber('job'), stepNumber('bankStatutory'), stepNumber('payroll'),
      stepNumber('family')]).toEqual([1, 2, 3, 4, 6]);
    expect(stepKey(5)).toBe('payroll');
    expect(stepKey(2)).toBe('job');
    expect(stepKey(3)).toBe('bankStatutory');
  });

  it('a draft link OPENS the tab it names — `?tab=` is honoured, not merely written', () => {
    // The shell writes `?tab=<key>` on every switch. Writing it and then ignoring it on load is the worst
    // of the three options: the address bar would name a tab the screen refuses to open, and a link
    // shared with a colleague would land them somewhere else. The activated record honours the same
    // parameter, and this item exists to make the two screens one.
    expect(openingTab('payroll', 1), 'the URL beats the stored step').toBe('payroll');
    expect(openingTab('family', 1)).toBe('family');
    // The stored step is the fallback, and it is the ordinary case: a draft reopened from the Personnel
    // list carries no `?tab=` at all.
    expect(openingTab(undefined, 3), 'no ?tab= — the stored step decides').toBe('bankStatutory');
    expect(openingTab(undefined, 5), 'the retired step 5 still reopens on Payroll').toBe('payroll');
    // An unknown value is a bookmark, not an instruction: ignored, never an error — including the six
    // tabs a draft does not get, which a link copied off an activated record would name.
    expect(openingTab('attendance', 2), 'a tab a draft never gets').toBe('job');
    expect(openingTab('', 2)).toBe('job');
    expect(openingTab('Payroll', 2), 'the key is exact — not case-folded').toBe('job');
  });

  it('the server page READS `tab` off the URL and hands it to the screen', () => {
    // `openingTab` can only be honoured if the parameter reaches it: this is the wiring between the URL
    // and the screen, and it is one line in a server component that no unit test would otherwise see.
    const page = read('app/admin/personnel/new/page.tsx');
    expect(page, 'the draft page must declare the `tab` search param')
      .toMatch(/searchParams: Promise<\{[^}]*tab\?: string/);
    expect(page, 'and pass it to the screen').toContain('initialTab={sp.tab}');
    // And the screen must resolve it rather than take it literally — an unknown tab key must not blank
    // the shell out.
    expect(read(WIZARD)).toContain('openingTab(initialTab, initialStep)');
  });
});

// ── §2 the words ──────────────────────────────────────────────────────────────────────────────────
describe('§2 the draft borrows the record\'s OWN words, in all six locales', () => {
  it('every tab label is the record\'s tab label, character for character', () => {
    for (const loc of LOCALES) {
      const m = msgs(loc);
      for (const k of [...DRAFT_TABS, 'empty']) {
        const draft = m.people.wizard.tabs?.[k];
        const record = m.people.detail.tabs?.[k];
        expect(String(record ?? '').trim(), `${loc} detail.tabs.${k}`).not.toBe('');
        expect(draft, `${loc} wizard.tabs.${k} must equal detail.tabs.${k}`).toBe(record);
      }
    }
  });

  it('every card heading is the record\'s card heading, character for character', () => {
    // The mapping is the point of the test, so it is written out: draft section key → the key the
    // activated employee's screen reads for the SAME card. A new card on the draft belongs here too.
    const SECTIONS: Record<string, string> = {
      personalDetails: 'personalDetails',
      contactAddress: 'contactAddressTitle',
      organisation: 'employmentInfo.orgGroup',
      employmentDates: 'employmentInfo.datesGroup',
      bank: 'bankCardTitle',
      statutoryMalaysia: 'statutoryMalaysia',
      identityTax: 'identityTaxCardTitle',
      compensation: 'compensation',
      // r393 (685d2380 step 2) — the Payroll tab's two new cards. "How This Employee Is Paid" is the
      // record's own group heading on its Payroll tab; "Payroll policy" is the record's Payroll policy card
      // title, which lives in the `payrollPolicy` namespace rather than under people.detail — hence the
      // leading `/`, read from the catalogue ROOT instead.
      payMethodGroup: 'payMethodGroup',
      payrollPolicy: '/payrollPolicy.assignTitle',
      // r393 (685d2380 step 3b) — the training levy moved into its own card, the record's Others Statutory.
      othersStatutory: 'othersStatutoryTitle',
    };
    const dig = (node: unknown, path: string): unknown =>
      path.split('.').reduce<unknown>(
        (n, seg) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[seg] : undefined),
        node,
      );
    for (const loc of LOCALES) {
      const m = msgs(loc);
      const draftSections = m.people.wizard.sections ?? {};
      // Every section the screen declares is covered by the mapping — a card added to the draft with a
      // heading of its own invention would slip past a loop that only walked this table.
      expect(Object.keys(draftSections).sort(), `${loc} wizard.sections keys`).toEqual(Object.keys(SECTIONS).sort());
      for (const [key, path] of Object.entries(SECTIONS)) {
        const record = path.startsWith('/') ? dig(m, path.slice(1)) : dig(m.people.detail, path);
        expect(String(record ?? '').trim(), `${loc} the record's heading behind sections.${key}`).not.toBe('');
        expect(draftSections[key], `${loc} wizard.sections.${key} must equal the record's own heading`)
          .toBe(record);
      }
    }
  });

  it('the screen asks for those keys STATICALLY, so i18n coverage check C can see them', () => {
    // A computed `t(`tabs.${k}`)` resolves at runtime and is invisible to the coverage test, which is how
    // a missing Tamil label ships as a raw key. Both blocks are written out one literal per line.
    const src = read(WIZARD);
    for (const k of DRAFT_TABS) expect(src, `t('tabs.${k}')`).toContain(`t('tabs.${k}')`);
    // r393 (685d2380 step 3b) — `identityTax` left this list: the draft's "Identification & Tax" card is gone,
    // its fields now in the record's Income Tax (PCB) section inside Statutory (Malaysia). The key is
    // RETIRED, not deleted (it stays in every catalogue and in the SECTIONS table above, still equal to the
    // record's heading), and the screen must no longer ask for it.
    for (const k of ['personalDetails', 'contactAddress', 'organisation', 'employmentDates', 'bank',
      'statutoryMalaysia', 'compensation', 'payMethodGroup', 'payrollPolicy', 'othersStatutory']) {
      expect(src, `t('sections.${k}')`).toContain(`t('sections.${k}')`);
    }
    expect(src, 'the retired Identification & Tax card heading').not.toContain(`t('sections.identityTax')`);
    expect(src).not.toContain('t(`tabs.${');
    expect(src).not.toContain('t(`sections.${');
  });
});

// ── §3 the Draft label, and what the move must not have cost ──────────────────────────────────────
describe('§3 "Draft — pending activation" is a LABEL on the record, not a different screen', () => {
  it('the status label exists in every locale and is not the English string copied through', () => {
    const seen = new Map<string, string>();
    for (const loc of LOCALES) {
      const v = String(msgs(loc).people.wizard.draftStatus ?? '').trim();
      expect(v, `${loc} wizard.draftStatus`).not.toBe('');
      seen.set(loc, v);
    }
    // Five of the six must differ from English. This is the check that catches a locale filled in by
    // pasting en.json — the failure that leaves a Thai user reading "Draft — pending activation".
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      expect(seen.get(loc), `${loc} draftStatus is the English string`).not.toBe(seen.get('en'));
    }
  });

  it('it is rendered in the record header, beside the ID and the name', () => {
    const src = read(WIZARD);
    expect(src).toContain("t('draftStatus')");
    // In the header Card — the one carrying the held Employee ID — rather than floating above the tabs.
    const header = src.slice(src.indexOf("t('fields.employeeCode')"), src.indexOf("t('companyFixedAfterCreate')"));
    expect(header, 'the Draft badge must sit inside the record header card').toContain("t('draftStatus')");
  });

  it('what makes a draft a draft survived the move onto tabs', () => {
    const src = read(WIZARD);
    // SAVE DOES NOT VALIDATE — the action is called with the data as it stands, from whichever tab is
    // open, and nothing gates it on `outstanding`.
    expect(src).toContain('await saveDraftAction(id, data, stepNumber(tab));');
    expect(src).toContain("<Button variant=\"secondary\" onClick={() => saveDraft()} disabled={pending}>");
    // ONLY ACTIVATE VALIDATES.
    expect(src).toContain('disabled={pending || outstanding.length > 0}');
    // THE SCREEN STILL SAYS WHAT IS OUTSTANDING, by tab, and each name reaches its tab.
    expect(src).toContain("t('activateNeeds')");
    expect(src).toContain('DRAFT_TABS.filter((k) => missing[k].length > 0)');
    expect(src).toContain('selectTabRef.current?.(k)');
    // THE COMPANY AND THE HELD EMPLOYEE ID ARE STILL READ-ONLY — no control writes either. (The server
    // re-pins both in `saveEmployeeDraft`; this is the screen half of the same promise.)
    expect(src).not.toContain("set('employment', { companyId");
    expect(src).not.toContain("set('profile', { employeeCode");
    // DISCARD is still here, and still says what it costs.
    expect(src).toContain("t('discardDraft')");
    expect(src).toContain("t('discardReleasesTip')");
  });
});
