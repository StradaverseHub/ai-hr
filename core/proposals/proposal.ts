/** ADR-0170 §10.3 move 1 and §11.3 change 1 — the signed proposal object, step 0b.
 *
 * A proposal is a frozen, versioned description of ONE prepared change: what, for whom, by which authority
 * (a person, or later a mandate), which native checks ran with their rule versions and results, which
 * existing review route confirms it, and when it expires. Chat cards, the review page, the mobile app and a
 * Connect client are renderers of it. It is signed with HMAC-SHA256 over a canonical encoding, using a
 * server secret read from configuration (TERAS_PROPOSAL_SECRET); the secret never appears in source.
 *
 * Invariants:
 *  - Only a native owner's preparer creates one (core/proposals/<action>.ts calls issueProposal after the
 *    owner's own check function passed; test/proposal-object.test.ts pins the callers).
 *  - It never applies a change. Confirmation happens on the existing review route, under the person's own
 *    login, where the owning service re-checks everything; a valid signature is integrity, not authority.
 *  - verifyProposal refuses a tampered body, an expired or not-yet-valid one, and any authority that is not
 *    the current caller. Mandate authority is refused until mandates exist (ADR-0170 §3.10, step 5a).
 * Not persisted here: durability is the review custody row the preparer created. Not imported by the
 * production Assistant. */
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {RECOMMENDATION_CHECKS,RECOMMENDATION_RESULTS,RECOMMENDATION_VERDICTS} from '../semantic-model/entities-recommend';

export const PROPOSAL_VERSION=1 as const;
const DOMAIN='teras:proposal:v1';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const anchor=z.string().regex(/^[a-z0-9_./-]+\.ts#[A-Za-z_][A-Za-z0-9_]*$/);
const instant=z.string().datetime();

export const ProposalAuthority=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('person'),tenantId:z.guid(),userId:z.guid(),personId:z.guid()}).strict(),
 z.object({kind:z.literal('mandate'),tenantId:z.guid(),mandateId:z.guid(),grantorPersonId:z.guid()}).strict(),
]);
/** One native check as it ran. `ruleVersion` null means the owner publishes no rule version yet. */
export const ProposalCheck=z.object({check:z.string().regex(/^[a-z_]+$/),owner:anchor,ruleVersion:z.string().min(1).nullable(),
 result:z.enum(['pass','needs_review','fail'])}).strict();
const calendarDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/),figure=z.number().finite(),clockTime=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const ProposalFacts=z.object({
 leaveType:z.string().min(1).max(64),startDate:calendarDate,endDate:calendarDate,
 /** Days the request covers, as the leave engine counted them. */days:figure.nonnegative(),
 /** The owner's estimate of the person's balance after the change (leave.apply). */balanceAfter:figure,
 /** The applicant's current ledger balance for the type (approver context, core/read.ts listLeaveRequests). */balanceNow:figure,
 /** Other people the caller may see with approved or pending leave on these dates (core/read.ts plannedAbsences). */othersAway:z.number().int().nonnegative(),
 /** Approved dates the person asks to give back (approved-leave cancellation). */cancelDates:z.array(calendarDate).min(1).max(31),
 /** The person's own decision (approvals.leave.decide). */decision:z.enum(['approved','rejected']),
 /** What confirming does, in the owner's own terms. */outcome:z.enum(['withdrawn_now','give_back_requested','rejection_if_confirmed','step_decision_if_confirmed','approval_if_native_checks_pass','submitted_not_approved']),
 /** Attendance (W2): the clock times the person asks for, and what the attendance record holds now (HH:MM, KL wall time). */
 checkIn:clockTime,checkOut:clockTime,recordedCheckIn:clockTime,recordedCheckOut:clockTime,
 /** Overtime and time off in lieu (W2): the window the person gave (HH:MM; an earlier end is the next day). */
 plannedStart:clockTime,plannedEnd:clockTime,
 /** The attendance service's own minute count for that overtime window. Never a pay figure. */overtimeMinutes:z.number().int().positive(),
 /** Days the leave service would credit for a time-off-in-lieu request, as its own review counted them. */creditDays:figure.positive(),
}).partial().strict();
export type ProposalFacts=z.infer<typeof ProposalFacts>;
/** Step 5 (§3.5): the approver recommendation from native checks, when the recommender worker ran. Two verdicts
 * only, recommend approve or needs review (owner decision, 2 November 2026: never reject). Its own checks may
 * fail and `failedRules` names them; the proposal's `checks` still may not fail. The approver decides. */
export const ProposalRecommendation=z.object({verdict:z.enum(RECOMMENDATION_VERDICTS),recommenderVersion:z.string().regex(/^[a-z0-9_.:-]{1,80}$/),
 checks:z.array(z.object({check:z.enum(RECOMMENDATION_CHECKS),owner:anchor,ruleVersion:z.string().min(1).max(200).nullable(),
  result:z.enum(RECOMMENDATION_RESULTS),blocking:z.boolean()}).strict()).length(RECOMMENDATION_CHECKS.length),
 failedRules:z.array(z.object({check:z.enum(RECOMMENDATION_CHECKS),blocking:z.boolean(),ruleVersion:z.string().min(1).max(200).nullable()}).strict()).max(RECOMMENDATION_CHECKS.length),
 recordId:z.guid().nullable()}).strict()
 // approve only when nothing failed; a failed rule always reads needs_review.
 .refine(value=>value.verdict==='needs_review'||(value.failedRules.length===0&&value.checks.every(check=>check.result==='pass')));
export type ProposalRecommendation=z.infer<typeof ProposalRecommendation>;
export const ProposalBody=z.object({
 kind:z.literal('teras.proposal'),version:z.literal(PROPOSAL_VERSION),id:z.guid(),
 what:z.object({action:z.string().regex(/^[a-z_-]+(?:\.[a-z_-]+)+$/),contractVersion:z.number().int().positive(),
  entity:z.string().regex(/^[a-z_]+$/),effect:z.enum(['create','withdraw','decide']),
  /** The typed selectors the person verifies on the card (dates only for the leave cards). */
  selectors:z.record(z.string(),z.string().max(64)),
  /** The owner's digest of the exact reviewed effect; the review route refuses any other. */
  reviewedDigest:digest}).strict(),
 forWhom:z.object({tenantId:z.guid(),subject:z.enum(['own_employment','assigned_request']),subjectId:z.guid()}).strict(),
 authority:ProposalAuthority,
 checks:z.array(ProposalCheck).min(1).max(32),
 /** Where the person reviews and confirms. `href` carries at most the review custody handle, never a business
  * identifier (a review page with several flows may name its flow first, as /assistant/attendance?flow=overtime does);
  * `reference` is what that route's own confirmation takes. */
 review:z.object({route:z.string().regex(/^\/[a-z0-9/_-]*$/),href:z.string().regex(/^\/[a-z0-9/_-]*(?:\?(?:flow=[a-z]+&)?[a-z]+=[0-9a-fA-F-]{36})?$/),reference:z.guid()}).strict(),
 /** Key facts from the native checks, for the card (step 2). Closed vocabulary; product labels, calendar
  * dates and the owner's own figures only, never a name, identifier or free text. */
 facts:ProposalFacts.optional(),
 recommendation:ProposalRecommendation.optional(),
 createdAt:instant,expiresAt:instant,
}).strict().refine(value=>Date.parse(value.expiresAt)>Date.parse(value.createdAt))
 .refine(value=>value.authority.tenantId===value.forWhom.tenantId)
 // A failed native check yields no proposal at all; "needs review" may still be shown for a person to decide.
 .refine(value=>value.checks.every(check=>check.result!=='fail'));
export type ProposalBody=z.infer<typeof ProposalBody>;
export const Proposal=z.object({body:ProposalBody,signature:z.object({alg:z.literal('HMAC-SHA256'),value:digest}).strict()}).strict();
export type Proposal=Readonly<z.infer<typeof Proposal>>;

/** Missing or weak configuration. Callers fail closed: no proposal is issued or accepted. */
export class ProposalUnavailable extends Error{constructor(){super('Proposals are unavailable.');this.name='ProposalUnavailable';}}
function secret():Buffer{
 const value=process.env.TERAS_PROPOSAL_SECRET;
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')<32)throw new ProposalUnavailable();
 return Buffer.from(value,'utf8');
}
/** For preparers that save a review before issuing: refuse first, so no review is saved that cannot be signed. */
export function assertProposalsConfigured():void{secret();}
/** Deterministic encoding: object keys sorted at every depth, arrays in order, no undefined or non-finite numbers. */
export function canonicalJson(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isFinite(value))throw new ProposalUnavailable();return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(typeof value==='object'){const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw new ProposalUnavailable();
  return '{'+Object.keys(value).sort().map(key=>{const child=(value as Record<string,unknown>)[key];if(child===undefined)throw new ProposalUnavailable();return JSON.stringify(key)+':'+canonicalJson(child);}).join(',')+'}';}
 throw new ProposalUnavailable();
}
const sign=(body:ProposalBody)=>createHmac('sha256',secret()).update(DOMAIN+'\n'+canonicalJson(body)).digest('hex');
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export type ProposalDraft=Omit<ProposalBody,'kind'|'version'|'id'>;
/** For native preparers in core/proposals only, after the owner's check function passed. */
export function issueProposal(draft:ProposalDraft):Proposal{
 const body=ProposalBody.parse({kind:'teras.proposal',version:PROPOSAL_VERSION,id:randomUUID(),...draft});
 return freeze({body,signature:{alg:'HMAC-SHA256' as const,value:sign(body)}});
}

export type ProposalRefusal='malformed'|'signature'|'not_yet_valid'|'expired'|'authority_mismatch'|'authority_unsupported';
export type ProposalVerification=Readonly<{ok:true;proposal:Proposal}>|Readonly<{ok:false;reason:ProposalRefusal}>;
/** Integrity, freshness and authority binding to the CURRENT caller. Never authority for the effect itself:
 * the review route re-checks the person's access and the owner's rules at confirmation. */
export function verifyProposal(value:unknown,caller:SessionContext,now:Date):ProposalVerification{
 const parsed=Proposal.safeParse(value);
 if(!parsed.success||!Number.isFinite(now.getTime()))return{ok:false,reason:'malformed'};
 const proposal=parsed.data,expected=Buffer.from(sign(proposal.body),'hex'),given=Buffer.from(proposal.signature.value,'hex');
 if(expected.length!==given.length||!timingSafeEqual(expected,given))return{ok:false,reason:'signature'};
 if(now.getTime()<Date.parse(proposal.body.createdAt)-5_000)return{ok:false,reason:'not_yet_valid'};
 if(now.getTime()>=Date.parse(proposal.body.expiresAt))return{ok:false,reason:'expired'};
 const authority=proposal.body.authority;
 if(authority.kind==='mandate')return{ok:false,reason:'authority_unsupported'};
 if(authority.tenantId!==caller.tenantId||authority.userId!==caller.userId||!caller.personId||authority.personId!==caller.personId)
  return{ok:false,reason:'authority_mismatch'};
 return{ok:true,proposal:freeze(proposal)};
}
