/**
 * Create New Employee — drafts. Item 6d671f44, extended by bd271009, reshaped by 06f0cb8f.
 *
 * 6d671f44's requirements were mostly ABOUT WHAT A DRAFT IS NOT: it must not appear as an employee,
 * must not enter payroll, must not trigger statutory calculation, must not appear in reports, and must
 * not consume an Employee ID. All but the last are still true by CONSTRUCTION — a draft is captured
 * input in its own table and no employment exists until Activate — and §3 proves the construction
 * rather than testing each list read one by one.
 *
 * ITEM bd271009 EXTENDED IT: the Employee ID became conditionally required and the "Allow manual
 * override" switch started meaning something (§1b, §5, §6).
 *
 * ITEM 06f0cb8f INVERTED THE LAST CLAUSE. A draft now TAKES its Employee ID at Create and holds it, so
 * no second draft, no hand-entry and no bulk import can be given it. §7 is that hold: what it blocks,
 * what Activate does with it, and — the part with a real cost — when a discard gives the number back
 * and when it leaves a gap.
 *
 * §1  the two completeness rules (pure, shared by the browser and the server)
 * §1b the Employee ID mode resolver (pure)
 * §2  the computed-key guard — `t(`steps.${k}`)` and `t(`fields.${f}`)` are INVISIBLE to
 *     test/i18n-coverage.test.ts check C, which only resolves literal keys
 * §3  the draft lifecycle against a real database
 * §4  source guards on migration 0337 and its journal entry
 * §5  which Employee ID a wizard-created employee gets, against a real database
 * §6  source guards on migration 0355 and its journal entry
 * §7  the reserved Employee ID (item 06f0cb8f), against a real database
 * §8  source guards on migration 0415 and its journal entry
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  DRAFT_TABS,
  draftLabel,
  missingByTab,
  missingForCreation,
  missingToCreate,
  stepKey,
  stepNumber,
  type EmployeeDraftData,
} from '../lib/employee-draft-schema';
import { resolveEmployeeIdMode, type EmployeeIdRule } from '../lib/employee-id-mode';
import {
  completeEmployeeDraft,
  createEmployeeDraftWithReservedCode,
  discardEmployeeDraft,
  employeeIdRuleFor,
  getEmployeeDraft,
  isEmployeeCodeTaken,
  listEmployeeDrafts,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { createConfig, listConfigs } from '../core/employee-id-config';
import { hireEmployee } from '../core/org';
import { commitEmployeeImport, validateEmployeeImport } from '../core/import';
import { parseCsvRecords } from '../lib/csv';
import { movementHistory } from '../core/movement';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

let b: Base;

/**
 * b1b1879d — `listEmployeeDrafts` now takes the top-bar company scope, and has no unscoped default. These
 * cases are about the draft itself, not the scope, so they read the every-company view: all of the tenant's
 * companies selected, which is also the one view that includes a draft with no company yet.
 */
const everyCompany = async () => ({
  companyIds: (
    await owner.db.select({ id: schema.company.id }).from(schema.company).where(eq(schema.company.tenantId, b.tenantId))
  ).map((r) => r.id),
  includeWithoutCompany: true,
});

/**
 * A draft that has everything creation needs, for the fixtures below.
 *
 * IT NOW CARRIES A HAND-TYPED EMPLOYEE ID, and that is the item bd271009 behaviour change made visible:
 * `seedBase` configures no Employee ID Auto Running Number Setup, and the wizard no longer falls silently
 * through to the legacy house counter for a company that has none. The bulk importer and the seeds are
 * deliberately untouched — §5 pins that with a direct `hireEmployee` call.
 */
function completeDraft(over: Partial<EmployeeDraftData> = {}): EmployeeDraftData {
  return {
    profile: {
      fullName: 'Nadia Yusof',
      primaryEmail: `nadia.${randomUUID().slice(0, 8)}@demo.test`,
      employeeCode: `WZ${randomUUID().slice(0, 8).toUpperCase()}`,
    },
    employment: {
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    },
    payroll: { basicSalary: '5200' },
    ...over,
  };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

// ── §1 the completeness rules ─────────────────────────────────────────────────────────────────────
describe('§1 the two rules — what Create asks for, and what Activate needs', () => {
  it('ITEM 06f0cb8f — Create asks for exactly four things, and only those four', () => {
    // The defect this pins: the old single rule made a new employee wait on Department, Employment Type,
    // Join Date and a salary before anything at all existed, so an offer that had been accepted could not
    // be recorded and its Employee ID could not be held. Splitting the rule is what makes Create short —
    // and the count matters as much as the contents. A fifth entry sneaking in here is the regression.
    expect(missingToCreate({}, { employeeIdRule: null })).toEqual([
      'company',
      'employeeCode',
      'fullName',
      'primaryEmail',
    ]);
    // …and nothing an employment needs is judged at Create.
    for (const f of ['department', 'employmentType', 'hiredOn', 'basicSalary']) {
      expect(missingToCreate({}, { employeeIdRule: null })).not.toContain(f);
    }
  });

  it('the four Create fields are NOT re-asked by the Activate rule — that is the whole split', () => {
    // Deliberately an empty draft: even with nothing at all filled in, the Activate rule says nothing
    // about company, name or email, because by the time it runs those are settled and stored.
    const m = missingForCreation({});
    for (const f of ['company', 'fullName', 'primaryEmail', 'employeeCode']) expect(m).not.toContain(f);
    // r374 (item 7dbaf677) — `remarks`, NOT `basicSalary`. An empty draft has no basic amount, which is
    // now LEGITIMATE (a Director paid quarterly fees); what it is missing is the sentence saying why.
    expect(m).toEqual(['department', 'employmentType', 'hiredOn', 'remarks']);
  });

  it('an empty draft is missing exactly the required fields, grouped by their own TAB', () => {
    const m = missingByTab({});
    // PROFILE DETAILS NOW REQUIRES NOTHING (item 06f0cb8f). Company, Full Name and Email left for the
    // Create screen; what is left on this step is optional in every writer downstream, so it opens with
    // a tick. Its rules are FORMAT rules only — see the malformed-date case below.
    expect(m.profile).toEqual([]);
    expect(m.job).toEqual(['department', 'employmentType', 'hiredOn']);
    expect(m.bankStatutory).toEqual([]); // nothing on Bank & Statutory is required by any writer
    // r374 — see the note on the Create/Activate split case above: an absent amount asks for REMARKS.
    expect(m.payroll).toEqual(['remarks']);
    // ITEM 759dfc7d ADDED `family`, AND IT REQUIRES NOTHING. Most new joiners have no family record to
    // enter, so a step that demanded one would block every one of them; what the rule does judge is a
    // member somebody DID add (see test/employee-draft-family.test.ts §1).
    expect(m.family).toEqual([]);
    // Review is GONE — Activate replaced it, and `missingByTab` must not still be shaped around a step
    // the form no longer has. The KEYS ARE THE ACTIVE RECORD'S TAB KEYS since 759dfc7d work item 2
    // (`employment` → `job`, `statutory` → `bankStatutory`), which is what lets one rule speak the same
    // vocabulary as the screen it drives. The list is ALSO order-sensitive, which is why this case pins
    // it rather than a set: each key's position maps to `employee_draft.current_step` on rows already
    // sitting in production, so a tab may only ever be APPENDED. Re-ordering to put Family SECOND —
    // where the activated record shows it — would silently reopen every existing draft on another tab.
    expect(Object.keys(m)).toEqual(['profile', 'job', 'bankStatutory', 'payroll', 'family']);
  });

  it('a complete draft has nothing outstanding', () => {
    expect(missingForCreation(completeDraftShape())).toEqual([]);
    expect(missingToCreate(completeDraftShape())).toEqual([]);
  });

  it('with NO rule supplied the Employee ID is not judged at all — two callers rely on it', () => {
    // The OPTION-OMITTED contract, unchanged since bd271009: a caller that spans many companies (the
    // drafts list) has no single rule to apply, and a caller checking a draft whose ID is ALREADY HELD
    // (06f0cb8f) has nothing left to judge. Neither may start reporting every draft as incomplete.
    const d = completeDraftShape();
    delete d.profile!.employeeCode;
    expect(missingForCreation(d)).toEqual([]);
    expect(missingToCreate(d)).toEqual([]);
  });

  it('the identity number is NOT required — e3ce0d4d allows a passport holder', () => {
    const d = completeDraftShape();
    expect(d.profile!.icNumber).toBeUndefined();
    expect(missingForCreation(d)).toEqual([]);
  });

  it('rejects a malformed email and a malformed date rather than passing them to a writer', () => {
    // The email is judged by the CREATE rule now — it is one of the four — and a malformed one must be
    // refused there, before a record and an Employee ID exist for it.
    expect(missingToCreate({ profile: { fullName: 'X', primaryEmail: 'not-an-email' } })).toContain('primaryEmail');
    expect(missingByTab({ profile: { fullName: 'X', primaryEmail: 'a@b.co', dateOfBirth: '01/01/1990' } }).profile)
      .toContain('dateOfBirth');
    expect(missingByTab({ employment: { hiredOn: '1 June 2026' } }).job).toContain('hiredOn');
  });

  it('mirrors the importer: bank name and account number are all-or-nothing', () => {
    expect(missingByTab({ statutory: { bankName: 'Maybank' } }).bankStatutory).toEqual(['bankAccount']);
    expect(missingByTab({ statutory: { bankAccountNo: '514012345678' } }).bankStatutory).toEqual(['bankAccount']);
    expect(missingByTab({ statutory: { bankName: 'Maybank', bankAccountNo: '514012345678' } }).bankStatutory).toEqual([]);
    expect(missingByTab({ statutory: {} }).bankStatutory).toEqual([]);
  });

  it('mirrors setCompensation: a daily or hourly pay mode needs a positive rate', () => {
    const base = { payroll: { basicSalary: '5000', payMode: 'daily' } };
    expect(missingByTab(base).payroll).toContain('rateAmount');
    expect(missingByTab({ payroll: { ...base.payroll, rateAmount: '180' } }).payroll).not.toContain('rateAmount');
    // A monthly worker needs no rate at all.
    expect(missingByTab({ payroll: { basicSalary: '5000', payMode: 'monthly' } }).payroll).toEqual([]);
  });

  /**
   * r374 (item 7dbaf677) — THIS CASE USED TO SAY "rejects a zero or negative salary". The zero no
   * longer is rejected; the reporter told us plainly that a Director paid quarterly fees has no monthly
   * basic and that refusing the zero was wrong. The other two cases are UNCHANGED and must stay red: a
   * junk string is not a Director, and a negative wage has no meaning in any arrangement they described.
   * The full conditional rule lives in test/r374-no-basic-salary-forms.test.ts §1.
   */
  it('still rejects a negative or unparseable salary — but a ZERO is now a legitimate answer', () => {
    expect(missingByTab({ payroll: { basicSalary: '-100' } }).payroll).toContain('basicSalary');
    expect(missingByTab({ payroll: { basicSalary: 'abc' } }).payroll).toContain('basicSalary');
    // A zero is accepted on its own terms — what it needs is the reason, not a different amount.
    expect(missingByTab({ payroll: { basicSalary: '0' } }).payroll).not.toContain('basicSalary');
    expect(missingByTab({ payroll: { basicSalary: '0' } }).payroll).toEqual(['remarks']);
    expect(missingByTab({ payroll: { basicSalary: '0', remarks: "Quarterly director's fees" } }).payroll)
      .toEqual([]);
  });

  it('tab numbers and keys round-trip, and the label comes from the name typed so far', () => {
    for (const k of DRAFT_TABS) expect(stepKey(stepNumber(k))).toBe(k);
    // Out-of-range clamps rather than returning undefined — a stored step from a future version of
    // the wizard must still open something.
    expect(stepKey(0)).toBe(DRAFT_TABS[0]);
    expect(stepKey(99)).toBe(DRAFT_TABS[DRAFT_TABS.length - 1]);
    expect(draftLabel({ profile: { fullName: '  Nadia Yusof ' } })).toBe('Nadia Yusof');
    expect(draftLabel({})).toBe('');
  });
});

/** Pure (DB-free) twin of `completeDraft` for the §1 unit tests. */
function completeDraftShape(): EmployeeDraftData {
  return {
    profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@demo.test' },
    employment: {
      companyId: 'c1',
      departmentId: 'd1',
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    },
    payroll: { basicSalary: '5200' },
  };
}

// ── §1b the Employee ID mode (item bd271009) ──────────────────────────────────────────────────────
//
// ONE resolver decides three things that must never disagree: which radio is on, whether the Profile
// step shows a tick, and whether `completeEmployeeDraft` will accept the draft. These are pure, so they
// run without a database and pin the decision itself rather than any one of its three consumers.
describe('§1b the Employee ID mode decides whether the ID is required', () => {
  const rule = (over: Partial<EmployeeIdRule> = {}): EmployeeIdRule => ({
    hasConfig: true,
    scope: 'company',
    prefix: 'ABC',
    suffix: '',
    numberLength: 6,
    nextNumber: 123,
    sampleCode: 'ABC000123',
    allowManualOverride: true,
    ...over,
  });

  it('Auto Running Number is the default, and it needs no typed ID', () => {
    const d = resolveEmployeeIdMode(rule(), {});
    expect(d).toEqual({ mode: 'auto', choosable: true, forcedBecause: null, codeRequired: false });
    const draft = completeDraftShape();
    expect(missingToCreate(draft, { employeeIdRule: rule() })).toEqual([]);
  });

  it('Manual Key In makes the Employee ID required, ON THE CREATE SCREEN', () => {
    const d = resolveEmployeeIdMode(rule(), { chosen: 'manual' });
    expect(d).toMatchObject({ mode: 'manual', choosable: true, codeRequired: true });
    const draft = completeDraftShape();
    draft.profile!.employeeIdMode = 'manual';
    // 06f0cb8f — it is `missingToCreate` that judges it, so a typed ID is demanded on the four-field
    // screen that asks for it. The continue form never re-asks: by then the ID is held.
    expect(missingToCreate(draft, { employeeIdRule: rule() })).toContain('employeeCode');
    expect(missingForCreation(draft)).not.toContain('employeeCode');
    // Typing one satisfies it.
    draft.profile!.employeeCode = 'X-777';
    expect(missingToCreate(draft, { employeeIdRule: rule() })).toEqual([]);
  });

  it('NO setup for the company forces Manual and REQUIRES the ID — the one behaviour that changes', () => {
    // Today a blank ID here falls silently through to the legacy house counter (EMP-####). That is
    // where the unrecognised IDs came from, and it is what the reporter asked to stop.
    const d = resolveEmployeeIdMode(null, {});
    expect(d).toEqual({ mode: 'manual', choosable: false, forcedBecause: 'noConfig', codeRequired: true });
    expect(resolveEmployeeIdMode(rule({ hasConfig: false }), { chosen: 'auto' })).toMatchObject({
      mode: 'manual',
      forcedBecause: 'noConfig',
    });
    expect(missingToCreate(completeDraftShape(), { employeeIdRule: null })).toEqual(['employeeCode']);
  });

  it('"Allow manual override" off beats a stale remembered choice, and takes the choice away', () => {
    const off = rule({ allowManualOverride: false });
    // The draft remembers 'manual' from before the switch was turned off. The LIVE rule overrules it.
    const d = resolveEmployeeIdMode(off, { chosen: 'manual', hasCode: true });
    expect(d).toEqual({ mode: 'auto', choosable: false, forcedBecause: 'manualNotAllowed', codeRequired: false });
    // And a leftover code does not make the draft incomplete — it is simply not used.
    const draft = completeDraftShape();
    draft.profile!.employeeIdMode = 'manual';
    expect(missingToCreate(draft, { employeeIdRule: off })).toEqual([]);
  });

  it('a draft written before this screen existed reads as Manual when it already carries an ID', () => {
    expect(resolveEmployeeIdMode(rule(), { hasCode: true })).toMatchObject({ mode: 'manual', codeRequired: true });
    // …and as Auto when it does not.
    expect(resolveEmployeeIdMode(rule(), { hasCode: false })).toMatchObject({ mode: 'auto' });
    // A junk stored value is not obeyed: it falls back to the same default.
    expect(resolveEmployeeIdMode(rule(), { chosen: 'whatever' })).toMatchObject({ mode: 'auto' });
  });

  it('omitting the option entirely leaves the Employee ID unjudged, whatever the draft says', () => {
    const draft = completeDraftShape();
    draft.profile!.employeeIdMode = 'manual';
    expect(missingToCreate(draft)).toEqual([]);
  });
});

// ── §2 the computed-key guard ─────────────────────────────────────────────────────────────────────
describe('§2 every computed translation key resolves, in all six locales', () => {
  it('t(`tabs.${k}`) — one for every tab, and the old `steps` block is gone', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      for (const k of DRAFT_TABS) {
        expect(String(msgs.people?.wizard?.tabs?.[k] ?? '').trim(), `${loc} tabs.${k}`).not.toBe('');
      }
      // 759dfc7d work item 2 — the five-step form is gone and so are its step labels. Left behind they
      // would be five orphan strings per locale that read as the screen's vocabulary and are not.
      expect(msgs.people?.wizard?.steps, `${loc} wizard.steps`).toBeUndefined();
      // Back / Next went with the wizard: a tabbed record has no sequence to move along.
      expect(msgs.people?.wizard?.back, `${loc} wizard.back`).toBeUndefined();
      expect(msgs.people?.wizard?.next, `${loc} wizard.next`).toBeUndefined();
    }
  });

  it('t(`fields.${f}`) — every field name either rule can ever return', () => {
    // Enumerated from the rules themselves rather than hand-listed: drive them with inputs that trip
    // every branch, so a new required field added without a label fails HERE. BOTH rules are swept
    // (item 06f0cb8f) — the four Create fields are `missingToCreate`'s and are labelled from the same
    // `fields.*` block, so leaving it out would stop covering half the form.
    const trip: EmployeeDraftData[] = [
      {},
      { profile: { fullName: 'X', primaryEmail: 'bad', dateOfBirth: 'nope' } },
      { employment: { provisionalEndOn: 'nope' } },
      { statutory: { bankName: 'Maybank' } },
      { payroll: { basicSalary: '1', payMode: 'hourly' } },
      // r374 — the empty draft above no longer trips `basicSalary` (a blank amount is legitimate and
      // asks for `remarks` instead), so the only inputs that still reach that branch are a junk string
      // and a negative one. Both are listed so the sweep keeps covering the label for it.
      { payroll: { basicSalary: 'abc' } },
      { payroll: { basicSalary: '-100' } },
      // item 759dfc7d — the Family step's three names. Swept from the same rule for the same reason:
      // a family field added without a label would otherwise reach HR as a raw `fields.familyMemberX`.
      { family: [{}] },
      { family: [{ fullName: 'A', relationship: 'child', dateOfBirth: 'nope' }] },
    ];
    const names = new Set([
      ...trip.flatMap((d) => missingForCreation(d)),
      ...trip.flatMap((d) => missingToCreate(d)),
      // item bd271009 — the Manual Key In branch, reachable ONLY with a rule supplied.
      ...missingToCreate({}, { employeeIdRule: null }),
    ]);
    // Sanity: the sweep really did reach every step's rules.
    for (const expected of ['fullName', 'primaryEmail', 'dateOfBirth', 'company', 'department',
      'employmentType', 'hiredOn', 'provisionalEndOn', 'bankAccount', 'basicSalary', 'rateAmount',
      // r374 — the payroll tab's new name. It is rendered by the SAME `t(\`fields.${f}\`)` as the rest,
      // so a locale without it would show HR a raw `fields.remarks` on the outstanding list.
      'remarks',
      'employeeCode']) {
      expect(names.has(expected), expected).toBe(true);
    }
    // r392 (685d2380 step 1) — TWO NAMES ARE RELABELLED BEFORE THE COMPUTED KEY IS REACHED, by the wizard's
    // `missingFieldLabel`: `hiredOn` → `fields.groupJoinDate` (its old key is retired), and
    // `provisionalEndOn` → the box's own type-specific name (`fields.contractEndDate` /
    // `fields.internshipEndDate`, else the still-live `fields.provisionalEndOn`). So the key that must resolve
    // for those names is the one actually RENDERED, and the retired one must stay retired — a sweep that
    // only checked `fields.hiredOn` was non-empty would pass on "[retired r392 — …]".
    const RELABEL: Record<string, string[]> = {
      hiredOn: ['groupJoinDate'],
      provisionalEndOn: ['contractEndDate', 'internshipEndDate', 'provisionalEndOn'],
    };
    const wizard = read('app/admin/personnel/new/wizard.tsx');
    expect(wizard, 'the wizard intercepts hiredOn').toContain("if (f === 'hiredOn') return t('fields.groupJoinDate');");
    expect(wizard, 'the outstanding list goes through the relabeller').toContain('{missing[k].map(missingFieldLabel).join');
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      for (const n of names) {
        for (const key of RELABEL[n] ?? [n]) {
          const v = String(msgs.people?.wizard?.fields?.[key] ?? '').trim();
          expect(v, `${loc} fields.${key}`).not.toBe('');
          expect(v, `${loc} fields.${key} is a live label, not a retired one`).not.toMatch(/^\[retired/);
        }
      }
      expect(String(msgs.people?.wizard?.fields?.hiredOn), `${loc} fields.hiredOn retired, not deleted`).toMatch(
        /^\[retired r392/,
      );
    }
  });

  it('every Employee ID string exists in all six locales, placeholders intact (item bd271009)', () => {
    // A missing {code} here is the difference between naming the clashing ID and telling HR that
    // something, somewhere, is already taken — the whole value of the message.
    const plain = ['heading', 'chooseCompanyFirst', 'noSetup', 'modeLabel', 'modeAuto', 'modeManual',
      'forcedAuto', 'checking',
      // item 06f0cb8f — the three strings the reservation introduced. `reserveNote` and `heldFromCreate`
      // replaced wording that said the OPPOSITE ("the real ID is issued when the employee is created",
      // "saving as a draft costs nothing"), so a locale left on the old text would state the old promise.
      'reserveNote', 'heldFromCreate', 'issuedAtActivate'];
    const withVars: [string, string][] = [
      ['ruleCompany', '{sample}'],
      ['ruleGlobal', '{sample}'],
      ['duplicate', '{code}'],
      ['available', '{code}'],
    ];
    for (const loc of LOCALES) {
      const w = JSON.parse(read(`messages/${loc}.json`)).people.wizard;
      for (const k of plain) expect(String(w.employeeId?.[k] ?? '').trim(), `${loc} employeeId.${k}`).not.toBe('');
      for (const [k, v] of withVars) expect(String(w.employeeId?.[k] ?? ''), `${loc} employeeId.${k}`).toContain(v);
      // The strings the two forms need outside the Employee ID block.
      for (const k of ['createDraft', 'createDraftNote', 'createDescription', 'continueTitle',
        'companyFixedAfterCreate', 'activate', 'activating', 'activateNeeds', 'discardReleasesTip',
        'requiredField']) {
        expect(String(w[k] ?? '').trim(), `${loc} ${k}`).not.toBe('');
      }
      expect(String(w.hints?.companyFixed ?? '').trim(), `${loc} hints.companyFixed`).not.toBe('');
      // And the Draft status label the employee list renders on every draft row.
      const list = JSON.parse(read(`messages/${loc}.json`)).people.list;
      expect(String(list?.statusDraft ?? '').trim(), `${loc} list.statusDraft`).not.toBe('');
    }
  });

  it('the wording that the reservation INVERTED is gone from every locale, not just English', () => {
    // The failure this pins is specific and silent: `people.wizard.employeeId.draftCostsNothing` said
    // "Saving as a draft costs nothing. The Employee ID is taken only when the employee is successfully
    // created." That is now false. A locale still carrying the key would keep telling non-English users
    // the opposite of what the system does, and no rendering test would catch it because nothing reads it.
    for (const loc of LOCALES) {
      const w = JSON.parse(read(`messages/${loc}.json`)).people.wizard;
      for (const dead of ['draftCostsNothing', 'previewNote', 'staleCode', 'removeCode']) {
        expect(w.employeeId?.[dead], `${loc} employeeId.${dead}`).toBeUndefined();
      }
      // The Review step is gone from the form; its label must not survive as an orphan either.
      expect(w.steps?.review, `${loc} steps.review`).toBeUndefined();
    }
  });
});

// ── §3 the lifecycle, against a real database ─────────────────────────────────────────────────────
describe('§3 a draft creates nothing until it is completed', () => {
  it('saving a draft creates NO person, NO employment and NO employee code', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, { data: completeDraft(), currentStep: 2 });
    expect(id).toBeTruthy();
    expect(await counts()).toEqual(before);
    // And it is readable back exactly as saved.
    const got = await getEmployeeDraft(ctx, id);
    expect(got?.currentStep).toBe(2);
    expect(got?.data.profile?.fullName).toBe('Nadia Yusof');
  });

  it('the list derives its label and company from the payload, and recomputes what is outstanding', async () => {
    const ctx = adminCtx(b);
    await saveEmployeeDraft(ctx, { data: { profile: { fullName: 'Half Done' } }, currentStep: 1 });
    const rows = await listEmployeeDrafts(ctx, await everyCompany());
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Half Done');
    expect(rows[0].companyId).toBeNull();
    expect(rows[0].missing.length).toBeGreaterThan(0);
  });

  it('an update replaces the payload rather than creating a second draft', async () => {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data: { profile: { fullName: 'First' } }, currentStep: 1 });
    const again = await saveEmployeeDraft(ctx, { id, data: { profile: { fullName: 'Second' } }, currentStep: 3 });
    expect(again.id).toBe(id);
    expect(await listEmployeeDrafts(ctx, await everyCompany())).toHaveLength(1);
    expect((await getEmployeeDraft(ctx, id))?.data.profile?.fullName).toBe('Second');
  });

  it('refuses to complete an incomplete draft, and still creates nothing', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, { data: { profile: { fullName: 'Half' } }, currentStep: 1 });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Cannot create the employee yet/);
    expect(await counts()).toEqual(before);
    // The draft survives the refusal — losing the typed work would be the worse failure.
    expect(await getEmployeeDraft(ctx, id)).not.toBeNull();
  });

  it('completing it creates the employee through the real writers, and the draft stops existing', async () => {
    const ctx = adminCtx(b);
    const data = completeDraft({ payroll: { basicSalary: '5200', monthlyAllowance: '400' } });
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);

    // Assert the created row FIELD BY FIELD, not by counting — r73 Decision 3's lesson (a writer
    // silently dropping a column it predates surfaces only this way).
    const [emp] = await owner.db
      .select({
        companyId: schema.employment.companyId,
        hiredOn: schema.employment.hiredOn,
        joinDate: schema.employment.joinDate,
        employeeCode: schema.employment.employeeCode,
        personId: schema.employment.personId,
      })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    expect(emp.companyId).toBe(b.companyId);
    expect(emp.hiredOn).toBe('2026-06-01');
    // 89ea527b — the two dates start identical, seeded by hireEmployee.
    expect(emp.joinDate).toBe('2026-06-01');
    // The Employee ID is generated HERE and only here.
    expect(emp.employeeCode).toBeTruthy();

    const [p] = await owner.db
      .select({ fullName: schema.person.fullName, email: schema.person.primaryEmail })
      .from(schema.person)
      .where(eq(schema.person.id, emp.personId));
    expect(p.fullName).toBe('Nadia Yusof');
    expect(p.email).toBe(data.profile!.primaryEmail);

    // The initial assignment carries the department and the employment type.
    const [a] = await owner.db
      .select({ departmentId: schema.assignment.departmentId, employmentType: schema.assignment.employmentType })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, employmentId));
    expect(a.departmentId).toBe(b.deptA);
    expect(a.employmentType).toBe('full_time');

    // Compensation was set from the draft, effective from the join date.
    const [c] = await owner.db
      .select({ basic: schema.compensation.basicSalary, from: schema.compensation.validFrom })
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employmentId));
    expect(Number(c.basic)).toBe(5200);
    expect(c.from).toBe('2026-06-01');

    // The draft is gone, and the completion is on the audit trail.
    expect(await getEmployeeDraft(ctx, id)).toBeNull();
    expect(await listEmployeeDrafts(ctx, await everyCompany())).toHaveLength(0);
    const [ev] = await owner.db
      .select({ type: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'employee-draft.completed'));
    expect(ev?.type).toBe('employee-draft.completed');
  });

  it('opens Employment History with exactly ONE Hired row — no spurious second row', async () => {
    const ctx = adminCtx(b);
    const data = completeDraft();
    data.employment!.reportingManagerEmploymentId = undefined;
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    // r78 (4d391ab7): the initial assignment is SYNTHESIZED as the Hired row from the employment
    // itself. Emitting a movement event for it would give every new employee TWO rows for one
    // action — the exact fault that round fixed for the hire-time reporting line. This asserts the
    // PROJECTION, not the event log, because the projection is what the reporter actually sees.
    const history = await movementHistory(ctx, employmentId);
    expect(history.filter((r) => r.kind === 'hired')).toHaveLength(1);
    // A wizard-created employee DOES have an `employment.hired` event, so its Hired row is the
    // event-derived one with a real entry date — core/movement.ts only synthesizes an entry-date-less
    // Hired row for seed/legacy employments that never had the event. What matters here is the COUNT.
    // Exactly ONE row, and it is the Hired row. The initial salary is deliberately part of Hired
    // rather than a movement of its own (core/movement.ts: "Initial salary at hire is part of Hired"),
    // which is why a correct wizard produces a single-row history for a brand-new employee.
    expect(history.map((r) => r.kind)).toEqual(['hired']);
    // And nothing recorded a movement of its own.
    const recorded = await owner.db
      .select({ type: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.subjectEmploymentId, employmentId));
    expect(recorded.map((r) => r.type)).not.toContain('employment.movement.recorded');
  });

  it('discarding a draft removes it and creates nothing', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, { data: completeDraft(), currentStep: 3 });
    await discardEmployeeDraft(ctx, id);
    expect(await listEmployeeDrafts(ctx, await everyCompany())).toHaveLength(0);
    expect(await counts()).toEqual(before);
  });

  it('a non-admin cannot save, complete or discard', async () => {
    const employee = { ...adminCtx(b), roles: ['employee'] };
    await expect(saveEmployeeDraft(employee, { data: {}, currentStep: 1 })).rejects.toThrow(/Only an admin/);
    await expect(completeEmployeeDraft(employee, randomUUID())).rejects.toThrow(/Only an admin/);
    await expect(discardEmployeeDraft(employee, randomUUID())).rejects.toThrow(/Only an admin/);
  });

  it('an invalid identity number is refused BEFORE anything is created', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const data = completeDraft();
    data.profile!.icNumber = '12345'; // not 12 digits
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Invalid identity number/);
    expect(await counts()).toEqual(before);
  });
});

/** Person / employment counts — the two things a draft must never create. */
async function counts(): Promise<{ people: number; employments: number }> {
  const [p] = await owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.person);
  const [e] = await owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.employment);
  return { people: Number(p.n), employments: Number(e.n) };
}

// ── §4 the migration ──────────────────────────────────────────────────────────────────────────────
describe('§4 migration 0337', () => {
  const mig = read('db/migrations/0337_employee_draft.sql');

  it('creates the table with RLS, idempotently', () => {
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS employee_draft');
    expect(mig).toContain('ALTER TABLE employee_draft ENABLE ROW LEVEL SECURITY');
    expect(mig).toContain('DROP POLICY IF EXISTS employee_draft_rls');
    expect(mig).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON employee_draft TO ai_hr_app');
  });

  it('is visible to the AUTHOR or an admin — a different rule from an employment row', () => {
    expect(mig).toContain('app.is_admin() OR app.is_self_person(created_by_person_id)');
    // Deliberately NOT app.can_see_person: a draft is not about a person yet. Asserted against the
    // SQL only — the header comment says the same thing in prose, and a guard that trips on its own
    // explanation is a guard nobody will keep.
    const sqlOnly = mig
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(sqlOnly).not.toContain('can_see_person');
    expect(sqlOnly).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('its journal entry sits ABOVE the deployed watermark (the r84 stale-number trap)', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const mine = journal.entries.find((e) => e.tag === '0337_employee_draft');
    expect(mine).toBeTruthy();
    expect(mine!.idx).toBe(337);
    // drizzle-kit reads the last applied `when` as a watermark and SILENTLY SKIPS anything below it.
    // The invariant is monotonicity against everything that runs BEFORE this migration — not against
    // every entry in the journal. Comparing against the global maximum passed in isolation and then
    // failed the moment a SIBLING agent's higher-numbered migration merged alongside it, which is an
    // integration artefact rather than the trap being guarded.
    const priorMax = Math.max(...journal.entries.filter((e) => e.idx < mine!.idx).map((e) => e.when));
    expect(mine!.when).toBeGreaterThan(priorMax);
  });
});

// ── §5 the Employee ID rule, against a real database (item bd271009) ──────────────────────────────
//
// §1b pins the DECISION; this pins that the decision is what actually happens to a row. Every case here
// goes through `completeEmployeeDraft`, which is the only path the wizard has.
describe('§5 which Employee ID a wizard-created employee gets', () => {
  /** A draft with NO hand-typed ID (the fixture above carries one, because seedBase has no setup). */
  const autoDraft = (over: Partial<EmployeeDraftData> = {}): EmployeeDraftData => {
    const d = completeDraft(over);
    delete d.profile!.employeeCode;
    return d;
  };
  const codeOf = async (employmentId: string) => {
    const [row] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    return row.code;
  };

  it('a company with NO setup refuses a blank Employee ID, and creates nothing', async () => {
    const ctx = adminCtx(b);
    // seedBase configures no Employee ID Auto Running Number Setup at all.
    expect((await employeeIdRuleFor(ctx, b.companyId)).hasConfig).toBe(false);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, { data: autoDraft(), currentStep: 5 });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Cannot create the employee yet.*employeeCode/);
    expect(await counts()).toEqual(before);
    // The typed work survives the refusal.
    expect(await getEmployeeDraft(ctx, id)).not.toBeNull();
  });

  it('the IMPORTER path is deliberately untouched — a blank code still falls back to the legacy counter', async () => {
    // The new rule lives in the wizard's own validation, NOT inside hireEmployee, precisely so bulk
    // import and the seed corpus keep working exactly as they do today.
    const { employmentId } = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Imported', primaryEmail: `imp_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    });
    expect(await codeOf(employmentId)).toBe('EMP-0001');
  });

  it('with an ACTIVE setup, Auto issues the previewed running number and advances the counter', async () => {
    const ctx = adminCtx(b);
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 123, numberLength: 6, increment: 1,
      allowManualOverride: true,
    });
    const rule = await employeeIdRuleFor(ctx, b.companyId);
    expect(rule).toMatchObject({ hasConfig: true, scope: 'company', sampleCode: 'ABC000123' });

    const { id } = await saveEmployeeDraft(ctx, { data: autoDraft(), currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    // The sample the wizard showed is the ID that was issued.
    expect(await codeOf(employmentId)).toBe('ABC000123');
    expect((await listConfigs(ctx))[0].currentRunningNumber).toBe(123);
  });

  it('with "Allow manual override" OFF, a hand-keyed ID is REFUSED — the switch finally does something', async () => {
    const ctx = adminCtx(b);
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 1, numberLength: 4, increment: 1,
      allowManualOverride: false,
    });
    const before = await counts();
    const data = completeDraft(); // carries a hand-typed ID
    data.profile!.employeeIdMode = 'manual';
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/does not allow manual entry/);
    expect(await counts()).toEqual(before);
  });

  it('with the switch ON, a hand-keyed ID is honoured and the running counter does NOT move', async () => {
    const ctx = adminCtx(b);
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 1, numberLength: 4, increment: 1,
      allowManualOverride: true,
    });
    const data = completeDraft({ profile: { fullName: 'Manual Mary', primaryEmail: `mm_${randomUUID().slice(0, 8)}@t.local`, employeeCode: 'X-777', employeeIdMode: 'manual' } });
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    expect(await codeOf(employmentId)).toBe('X-777');
    // Nothing was burned off the sequence — that is the "gaps are possible, duplicates are not" contract.
    expect((await listConfigs(ctx))[0].currentRunningNumber).toBe(0);
  });

  it('a code left behind by switching Manual → Auto is IGNORED, not used', async () => {
    const ctx = adminCtx(b);
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 500, numberLength: 6, increment: 1,
      allowManualOverride: true,
    });
    const data = completeDraft();
    data.profile!.employeeCode = 'LEFTOVER-1';
    data.profile!.employeeIdMode = 'auto'; // the mode on screen is the promise
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    expect(await codeOf(employmentId)).toBe('ABC000500');
  });

  it('the rule is read at CREATION, so editing the setup between draft and create is obeyed', async () => {
    const ctx = adminCtx(b);
    const data = completeDraft(); // hand-typed ID, valid while no setup exists
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    // An administrator now adds a setup that forbids hand-keying. A rule STORED on the draft would
    // still say "manual is fine" and the wizard would promise an ID the engine will not issue.
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 1, numberLength: 4, increment: 1,
      allowManualOverride: false,
    });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/does not allow manual entry/);
  });

  it('the duplicate look-ahead names a clash, is case-insensitive, and a DRAFT reserves nothing', async () => {
    const ctx = adminCtx(b);
    const data = completeDraft();
    data.profile!.employeeCode = 'DUP-1';
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    // A saved draft has taken NOTHING — the look-ahead still says the ID is free.
    expect(await isEmployeeCodeTaken(ctx, 'DUP-1')).toBe(false);
    await completeEmployeeDraft(ctx, id);
    expect(await isEmployeeCodeTaken(ctx, 'DUP-1')).toBe(true);
    expect(await isEmployeeCodeTaken(ctx, 'dup-1')).toBe(true); // same identifier, either case
    expect(await isEmployeeCodeTaken(ctx, '  dup-1  ')).toBe(true);
    expect(await isEmployeeCodeTaken(ctx, 'DUP-2')).toBe(false);
    expect(await isEmployeeCodeTaken(ctx, '')).toBe(false);
    // And the create refuses the second one, naming it, exactly as the look-ahead warned.
    const second = completeDraft();
    second.profile!.employeeCode = 'DUP-1';
    const { id: id2 } = await saveEmployeeDraft(ctx, { data: second, currentStep: 5 });
    await expect(completeEmployeeDraft(ctx, id2)).rejects.toThrow(/Employee ID "DUP-1" is already in use/);
  });

  it('the drafts LIST still counts what it always did — it has no single rule to apply', async () => {
    const ctx = adminCtx(b);
    // A draft with no ID, for a company with no setup. `completeEmployeeDraft` would refuse it, but the
    // list spans many companies and must not start calling every such draft incomplete.
    await saveEmployeeDraft(ctx, { data: autoDraft(), currentStep: 5 });
    expect((await listEmployeeDrafts(ctx, await everyCompany()))[0].missing).toEqual([]);
  });
});

// ── §6 migration 0355 ─────────────────────────────────────────────────────────────────────────────
describe('§6 migration 0355 — allow_manual_override on existing active setups', () => {
  const mig = read('db/migrations/0355_employee_id_manual_override_default_on.sql');

  it('flips ACTIVE configs only, and touches no counter', () => {
    expect(mig).toContain('UPDATE "employee_id_config"');
    expect(mig).toContain('"allow_manual_override" = true');
    expect(mig).toContain(`"status" = 'active'`);
    // The running counters are the one thing in this table an employee's ID depends on.
    const sqlOnly = mig.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(sqlOnly).not.toContain('current_running_number');
    expect(sqlOnly).not.toContain('DELETE');
    expect(sqlOnly).not.toContain('employment');
  });

  it('its journal entry sits ABOVE everything that runs before it (the r84 stale-number trap)', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const mine = journal.entries.find((e) => e.tag === '0355_employee_id_manual_override_default_on');
    expect(mine).toBeTruthy();
    expect(mine!.idx).toBe(355);
    const priorMax = Math.max(...journal.entries.filter((e) => e.idx < mine!.idx).map((e) => e.when));
    expect(mine!.when).toBeGreaterThan(priorMax);
  });

  it('a NEW setup created through the settings form starts with manual entry permitted', () => {
    // The screen's checkbox now defaults to ticked; without it, 0355 would flip the old rows on and the
    // very next setup an administrator created would silently be off again.
    expect(read('app/admin/settings/employee-id/page.tsx')).toContain('editing?.allowManualOverride ?? true');
  });
});

// ── §7 the reserved Employee ID (item 06f0cb8f) ───────────────────────────────────────────────────
//
// THE ONE PROMISE THIS ITEM MAKES: "The generated Employee ID shall be reserved and cannot be assigned
// to another employee, even if the employee remains in Draft status." Everything here is that sentence,
// tested from each of the three directions an ID can be handed out — a second draft, the hire path, and
// the bulk importer — plus the two halves of the give-it-back rule.
describe('§7 an Employee ID held by a draft', () => {
  const config = (over: Record<string, unknown> = {}) =>
    createConfig(adminCtx(b), {
      companyId: b.companyId, prefix: 'ABC', startNumber: 1, numberLength: 4, increment: 1,
      allowManualOverride: true, ...over,
    });
  const four = (over: Partial<Parameters<typeof createEmployeeDraftWithReservedCode>[1]> = {}) => ({
    companyId: b.companyId,
    fullName: 'Nadia Yusof',
    primaryEmail: `nadia.${randomUUID().slice(0, 8)}@demo.test`,
    ...over,
  });
  const codeOf = async (employmentId: string) => {
    const [row] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    return row.code;
  };
  const counterOf = async () => (await listConfigs(adminCtx(b)))[0].currentRunningNumber;
  const legacyCounter = async () => {
    const [row] = await owner.db
      .select({ v: schema.tenantCounter.value })
      .from(schema.tenantCounter)
      .where(and(eq(schema.tenantCounter.tenantId, b.tenantId), eq(schema.tenantCounter.kind, 'employee_code')));
    return row?.v ?? null;
  };

  it('Create issues the number, holds it on the draft, and STILL creates no person and no employment', async () => {
    const ctx = adminCtx(b);
    await config({ startNumber: 7, numberLength: 6 });
    const before = await counts();
    const { id, employeeCode } = await createEmployeeDraftWithReservedCode(ctx, four());
    expect(employeeCode).toBe('ABC000007');
    // The counter moved — that IS the reservation, and it is the one thing 6d671f44 promised would not
    // happen. Everything else that item promised still holds, which is what `counts()` proves.
    expect(await counterOf()).toBe(7);
    expect(await counts()).toEqual(before);
    const draft = await getEmployeeDraft(ctx, id);
    expect(draft?.reservedEmployeeCode).toBe('ABC000007');
    // Mirrored into the payload so the continue form renders it without a second prop.
    expect(draft?.data.profile?.employeeCode).toBe('ABC000007');
    expect(draft?.companyId).toBe(b.companyId);
  });

  it('blocks a SECOND draft, a hand-entered hire and a bulk import — all three, by name', async () => {
    const ctx = adminCtx(b);
    const { employeeCode } = await createEmployeeDraftWithReservedCode(
      ctx,
      four({ employeeIdMode: 'manual', employeeCode: 'HELD-1' }),
    );
    expect(employeeCode).toBe('HELD-1');

    // 1. A second draft typing the same ID.
    await expect(
      createEmployeeDraftWithReservedCode(ctx, four({ employeeIdMode: 'manual', employeeCode: 'held-1' })),
    ).rejects.toThrow(/reserved by a draft/);

    // 2. The hire path — the single-hire form and every other caller of hireEmployee.
    await expect(
      hireEmployee(ctx, {
        person: { fullName: 'Rival', primaryEmail: `r_${randomUUID().slice(0, 8)}@t.local` },
        employeeCode: 'HELD-1',
        companyId: b.companyId,
        departmentId: b.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-06-01',
      }),
    ).rejects.toThrow(/reserved by a draft/);

    // 3. The BULK IMPORTER. This is the wider-than-reported bit: the ticket only mentions "another
    // employee", but an import is the path most likely to be run by somebody who has never seen the
    // draft. It inherits the check because commitEmployeeImport goes through hireEmployee — assert the
    // OUTCOME rather than the composition, so a future refactor that stops inheriting it fails here.
    const csv =
      'full_name,email,department,hired_on,ic_number,basic_salary,employee_code\n' +
      `Import Rival,imp_${randomUUID().slice(0, 8)}@t.local,Finance,2026-06-01,910505051234,4000,HELD-1\n`;
    const preview = await validateEmployeeImport(ctx, {
      companyId: b.companyId,
      records: parseCsvRecords(csv).records,
    });
    // Named in the PREVIEW, where a spreadsheet can still be corrected…
    expect(preview.validCount).toBe(0);
    expect(preview.rows[0].errors.join(' ')).toMatch(/reserved by a draft/);
    // …and refused by the commit even if the preview is bypassed, because commitEmployeeImport
    // re-validates and then goes through hireEmployee. Assert the OUTCOME rather than the
    // composition, so a future refactor that stops inheriting the check fails here.
    const res = await commitEmployeeImport(ctx, {
      companyId: b.companyId,
      records: parseCsvRecords(csv).records,
    });
    expect(res.imported).toBe(0);

    // And nothing anywhere got the ID.
    const rows = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(eq(schema.employment.employeeCode, 'HELD-1'));
    expect(rows).toHaveLength(0);
  });

  it('the look-ahead reports a held ID as taken — and a draft never collides with itself', async () => {
    const ctx = adminCtx(b);
    const { id } = await createEmployeeDraftWithReservedCode(
      ctx,
      four({ employeeIdMode: 'manual', employeeCode: 'HELD-2' }),
    );
    expect(await isEmployeeCodeTaken(ctx, 'HELD-2')).toBe(true);
    expect(await isEmployeeCodeTaken(ctx, ' held-2 ')).toBe(true); // same identifier, either case
    expect(await isEmployeeCodeTaken(ctx, 'HELD-2', { excludeDraftId: id })).toBe(false);
    expect(await isEmployeeCodeTaken(ctx, 'HELD-3')).toBe(false);
  });

  it('Activate uses the held ID and does NOT advance the counter a second time', async () => {
    const ctx = adminCtx(b);
    await config({ startNumber: 100, numberLength: 5 });
    const { id, employeeCode } = await createEmployeeDraftWithReservedCode(ctx, four());
    expect(employeeCode).toBe('ABC00100');
    expect(await counterOf()).toBe(100);

    // Fill in the rest, exactly as the continue form does.
    const draft = await getEmployeeDraft(ctx, id);
    await saveEmployeeDraft(ctx, {
      id,
      data: {
        ...draft!.data,
        employment: { ...draft!.data.employment, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-06-01' },
        payroll: { basicSalary: '5200' },
      },
      currentStep: 4,
    });
    const { employmentId } = await completeEmployeeDraft(ctx, id);

    // The employee carries the number that was held for them from day one…
    expect(await codeOf(employmentId)).toBe('ABC00100');
    // …and the sequence did not skip one. Without the reservation being passed through, hireEmployee
    // would have generated ABC00101 and the ID HR was shown at Create would belong to nobody.
    expect(await counterOf()).toBe(100);
    // The hold is released with the draft — two live claims on one ID is the state it exists to prevent.
    expect(await getEmployeeDraft(ctx, id)).toBeNull();
  });

  it('discarding AT THE TIP gives the number back; discarding BEHIND a later create does not', async () => {
    const ctx = adminCtx(b);
    await config({ startNumber: 1, numberLength: 4 });

    // At the tip: nothing was issued after it.
    const first = await createEmployeeDraftWithReservedCode(ctx, four());
    expect(first.employeeCode).toBe('ABC0001');
    expect(await counterOf()).toBe(1);
    await discardEmployeeDraft(ctx, first.id);
    expect(await counterOf()).toBe(0);
    // Proof it was really returned rather than merely decremented: the next Create takes it again.
    const again = await createEmployeeDraftWithReservedCode(ctx, four());
    expect(again.employeeCode).toBe('ABC0001');

    // BEHIND a later issue: this is the gap the plan tells the reporter about in their own words.
    // Rolling back here would hand ABC0002 out twice, so the number stays spent and the sequence skips it.
    const behind = await createEmployeeDraftWithReservedCode(ctx, four());
    expect(behind.employeeCode).toBe('ABC0002');
    const ahead = await createEmployeeDraftWithReservedCode(ctx, four());
    expect(ahead.employeeCode).toBe('ABC0003');
    await discardEmployeeDraft(ctx, behind.id);
    expect(await counterOf()).toBe(3);
    // ABC0002 is free to be re-used BY HAND — it is a gap, not a permanent hole — but nothing issues it
    // automatically, and the next automatic number carries on from the tip.
    expect(await isEmployeeCodeTaken(ctx, 'ABC0002')).toBe(false);
    const next = await createEmployeeDraftWithReservedCode(ctx, four());
    expect(next.employeeCode).toBe('ABC0004');
  });

  it('the discard event records WHETHER the number came back — the gap is on the audit trail', async () => {
    const ctx = adminCtx(b);
    await config();
    const first = await createEmployeeDraftWithReservedCode(ctx, four());
    const second = await createEmployeeDraftWithReservedCode(ctx, four());
    await discardEmployeeDraft(ctx, first.id); // behind `second` ⇒ leaves a gap
    await discardEmployeeDraft(ctx, second.id); // at the tip ⇒ returned
    const rows = await owner.db
      .select({ aggregateId: schema.domainEvent.aggregateId, payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'employee-draft.discarded'));
    const byId = new Map(rows.map((r) => [r.aggregateId, r.payload as Record<string, unknown>]));
    expect(byId.get(first.id)).toMatchObject({ reservedEmployeeCode: 'ABC0001', released: false });
    expect(byId.get(second.id)).toMatchObject({ reservedEmployeeCode: 'ABC0002', released: true });
  });

  it('a company with NO setup holds a HAND-KEYED ID — the half of the plan that works everywhere', async () => {
    const ctx = adminCtx(b);
    // seedBase configures no Employee ID Auto Running Number Setup at all, which is the situation eight
    // of the nine live companies are in — ISEDECOR BINA, with 22 people on a hand-keyed A0001..A0014 run,
    // among them. bd271009's rule is unchanged and deliberately NOT relaxed here: with no setup the ID
    // must be typed, because falling silently through to the legacy EMP-#### counter is exactly where
    // the unrecognised IDs used to come from. What 06f0cb8f adds is that the typed ID is then HELD.
    expect((await employeeIdRuleFor(ctx, b.companyId)).hasConfig).toBe(false);
    await expect(createEmployeeDraftWithReservedCode(ctx, four())).rejects.toThrow(
      /Cannot create the employee record yet.*employeeCode/,
    );
    const { id, employeeCode } = await createEmployeeDraftWithReservedCode(
      ctx,
      four({ employeeIdMode: 'manual', employeeCode: 'A0015' }),
    );
    expect(employeeCode).toBe('A0015');
    expect((await getEmployeeDraft(ctx, id))?.reservedEmployeeCode).toBe('A0015');
    // A hand-keyed hold consumes no counter, so there is nothing to give back — and nothing is taken.
    expect(await legacyCounter()).toBeNull();
    await discardEmployeeDraft(ctx, id);
    expect(await isEmployeeCodeTaken(ctx, 'A0015')).toBe(false);
  });

  it('the company and the held ID are PINNED — the server refuses a payload that moves either', async () => {
    const ctx = adminCtx(b);
    await config();
    const other = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd', country: 'MY' })
      .returning({ id: schema.company.id });
    const { id, employeeCode } = await createEmployeeDraftWithReservedCode(ctx, four());
    // A client that sends a different company and a different ID — the shape a stale tab, or a tampered
    // request, would take. Neither may land: the held number came from THIS company's numbering rule.
    await saveEmployeeDraft(ctx, {
      id,
      data: { profile: { employeeCode: 'SOMETHING-ELSE' }, employment: { companyId: other[0].id } },
      currentStep: 2,
    });
    const after = await getEmployeeDraft(ctx, id);
    expect(after?.companyId).toBe(b.companyId);
    expect(after?.reservedEmployeeCode).toBe(employeeCode);
    expect(after?.data.profile?.employeeCode).toBe(employeeCode);
    expect(after?.data.employment?.companyId).toBe(b.companyId);
  });

  it('a PRE-06f0cb8f draft, with no reservation, still activates exactly as it always did', async () => {
    // The one draft on production was written before this item and carries null in all four columns.
    // It must go on behaving as bd271009 left it: the rule is resolved at Activate, and the ID is issued
    // there. This is the regression that a "reservation is now mandatory" refactor would introduce.
    const ctx = adminCtx(b);
    await config({ startNumber: 500, numberLength: 6 });
    const data = completeDraft();
    delete data.profile!.employeeCode; // Auto — the ID is issued by hireEmployee, as it used to be
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 4 });
    expect((await getEmployeeDraft(ctx, id))?.reservedEmployeeCode).toBeNull();
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    expect(await codeOf(employmentId)).toBe('ABC000500');
    expect(await counterOf()).toBe(500);
  });

  it('Create refuses before it takes a number — a refused create burns nothing', async () => {
    const ctx = adminCtx(b);
    await config({ allowManualOverride: false });
    const before = await counterOf();
    // Manual entry on a setup that forbids it: refused, and the counter has not moved. The refusal is
    // BEFORE the transaction that issues, which is what makes "burns nothing" true rather than lucky.
    await expect(
      createEmployeeDraftWithReservedCode(ctx, four({ employeeIdMode: 'manual', employeeCode: 'X-1' })),
    ).rejects.toThrow(/does not allow manual entry/);
    // A missing email: the four-field rule, re-run on the server because the client is not trusted.
    await expect(
      createEmployeeDraftWithReservedCode(ctx, { ...four(), primaryEmail: '' }),
    ).rejects.toThrow(/Cannot create the employee record yet.*primaryEmail/);
    expect(await counterOf()).toBe(before);
    expect(await listEmployeeDrafts(ctx, await everyCompany())).toHaveLength(0);
  });

  it('the DATABASE holds the reservation, not merely the service — and only for non-null codes', async () => {
    // The pre-checks above all live in TypeScript, and TypeScript loses a race. The partial unique index
    // from 0415 is what actually makes a double-issue impossible, so it is asserted against the database
    // directly, bypassing every service. A migration that shipped without the index would leave all the
    // refusal tests above passing and the guarantee itself absent.
    const row = (code: string | null) => ({
      tenantId: b.tenantId,
      companyId: b.companyId,
      label: 'X',
      reservedEmployeeCode: code,
    });
    await owner.db.insert(schema.employeeDraft).values(row('DUP-HOLD'));
    // Assert the CONSTRAINT by name, not merely "it threw": a NOT NULL or a foreign key would also
    // throw, and would prove nothing about the reservation. The driver nests the Postgres error, which
    // is why core/employee-draft.ts walks the cause chain to turn this into a sentence.
    const clash = await owner.db
      .insert(schema.employeeDraft)
      .values(row('DUP-HOLD'))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(clash).toBeTruthy();
    // `constraint_name` is postgres.js's spelling; node-postgres calls it `constraint`. Accept either,
    // because getting this wrong is exactly how a "friendly message" mapper ends up never firing.
    type PgErr = { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    let cur = clash as PgErr | undefined;
    let hit: PgErr | undefined;
    for (let i = 0; cur && i < 4; i++) {
      if (cur.code === '23505') { hit = cur; break; }
      cur = cur.cause as PgErr | undefined;
    }
    expect(hit?.constraint_name ?? hit?.constraint, JSON.stringify(clash)).toBe(
      'employee_draft_reserved_code_uq',
    );
    // PARTIAL: nulls do not collide, which is why every draft written before 0415 — and every draft that
    // never reached Create — is untouched by the index.
    await owner.db.insert(schema.employeeDraft).values(row(null));
    await owner.db.insert(schema.employeeDraft).values(row(null));
    const [{ n }] = await owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.employeeDraft);
    expect(Number(n)).toBe(3);
  });

  it('a non-admin cannot reserve an Employee ID', async () => {
    const employee = { ...adminCtx(b), roles: ['employee'] };
    await expect(createEmployeeDraftWithReservedCode(employee, four())).rejects.toThrow(/Only an admin/);
  });

  it('AUTO skips a running number an EMPLOYMENT already holds, rather than reserving it', async () => {
    /**
     * FOUND IN VERIFICATION. The manual branch asked findEmployeeCodeClaim; the auto branch did not. A
     * running number and a hand-keyed code share ONE namespace — this tenant has 22 employments at
     * ISEDECOR numbered A0001..A0014 by hand — so a counter sitting behind the codes already in use issues
     * one that is taken. HR was shown it as "issued and reserved for you" and only found out at Activate,
     * when hireEmployee refused. The reservation was never usable and the work was lost late.
     */
    await config({ allowManualOverride: false });
    // Somebody already holds ABC0001, hand-keyed — exactly the ISEDECOR shape.
    await hireEmployee(adminCtx(b), {
      person: { fullName: 'Holder', primaryEmail: `hold.${randomUUID().slice(0, 8)}@demo.test` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
      employeeCode: 'ABC0001',
    });

    const { employeeCode } = await createEmployeeDraftWithReservedCode(adminCtx(b), four());

    expect(employeeCode, 'must not hand out the code an employment already holds').not.toBe('ABC0001');
    expect(employeeCode).toMatch(/^ABC\d{4}$/);
    const clash = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(eq(schema.employment.employeeCode, employeeCode));
    expect(clash, 'the reserved code must be genuinely free').toHaveLength(0);
  });
});

// ── §8 migration 0415 ─────────────────────────────────────────────────────────────────────────────
describe('§8 migration 0415 — the reservation columns', () => {
  const mig = read('db/migrations/0415_employee_draft_reserved_code.sql');

  it('adds the four columns idempotently and indexes the code PARTIALLY', () => {
    for (const col of ['reserved_employee_code', 'reserved_at', 'reserved_config_id', 'reserved_number']) {
      expect(mig, col).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(mig).toContain('CREATE UNIQUE INDEX IF NOT EXISTS employee_draft_reserved_code_uq');
    // PARTIAL is the whole reason existing drafts are unaffected: nulls are not unique-compared, so
    // every row written before this migration keeps behaving exactly as it did.
    expect(mig).toContain('WHERE reserved_employee_code IS NOT NULL');
  });

  it('touches no existing data and drops nothing', () => {
    const sqlOnly = mig.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    // `DELETE FROM` / `DROP ` rather than the bare words: the reserved_config_id reference carries
    // ON DELETE SET NULL, which is a referential action and destroys nothing.
    expect(sqlOnly).not.toContain('DELETE FROM');
    expect(sqlOnly).not.toContain('DROP ');
    expect(sqlOnly).not.toContain('UPDATE ');
    // No new GRANT is needed — 0337 granted the TABLE, and a new column inherits it. Asserted so a
    // future reader does not "fix" a missing grant that was never missing.
    expect(sqlOnly).not.toContain('GRANT');
  });

  it('its journal entry sits ABOVE everything that runs before it (the r84 stale-number trap)', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const mine = journal.entries.find((e) => e.tag === '0415_employee_draft_reserved_code');
    expect(mine).toBeTruthy();
    expect(mine!.idx).toBe(415);
    const priorMax = Math.max(...journal.entries.filter((e) => e.idx < mine!.idx).map((e) => e.when));
    expect(mine!.when).toBeGreaterThan(priorMax);
  });

  it('the drizzle schema declares the same four columns and the same partial index', () => {
    // The .sql is what runs; db/schema.ts is what every query is typed against. A column added to one
    // and not the other is a runtime error in a service that type-checks clean.
    const schemaSrc = read('db/schema.ts');
    for (const col of ['reserved_employee_code', 'reserved_at', 'reserved_config_id', 'reserved_number']) {
      expect(schemaSrc, col).toContain(`'${col}'`);
    }
    expect(schemaSrc).toContain("uniqueIndex('employee_draft_reserved_code_uq')");
  });
});
