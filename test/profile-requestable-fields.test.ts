/**
 * r260 stage two (board item 9583deac) — ONE DECLARATION OF WHICH FIELDS MAY BE ASKED ABOUT, AND EVERY
 * SURFACE READS IT.
 *
 * The approved plan's instruction, verbatim: widen the request path "to a declared set and name it in
 * one place, keyed by the same field keys the visibility manifest uses so a permission and a request can
 * never disagree about what a field is called."
 *
 * That is a relationship BETWEEN FILES that no runtime has in hand at once — a lib module, the /me
 * manifest, the request form, the server action, the core sanitiser/applier and six message catalogues.
 * So this is source-static, the same shape as test/me-profile-visibility.test.ts, and it holds the
 * declaration to the four promises it makes:
 *
 *   1. every requestable field is one the employee can SEE on their own record (you may not ask to
 *      change what you are not shown, and you certainly may not ask to change something withheld);
 *   2. every requestable field has a column an approval actually writes — the "requestable but not
 *      appliable" gap that the two parallel `if` ladders in core/profile.ts used to make possible;
 *   3. the form offers exactly the declared set — no orphan control, no field with nowhere to type it;
 *   4. every label and option key it names resolves in ALL SIX catalogues.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_REQUESTABLE_FIELDS,
  PROFILE_REQUESTABLE_KEYS,
  maskAccountNumber,
  requestableField,
  requestableFieldsForTab,
} from '../lib/profile-requestable-fields';
import { ME_VISIBLE_FIELD_LABEL_KEYS } from '../app/me/visible-fields';
import { ME_WITHHELD_COLUMNS } from '../app/me/visible-fields';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const CORE_PROFILE = read('core/profile.ts');
const ME_ACTIONS = read('app/me/actions.ts');
const REQUEST_CARD = read('app/me/request-change-card.tsx');
const ME_PAGE = read('app/me/page.tsx');
const SCHEMA = read('db/schema.ts');
const MIGRATION = read('db/migrations/0458_profile_change_decision_reason.sql');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const CATALOGS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)) as Record<string, unknown>]),
) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

function leaf(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('r260 — the requestable-field declaration', () => {
  it('is not empty, and genuinely WIDER than the three areas the plan says it replaces', () => {
    // The plan's own words to the reporter: the path is widened "instead of only bank details, family
    // and PCB category". A declaration that merely re-expressed those seven would be a refactor wearing
    // a stage's name, so the count is asserted rather than assumed.
    expect(PROFILE_REQUESTABLE_KEYS.length).toBeGreaterThan(15);
    for (const wasAlreadyThere of ['bankName', 'bankAccountNo', 'taxCategory', 'numChildren', 'dateOfBirth', 'gender', 'maritalStatus']) {
      expect(requestableField(wasAlreadyThere), `${wasAlreadyThere} was requestable before stage two and must stay so`).toBeDefined();
    }
    // …and the widening reaches BOTH tables, not just the statutory one.
    expect(PROFILE_REQUESTABLE_FIELDS.some((f) => f.target === 'person')).toBe(true);
    expect(PROFILE_REQUESTABLE_FIELDS.some((f) => f.target === 'statutory')).toBe(true);
  });

  it('has no duplicate key, and every key has a control the form can render', () => {
    expect(new Set(PROFILE_REQUESTABLE_KEYS).size).toBe(PROFILE_REQUESTABLE_KEYS.length);
    for (const f of PROFILE_REQUESTABLE_FIELDS) {
      if (f.input === 'select') {
        expect((f.options ?? []).length, `${f.key} is a select with no options`).toBeGreaterThan(0);
      } else {
        expect(f.options, `${f.key} is a ${f.input} carrying select options`).toBeUndefined();
      }
    }
  });

  it('NAMES EVERY FIELD WITH A KEY THE EMPLOYEE ACTUALLY SEES ON THEIR OWN RECORD', () => {
    /**
     * THE PROMISE THIS FILE EXISTS FOR. If a requestable field's `labelKey` is not on the visibility
     * manifest, one of two things is true and both are defects: the employee is being offered a change
     * to a field their own record does not show them (so they cannot check the current value against
     * the one they are asking for), or the field is named by a second wording — which is the exact
     * drift stage one was raised about, reopened one level down.
     *
     * When this fails: put the field on My Profile and add its key to ME_VISIBLE_FIELD_LABEL_KEYS, or
     * take the field out of the declaration. Do not add an exception list.
     */
    const shown = new Set(Object.values(ME_VISIBLE_FIELD_LABEL_KEYS).flat());
    const unseen = PROFILE_REQUESTABLE_FIELDS.filter((f) => !shown.has(f.labelKey));
    expect(
      unseen.map((f) => `${f.key} (${f.labelKey})`),
      'these fields may be requested but are not on the employee’s own record — an employee cannot ' +
        'check what they are changing, and a request and a record would call one field two things',
    ).toEqual([]);
  });

  it('never offers a field that is on the WITHHELD list', () => {
    // The other direction, and the dangerous one: asking to change a field is a way to learn it exists.
    // `ME_WITHHELD_COLUMNS` is the machine-readable half of docs/me-profile-field-visibility.md.
    const withheld = new Set(ME_WITHHELD_COLUMNS);
    const leaked = PROFILE_REQUESTABLE_FIELDS.filter((f) => withheld.has(f.key) || withheld.has(f.column));
    expect(leaked.map((f) => f.key), 'a withheld field is offered as requestable').toEqual([]);
  });

  it('every field lands on a real column of the table it names', () => {
    /**
     * The "requestable but not appliable" gap. Before stage two, `sanitizeProposed` accepted a set of
     * keys and the apply half tested a DIFFERENT set by hand — so a key could be accepted, wait in the
     * approver's queue, be approved, and land nowhere at all. The applier now walks this declaration, so
     * the only remaining way to break it is to name a column that does not exist. Checked against
     * db/schema.ts's own column list for the two tables.
     */
    const tableBody = (name: string) => {
      const i = SCHEMA.indexOf(`export const ${name} = pgTable(`);
      expect(i, `${name} is not in db/schema.ts`).toBeGreaterThan(0);
      return SCHEMA.slice(i, SCHEMA.indexOf('\n);', i));
    };
    const bodies = { person: tableBody('person'), statutory: tableBody('employeeStatutoryMy') };
    const missing = PROFILE_REQUESTABLE_FIELDS.filter(
      (f) => !new RegExp(`\\n\\s{4}${f.column}:`).test(bodies[f.target]),
    );
    expect(
      missing.map((f) => `${f.key} → ${f.target}.${f.column}`),
      'an approval would write these to a column that does not exist',
    ).toEqual([]);
  });

  it('the /me form offers exactly the declared set, and the action reads exactly the declared set', () => {
    // Both are generated FROM the declaration rather than listing names, which is the point — so this
    // asserts the generation is still in place rather than counting inputs.
    expect(REQUEST_CARD).toContain('requestableFieldsForTab(tab)');
    expect(REQUEST_CARD).toContain('name={f.key}');
    expect(ME_ACTIONS).toContain('for (const field of PROFILE_REQUESTABLE_FIELDS)');
    expect(ME_ACTIONS).toContain("formData.get(field.key)");
    // A hard-coded name left behind in the action would be a field read twice or a field read that the
    // declaration no longer carries.
    for (const dead of ["formData.get('bankName')", "formData.get('taxCategory')", "formData.get('gender')"]) {
      expect(ME_ACTIONS.includes(dead), `${dead} survives the declaration-driven read`).toBe(false);
    }
    // Every tab named by the declaration has a card mounted for it on /me — a field declared on a tab
    // with no card is a field nobody can ask about.
    for (const tab of new Set(PROFILE_REQUESTABLE_FIELDS.map((f) => f.tab))) {
      expect(requestableFieldsForTab(tab).length).toBeGreaterThan(0);
      expect(ME_PAGE.includes(`<RequestChangeCard tab="${tab}"`), `no request card mounted for tab '${tab}'`).toBe(true);
    }
  });

  it('core/profile.ts applies from the declaration, and applies NOTHING on a rejection', () => {
    // The safety property, asserted at the shape level here and against a live database in
    // test/me-profile-change-requests.test.ts. There must be exactly one place a master write can
    // happen, and it must be inside the approved branch.
    expect(CORE_PROFILE).toContain("if (p.decision === 'approved') {");
    expect(CORE_PROFILE).toContain('const setFor = (target: ProfileRequestTarget)');
    expect(CORE_PROFILE).toContain("const statSet = setFor('statutory');");
    expect(CORE_PROFILE).toContain("const personSet = setFor('person');");
    // Scoped to decideProfileChange's OWN body. `person` is legitimately written by two other functions
    // in this file — `updateOwnContact` (ADR-0012 path one, the instant contact self-edit) and
    // `setPersonComplianceFields` (the HR-direct setter) — and neither is a decision path.
    const decideBody = CORE_PROFILE.slice(
      CORE_PROFILE.indexOf('export async function decideProfileChange('),
      CORE_PROFILE.indexOf('export async function setPersonComplianceFields('),
    );
    expect(decideBody.length, 'decideProfileChange could not be located in core/profile.ts').toBeGreaterThan(500);
    const approvedBranch = decideBody.slice(
      decideBody.indexOf("if (p.decision === 'approved') {"),
      decideBody.indexOf('await tx\n      .update(profileChangeRequest)'),
    );
    for (const writer of ['.update(employeeStatutoryMy)', '.update(person)']) {
      expect(
        decideBody.split(writer).length - 1,
        `${writer} is written in more than one place inside decideProfileChange`,
      ).toBe(1);
      expect(approvedBranch.includes(writer), `${writer} runs outside the approved branch`).toBe(true);
    }
    // And the branch that follows a decision writes only the request row itself — never a master table.
    const afterDecision = decideBody.slice(decideBody.indexOf('await tx\n      .update(profileChangeRequest)'));
    for (const writer of ['.update(employeeStatutoryMy)', '.update(person)', '.insert(']) {
      expect(afterDecision.includes(writer), `${writer} runs after the decision is recorded`).toBe(false);
    }
  });

  it('a rejection cannot be stored without a reason — service, schema and migration all say so', () => {
    expect(CORE_PROFILE).toContain('export class ProfileChangeReasonRequiredError');
    expect(CORE_PROFILE).toContain("if (p.decision === 'rejected' && reason === null) throw new ProfileChangeReasonRequiredError();");
    expect(SCHEMA).toContain("decisionReason: text('decision_reason')");
    expect(MIGRATION).toContain('ADD COLUMN "decision_reason" text');
    expect(MIGRATION).toContain('profile_change_request_reject_reason_ck');
    // NOT VALID is load-bearing: rows rejected before this column existed have no reason and must not be
    // back-filled with an invented one. See the migration's own header.
    expect(MIGRATION).toContain('NOT VALID');
    // An ALTER on an existing table inherits its policies and grants — the migration must SAY so rather
    // than leave the next reader to re-derive it (AGENTS rule 5).
    expect(MIGRATION).toMatch(/NO RLS OR GRANT CHANGES/);
  });

  it('every label and option key resolves in ALL SIX catalogues', () => {
    const report: string[] = [];
    for (const loc of LOCALES) {
      for (const f of PROFILE_REQUESTABLE_FIELDS) {
        const v = leaf(leaf(CATALOGS[loc], 'people.detail'), f.labelKey);
        if (typeof v !== 'string' || v === '') report.push(`${loc}: people.detail.${f.labelKey}`);
        for (const o of f.options ?? []) {
          const ov = leaf(leaf(CATALOGS[loc], 'me'), o.labelKey);
          if (typeof ov !== 'string' || ov === '') report.push(`${loc}: me.${o.labelKey}`);
        }
      }
      // The card's own wording, which is dynamic-key-free but multi-namespace, so i18n-coverage check C
      // skips the file. Named here instead of trusted.
      for (const k of [
        'requestChangeProfileHeading',
        'myChangeRequests',
        'noChangeRequests',
        'requestedOn',
        'decidedOn',
        'decisionReasonLabel',
        'proposedCleared',
        'requestedPendingLabel',
      ]) {
        const v = leaf(leaf(CATALOGS[loc], 'me'), k);
        if (typeof v !== 'string' || v === '') report.push(`${loc}: me.${k}`);
      }
      const ph = leaf(leaf(CATALOGS[loc], 'people'), 'list.rejectReasonPlaceholder');
      if (typeof ph !== 'string' || ph === '') report.push(`${loc}: people.list.rejectReasonPlaceholder`);
    }
    expect(report, report.join('\n')).toEqual([]);
  });

  it('a pending bank account number is masked exactly as the master one is', () => {
    // One function, used by the record card AND by the pending annotation beside it. Printing the
    // requested number in full next to a masked master would defeat the masking on the same line.
    expect(maskAccountNumber('1234567890')).toBe('•••• 7890');
    expect(maskAccountNumber(null)).toBeNull();
    expect(requestableField('bankAccountNo')?.masked).toBe(true);
    expect(REQUEST_CARD).toContain('if (field.masked) return maskAccountNumber(String(value))');
    expect(ME_PAGE).toContain('maskAccountNumber(st.bankAccountNo)');
  });
});
