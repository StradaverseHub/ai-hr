/**
 * Employee self-service profile (ADR-0012). Two paths by risk:
 *  - low-risk contact fields → direct self-edit of `person` (RLS confines it to the caller's
 *    own row; this is the only writer that runs under an employee session and it never touches
 *    name/email/identity);
 *  - everything else the employee may ask to change → a change request an admin approves before it
 *    applies. Reuses the shared `assertCanDecide` guard.
 *
 * ── r260 · STAGE TWO OF BOARD ITEM 9583deac: WIDENED, NOT REBUILT ───────────────────────────────────
 * The approved plan corrects an earlier build note of our own that said stage two needed a request
 * store. It did not: this file and `profile_change_request` (migration 0029) have implemented the
 * request-and-approve path since ADR-0012. Stage two changes three things and nothing else:
 *
 *   1. WHICH FIELDS may be proposed. Was seven names hard-coded across this file, the /me form and the
 *      /me action; is now `lib/profile-requestable-fields.ts`, one declaration that all three read, and
 *      whose keys are the SAME `people.detail.*` names the visibility manifest uses — so a permission
 *      (stage three) and a request can never disagree about what a field is called.
 *   2. A REJECTION MUST SAY WHY, and the employee is shown the sentence
 *      (ProfileChangeReasonRequiredError + `decision_reason`, migration 0458). The only genuinely new
 *      thing in the schema this round.
 *   3. THE EMPLOYEE'S OWN HISTORY is scoped by the session rather than by a passed id, and returns the
 *      decision reason so "waiting / approved / rejected, and why" is answerable on their own screen.
 *
 * What did NOT change, and must not be read as unchanged by accident: the approval authority
 * (admin-only, never self, through `assertCanDecide`), the fact that a pending request touches nothing,
 * and the audit rule that the event log records field NAMES and never values.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { employeeStatutoryMy, employment, person, profileChangeRequest } from '../db/schema';
import { assertCanDecide } from './approvals';
// 9583deac stage two — the ONE declaration of which fields may be requested, what each is called on
// both screens, and which table/column an approval writes it to. See the header of that file.
import {
  PROFILE_REQUESTABLE_FIELDS,
  PROFILE_REQUESTABLE_KEYS,
  requestableField,
  type ProfileRequestTarget,
} from '../lib/profile-requestable-fields';
// r261 stage three — the tenant's own answers to "which fields may be asked about?" and "who decides?".
// Read from the per-request entitlement snapshot; see core/tenant-settings.ts for why they throw rather
// than degrade when the snapshot cannot answer.
import { profileChangeAllowedKeys, profileChangeApprover } from './tenant-settings';
import { isGroupAdmin } from '../lib/authz';
// 23ad620e — the emergency contact lives in its own per-person register; /me reads and writes the primary.
import { primaryEmergencyContactSql, writeSingleEmergencyContactInTx } from './emergency-contacts';
// 35b7af0a — the person master lists, defined in a CLIENT-SAFE module and re-exported below (see the note
// there). Client components render the same lists this module validates saves against.
import { GENDERS, MARITAL_STATUSES } from '../lib/person-vocabulary';

const clean = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};
const oneOf = (v: unknown, allowed: readonly string[]): string | null => {
  const s = clean(v);
  return s && allowed.includes(s) ? s : null;
};
// Centralized person master lists (#12129e77). Every surface that lets a value be chosen for an employee
// record — HR-set personnel card, the Create New Employee wizard, ESS self-edit, and the leave-eligibility
// rule form — must draw from this one list so a rule value (e.g. 'divorced') always has a reachable
// matching profile value.
//
// 35b7af0a — the DEFINITION now lives in `lib/person-vocabulary.ts` (imported at the top of this file) and
// is only re-exported here. Two of those surfaces are CLIENT components and could not import this module at
// all (it pulls in the database), so they carried hand-synced copies — and the Create New Employee wizard's
// copy had silently fallen ONE value behind on gender and FOUR behind on marital status. Re-exported rather
// than redefined, so every existing `import { MARITAL_STATUSES } from './profile'` keeps working AND keeps
// the same array IDENTITY: core/admin.ts sets ELIGIBILITY_MARITAL_OPTIONS = MARITAL_STATUSES and
// test/marital-master-enum.test.ts asserts that with `toBe`.
export { GENDERS, MARITAL_STATUSES };

/**
 * ── STAGE TWO (r260, board item 9583deac): THE PROPOSABLE KEYS ARE A DECLARATION, NOT A LIST HERE ───
 *
 * `lib/profile-requestable-fields.ts` names every field an employee may ask to change, the
 * `people.detail.*` key it is called by on both screens, and the table + column an approval writes it
 * to. This type is the same set expressed for the type-checker; `sanitizeProposed` and the apply half of
 * `decideProfileChange` both walk the declaration, so widening the set is one edit in one file rather
 * than an edit here, an edit in the sanitiser, an edit in the applier and an edit in the form.
 */
export type ProfileChangeProposed = {
  // Pay-affecting statutory fields (employee_statutory_my).
  bankName?: string | null;
  bankAccountNo?: string | null;
  taxCategory?: number;
  numChildren?: number;
  // Stage two — the registration numbers an employee is issued and HR files returns against.
  epfNumber?: string | null;
  socsoNumber?: string | null;
  taxNumber?: string | null;
  // Stage two — the identity documents on the statutory row, read on the employee's Profile tab.
  icNumber?: string | null;
  oldIcNumber?: string | null;
  passportNumber?: string | null;
  passportIssueDate?: string | null;
  passportExpiryDate?: string | null;
  passportIssuingCountry?: string | null;
  // Compliance-sensitive identity fields on `person` (ADR-0012 §refinement, #24): date of birth drives
  // age-based statutory (EPF senior/SOCSO/retirement), marital status drives the PCB category, and gender
  // gates maternity/paternity eligibility — so a self-edit goes through approval, not a direct write.
  dateOfBirth?: string | null;
  gender?: string | null;
  maritalStatus?: string | null;
  // Stage two — the name block and the personal particulars. NOT on the self-edit path and never will
  // be: `person.full_name` prints on the payslip, the EA statement and the bank file.
  salutation?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  nationality?: string | null;
  religion?: string | null;
  race?: string | null;
};

/** ISO calendar date, the only date shape a proposal may carry. */
const isoDate = (v: unknown): string | null | undefined => {
  // Accept a clear (null / '') or a well-formed ISO date only; a malformed value is DROPPED (never
  // written) so a bad DOB can't reach the age-band statutory math (EPF/SOCSO, core/payroll.ts).
  const d = clean(v);
  if (d === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
};

/** The whole declaration, as a set. The HR-direct writer below passes this where the employee path
 *  passes the tenant's allow-list — see setPersonComplianceFields for why the two differ. */
const EVERY_REQUESTABLE_KEY: ReadonlySet<string> = new Set(PROFILE_REQUESTABLE_KEYS);

/**
 * Keep only the recognised, sanitised keys — the bundle is a jsonb patch we later apply.
 *
 * DRIVEN BY THE DECLARATION. Every key must be one `lib/profile-requestable-fields.ts` names, and its
 * `input` decides how the value is cleaned: `select` is whitelisted against the declaration's own
 * options, `date` must be ISO, `number` is coerced to a non-negative integer, `text` is trimmed to
 * null-or-value. An unknown key is silently dropped, exactly as before — a form that posts junk gets
 * nothing stored rather than an error that tells a prober which names exist.
 */
function sanitizeProposed(raw: ProfileChangeProposed, allowed: ReadonlySet<string>): ProfileChangeProposed {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    const field = requestableField(key);
    if (!field) continue;
    // r261 stage three — AND THE TENANT MUST ALLOW IT. `allowed` is the tenant's own answer to "which
    // fields may an employee ask to change?", and it is applied HERE rather than on the form, because the
    // form is a suggestion and this is the gate: a POST naming a switched-off field is dropped exactly as
    // an unknown key is, silently and with nothing stored. Silent, not an error, for the reason the
    // unknown-key drop is silent — an error that named the field would tell a prober which names exist.
    if (!allowed.has(key)) continue;
    if (field.input === 'select') {
      // The declaration's own option values, plus the two module master lists it mirrors — GENDERS and
      // MARITAL_STATUSES stay the authority for those two so a rule value elsewhere in the product
      // (leave eligibility) can never name a status this path would refuse.
      const allowed =
        key === 'gender' ? GENDERS : key === 'maritalStatus' ? MARITAL_STATUSES : (field.options ?? []).map((o) => o.value);
      const picked = oneOf(value, allowed);
      if (key === 'taxCategory') {
        // Stored as an LHDN integer, and it is NOT NULL with a default — so an unrecognised value is
        // dropped rather than turned into a null that the column would refuse on apply.
        if (picked !== null) out[key] = Number(picked);
      } else {
        // Text-valued selects: an unrecognised value means "clear it", the behaviour since #24.
        out[key] = picked;
      }
      continue;
    }
    if (field.input === 'date') {
      const d = isoDate(value);
      if (d === undefined) continue; // malformed — dropped, never written
      out[key] = d;
      continue;
    }
    if (field.input === 'number') {
      if (!Number.isFinite(Number(value))) continue;
      out[key] = Math.max(0, Math.floor(Number(value)));
      continue;
    }
    out[key] = clean(value);
  }
  return out as ProfileChangeProposed;
}

/**
 * A rejection must say why. The plan promises the reporter exactly that, and this is the SOLE authority
 * for it — the same shape as leave's MissingRejectReasonError, thrown BEFORE the transaction opens so a
 * reasonless rejection never reaches the row.
 *
 * ── AND IT IS DELIBERATELY NOT ALSO A DATABASE CONSTRAINT ───────────────────────────────────────────
 * Migration 0458's first draft carried `CHECK (status <> 'rejected' OR decision_reason <> '') NOT VALID`
 * as "a second line of the same defence". It was not a second line; it was a second RULE, applying to
 * every writer of the row rather than to every rejection. NOT VALID skips the historical scan but is
 * still enforced on the new row version of any UPDATE, and `core/pdpa.ts` erasePersonPii rewrites EVERY
 * one of a subject's profile-change rows inside the single transaction an erasure runs in — so one
 * pre-existing reasonless rejection would have aborted that employee's whole PDPA erasure. Rejecting is
 * done HERE and nowhere else, so the rule is enforced here and nowhere else.
 */
export class ProfileChangeReasonRequiredError extends Error {
  constructor() {
    super('A reason is required to reject a profile change request');
    this.name = 'ProfileChangeReasonRequiredError';
  }
}

/**
 * ⚠️ AN APPROVAL NAMES A FIELD THE EMPLOYER HAS SINCE CLOSED — refused at the decision itself.
 *
 * r261 fix pass. Stage three's sweep (`withdrawProfileChangesForLockedFields`) rejects every waiting
 * request the moment its field is switched off, and that is the ORDINARY path: the employee is told, in
 * a sentence, on their own screen. This error is the path that is left when the sweep did not run for
 * this row — a request raised in the seconds between the setting being written and the sweep finishing,
 * a row created by a writer that is not the settings action, a sweep that failed and was refused to the
 * admin. There is no configuration of this product in which such a request may APPLY, so the decision
 * refuses it rather than trusting that something upstream caught it.
 *
 * WHY REFUSE THE WHOLE REQUEST RATHER THAN APPLY THE STILL-OPEN HALF OF IT: applying a subset would put
 * a change into the master record that nobody submitted and nobody approved, and it is the same argument
 * the sweep's own header makes for rejecting a mixed request whole. The approver is told to reject it,
 * which sends the employee a reason and closes the row.
 */
export class ProfileChangeFieldClosedError extends Error {
  /** The keys of `proposed` this tenant no longer allows. Field NAMES only — never a proposed value. */
  readonly closedKeys: readonly string[];
  constructor(closedKeys: readonly string[]) {
    super(
      'This request asks to change a field the employer no longer allows employees to request ' +
        `(${closedKeys.join(', ')}). It cannot be approved — reject it with a reason instead.`,
    );
    this.name = 'ProfileChangeFieldClosedError';
    this.closedKeys = closedKeys;
  }
}

/** The caller's own profile: editable contact fields + a read-only summary of the
 *  pay-affecting statutory fields (the employee sees their own). */
export function myProfile(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return null;
    const [p] = await tx
      .select({
        fullName: person.fullName,
        primaryEmail: person.primaryEmail,
        phone: person.phone,
        address: person.address,
        dateOfBirth: person.dateOfBirth,
        gender: person.gender,
        maritalStatus: person.maritalStatus,
        // 23ad620e — the emergency contact moved to its own per-person register; /me still shows ONE, so
        // these five resolve to the highest-priority live record (Primary → Secondary → Other).
        emergencyContactName: primaryEmergencyContactSql('full_name'),
        emergencyContactPhone: primaryEmergencyContactSql('mobile_phone'),
        // b4682879 — structured home address + extended emergency contact (self-maintained on /me).
        personalEmail: person.personalEmail,
        addressLine1: person.addressLine1,
        addressLine2: person.addressLine2,
        addressLine3: person.addressLine3,
        postcode: person.postcode,
        city: person.city,
        state: person.state,
        country: person.country,
        emergencyContactRelationship: primaryEmergencyContactSql('relationship'),
        emergencyContactPhone2: primaryEmergencyContactSql('home_phone'),
        emergencyContactAddress: primaryEmergencyContactSql('address'),
      })
      .from(person)
      .where(eq(person.id, ctx.personId))
      .limit(1);
    const [stat] = await tx
      .select({
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        taxCategory: employeeStatutoryMy.taxCategory,
        numChildren: employeeStatutoryMy.numChildren,
      })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, ctx.personId))
      .limit(1);
    return { person: p ?? null, statutory: stat ?? null };
  });
}

/** Direct self-edit of low-risk contact fields on the caller's own person row. Genuinely low-risk only —
 *  date of birth / gender / marital status are compliance-sensitive and go through the approval gate
 *  (requestProfileChange), not here (#24). */
export async function updateOwnContact(
  ctx: SessionContext,
  p: {
    phone?: string | null;
    // b4682879 — the legacy single-line `address` is retired from the UI in favour of the structured
    // fields below; it is intentionally NOT accepted here any more (the column is retained for history).
    personalEmail?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    addressLine3?: string | null;
    postcode?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    emergencyContactName?: string | null;
    emergencyContactRelationship?: string | null;
    emergencyContactPhone?: string | null;
    emergencyContactPhone2?: string | null;
    emergencyContactAddress?: string | null;
  },
) {
  const personId = ctx.personId;
  if (!personId) throw new Error('This account is not linked to an employee profile.');
  return withTenant(ctx, async (tx) => {
    await tx
      .update(person)
      .set({
        phone: clean(p.phone),
        personalEmail: clean(p.personalEmail),
        addressLine1: clean(p.addressLine1),
        addressLine2: clean(p.addressLine2),
        addressLine3: clean(p.addressLine3),
        postcode: clean(p.postcode),
        city: clean(p.city),
        state: clean(p.state),
        country: clean(p.country),
      })
      .where(eq(person.id, personId));
    // 23ad620e — the emergency block no longer lives on `person`. /me still edits ONE contact, so the five
    // field names route into the highest-priority record of the register, in this same transaction. The
    // RLS write check on person_emergency_contact is is_admin OR is_self_person — the same rule person_rls
    // applies, so an employee's self-edit reaches exactly as far as it did before.
    await writeSingleEmergencyContactInTx(tx, ctx, personId, {
      emergencyContactName: clean(p.emergencyContactName),
      emergencyContactRelationship: clean(p.emergencyContactRelationship),
      emergencyContactPhone: clean(p.emergencyContactPhone),
      emergencyContactPhone2: clean(p.emergencyContactPhone2),
      emergencyContactAddress: clean(p.emergencyContactAddress),
    });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: personId,
      eventType: 'person.self-updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      payload: { fields: Object.keys(p) },
    });
  });
}

/**
 * Propose a change to any field `lib/profile-requestable-fields.ts` declares. RLS confines the insert to
 * the caller's own employment; approval (admin-only) applies it, and nothing before that touches the
 * master record.
 *
 * `numChildren` (num_children) is `NOT NULL DEFAULT 0` and `taxCategory` is `NOT NULL DEFAULT 1`; both
 * are sanitised to a value or dropped, never to null, so an approval cannot violate the column.
 */
export async function requestProfileChange(
  ctx: SessionContext,
  p: { employmentId: string; proposed: ProfileChangeProposed },
) {
  if (!ctx.personId) throw new Error('This account is not linked to an employee profile.');
  // r261 stage three — the tenant's field-by-field permission, resolved BEFORE anything is stored. A
  // field switched off has no control on /me (app/me/request-change-card.tsx renders none) and is
  // dropped here as well, so hiding the control and enforcing the rule are two independent statements of
  // the same policy rather than one of them dressed as both.
  const proposed = sanitizeProposed(p.proposed, profileChangeAllowedKeys(ctx));
  if (Object.keys(proposed).length === 0) throw new Error('Nothing to change.');
  // A bank change is all-or-nothing: approving an account number against a stale bank name (or
  // vice versa) is exactly the half-update the approval gate exists to prevent.
  if ((proposed.bankName != null) !== (proposed.bankAccountNo != null)) {
    throw new Error('A bank change needs both the bank name and the account number.');
  }
  const personId = ctx.personId;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(profileChangeRequest)
      .values({ tenantId: ctx.tenantId, employmentId: p.employmentId, personId, proposed })
      .returning({ id: profileChangeRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'profile-change',
      aggregateId: row.id,
      eventType: 'profile-change.requested',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // Audit the WHAT, not the values — bank account / dependents are PII and the event log is
      // append-only (PDPA erasure). The values live in profile_change_request.proposed (RLS-scoped,
      // consumed on decide); the apply event likewise records only field names.
      payload: { employmentId: p.employmentId, fields: Object.keys(proposed) },
    });
    return { requestId: row.id };
  });
}

/**
 * Decide a profile change. Admin-only (bank/tax data is not a manager's call) and never self —
 * approval applies the proposed patch, rejection applies NOTHING.
 *
 * ── THE SAFETY PROPERTY OF THE WHOLE OF STAGE TWO ───────────────────────────────────────────────────
 * A pending request must never reach the master record without a decision, and a rejected one must never
 * be applied at all. Structurally: the write set is built inside `if (p.decision === 'approved')` and
 * there is no other writer in this function — the only thing a rejection touches is the request row's
 * own status, decider, timestamp and reason. `test/me-profile-change-requests.test.ts` pins it by
 * reading the master columns byte-for-byte either side of a rejection.
 *
 * ── AND A REJECTION MUST SAY WHY ────────────────────────────────────────────────────────────────────
 * `reason` is REQUIRED when rejecting (ProfileChangeReasonRequiredError, thrown before the transaction
 * opens) and optional when approving. It is stored on the request and shown to the EMPLOYEE on their own
 * screen — which is the point of it, and the one thing in stage two the schema did not already have.
 */
export async function decideProfileChange(
  ctx: SessionContext,
  p: {
    requestId: string;
    decision: 'approved' | 'rejected';
    deciderEmploymentId?: string;
    /** The approver's words. Required to reject; optional on an approval. */
    reason?: string | null;
  },
) {
  const reason = clean(p.reason);
  if (p.decision === 'rejected' && reason === null) throw new ProfileChangeReasonRequiredError();
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select()
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.id, p.requestId))
      .limit(1);
    if (!req) throw new Error('profile change request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`profile change request is already ${req.status}`);

    /**
     * ── WHO MAY DECIDE, AND THE TWO HALVES OF IT ────────────────────────────────────────────────────
     *
     * `assertCanDecide` is the FLOOR and it is not configurable: it bans the subject from deciding their
     * own request (the super_admin sole-admin escape hatch is pre-existing and untouched by this round),
     * and it admits only an administrator, the subject's ACTIVE administrative manager, or a one-hop
     * delegate of that manager. Every approval in this product passes through it.
     *
     * The ADMIN REQUIREMENT below is also not configurable, and it is the database's rule rather than a
     * preference: approving WRITES the master record, and `person_rls` (0029) has always been
     * `WITH CHECK (app.is_admin() OR app.is_self_person(id))`. A non-admin approver would pass this
     * guard and then be refused by Postgres mid-transaction. So the setting can only NARROW.
     *
     * r261 stage three is that narrowing — the plan's "a setting that controls who approves". `admin`
     * (the default, and stage two's behaviour) lets any HR administrator decide, including one granted
     * over a single company. `group_admin` requires a GROUP administrator, so a bank account or an IC is
     * signed off by whoever holds the whole group rather than by whoever administers one company.
     *
     * ⚠️ WHAT THIS DELIBERATELY DOES NOT DO. It does not add a second level — the plan sold single-level
     * approval and invited a rejection if the reporter wanted multi-level; they approved it as written,
     * so one decision by one person ends the request either way. It does not widen VISIBILITY by one row:
     * `profile_change_request_rls` (0029) is `app.can_see_employment`, untouched. And it cannot widen
     * AUTHORITY in any configuration — both branches below only ever refuse.
     */
    await assertCanDecide(tx, ctx, req.employmentId, 'profile change'); // bans self
    const roles = ctx.roles ?? [];
    if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
      throw new Error('Only an admin can approve a profile change');
    }
    if (profileChangeApprover(ctx) === 'group_admin' && !isGroupAdmin(ctx)) {
      throw new Error('Only a group administrator can approve a profile change');
    }

    if (p.decision === 'approved') {
      const proposed = (req.proposed ?? {}) as Record<string, unknown>;
      /**
       * ⚠️ THE DECISION IS THE LAST GATE, AND IT RE-ASKS THE PERMISSION (r261 fix pass).
       *
       * `requestProfileChange` already refuses a key the tenant does not allow, and switching a field
       * off sweeps every request waiting on it. Neither of those is enough on its own, because both run
       * at a different moment from this one: a request raised in the same second the setting changed, a
       * row written by anything other than the settings action, or a sweep that failed and was reported
       * to the admin, all leave a pending row naming a field that is now closed. What decides whether
       * the master record moves is THIS statement, so this statement asks the question — the tenant's
       * CURRENT allow-list, read the same throwing way the request side reads it, against the keys the
       * row actually carries.
       *
       * `profileChangeAllowedKeys` is already intersected with `PROFILE_REQUESTABLE_FIELDS`, so a key
       * for a field the declaration has since withdrawn is closed by the same test — there is no path
       * on which "the row says so" is an argument for writing a field the product no longer offers.
       *
       * REJECTION IS UNAFFECTED, deliberately: this sits inside the approve branch, so an approver can
       * always clear such a request out of the queue with a reason the employee reads.
       */
      const allowedNow = profileChangeAllowedKeys(ctx);
      const closedKeys = Object.keys(proposed).filter((k) => !allowedNow.has(k));
      if (closedKeys.length > 0) throw new ProfileChangeFieldClosedError(closedKeys);
      /**
       * THE WRITE SETS ARE BUILT FROM THE DECLARATION, one entry per field, so a field added to
       * lib/profile-requestable-fields.ts is applied on approval without a second edit here. Before
       * stage two this was an `if` ladder of four names beside another of three, and the two ladders
       * were the reason "requestable" and "appliable" could quietly become different sets: a key could
       * be accepted into `proposed`, wait in the queue, be approved — and land nowhere.
       */
      const setFor = (target: ProfileRequestTarget): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const f of PROFILE_REQUESTABLE_FIELDS) {
          if (f.target !== target) continue;
          if (proposed[f.key] === undefined) continue;
          out[f.column] = proposed[f.key];
        }
        return out;
      };
      // Pay-affecting statutory fields → employee_statutory_my (needs a statutory profile to apply to).
      const statSet = setFor('statutory');
      // The IC is uniquely indexed per tenant (employee_statutory_my_ic_uq, partial on NOT NULL). An
      // approval that collides would surface as a raw Postgres unique violation in a redirect's query
      // string; checked here instead so the approver is told what is wrong in a sentence. Inside the
      // transaction and under RLS, so it reads only rows this approver may already see.
      if (typeof statSet.icNumber === 'string' && statSet.icNumber !== '') {
        const [clash] = await tx
          .select({ id: employeeStatutoryMy.id })
          .from(employeeStatutoryMy)
          .where(
            and(
              eq(employeeStatutoryMy.icNumber, statSet.icNumber),
              sql`${employeeStatutoryMy.personId} <> ${req.personId}`,
            ),
          )
          .limit(1);
        if (clash) {
          throw new Error('That identity number is already filed against another employee.');
        }
      }
      if (Object.keys(statSet).length > 0) {
        const [existing] = await tx
          .select({ id: employeeStatutoryMy.id })
          .from(employeeStatutoryMy)
          .where(eq(employeeStatutoryMy.personId, req.personId))
          .limit(1);
        if (!existing) {
          throw new Error('No statutory profile to apply to — set the employee’s IC first.');
        }
        await tx
          .update(employeeStatutoryMy)
          .set({ ...statSet, updatedAt: sql`now()` })
          .where(eq(employeeStatutoryMy.id, existing.id));
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'employee-statutory-my',
          aggregateId: existing.id,
          eventType: 'statutory.my.updated',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { via: 'profile-change', requestId: req.id, fields: Object.keys(statSet) },
        });
      }
      // #24 + stage two: identity, name and personal particulars → person (no statutory profile
      // required). `person.full_name` is NOT NULL, so a proposal that would blank it is dropped rather
      // than written — the request stays approved and the rest of it applies, which is the same
      // treatment sanitizeProposed gives a malformed date.
      const personSet = setFor('person');
      if ('fullName' in personSet && (personSet.fullName == null || personSet.fullName === '')) {
        delete personSet.fullName;
      }
      if (Object.keys(personSet).length > 0) {
        await tx.update(person).set(personSet).where(eq(person.id, req.personId));
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'person',
          aggregateId: req.personId,
          eventType: 'person.updated',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { via: 'profile-change', requestId: req.id, fields: Object.keys(personSet) },
        });
      }
    }

    await tx
      .update(profileChangeRequest)
      .set({
        status: p.decision,
        decidedByEmploymentId: p.deciderEmploymentId ?? null,
        decidedAt: sql`now()`,
        decisionReason: reason,
      })
      .where(eq(profileChangeRequest.id, req.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'profile-change',
      aggregateId: req.id,
      eventType: `profile-change.${p.decision}`,
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      // The REASON IS NOT AUDITED INTO THE EVENT LOG, deliberately, and for the same rule the values
      // follow (see requestProfileChange): the log is append-only and PDPA erasure cannot reach it, so
      // it records that a decision carried a reason rather than the sentence itself. The sentence lives
      // on profile_change_request.decision_reason, which is RLS-scoped and erasable with the record.
      // Single-line, which is the repo convention AND what test/event-payload-pii-guard.test.ts can
      // actually scan — it reads the remainder of the line containing `payload:`, so a wrapped object
      // literal in the one core file that handles bank, IC and passport values would be unscanned.
      payload: { decision: p.decision, deciderEmploymentId: p.deciderEmploymentId ?? null, reasonGiven: reason !== null },
    });
    return { status: p.decision };
  });
}

/**
 * HR/Admin-originated set of the two compliance-sensitive identity fields on `person`
 * (gender, marital status) for ANOTHER employee. These drive leave eligibility (gender gates
 * maternity, married-male gates paternity — Wave 2A-1). ADR-0012 refinement #24 deliberately
 * moved these fields onto the approval-gated path, so we do NOT widen the instant-write
 * `updatePerson`; instead we originate a *pre-approved* profile-change and apply it through the
 * same `person.updated` write, reusing `sanitizeProposed`'s validation. This keeps ONE writer and
 * ONE trust semantic for these columns.
 *
 * NOTE (marital ⊥ PCB): setting marital status here updates leave eligibility only. The PCB/tax
 * bracket (`employee_statutory_my.taxCategory`) is a separate statutory field and is NOT changed —
 * the UI surfaces this decoupling as an on-screen note.
 */
export async function setPersonComplianceFields(
  ctx: SessionContext,
  p: {
    employmentId: string;
    gender?: string | null;
    maritalStatus?: string | null;
    dateOfBirth?: string | null;
    // Item 354a500d — when true, the dateOfBirth in this call is a derived (IC-autofill) value that must ONLY
    // be written when the person has no DOB yet; an existing DOB is never overwritten server-side. Checked
    // atomically against the live row inside the tx (below).
    dobOnlyIfEmpty?: boolean;
  },
) {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can set gender / marital status.');
  }
  // Reuse the module-private sanitiser (whitelist → null on unrecognised; DOB validated to ISO shape).
  // Only include a field in the write set when the caller provided it (undefined = leave as-is; explicit
  // null = clear). b4682879 adds date of birth to this compliance-gated setter (it drives EPF age bands).
  // EVERY_REQUESTABLE_KEY, not the tenant's allow-list, and the argument is passed explicitly rather
  // than defaulted so the difference is impossible to inherit by forgetting. `ess.profile_change_fields`
  // answers "what may an EMPLOYEE ASK to change" — this is HR writing the record directly, the very act
  // an employee is being told to ask for. Narrowing it by the employee's permission would mean switching
  // a field off stopped HR from correcting it too, which is the opposite of what the setting is for.
  const proposed = sanitizeProposed(
    {
      ...(p.gender !== undefined ? { gender: p.gender } : {}),
      ...(p.maritalStatus !== undefined ? { maritalStatus: p.maritalStatus } : {}),
      ...(p.dateOfBirth !== undefined ? { dateOfBirth: p.dateOfBirth } : {}),
    },
    EVERY_REQUESTABLE_KEY,
  );
  const personSet: Record<string, string | null> = {};
  if (proposed.gender !== undefined) personSet.gender = proposed.gender;
  if (proposed.maritalStatus !== undefined) personSet.maritalStatus = proposed.maritalStatus;
  if (proposed.dateOfBirth !== undefined) personSet.dateOfBirth = proposed.dateOfBirth;
  if (Object.keys(personSet).length === 0) throw new Error('Nothing to change.');

  return withTenant(ctx, async (tx) => {
    // Resolve the person from the employment (RLS confines this select to admin scope).
    const [emp] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) throw new Error('Employment not found (or not visible).');
    const personId = emp.personId;

    const [before] = await tx
      .select({ gender: person.gender, maritalStatus: person.maritalStatus, dateOfBirth: person.dateOfBirth })
      .from(person)
      .where(eq(person.id, personId))
      .limit(1);
    if (!before) throw new Error('Person not found.');

    // Item 354a500d — for the IC-autofill path (dobOnlyIfEmpty), honour "never overwrite an existing DOB"
    // atomically against the live row: drop the derived dateOfBirth when the person already has one. If that
    // leaves nothing to write (DOB already set), return quietly — this is a no-op, not an error.
    const writeSet: Record<string, string | null> = { ...personSet };
    if (p.dobOnlyIfEmpty && 'dateOfBirth' in writeSet && (before.dateOfBirth ?? '') !== '') {
      delete writeSet.dateOfBirth;
    }
    if (Object.keys(writeSet).length === 0) return { id: personId };

    await tx.update(person).set(writeSet).where(eq(person.id, personId));
    const after = { ...before, ...writeSet };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: personId,
      eventType: 'person.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // Provenance: `via:'admin-set'` distinguishes this HR-direct write from the self path's
      // `via:'profile-change'` and from a plain name/email edit (updatePerson).
      payload: { via: 'admin-set', fields: Object.keys(writeSet), before, after },
    });
    return { id: personId };
  });
}

/** Admin inbox — RLS trims to scope. Recent first. */
export function listProfileChangeRequests(
  ctx: SessionContext,
  opts: { companyIds?: string[]; status?: 'pending' | 'approved' | 'rejected' } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: profileChangeRequest.id,
        employmentId: profileChangeRequest.employmentId,
        personId: profileChangeRequest.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        proposed: profileChangeRequest.proposed,
        status: profileChangeRequest.status,
        decisionReason: profileChangeRequest.decisionReason,
        decidedAt: profileChangeRequest.decidedAt,
        createdAt: profileChangeRequest.createdAt,
      })
      .from(profileChangeRequest)
      .innerJoin(employment, eq(employment.id, profileChangeRequest.employmentId))
      .innerJoin(person, eq(person.id, profileChangeRequest.personId))
      .where(
        and(
          opts.status ? eq(profileChangeRequest.status, opts.status) : undefined,
          opts.companyIds && opts.companyIds.length
            ? inArray(employment.companyId, opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(desc(profileChangeRequest.createdAt))
      .limit(100),
  );
}

/**
 * The caller's own profile-change requests — the /me history, and the source of the pending values My
 * Profile draws BESIDE the master ones.
 *
 * ── IT TAKES NO ID, AND THAT IS THE SECURITY PROPERTY ───────────────────────────────────────────────
 * Stage one made `myProfileRecord` resolve the employment from `ctx.personId` for exactly this reason
 * (app/me/record.ts's header). This used to take an `employmentId` parameter: the /me page passed its
 * own, and RLS would have refused a colleague's rows anyway — but a parameter is a way in that a future
 * caller can get wrong, and "scoped by the session" is a property you can read off the signature. So the
 * subject is `ctx.personId` and there is nothing to pass. A principal linked to no person gets an empty
 * list rather than everybody's. Pinned by test/me-profile-change-requests.test.ts, which calls it under
 * a colleague's session and expects nothing back.
 *
 * `limit` defaults to the whole recent history rather than five: the plan promises "You can see the
 * status of your own requests: waiting, approved or rejected", and a rejection that scrolled off the
 * bottom after five newer requests is a promise not kept.
 */
export function myProfileChangeRequests(ctx: SessionContext, limit = 50) {
  const personId = ctx.personId;
  if (!personId) return Promise.resolve([]);
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: profileChangeRequest.id,
        proposed: profileChangeRequest.proposed,
        status: profileChangeRequest.status,
        decisionReason: profileChangeRequest.decisionReason,
        decidedAt: profileChangeRequest.decidedAt,
        createdAt: profileChangeRequest.createdAt,
      })
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.personId, personId))
      .orderBy(desc(profileChangeRequest.createdAt))
      .limit(limit),
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * r261 stage three — WHAT HAPPENS TO A REQUEST ALREADY WAITING WHEN ITS FIELD IS SWITCHED OFF
 *
 * This is the blocker the round can produce, so the answer is a function rather than a paragraph.
 *
 * THE TWO OUTCOMES THAT WOULD BE DEFECTS:
 *   · the request stays pending and is APPROVED LATER, writing a value into a field the employer has
 *     since closed — the master record changed by a permission that no longer exists;
 *   · the request DISAPPEARS, and the employee who asked is never told what became of it.
 *
 * WHAT ACTUALLY HAPPENS: the moment a field is switched off, every PENDING request naming that field is
 * REJECTED with a stated reason, and the employee reads that reason under "My change requests" on their
 * own screen — the surface stage two built for exactly this. Nothing is applied and nothing is deleted:
 * the row survives with its `proposed` intact, its status, its timestamp and the sentence explaining it.
 * `profile_change_status` has three values and none of them is 'withdrawn'; inventing one would be a
 * migration to express something 'rejected' plus a reason already says truthfully.
 *
 * A request that names a locked field AND a still-open one is rejected WHOLE. The alternative — editing
 * the employee's `proposed` down to the surviving keys — silently changes what somebody asked for, and
 * an approver would then be deciding a request nobody submitted. The employee can ask again for the part
 * that is still open, and the reason tells them why they need to.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * How many PENDING requests name each field key, so the settings screen can say what switching a field
 * off would cost BEFORE it is switched off rather than only in the toast afterwards.
 *
 * RLS-scoped like every other read here: a group admin sees their tenant, and this returns counts, never
 * values — the settings screen has no business printing somebody's proposed bank account number.
 *
 * ⚠️ COUNTED IN SQL, OVER EVERY PENDING ROW, AND THAT IS THE FIX A REVIEW FORCED (r261 fix pass).
 * This used to `SELECT … LIMIT 1000` and bucket the rows in TypeScript. Past a thousand pending requests
 * — a number a tenant of any size reaches — the badge under-reported, and it under-reported hardest in
 * exactly the situation it exists for: an employer switching a field off would be shown "nothing is
 * waiting on this" while requests waited on it. One `jsonb_object_keys` per row inside the database
 * counts all of them and ships back one row per key rather than one row per request, so there is no
 * cap left to outgrow. `jsonb_typeof = 'object'` skips a row whose `proposed` is not an object at all
 * (nothing in this product writes one, and a set-returning function would error rather than skip it).
 */
export async function pendingProfileChangeCountsByKey(ctx: SessionContext): Promise<Map<string, number>> {
  const rows = await withTenant(ctx, (tx) =>
    tx.execute(sql`
      SELECT k AS key, count(*)::int AS n
        FROM ${profileChangeRequest} r,
             LATERAL jsonb_object_keys(r.proposed) AS k
       WHERE r.status = 'pending' AND jsonb_typeof(r.proposed) = 'object'
       GROUP BY k`),
  );
  const out = new Map<string, number>();
  for (const r of rows as unknown as { key: string; n: number | string }[]) {
    if (!requestableField(r.key)) continue;
    out.set(r.key, Number(r.n));
  }
  return out;
}

/**
 * Reject every pending request that names one of `lockedKeys`, with the reason the caller supplies.
 *
 * ── WHY THIS DOES NOT GO THROUGH `decideProfileChange`, AND WHY THAT IS SAFE ────────────────────────
 * `decideProfileChange` is a DECISION ON THE MERITS: it can apply the proposal, so it must ban the
 * subject from deciding their own (`assertCanDecide`) and it must know who decided. This is not that. It
 * is the consequence of a configuration change, it can only ever refuse, and it writes NOTHING to
 * `person` or `employee_statutory_my` — there is no approved branch to reach. Because it cannot apply
 * anything, a group admin whose OWN request happens to name a locked field gains nothing by running it:
 * the only thing they can do to their own request here is refuse it. That is why the self-ban is absent
 * rather than forgotten, and `decidedByEmploymentId` is left NULL because no person judged the request.
 *
 * Group admin only, mirroring `setTenantSetting`: the same authority that may change the setting is the
 * authority that may carry out its consequence, and nothing narrower would be able to finish the job it
 * started.
 */
export async function withdrawProfileChangesForLockedFields(
  ctx: SessionContext,
  p: { lockedKeys: readonly string[]; reason: string },
): Promise<{ withdrawn: number }> {
  if (!isGroupAdmin(ctx)) throw new Error('Only a group administrator can change profile-request settings.');
  const locked = new Set(p.lockedKeys.filter((k) => requestableField(k) != null));
  const reason = clean(p.reason);
  if (locked.size === 0 || reason === null) return { withdrawn: 0 };

  const lockedKeys = [...locked];

  return withTenant(ctx, async (tx) => {
    /**
     * ⚠️ ONE STATEMENT, FILTERED IN SQL, WITH NO CAP — the fix a review forced (r261 fix pass).
     *
     * This used to read `SELECT … WHERE status = 'pending' LIMIT 1000` and sift the rows in TypeScript.
     * Two things were wrong with that and the second is the serious one:
     *   · the cap was on ALL pending rows rather than on the matching ones, so in a tenant with a
     *     thousand unrelated requests waiting the matching row was simply never returned — proven on a
     *     live cluster, where the request naming the bank account stayed `pending`, the toast said
     *     "Fields saved" and an HR admin then approved it and moved the master account number;
     *   · saving twice did not help, because nothing about the second save made the missed row any more
     *     likely to be inside an unordered thousand.
     * `?|` ("does this jsonb object have ANY of these keys?") does the matching in the database, so the
     * statement touches exactly the rows it must refuse and converges by construction rather than by
     * luck. RETURNING gives back the rows it actually changed, which is also what makes the count honest.
     *
     * status + reason + timestamp ONLY. No master table is touched anywhere in this function, which is
     * the property test/me-profile-request-settings.test.ts reads the columns to prove.
     */
    const refused = await tx
      .update(profileChangeRequest)
      .set({ status: 'rejected', decidedByEmploymentId: null, decidedAt: sql`now()`, decisionReason: reason })
      .where(
        and(
          eq(profileChangeRequest.status, 'pending'),
          // ARRAY[$n, $n…], built with `sql.join` rather than by handing drizzle the JS array: a bare
          // array parameter expands to a RECORD `($5, $6)`, which Postgres refuses to cast to text[]
          // ("cannot cast type record to text[]"). Every key is still a bound parameter, never inlined.
          sql`${profileChangeRequest.proposed} ?| ARRAY[${sql.join(
            lockedKeys.map((k) => sql`${k}`),
            sql`, `,
          )}]::text[]`,
        ),
      )
      .returning({
        id: profileChangeRequest.id,
        employmentId: profileChangeRequest.employmentId,
        proposed: profileChangeRequest.proposed,
      });

    let withdrawn = 0;
    for (const req of refused) {
      const keys = Object.keys((req.proposed ?? {}) as Record<string, unknown>);
      const hit = keys.filter((k) => locked.has(k));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'profile-change',
        aggregateId: req.id,
        eventType: 'profile-change.rejected',
        actor: actorOf(ctx),
        subjectEmploymentId: req.employmentId,
        // Field NAMES and a provenance marker, never values and never the reason sentence — the same
        // rule decideProfileChange follows, and single-line so the event-payload PII guard can scan it.
        payload: { decision: 'rejected', via: 'field-locked', fields: hit, reasonGiven: true },
      });
      withdrawn += 1;
    }
    return { withdrawn };
  });
}
