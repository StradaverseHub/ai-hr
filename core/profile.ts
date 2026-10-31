import {splitProfileSubmission} from '../lib/profile-submission-policy';
import {validateProfileAttachments,saveProfileAttachmentsTx} from './profile-attachments';
import {profileFieldApproval} from '../lib/profile-edit-policy-value';
import {createHash} from 'node:crypto';
import {profileVisibilityFingerprint} from '../lib/profile-policy-fingerprint';
import {getSetting} from './entitlements';
import {assertAiPrincipalTx} from './ai-principal';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import type {AssignedApprovalMetadata} from '../lib/assigned-work';
import {pgSqlState} from '../lib/db-error';
import {isOwnPersonTx,ownPersonPredicate} from './own-person';
import {lockAccessConfigurationTx,lockProfileValueWritesTx} from './access-configuration-lock';
import {isProfilePhotoProposal} from '../lib/profile-photo-proposal';
import {readProfileRoutingPolicy,resolveProfileRouteTx,assertProfileRouteDecisionTx,profileRouteReaderPredicate,ProfileRoutingError,type ProfileRouteDecisionSubject} from './profile-routing';
import type {ProfilePresentationPolicy} from './profile-edit-policy';
import {projectOwnProfileProposal,ownProfileProposalIsIntact} from '../lib/personnel-ess-visibility';
import {freshProfileEditPolicyTx} from './profile-edit-policy';
import {EssProfileError,type EssProfileProposal} from '../lib/personnel-ess-model';
import {personnelField,PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import { isCalendarDate } from '../lib/calendar-date';
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
import { type Tx, withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { company,domainEvent,employeeDependent,employeeQualification,personEmergencyContact,employeeStatutoryMy, employment, person, profileChangeRequest,profileChangeAttachment,personPhoto } from '../db/schema';
import { assertCanDecide, assertAssignedWorkPrincipalTx, isApprovalDecisionRefusal } from './approvals';
// 9583deac stage two — the ONE declaration of which fields may be requested, what each is called on
// both screens, and which table/column an approval writes it to. See the header of that file.
import {
  PROFILE_REQUESTABLE_FIELDS,
  PROFILE_REQUESTABLE_KEYS,
  requestableField,
} from '../lib/profile-requestable-fields';
// r261 stage three — the tenant's own answers to "which fields may be asked about?" and "who decides?".
// Read from the per-request entitlement snapshot; see core/tenant-settings.ts for why they throw rather
// than degrade when the snapshot cannot answer.
import { profileChangeAllowedKeys, profileChangeApprover } from './tenant-settings';
import { isGroupAdmin } from '../lib/authz-model';
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
  const value=clean(v); if(value===null)return null;
  return isCalendarDate(value)?value:undefined;
};

/** The whole declaration, as a set. The HR-direct writer below passes this where the employee path
 *  passes the tenant's allow-list — see setPersonComplianceFields for why the two differ. */
const EVERY_REQUESTABLE_KEY: ReadonlySet<string> = new Set(PROFILE_REQUESTABLE_KEYS);

/**
 * 72fca31d — WHOEVER WRITES `marital_status` TAKES OWNERSHIP OF IT.
 *
 * `person.marital_status_source_request_id` (migration 0485) is a claim: "the current marital status was
 * written by that approved Marriage Leave request, so cancelling it may put the status back." Any OTHER
 * write of the column makes the claim false, and a stale claim is the one bug the whole mechanism exists
 * to prevent — a leave cancellation quietly overwriting a value a human had since corrected by hand.
 *
 * So this is spread into EVERY `person` update in this file that can carry the column, and this file is
 * the only place that writes it after creation: `decideProfileChange` (the employee asks, HR approves)
 * and `setPersonComplianceFields` (HR writes it directly; `hireEmployee` and the new-employee draft both
 * route through that one). The two Marriage Leave writers in migration 0485 are the only writers that
 * SET the pointer, and they set it in the same statement that writes the status.
 *
 * Returns `{}` when the update does not touch marital status, so every other profile write is unchanged.
 */
function maritalStatusSourceReset(writeSet: Record<string, unknown>): { maritalStatusSourceRequestId?: null } {
  return 'maritalStatus' in writeSet ? { maritalStatusSourceRequestId: null } : {};
}

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
    if (!ctx.personId||!await isOwnPersonTx(tx,ctx)) return null;
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
      .where(and(ownPersonPredicate(ctx),eq(person.id, ctx.personId)))
      .limit(1);
    const [stat] = await tx
      .select({
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        taxCategory: employeeStatutoryMy.taxCategory,
        numChildren: employeeStatutoryMy.numChildren,
      })
      .from(employeeStatutoryMy)
      .where(and(ownPersonPredicate(ctx),eq(employeeStatutoryMy.personId, ctx.personId)))
      .limit(1);
    return { person: p ?? null, statutory: stat ?? null };
  });
}

/** Direct self-edit of low-risk contact fields on the caller's own person row. Genuinely low-risk only —
 *  date of birth / gender / marital status are compliance-sensitive and go through the approval gate
 *  (requestProfileChange), not here (#24). */
export async function updateOwnContact(
  ctx:SessionContext,
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
  outerTx?:Tx,
){
 if(!ctx.personId)throw new EssProfileError('permission');
 const run=async(tx:Tx)=>{
  const policy=await freshProfileEditPolicyTx(tx,ctx);ctx=policy.ctx;
  if(!await isOwnPersonTx(tx,ctx))throw new EssProfileError('permission');
  if(Object.keys(p).some(key=>!['phone','personalEmail'].includes(key)&&p[key as keyof typeof p]!==undefined))throw new EssProfileError('addressReview');
  const patch:{phone?:string|null;personalEmail?:string|null}={};
  if(p.phone!==undefined){if(!policy.editable.has('profile.contact_and_permanent_address.phone')||profileFieldApproval(getSetting(ctx,'ess.profile_change_fields'),personnelField('profile.contact_and_permanent_address.phone')!).required)throw new EssProfileError('fieldClosed');patch.phone=clean(p.phone);}
  if(p.personalEmail!==undefined){if(!policy.editable.has('profile.contact_and_permanent_address.personalemail')||profileFieldApproval(getSetting(ctx,'ess.profile_change_fields'),personnelField('profile.contact_and_permanent_address.personalemail')!).required)throw new EssProfileError('fieldClosed');patch.personalEmail=clean(p.personalEmail);}
  if(!Object.keys(patch).length)return;
  const changed=await tx.update(person).set(patch).where(and(ownPersonPredicate(ctx),eq(person.id,ctx.personId!))).returning({id:person.id});
  if(changed.length!==1)throw new EssProfileError('permission');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'person',aggregateId:ctx.personId!,eventType:'person.self-updated',actor:actorOf(ctx),subjectEmploymentId:await subjectEmploymentForPerson(tx,ctx.tenantId,ctx.personId!),payload:{fields:Object.keys(patch)}});
 };
 return outerTx?run(outerTx):withTenant(ctx,run);
}

/** New submissions use the versioned owner exclusively; stored legacy requests retain decisions/history.
 * The current owner validates exact subject, policy, baselines, options and effective writer behavior.
 */
type OwnProfileChangeInput={employmentId:string;proposed:ProfileChangeProposed|EssProfileProposal;attachments?:import('../lib/profile-attachment').ProfileAttachmentInput[]};
async function prepareProfileChangeRequestTx(tx:Tx,ctx:SessionContext,p:OwnProfileChangeInput){
  await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  const policy=await freshProfileEditPolicyTx(tx,ctx);ctx=policy.ctx;
  const {ownProfileSubjectTx,prepareProfileProposalTx}=await import('./profile-edit');
  await ownProfileSubjectTx(tx,ctx,p.employmentId);
  // Legacy rows remain decidable/readable; no new request may bypass the versioned owner.
  if(!p.proposed||typeof p.proposed!=='object'||Array.isArray(p.proposed)||!('v' in p.proposed)||p.proposed.v!==2)throw new EssProfileError('invalid');
  const checked=await prepareProfileProposalTx(tx,ctx,p.employmentId,p.proposed);
  const partition=splitProfileSubmission(getSetting(ctx,'ess.profile_change_fields'),checked.proposal);
  if(checked.immediateRegisters.length||partition.immediate.fields.length||partition.immediate.registers.length)throw new EssProfileError('invalid');
  const proposed=checked.proposal;
  const attachments=validateProfileAttachments(p.attachments??[]),keys=new Set(proposed.fields.concat(proposed.registers.flatMap(row=>row.fields)).map(field=>field.fieldId));
  if(attachments.some(file=>file.fieldIds.some(id=>!keys.has(id))))throw new EssProfileError('invalid');
  const required=[...keys].filter(id=>profileFieldApproval(getSetting(ctx,'ess.profile_change_fields'),personnelField(id)!).attachmentRequired);
  if(required.some(id=>!attachments.some(file=>file.fieldIds.includes(id))))throw new EssProfileError('attachmentRequired',required);
  const route=await resolveProfileRouteTx(tx,ctx,p.employmentId);
  if(!proposed.fields.length&&!proposed.registers.length)throw new EssProfileError('invalid');
  return {ctx,policy,checked,proposed,route,attachments};
}
export type CanonicalOwnProfileChangeReview={employmentId:string;proposal:EssProfileProposal;reviewedDigest:string};
async function canonicalProfileChangeReviewTx(tx:Tx,prepared:Awaited<ReturnType<typeof prepareProfileChangeRequestTx>>):Promise<CanonicalOwnProfileChangeReview>{
 const {ctx,policy,checked,proposed,route,attachments}=prepared;
 if(!ownProfileProposalIsIntact(proposed,policy.visible))throw new EssProfileError('fieldClosed');
 // Only safe row-version metadata enters the source fingerprint. Never hash a hidden current
 // bank/identity/salary value into a client-review token. The canonical validator retains its locks.
 const [versions]=await tx.select({employment:sql<string>`${employment}.xmin::text`,person:sql<string>`${person}.xmin::text`,company:sql<string>`${company}.xmin::text`}).from(employment).innerJoin(person,eq(person.id,employment.personId)).innerJoin(company,eq(company.id,employment.companyId)).where(and(eq(employment.id,checked.subject.id),eq(employment.tenantId,ctx.tenantId),eq(person.id,ctx.personId!),eq(person.tenantId,ctx.tenantId),eq(company.tenantId,ctx.tenantId))).limit(1);
 if(!versions)throw new EssProfileError('unavailable');
 const dependentVersions=checked.rows.dependents.length?await tx.select({id:employeeDependent.id,revision:sql<string>`xmin::text`}).from(employeeDependent).where(and(eq(employeeDependent.tenantId,ctx.tenantId),inArray(employeeDependent.id,checked.rows.dependents.map(row=>row.id)))).orderBy(employeeDependent.id):[];
 const qualificationVersions=checked.rows.qualifications.length?await tx.select({id:employeeQualification.id,revision:sql<string>`xmin::text`}).from(employeeQualification).where(and(eq(employeeQualification.tenantId,ctx.tenantId),inArray(employeeQualification.id,checked.rows.qualifications.map(row=>row.id)))).orderBy(employeeQualification.id):[];
 const emergencyVersions=checked.rows.emergency.length?await tx.select({id:personEmergencyContact.id,revision:sql<string>`xmin::text`}).from(personEmergencyContact).where(and(eq(personEmergencyContact.tenantId,ctx.tenantId),inArray(personEmergencyContact.id,checked.rows.emergency.map(row=>row.id)))).orderBy(personEmergencyContact.id):[];
 if(dependentVersions.length!==checked.rows.dependents.length||qualificationVersions.length!==checked.rows.qualifications.length||emergencyVersions.length!==checked.rows.emergency.length)throw new EssProfileError('unavailable');
 const changed=[...proposed.fields,...proposed.registers.flatMap(row=>row.fields)];
 if(changed.some(change=>!['person','compliance','dependent','qualification','emergency'].includes(personnelField(change.fieldId)!.ess.binding!.owner))&&!checked.rows.snapshotSupported)throw new EssProfileError('unavailable');
 const projection=projectOwnProfileProposal(proposed,policy.visible) as EssProfileProposal;
 const routing=readProfileRoutingPolicy(ctx);
 const reviewedDigest=createHash('sha256').update(JSON.stringify(['own-profile-change-request:v1',{tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,employmentId:checked.subject.id,companyId:checked.subject.companyId,country:checked.subject.country},projection,profileVisibilityFingerprint(getSetting(ctx,'ess.profile_change_fields')),versions,{statutory:checked.rows.snapshot?{id:checked.rows.snapshot.rowId,revision:checked.rows.snapshot.revision}:null,dependentVersions,qualificationVersions,emergencyVersions},{revision:routing.revision,enabled:routing.enabled},route,attachments.map(file=>({fieldIds:[...file.fieldIds].sort(),fileName:file.fileName,mimeType:file.mimeType,sha256:createHash('sha256').update(file.content).digest('hex')}))])).digest('hex');
 return {employmentId:checked.subject.id,proposal:projection,reviewedDigest};
}
/** Read-only canonical review owner for a human-authored v2 approval request. No action custody,
 * model nomination, request/event write or click/commit proof is created here. */
export async function prepareOwnProfileChangeRequestReviewTx(tx:Tx,ctx:SessionContext,p:OwnProfileChangeInput){
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!ctx.personId)throw new EssProfileError('permission');
 await assertAiPrincipalTx(tx,ctx);
 return canonicalProfileChangeReviewTx(tx,await prepareProfileChangeRequestTx(tx,ctx,p));
}
async function requestProfileChangeOwnerTx(tx:Tx,ctx:SessionContext,p:OwnProfileChangeInput,expectedReviewedDigest?:string){
 const prepared=await prepareProfileChangeRequestTx(tx,ctx,p);ctx=prepared.ctx;const {proposed,route,attachments}=prepared;
 if(expectedReviewedDigest!==undefined){if(!/^[a-f0-9]{64}$/.test(expectedReviewedDigest)||(await canonicalProfileChangeReviewTx(tx,prepared)).reviewedDigest!==expectedReviewedDigest)throw new EssProfileError('stale');}
  // Policy advisory serializes canonical submissions. Exact retry reuses one pending proposal.
  const matching=await tx.select({id:profileChangeRequest.id}).from(profileChangeRequest).where(and(eq(profileChangeRequest.personId,ctx.personId!),eq(profileChangeRequest.employmentId,p.employmentId),eq(profileChangeRequest.status,'pending'),sql`${profileChangeRequest.proposed}=${JSON.stringify(proposed)}::jsonb`)).orderBy(profileChangeRequest.createdAt,profileChangeRequest.id).limit(2);
  if(matching.length>1)throw new EssProfileError('unavailable');
  if(matching.length===1){
   const storedFiles=await tx.select({fieldIds:profileChangeAttachment.fieldIds,fileName:profileChangeAttachment.fileName,mimeType:profileChangeAttachment.mimeType,content:profileChangeAttachment.content}).from(profileChangeAttachment).where(eq(profileChangeAttachment.requestId,matching[0].id));
   const evidence=(files:{fieldIds:string[];fileName:string;mimeType:string;content:Uint8Array}[])=>files.map(file=>JSON.stringify({fieldIds:[...file.fieldIds].sort(),fileName:file.fileName,mimeType:file.mimeType,sha256:createHash('sha256').update(file.content).digest('hex')})).sort();
   if(JSON.stringify(evidence(storedFiles))!==JSON.stringify(evidence(attachments)))throw new EssProfileError('stale');
   if(expectedReviewedDigest!==undefined){
    const [existing]=await tx.select({routeId:profileChangeRequest.routeId,routeRevision:profileChangeRequest.routeRevision,routeApproverUserId:profileChangeRequest.routeApproverUserId,routeApproverEmploymentId:profileChangeRequest.routeApproverEmploymentId,routeContext:profileChangeRequest.routeContext}).from(profileChangeRequest).where(eq(profileChangeRequest.id,matching[0].id)).limit(1);
    const context=existing?.routeContext as {asOf?:unknown;companyId?:unknown;fingerprint?:unknown}|null;
    if(!existing||existing.routeId!==(route?.routeId??null)||existing.routeRevision!==(route?.routeRevision??null)||existing.routeApproverUserId!==(route?.routeApproverUserId??null)||existing.routeApproverEmploymentId!==(route?.routeApproverEmploymentId??null)||(route?context?.asOf!==route.routeContext.asOf||context?.companyId!==route.routeContext.companyId||context?.fingerprint!==route.routeContext.fingerprint:context!==null))throw new EssProfileError('stale');
   }
   return {requestId:matching[0].id,requestedEventId:undefined,replayed:true};
  }
  const [row]=await tx.insert(profileChangeRequest).values({tenantId:ctx.tenantId,employmentId:p.employmentId,personId:ctx.personId!,proposed,...(route??{})}).returning({id:profileChangeRequest.id});
  const fields='v' in proposed&&proposed.v===2?[...proposed.fields.map(field=>field.fieldId),...proposed.registers.flatMap(record=>record.fields.map(field=>field.fieldId))]:Object.keys(proposed);
  if(attachments.length)await saveProfileAttachmentsTx(tx,ctx,row.id,attachments);
  const requestedEventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'profile-change',aggregateId:row.id,eventType:'profile-change.requested',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,payload:{employmentId:p.employmentId,fields,...(route?{approverEmploymentId:route.routeApproverEmploymentId,routeId:route.routeId,routeRevision:route.routeRevision}:{})}},{returnId:expectedReviewedDigest!==undefined});
  return {requestId:row.id,requestedEventId,replayed:false};
}
export async function requestProfileChange(ctx:SessionContext,p:OwnProfileChangeInput,outerTx?:Tx){
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!ctx.personId)throw new EssProfileError('permission');
 const run=async(tx:Tx)=>{const result=await requestProfileChangeOwnerTx(tx,ctx,p);return {requestId:result.requestId};};
 return outerTx?run(outerTx):withTenant(ctx,run);
}
export type OwnProfileChangeSubmissionReference={requestId:string;requestedEventId:string;employmentId:string;status:'pending'|'approved'|'rejected'};
/** Original actor and actual transaction login are both mandatory. A same-person second login
 * cannot adopt another actor's pending request or native event. No proposal/current private values
 * are selected or returned by this receipt reader. A reference means submitted, never approved. */
export async function readOwnProfileChangeSubmissionReferenceTx(tx:Tx,ctx:SessionContext,requestId:string,expectedEventId?:string):Promise<OwnProfileChangeSubmissionReference|null>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||!ctx.personId||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)||expectedEventId!==undefined&&! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedEventId))return null;
 await assertAiPrincipalTx(tx,ctx);if(!await isOwnPersonTx(tx,ctx))return null;
 const [request]=await tx.select({id:profileChangeRequest.id,employmentId:profileChangeRequest.employmentId,status:profileChangeRequest.status}).from(profileChangeRequest).innerJoin(employment,and(eq(employment.id,profileChangeRequest.employmentId),eq(employment.tenantId,profileChangeRequest.tenantId))).where(and(eq(profileChangeRequest.tenantId,ctx.tenantId),eq(profileChangeRequest.personId,ctx.personId),eq(employment.personId,ctx.personId),eq(profileChangeRequest.id,requestId))).limit(1);
 if(!request)return null;
 const events=await tx.select({id:domainEvent.id,employmentId:sql<unknown>`${domainEvent.payload}->>'employmentId'`,fields:sql<unknown>`${domainEvent.payload}->'fields'`}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'profile-change'),eq(domainEvent.aggregateId,request.id),eq(domainEvent.eventType,'profile-change.requested'),eq(domainEvent.actorType,'user'),eq(domainEvent.actorId,ctx.userId),eq(domainEvent.subjectEmploymentId,request.employmentId))).orderBy(domainEvent.sequence).limit(2);
 if(events.length!==1||expectedEventId!==undefined&&events[0].id!==expectedEventId||events[0].employmentId!==request.employmentId||!Array.isArray(events[0].fields)||events[0].fields.length===0||events[0].fields.length>4224||events[0].fields.some((id:unknown)=>typeof id!=='string'||!personnelField(id)))return null;
 return{requestId:request.id,requestedEventId:events[0].id,employmentId:request.employmentId,status:request.status};
}
/** Refusal-only expected review, then the SAME canonical request/event owner. The enclosing action
 * command owns this Tx and any future custody completion; no nested commit/extra ledger exists. */
export async function requestReviewedOwnProfileChangeTx(tx:Tx,ctx:SessionContext,p:OwnProfileChangeInput,expectedReviewedDigest:string){
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!ctx.personId||!ctx.userId)throw new EssProfileError('permission');
 await assertAiPrincipalTx(tx,ctx);
 const result=await requestProfileChangeOwnerTx(tx,ctx,p,expectedReviewedDigest);
 const reference=await readOwnProfileChangeSubmissionReferenceTx(tx,ctx,result.requestId,result.requestedEventId);
 if(!reference)throw new EssProfileError('unavailable');
 return {...reference,replayed:result.replayed};
}

export async function decideProfileChange(
  ctx: SessionContext,
  p: {
    requestId: string;
    decision: 'approved' | 'rejected';
    deciderEmploymentId?: string;
    /** The approver's words. Required to reject; optional on an approval. */
    reason?: string | null;
  },
  outerTx?:Tx,
) {
  p=structuredClone(p); ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  const reason = clean(p.reason);
  if (p.decision === 'rejected' && reason === null) throw new ProfileChangeReasonRequiredError();
  const run=async (tx:Tx) => {
    await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
    // Serialize the decision with configuration revocation before loading any proposal or master data.
    await lockAccessConfigurationTx(tx,ctx.tenantId);
    ctx=(await freshProfileEditPolicyTx(tx,ctx)).ctx;
    const [req] = await tx
      .select()
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.id, p.requestId))
      .limit(1).for('update');
    if (!req) throw new Error('profile change request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`profile change request is already ${req.status}`);

    /**
     * ── WHO MAY DECIDE, AND THE TWO HALVES OF IT ────────────────────────────────────────────────────
     *
     * `assertCanDecide` is the FLOOR and it is not configurable: it bans the subject from deciding their
     * own request (this profile course also explicitly refuses administrator self-approval),
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
     * 0560 restricts request rows to the own subject and scoped HR administrators. And it cannot widen
     * AUTHORITY in any configuration — both branches below only ever refuse.
     */
    await assertProfileChangeDecisionAuthorityTx(tx,ctx,req,p.decision);

    if(p.decision==='approved'&&!isProfilePhotoProposal(req.proposed))await tx.execute(sql`select app.access_profile_value_begin(${req.id}::uuid)`);
    if(p.decision==='approved'&&isProfilePhotoProposal(req.proposed)){
      const {applyProfilePhotoProposalTx}=await import('./person-photo');await applyProfilePhotoProposalTx(tx,ctx,req);
    }else if(p.decision==='approved'&&req.proposed&&typeof req.proposed==='object'&&!Array.isArray(req.proposed)&&'v' in req.proposed&&req.proposed.v===2){
      const {applyProfileProposalTx}=await import('./profile-edit');
      await applyProfileProposalTx(tx,ctx,req.employmentId,req.proposed);
    }else if (p.decision === 'approved') {
      const proposed = (req.proposed ?? {}) as Record<string, unknown>;
      /**
       * ⚠️ THE DECISION IS THE LAST GATE, AND IT RE-ASKS THE PERMISSION (r261 fix pass).
       *
       * The current request owner already refuses a field the tenant does not allow, and switching a field
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
      // The statutory database admission owner applies the current tenant policy, including
      // legacy requests. An unconditional pre-check here would incorrectly refuse ON-mode approvals.
      const {applyStoredLegacyProfileProposalTx}=await import('./profile-edit');
      await applyStoredLegacyProfileProposalTx(tx,ctx,req.employmentId,proposed);
    }

    const changedRows=await tx
      .update(profileChangeRequest)
      .set({
        status: p.decision,
        decidedByEmploymentId: p.deciderEmploymentId ?? null,
        decidedAt: sql`now()`,
        decisionReason: reason,
      })
      .where(eq(profileChangeRequest.id, req.id)).returning({id:profileChangeRequest.id,employmentId:profileChangeRequest.employmentId,personId:profileChangeRequest.personId,status:profileChangeRequest.status,reason:profileChangeRequest.decisionReason});
    if(outerTx&&(changedRows.length!==1||changedRows[0].id!==req.id||changedRows[0].employmentId!==req.employmentId||changedRows[0].personId!==req.personId||changedRows[0].status!==p.decision||changedRows[0].reason!==reason))throw new EssProfileError('stale');
    const [decisionProof]=outerTx?await tx.execute<{hash:string}>(sql`select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') as hash from profile_change_request r where r.id=${req.id}::uuid and r.tenant_id=${ctx.tenantId}::uuid`):[];
    const eventId=await appendEvent(tx, {
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
      payload: { decision: p.decision, deciderEmploymentId: p.deciderEmploymentId ?? null, reasonGiven: reason !== null, ...(outerTx?{decisionRowHash:decisionProof?.hash}: {}) },
    },{returnId:outerTx!==undefined});
    return { status: p.decision,...(outerTx?{eventId}: {}) };
  };
  return (outerTx?run(outerTx):withTenant(ctx,run)).catch(error=>{
    // Deferred SQL refusal is still a finite permission/stale result at the public decision owner.
    // Unknown storage/audit faults remain system failures and retain their original diagnostics.
    const state=pgSqlState(error);
    if(state!=='42501'&&state!=='40001')throw error;
    const refusal=new EssProfileError(state==='40001'?'stale':'permission');
    Object.defineProperty(refusal,'cause',{value:error});throw refusal;
  });
}

/** Bounded decision metadata for the existing Personnel rejection workflow. Values never leave this
 * owner. Photo/evidence/register proposals remain on the native queue. This is not new authority. */
export async function profileRequestRejectionContextTx(tx:Tx,ctx:SessionContext,requestId:string,mode:'pending'|'recorded'='pending'){
 await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);
 const policy=await freshProfileEditPolicyTx(tx,ctx);ctx=policy.ctx;
 const [req]=await tx.select().from(profileChangeRequest).where(and(eq(profileChangeRequest.id,requestId),eq(profileChangeRequest.tenantId,ctx.tenantId),sql`octet_length(${profileChangeRequest.proposed}::text)<=65536`)).limit(1).for('update');
 if(!req||req.status!==(mode==='pending'?'pending':'rejected')||mode==='pending'&&(req.decisionReason!==null||req.decidedAt!==null)||req.personId===ctx.personId)throw new EssProfileError('unavailable');
 await assertProfileChangeDecisionAuthorityTx(tx,ctx,req,'rejected');
 const [attachment]=await tx.select({id:profileChangeAttachment.id}).from(profileChangeAttachment).where(and(eq(profileChangeAttachment.tenantId,ctx.tenantId),eq(profileChangeAttachment.requestId,req.id))).limit(1);
 if(attachment||!req.proposed||typeof req.proposed!=='object'||Array.isArray(req.proposed)||isProfilePhotoProposal(req.proposed))throw new EssProfileError('unavailable');
 let fieldIds:string[];
 if('v' in req.proposed){
  const {parseEssProfileProposal}=await import('../lib/personnel-ess-contract');const proposed=parseEssProfileProposal(req.proposed);
  if(proposed.registers.length)throw new EssProfileError('unavailable');fieldIds=proposed.fields.map(field=>field.fieldId);
 }else{
  fieldIds=Object.entries(req.proposed).map(([key,value])=>{const definition=requestableField(key),field=PERSONNEL_FIELDS.find(item=>item.ess.binding?.legacyKey===key);if(!definition||!field||value!==null&&!['string','number','boolean'].includes(typeof value))throw new EssProfileError('unavailable');return field.id;});
 }
 if(!fieldIds.length||fieldIds.length>32||new Set(fieldIds).size!==fieldIds.length||fieldIds.some(id=>!policy.visible.has(id)))throw new EssProfileError('unavailable');
 const [identity]=await tx.select({employmentId:employment.id,companyId:employment.companyId,subjectPersonId:person.id,employeeName:person.fullName,employeeCode:employment.employeeCode,companyName:company.legalName,employmentVersion:sql<string>`employment.xmin::text`,personVersion:sql<string>`person.xmin::text`,companyVersion:sql<string>`company.xmin::text`}).from(employment).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).innerJoin(company,and(eq(company.id,employment.companyId),eq(company.tenantId,employment.tenantId))).where(and(eq(employment.id,req.employmentId),eq(employment.tenantId,ctx.tenantId),eq(person.id,req.personId))).limit(1).for('update');
 if(!identity)throw new EssProfileError('unavailable');
 const [version]=await tx.execute<{revision:string}>(sql`select xmin::text as revision from profile_change_request where id=${req.id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
 if(!version)throw new EssProfileError('unavailable');
 // Canonical JSON from PostgreSQL binds the full proposal and route, without returning their values.
 const [source]=await tx.execute<{hash:string}>(sql`select encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') as hash from profile_change_request r where r.id=${req.id}::uuid and r.tenant_id=${ctx.tenantId}::uuid`);
 const [authority]=await tx.execute<{hash:string}>(sql`select app.assistant_profile_rejection_authority_hash(${req.id}::uuid) as hash`);if(!authority?.hash)throw new EssProfileError('unavailable');
 return{ctx,subject:{...identity,subjectId:req.id,requestedAt:req.createdAt.toISOString(),fieldIds:fieldIds.sort()},sourceHash:source.hash,authorityHash:authority.hash,revision:version.revision,policyFingerprint:profileVisibilityFingerprint(getSetting(ctx,'ess.profile_change_fields'))};
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
  /** Explicit enclosing transaction; ordinary callers retain their owned transaction. */
  outerTx?: Tx,
) {
  p=structuredClone(p);
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  const roles = ctx.roles ?? [];
  const administrator=roles.includes('super_admin')||roles.includes('hr_admin');
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

  const run = async (tx:Tx) => {
    await tx.execute(sql`select app.access_workforce_write_lock()`);
    await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
    await lockProfileValueWritesTx(tx,ctx.tenantId);
    if(!administrator){const [direct]=await tx.execute<{allowed:boolean}>(sql`select app.profile_direct_subject(${p.employmentId}::uuid) as allowed`);if(!direct?.allowed)throw new EssProfileError('permission');}
    // Resolve the person through the authenticated subject or existing administrator scope.
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

    await tx
      .update(person)
      .set({ ...writeSet, ...maritalStatusSourceReset(writeSet) })
      .where(eq(person.id, personId));
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
  };
  return outerTx ? run(outerTx) : withTenant(ctx,run);
}

/** Admin inbox — RLS trims to scope. Recent first. */
export function listProfileChangeRequests(
  ctx: SessionContext,
  opts: { companyIds?: string[]; status?: 'pending' | 'approved' | 'rejected';requestId?:string;offset?:number;limit?:number } = {},
) {
  return withTenant(ctx, async (tx) => {
    const rows=await tx
      .select({
        id: profileChangeRequest.id,
        employmentId: profileChangeRequest.employmentId,
        personId: profileChangeRequest.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        proposed: profileChangeRequest.proposed,
        currentPhotoPresent:sql<boolean>`exists(select 1 from ${personPhoto} where ${personPhoto.personId}=${profileChangeRequest.personId})`,
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
          profileRouteReaderPredicate(ctx),
          opts.requestId?eq(profileChangeRequest.id,opts.requestId):undefined,
          opts.status ? eq(profileChangeRequest.status, opts.status) : undefined,
          opts.companyIds && opts.companyIds.length
            ? inArray(employment.companyId, opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(desc(profileChangeRequest.createdAt),desc(profileChangeRequest.id))
      .limit(Math.max(1,Math.min(opts.limit??100,100))).offset(Math.max(0,Math.min(opts.offset??0,100000)));
    const {currentProfileRequestValuesTx}=await import('./profile-edit');
    return Promise.all(rows.map(async row=>({...row,review:await currentProfileRequestValuesTx(tx,ctx,row)})));
  });
}

/**
 * The caller's own profile-change requests — the /me history, and the source of the pending values My
 * Profile draws BESIDE the master ones.
 *
 * ── IT TAKES NO ID, AND THAT IS THE SECURITY PROPERTY ───────────────────────────────────────────────
 * Stage one made `myProfileRecord` resolve the employment from `ctx.personId` for exactly this reason
 * (app/(app)/me/record.ts's header). This used to take an `employmentId` parameter: the /me page passed its
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
export function myProfileChangeRequests(ctx: SessionContext, limit = 50,presentation?:ProfilePresentationPolicy) {
  const personId = ctx.personId;
  if (!personId) return Promise.resolve([]);
  return withTenant(ctx, async (tx) => {
    const policy=presentation??await freshProfileEditPolicyTx(tx,ctx);
    const rows=await tx
      .select({
        id: profileChangeRequest.id,
        proposed: profileChangeRequest.proposed,
        status: profileChangeRequest.status,
        decisionReason: profileChangeRequest.decisionReason,
        decidedAt: profileChangeRequest.decidedAt,
        createdAt: profileChangeRequest.createdAt,
      })
      .from(profileChangeRequest)
      .where(and(ownPersonPredicate(ctx),eq(profileChangeRequest.personId, personId)))
      .orderBy(desc(profileChangeRequest.createdAt),desc(profileChangeRequest.id))
      .limit(limit);
    return rows.map(row=>{
      const proposed=projectOwnProfileProposal(row.proposed,policy.visible);
      // Free-form decision text can repeat a proposed private value; retain it only for an intact view.
      const intact=ownProfileProposalIsIntact(row.proposed,policy.visible);
      return {...row,proposed,decisionReason:intact?row.decisionReason:null};
    });
  });
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
export async function pendingProfileChangeCountsByKey(ctx:SessionContext):Promise<Map<string,number>>{
 const rows=await withTenant(ctx,tx=>tx.execute(sql`
  SELECT keys.key,count(DISTINCT r.id)::int n FROM ${profileChangeRequest} r,
  LATERAL (
   SELECT r.proposed->>'fieldId' AS key WHERE r.proposed->>'kind'='photo'
   UNION SELECT jsonb_object_keys(CASE WHEN r.proposed->>'v' IN ('2','3') THEN '{}'::jsonb WHEN jsonb_typeof(r.proposed)='object' THEN r.proposed ELSE '{}'::jsonb END) key
   UNION SELECT f->>'fieldId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.proposed->'fields')='array' THEN r.proposed->'fields' ELSE '[]'::jsonb END) f
   UNION SELECT f->>'fieldId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.proposed->'registers')='array' THEN r.proposed->'registers' ELSE '[]'::jsonb END) x,
    LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x->'fields')='array' THEN x->'fields' ELSE '[]'::jsonb END) f
  ) keys WHERE r.status='pending' GROUP BY keys.key`));
 const out=new Map<string,number>();
 for(const row of rows as unknown as {key:string;n:number|string}[])if(requestableField(row.key)||personnelField(row.key)?.ess.binding||row.key==='profile.personal_details.photo')out.set(row.key,Number(row.n));
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
  outerTx?:Tx,
): Promise<{ withdrawn: number }> {
  if (!isGroupAdmin(ctx)) throw new Error('Only a group administrator can change profile-request settings.');
  const locked = new Set(p.lockedKeys.filter((k) => requestableField(k) != null||personnelField(k)?.ess.binding||k==='profile.personal_details.photo'));
  const reason = clean(p.reason);
  if (locked.size === 0 || reason === null) return { withdrawn: 0 };

  // Legacy settings and v2 editors name the same descriptor differently. Expand only validated
  // declaration-owned counterparts; unknown names can never turn into a writable/matching field.
  for(const field of PERSONNEL_FIELDS){const alias=field.ess.binding?.legacyKey;
    if(alias&&(locked.has(alias)||locked.has(field.id))){locked.add(alias);locked.add(field.id);}
  }
  const lockedKeys = [...locked];

  const run=async (tx:Tx) => {
    // A write-only configuration consequence, independent of merit-review permission. The SQL
    // owner refreshes actual group administration and configuration denial, updates only pending
    // matching requests, purges decided photo bytes via the retention trigger and audits atomically.
    // It returns a count, never a proposal/route/reason, so a denied reviewer gains no row read.
    const [row]=await tx.execute<{withdrawn:number}>(sql`select app.access_withdraw_profile_requests(${JSON.stringify(lockedKeys)}::jsonb,${reason}) as withdrawn`);
    return {withdrawn:Number(row?.withdrawn??0)};
  };
  return outerTx?run(outerTx):withTenant(ctx,run);
}


export async function pendingProfileTaskMetadata(ctx:SessionContext,companyIds?:string[]):Promise<AssignedApprovalMetadata[]>{
 const candidates=await withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const current=(await freshProfileEditPolicyTx(tx,ctx)).ctx;
  return tx.select({id:profileChangeRequest.id,employmentId:profileChangeRequest.employmentId,personId:profileChangeRequest.personId,
   employee:person.fullName,createdAt:profileChangeRequest.createdAt}).from(profileChangeRequest)
   .innerJoin(employment,and(eq(employment.id,profileChangeRequest.employmentId),eq(employment.tenantId,profileChangeRequest.tenantId)))
   .leftJoin(person,and(eq(person.id,profileChangeRequest.personId),eq(person.tenantId,profileChangeRequest.tenantId)))
   .where(and(eq(profileChangeRequest.tenantId,ctx.tenantId),eq(profileChangeRequest.status,'pending'),profileRouteReaderPredicate(current),
    sql`NOT app.is_self_person(${profileChangeRequest.personId})`,companyIds===undefined?undefined:inArray(employment.companyId,companyIds)))
   .orderBy(desc(profileChangeRequest.createdAt),profileChangeRequest.id);
 });
 const allowed=new Set(await actionableProfileChangeIds(ctx,candidates.map(row=>row.id)));
 return candidates.filter(row=>allowed.has(row.id));
}


export function actionableProfileChangeIds(ctx:SessionContext,requestIds:readonly string[]){
 return withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const current=(await freshProfileEditPolicyTx(tx,ctx)).ctx,result:string[]=[],ids=[...new Set(requestIds)];
  for(let offset=0;offset<ids.length;offset+=1000){
   const rows=await tx.select({id:profileChangeRequest.id,employmentId:profileChangeRequest.employmentId,personId:profileChangeRequest.personId,
    routeId:profileChangeRequest.routeId,routeRevision:profileChangeRequest.routeRevision,routeApproverUserId:profileChangeRequest.routeApproverUserId,
    routeApproverEmploymentId:profileChangeRequest.routeApproverEmploymentId,routeContext:profileChangeRequest.routeContext,requestType:sql<'fields'|'photo'|null>`app.profile_task_request_type(${profileChangeRequest.id})`}).from(profileChangeRequest)
    .where(and(inArray(profileChangeRequest.id,ids.slice(offset,offset+1000)),eq(profileChangeRequest.status,'pending'),profileRouteReaderPredicate(current))).orderBy(profileChangeRequest.id);
   for(const row of rows){
    if(row.personId===current.personId||row.requestType===null)continue;
    try{await assertProfileChangeDecisionAuthorityTx(tx,current,{...row,requestType:row.requestType},'rejected');result.push(row.id);}
    catch(error){
     if(isApprovalDecisionRefusal(error,'profile change'))continue;
     if(error instanceof ProfileRoutingError&&['changed','unauthorized'].includes(error.code))continue;
     if(error instanceof Error&&error.constructor===Error&&['Only an admin can approve a profile change','Only a group administrator can approve a profile change'].includes(error.message))continue;
     throw error;
    }
   }
  }
  return result.sort();
 });
}


async function assertProfileChangeDecisionAuthorityTx(tx:Tx,ctx:SessionContext,req:ProfileRouteDecisionSubject&{personId:string},decision:'approved'|'rejected'){
 await assertProfileRouteDecisionTx(tx,ctx,req);
 if(req.personId===ctx.personId&&decision==='approved')throw new EssProfileError('permission');
 await assertCanDecide(tx,ctx,req.employmentId,'profile change');
 const roles=ctx.roles??[];
 if(!(roles.includes('super_admin')||roles.includes('hr_admin')))throw new Error('Only an admin can approve a profile change');
 if(profileChangeApprover(ctx)==='group_admin'&&!isGroupAdmin(ctx))throw new Error('Only a group administrator can approve a profile change');
}
