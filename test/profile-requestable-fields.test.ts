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
  PROFILE_REQUEST_APPROVERS,
  PROFILE_REQUEST_APPROVER_SETTING_KEY,
  PROFILE_REQUEST_FIELDS_DEFAULT,
  PROFILE_REQUEST_FIELDS_SETTING_KEY,
  formatProposedValue,
  maskAccountNumber,
  offeredRequestableFieldsForTab,
  requestableField,
  requestableFieldsForTab,
} from '../lib/profile-requestable-fields';
import { SETTING_CATALOG } from '../packs/catalog';
import { ME_VISIBLE_FIELD_LABEL_KEYS } from '../app/me/visible-fields';
import { ME_WITHHELD_COLUMNS } from '../app/me/visible-fields';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const CORE_PROFILE = read('core/profile.ts');
const ME_ACTIONS = read('app/me/actions.ts');
const REQUEST_CARD = read('app/me/request-change-card.tsx');
const ME_PAGE = read('app/me/page.tsx');
// The two screens an APPROVER reads a proposed change on. Both are held to the same renderer as /me.
const PERSONNEL_PAGE = read('app/admin/personnel/page.tsx');
const APPROVALS_PAGE = read('app/approvals/page.tsx');
// The two documents the REPORTER reads. They are prose, so nothing else in the build can notice when a
// number in them stops being true.
const DOC_REQUESTS = read('docs/me-profile-change-requests.md');
const DOC_VISIBILITY = read('docs/me-profile-field-visibility.md');
const SCHEMA = read('db/schema.ts');
const PDPA = read('core/pdpa.ts');
const MIGRATION = read('db/migrations/0458_profile_change_decision_reason.sql');
/** 0458 with its `--` commentary stripped: what Postgres is actually asked to DO, not what the header
 *  explains it deliberately does not do. The header quotes the CHECK that was removed, so a naive grep
 *  over the whole file would find the very thing this test exists to keep out. */
const MIGRATION_SQL = MIGRATION.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

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

  it('a rejection cannot be stored without a reason — enforced AT THE DECISION, never as a table CHECK', () => {
    /**
     * THIS CASE CHANGED SHAPE IN THE FIX PASS, AND IT IS STRICTLY STRONGER THAN THE ONE IT REPLACES.
     *
     * 0458 shipped its first draft with `CHECK (status <> 'rejected' OR btrim(decision_reason) <> '')
     * NOT VALID`, and this case asserted the constraint was there. The adversarial verify pass proved on
     * a live probe table that NOT VALID skips only the historical SCAN — it is STILL enforced against
     * the new row version of every UPDATE. `core/pdpa.ts` erasePersonPii updates EVERY one of a
     * subject's profile-change rows, no status filter, inside the single transaction the whole erasure
     * runs in. So one legacy rejection with no reason (exactly the rows 0458 leaves blank on purpose)
     * would have made that employee's PDPA erasure abort with nothing erased.
     *
     * So the constraint is gone and the assertion is inverted: the migration must add a NULLABLE column
     * and nothing a writer of this table has to satisfy, and the rule must be provable at the decision
     * instead. Two writers are named below by name, because "who rejects a request?" is the enumeration
     * that got this wrong the first time.
     */
    expect(CORE_PROFILE).toContain('export class ProfileChangeReasonRequiredError');
    expect(CORE_PROFILE).toContain("if (p.decision === 'rejected' && reason === null) throw new ProfileChangeReasonRequiredError();");
    expect(SCHEMA).toContain("decisionReason: text('decision_reason')");
    expect(MIGRATION_SQL).toContain('ADD COLUMN "decision_reason" text');
    // The column is NULLABLE — a NOT NULL here would fail the ALTER outright on any table with rows.
    expect(MIGRATION_SQL).not.toMatch(/decision_reason"?\s+text\s+not\s+null/i);
    // NOTHING ELSE. No CHECK, valid or NOT VALID, and no constraint of any other kind.
    expect(MIGRATION_SQL, '0458 must add no constraint — core/pdpa.ts rewrites these rows during an erasure').not.toMatch(
      /ADD\s+CONSTRAINT/i,
    );
    expect(MIGRATION_SQL, '0458 must add no CHECK — see the erasure-abort case in this file').not.toMatch(/\bCHECK\s*\(/i);
    // The OTHER writer of the table, named so a future constraint author meets it here.
    expect(PDPA).toContain('.update(profileChangeRequest)');
    // And the free-text reason is erased with the record — core/profile.ts keeps it out of the
    // append-only event log on exactly that promise.
    expect(PDPA).toContain('decisionReason: null');
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

  it('a pending bank account number is masked exactly as the master one is — the approver still reads it whole', () => {
    // One function, used by the record card AND by the pending annotation beside it. Printing the
    // requested number in full next to a masked master would defeat the masking on the same line.
    // The APPROVER is the one audience that legitimately differs: they are checking the proposed number
    // against a bank letter, and read it unmasked on the Personnel card anyway. That is why `mask` is a
    // required argument of the shared renderer and not a default somebody can inherit by forgetting.
    const t = (k: string) => k; // identity: this case is about the VALUE, not the wording
    const acct = requestableField('bankAccountNo')!;
    expect(acct.masked).toBe(true);
    expect(maskAccountNumber('1234567890')).toBe('•••• 7890');
    expect(maskAccountNumber(null)).toBeNull();
    expect(formatProposedValue(acct, '1234567890', t, { mask: true })).toBe('•••• 7890');
    expect(formatProposedValue(acct, '1234567890', t, { mask: false })).toBe('1234567890');
    expect(ME_PAGE).toContain('maskAccountNumber(st.bankAccountNo)');
    expect(REQUEST_CARD).toContain('formatProposedValue(field, value, t, { mask: true })');
  });

  it('the count the reporter is given is the count that shipped', () => {
    /**
     * The first draft of these documents said "twenty-one fields" three times while the declaration
     * carried twenty-four — in the one artefact written for somebody who cannot read the declaration,
     * and who is being asked to approve a stage on the strength of it. The tables listed all
     * twenty-four; only the number was wrong, which is exactly the kind of error prose keeps.
     *
     * So the number is spelled out here in words and checked. A field added or removed in the future
     * fails this case, which is the moment to re-read the document rather than the moment after it has
     * been sent to the reporter.
     */
    const WORDS: Record<number, string> = {
      20: 'twenty',
      21: 'twenty-one',
      22: 'twenty-two',
      23: 'twenty-three',
      24: 'twenty-four',
      25: 'twenty-five',
      26: 'twenty-six',
      27: 'twenty-seven',
      28: 'twenty-eight',
      29: 'twenty-nine',
      30: 'thirty',
    };
    const total = PROFILE_REQUESTABLE_FIELDS.length;
    const word = WORDS[total];
    expect(word, `no spelled-out word for ${total} fields — extend WORDS above`).toBeTruthy();

    for (const [name, doc] of [
      ['docs/me-profile-change-requests.md', DOC_REQUESTS],
      ['docs/me-profile-field-visibility.md', DOC_VISIBILITY],
    ] as const) {
      // `(?!-)` so plain "twenty" does not match inside "twenty-four".
      const says = (w: string) => new RegExp(`\\b${w}\\b(?!-)`).test(doc);
      const stale = Object.entries(WORDS)
        .filter(([n, w]) => Number(n) !== total && says(w))
        .map(([, w]) => w);
      expect(stale, `${name} still tells the reporter "${stale.join('", "')}" — the declaration carries ${word}`).toEqual(
        [],
      );
      expect(says(word), `${name} never states the field count (${word})`).toBe(true);
    }
    // And the per-tab split the document quotes, which is the half a reader can actually count.
    expect(requestableFieldsForTab('profile').length).toBe(17);
    expect(requestableFieldsForTab('bankStatutory').length).toBe(7);
    expect(DOC_REQUESTS).toContain('seventeen on the Profile tab and seven on Bank & Statutory');
  });

  it('every screen that prints a proposed value uses the ONE renderer — nobody is shown a stored code', () => {
    /**
     * THE REGRESSION THIS CASE EXISTS FOR. /admin/personnel shipped
     *   f.options?.find((opt) => opt.value === String(value))?.value
     * — a no-op returning the string it had just matched on — so an approver read "Tax Category → 2"
     * and "Gender → male" where the code it replaced printed "PCB → Married · spouse working", while
     * My Profile printed the label for the same request in the same round. Two screens, one request,
     * two different sentences: the opposite of the single-declaration property this round is sold on.
     * Both queues now call the shared renderer, and this case fails if either stops.
     */
    const WORDS: Record<string, string> = {
      pcbOption2: 'Married · spouse not working',
      gender_male: 'Male',
      marital_married: 'Married',
      proposedCleared: '— cleared —',
    };
    const t = (k: string) => WORDS[k] ?? k;

    const pcb = requestableField('taxCategory')!;
    expect(formatProposedValue(pcb, '2', t, { mask: false })).toBe('Married · spouse not working');
    // jsonb round-trips a number as a number — the approver must not read "2" because of a type.
    expect(formatProposedValue(pcb, 2, t, { mask: false })).toBe('Married · spouse not working');
    expect(formatProposedValue(requestableField('gender')!, 'male', t, { mask: false })).toBe('Male');
    expect(formatProposedValue(requestableField('maritalStatus')!, 'married', t, { mask: false })).toBe('Married');
    // A stored value outside the option set degrades to the value itself, never to a blank.
    expect(formatProposedValue(requestableField('gender')!, 'martian', t, { mask: false })).toBe('martian');
    // A cleared field says so in words rather than printing nothing.
    expect(formatProposedValue(requestableField('preferredName')!, '', t, { mask: false })).toBe('— cleared —');
    expect(formatProposedValue(requestableField('preferredName')!, null, t, { mask: false })).toBe('— cleared —');

    for (const [name, src] of [
      ['app/admin/personnel/page.tsx', PERSONNEL_PAGE],
      ['app/approvals/page.tsx', APPROVALS_PAGE],
      ['app/me/request-change-card.tsx', REQUEST_CARD],
    ] as const) {
      expect(src, `${name} must print a proposed value through the shared renderer`).toContain('formatProposedValue(');
      // …and the exact no-op that shipped must never come back, on any of them.
      expect(src, `${name} resolves a select option to its own .value — the reader gets the stored code`).not.toMatch(
        /options\?\.find\([\s\S]{0,80}?\)\?\.value/,
      );
    }
    // The approval queues resolve option words from the namespace the EMPLOYEE picked them in.
    for (const [name, src] of [
      ['app/admin/personnel/page.tsx', PERSONNEL_PAGE],
      ['app/approvals/page.tsx', APPROVALS_PAGE],
    ] as const) {
      expect(src, `${name} must resolve option labels from PROFILE_REQUEST_OPTION_NAMESPACE`).toContain(
        'getTranslations(PROFILE_REQUEST_OPTION_NAMESPACE)',
      );
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * r261 STAGE THREE — THE TWO SETTINGS, AS A RELATIONSHIP BETWEEN FILES
 *
 * The runtime behaviour of both settings is proved against a live cluster in
 * test/me-profile-request-settings.test.ts. What is left here is what no runtime holds in hand at once:
 * a catalog entry, a screen, a server action, a service and six message catalogues all having to agree
 * about ONE permission over ONE set of field keys.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

const SETTINGS_PAGE = read('app/admin/settings/profile-requests/page.tsx');
const SETTINGS_ACTIONS = read('app/admin/settings/profile-requests/actions.ts');
const CORE_TENANT_SETTINGS = read('core/tenant-settings.ts');
const DOC_SETTINGS = read('docs/me-profile-request-settings.md');

describe('r261 — the two settings are catalogued, and catalogued the way they are read', () => {
  it('both are TENANT-scoped, customer-visible, and arrive with nothing written at install', () => {
    // A `platform` scope would put them out of the customer's reach entirely (0313's write policy);
    // `customerVisible: false` would hide them from the very screen this round ships. `defaultOnInstall:
    // null` is the third: there is nothing to write at provisioning time, because the ABSENCE of a row
    // is the default and the default is stage two's shipped behaviour.
    for (const key of [PROFILE_REQUEST_FIELDS_SETTING_KEY, PROFILE_REQUEST_APPROVER_SETTING_KEY]) {
      const entry = SETTING_CATALOG.find((e) => e.key === key);
      expect(entry, `${key} is not in SETTING_CATALOG — getSetting throws a bare Error for it`).toBeDefined();
      expect(entry!.scope, `${key} scope`).toBe('tenant');
      expect(entry!.customerVisible, `${key} customerVisible`).toBe(true);
      expect(entry!.defaultOnInstall, `${key} defaultOnInstall`).toBeNull();
    }
  });

  it('the field list defaults to the SENTINEL, never to a copy of the declaration', () => {
    /**
     * THE DECISION THIS CASE EXISTS TO KEEP. A catalog `defaultValue` listing the 24 field keys would be
     * a second copy of PROFILE_REQUESTABLE_FIELDS in a file nothing compares against it, and it would rot
     * the first time a field was added, renamed or withdrawn — silently, because a stale default reads as
     * a working permission. `'all'` cannot rot: it means "not configured", and it is resolved against the
     * declaration in exactly one place.
     */
    const entry = SETTING_CATALOG.find((e) => e.key === PROFILE_REQUEST_FIELDS_SETTING_KEY)!;
    expect(entry.valueType).toBe('json');
    expect(entry.defaultValue).toBe(PROFILE_REQUEST_FIELDS_DEFAULT);
    expect(Array.isArray(entry.defaultValue), 'the default must NOT be a list of keys').toBe(false);

    const approver = SETTING_CATALOG.find((e) => e.key === PROFILE_REQUEST_APPROVER_SETTING_KEY)!;
    expect(approver.valueType).toBe('string');
    expect(approver.defaultValue, "the default is stage two's authority, unchanged").toBe('admin');
    expect(PROFILE_REQUEST_APPROVERS).toContain(approver.defaultValue);
  });

  it('the writer accepts the json shape the catalog declares — the policy would have accepted it silently', () => {
    // 0313's tenant_setting_write admits `d.value_type = 'json'` with any shape, and the column has
    // always been jsonb. Before r261 no TypeScript writer could express one, so a `json` catalog entry
    // was unreachable from the product. This is the conjunct that keeps the two in step.
    expect(CORE_TENANT_SETTINGS).toContain('settingValueType(p.value) !== entry.valueType');
    expect(CORE_TENANT_SETTINGS).toContain("return Array.isArray(v) ? 'json' : typeof v;");
  });
});

describe('r261 — a switched-off field is ABSENT from the employee\'s screen, not disabled on it', () => {
  it('the /me card renders from the OFFERED list, and the page resolves it from the tenant setting', () => {
    /**
     * NON-VACUITY: reverting `offeredRequestableFieldsForTab(tab, allowedKeys)` to
     * `requestableFieldsForTab(tab)` in the card fails the first expectation here, and the live-cluster
     * file's "OMITTED, not offered disabled" case with it.
     */
    expect(REQUEST_CARD).toContain('offeredRequestableFieldsForTab(tab, allowedKeys)');
    expect(REQUEST_CARD, 'the prop is required, so a caller cannot silently reopen every field').toContain(
      'allowedKeys: ReadonlySet<string>;',
    );
    expect(ME_PAGE).toContain('const allowedRequestKeys = profileChangeAllowedKeys(s);');
    for (const tab of ['profile', 'bankStatutory']) {
      expect(
        ME_PAGE.includes(`<RequestChangeCard tab="${tab}"`) && ME_PAGE.includes('allowedKeys={allowedRequestKeys}'),
        `the ${tab} card must be handed the tenant's allow-list`,
      ).toBe(true);
    }
    // Two cards, two allow-list props — a page that resolved it once and passed it once would leave one
    // tab reading the full declaration.
    expect(ME_PAGE.split('allowedKeys={allowedRequestKeys}').length - 1).toBe(2);
  });

  it('offers NO inert control — the request card contains no disabled attribute at all', () => {
    // "Assert it renders nothing rather than something inert." A disabled control still announces that
    // the field exists and that somebody decided this employee may not touch it, and it is one removed
    // attribute away from being submittable.
    // COMMENTS STRIPPED FIRST (AGENTS 27): this file's own explanation of why nothing is disabled
    // contains the word, and a source-scanning guard that tripped on prose would teach the next person
    // to delete the explanation rather than keep the property.
    const cardCode = REQUEST_CARD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(cardCode, 'a request control must never render disabled — it must not render').not.toMatch(
      /\bdisabled\b/,
    );
    // And the pure function says the same thing: an excluded key is absent from the list, not flagged in it.
    const only = offeredRequestableFieldsForTab('profile', new Set(['fullName']));
    expect(only.map((f) => f.key)).toEqual(['fullName']);
    expect(offeredRequestableFieldsForTab('profile', new Set())).toEqual([]);
  });

  it('the service drops a disallowed key too — the screen is not the gate', () => {
    expect(CORE_PROFILE).toContain('sanitizeProposed(p.proposed, profileChangeAllowedKeys(ctx))');
    expect(CORE_PROFILE).toContain('if (!allowed.has(key)) continue;');
    // The HR-DIRECT setter is deliberately NOT narrowed by the employee's permission: switching a field
    // off must not stop HR correcting it, which is the very act an employee is being told to ask for.
    expect(CORE_PROFILE).toContain('EVERY_REQUESTABLE_KEY,');
  });
});

describe('r261 — the settings screen speaks the declaration\'s own vocabulary', () => {
  it('renders one control per DECLARED field, named by the shared people.detail key', () => {
    expect(SETTINGS_PAGE).toContain('requestableFieldsForTab(tab).map');
    expect(SETTINGS_PAGE, 'per FIELD, which is what the reporter asked for').toContain('value={f.key}');
    expect(SETTINGS_PAGE, 'and named the way Personnel Management names it').toContain('{tp(f.labelKey)}');
    // No second vocabulary: the screen must not invent a label key of its own for a field.
    expect(SETTINGS_PAGE).not.toMatch(/t\(`field\./);
  });

  it('the action intersects the posted names with the declaration and never trusts them', () => {
    /**
     * ⚠️ THE FORM POSTS FIELD NAMES. A hand-rolled POST can name anything at all, and the dangerous
     * shape is not a typo — it is a key the declaration deliberately EXCLUDES (an HR determination, or
     * something on the withheld list an employee may not even see). Storing a permission over one of
     * those would make it requestable the moment anybody widened the declaration.
     */
    expect(SETTINGS_ACTIONS).toContain('PROFILE_REQUESTABLE_KEYS.filter((k) => posted.includes(k)');
    expect(SETTINGS_ACTIONS, 'and the setting key is a constant, never posted').not.toContain("formData.get('key')");
    // The consequence of switching a field off is carried out in the same action, not left to a cron.
    expect(SETTINGS_ACTIONS).toContain('withdrawProfileChangesForLockedFields(s, {');
    expect(SETTINGS_ACTIONS, 'the setting is written FIRST, so a failure cannot withdraw under a permission that never changed').toMatch(
      /setTenantSetting\(s, \{ key: PROFILE_REQUEST_FIELDS_SETTING_KEY[\s\S]*?withdrawPendingRequests|setTenantSetting\(s, \{ key: PROFILE_REQUEST_FIELDS_SETTING_KEY[\s\S]*?withdrawProfileChangesForLockedFields/,
    );
  });

  it('the withdrawal writes the request row and NOTHING else — no master table, ever', () => {
    const body = CORE_PROFILE.slice(CORE_PROFILE.indexOf('export async function withdrawProfileChangesForLockedFields('));
    expect(body.length, 'withdrawProfileChangesForLockedFields could not be located').toBeGreaterThan(400);
    for (const writer of ['.update(employeeStatutoryMy)', '.update(person)', '.delete(']) {
      expect(body.includes(writer), `${writer} must not appear in the withdrawal path`).toBe(false);
    }
    expect(body).toContain(".set({ status: 'rejected'");
    // Nobody judged it, so nobody is recorded as having judged it.
    expect(body).toContain('decidedByEmploymentId: null');
  });
});

describe('r261 — the reporter is told what the setting cannot do', () => {
  it('the document states the manager-approval limit rather than leaving it as a silence', () => {
    /**
     * The plan's parent request described manager-then-HR approval. Stage three ships a setting that can
     * only NARROW who approves, because approving WRITES the master record and `person_rls` admits only
     * an administrator — so a manager approver would have been a widening of master-record write access
     * to every manager, by every route. That is a constraint the reporter can act on (it is the shape of
     * the next request), and a document that omitted it would read as if manager approval had simply
     * been forgotten.
     */
    expect(DOC_SETTINGS).toMatch(/manager/i);
    expect(DOC_SETTINGS).toMatch(/person_rls|master record/i);
    expect(DOC_SETTINGS, 'single-level, as the reporter approved it').toMatch(/single/i);
  });

  it('every key the settings screen renders resolves in ALL SIX catalogues', () => {
    const report: string[] = [];
    const KEYS = [
      'title',
      'description',
      'readOnlyNotice',
      'approverHeading',
      'approverHelp',
      'singleLevelNote',
      'saveApprover',
      'savedApprover',
      'unknownApprover',
      'fieldsHeading',
      'fieldsHelp',
      'lockWithdrawsNotice',
      'tabProfile',
      'tabBankStatutory',
      'waitingCount',
      'saveFields',
      'savedFields',
      'savedFieldsWithdrew',
      'withdrawnReason',
    ];
    for (const loc of LOCALES) {
      for (const k of KEYS) {
        const v = leaf(leaf(CATALOGS[loc], 'profileRequestSettings'), k);
        if (typeof v !== 'string' || v === '') report.push(`${loc}: profileRequestSettings.${k}`);
      }
      // The dynamic per-option keys, and the typed refusal reasons the action resolves by name.
      for (const a of PROFILE_REQUEST_APPROVERS) {
        for (const ns of ['approverOption', 'approverOptionHelp']) {
          const v = leaf(leaf(CATALOGS[loc], `profileRequestSettings.${ns}`), a);
          if (typeof v !== 'string' || v === '') report.push(`${loc}: profileRequestSettings.${ns}.${a}`);
        }
      }
      for (const r of ['not_group_admin', 'unknown_key', 'not_tenant_scoped', 'not_customer_visible', 'wrong_type']) {
        const v = leaf(leaf(CATALOGS[loc], 'profileRequestSettings.refused'), r);
        if (typeof v !== 'string' || v === '') report.push(`${loc}: profileRequestSettings.refused.${r}`);
      }
      // The nav label the sidebar AND the function-access grid resolve, and the /me card's own wording
      // for a tab whose fields are all switched off.
      for (const [ns, k] of [['nav', 'profileRequestSettings'], ['me', 'noRequestableFields']] as const) {
        const v = leaf(leaf(CATALOGS[loc], ns), k);
        if (typeof v !== 'string' || v === '') report.push(`${loc}: ${ns}.${k}`);
      }
    }
    expect(report, report.join('\n')).toEqual([]);
  });
});
