/** ADR-0151 §4.3 inline review cards: the closed set of actions a chat answer may PROPOSE, and the only
 * hints each may carry. Pure and browser-safe (zod only): no session, store, provider or effect.
 *
 * A hint is a typed selector the person can verify on the card (a date or a clock time). It is never an
 * ID, a name, a reason, a remark, a note, a description or a decision. Hints are resolved after the turn
 * against the caller's own fresh `choices` read for that action; one match is preselected, zero or several
 * ask the person to pick. Nothing is prepared until the person presses the card's own prepare button.
 *
 * NEXT INCREMENT (not covered here): the other implemented actions (leave.apply, claims.draft.save,
 * claims.submit, attendance.correction.request, approvals.leave.decide, toil, lifecycle, knowledge base,
 * org, notifications, profile, performance, testing, payroll close, rewards, pay codes, statutory and
 * multi-cycle runs) keep their bespoke browser protocols. A chat answer reaches them only through the
 * existing human-review link card (`refuse` + `human_review_required`) to their /assistant page. Each needs
 * its own typed hint shape and panel prefill before it can be proposed inline.
 */
import {z} from 'zod';

const date=z.iso.date(),time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
/** Hint keys in canonical order. `?` marks an optional selector. Constants only: part of the prompt prefix. */
export const ASSISTANT_PROPOSAL_HINT_KEYS=Object.freeze({
 'leave.cancel':Object.freeze(['startDate?']),
 'leave.edit':Object.freeze(['startDate?','newStartDate','newEndDate']),
 'claims.cancel':Object.freeze(['incurredOn?']),
 'attendance.overtime.request':Object.freeze(['date','plannedStartTime','plannedEndTime']),
 'approvals.claim.decide':Object.freeze([]),
 'approvals.attendance.decide':Object.freeze([]),
 'approvals.toil.decide':Object.freeze([]),
} as const);
export type AssistantProposableAction=keyof typeof ASSISTANT_PROPOSAL_HINT_KEYS;
export const ASSISTANT_PROPOSABLE_ACTIONS=Object.freeze(Object.keys(ASSISTANT_PROPOSAL_HINT_KEYS) as AssistantProposableAction[]);
/** The module each proposable action belongs to; the caller must currently be able to read it. */
export const ASSISTANT_PROPOSAL_MODULE=Object.freeze({
 'leave.cancel':'leave','leave.edit':'leave','claims.cancel':'claims','attendance.overtime.request':'attendance',
 'approvals.claim.decide':'approvals','approvals.attendance.decide':'approvals','approvals.toil.decide':'approvals',
} as const satisfies Record<AssistantProposableAction,string>);
/** The existing review page for each proposable action: the card's fallback and reopen destination. */
export const ASSISTANT_PROPOSAL_FALLBACK=Object.freeze({
 'leave.cancel':'/assistant/leave?flow=change','leave.edit':'/assistant/leave?flow=change','claims.cancel':'/assistant/claims?flow=cancel',
 'attendance.overtime.request':'/assistant/attendance?flow=overtime','approvals.claim.decide':'/assistant/approvals?flow=claims',
 'approvals.attendance.decide':'/assistant/approvals?flow=attendance','approvals.toil.decide':'/assistant/approvals?flow=toil',
} as const satisfies Record<AssistantProposableAction,string>);
const SCHEMAS:Readonly<Record<AssistantProposableAction,z.ZodType>>={
 'leave.cancel':z.object({startDate:date.optional()}).strict(),
 'leave.edit':z.object({startDate:date.optional(),newStartDate:date,newEndDate:date}).strict().refine(h=>h.newStartDate<=h.newEndDate),
 'claims.cancel':z.object({incurredOn:date.optional()}).strict(),
 'attendance.overtime.request':z.object({date,plannedStartTime:time,plannedEndTime:time}).strict().refine(h=>h.plannedStartTime!==h.plannedEndTime),
 // The model never chooses approve/reject, a note or the item: the approver does, on the card.
 'approvals.claim.decide':z.object({}).strict(),
 'approvals.attendance.decide':z.object({}).strict(),
 'approvals.toil.decide':z.object({}).strict(),
};
export type AssistantProposalHints=Readonly<{startDate?:string;newStartDate?:string;newEndDate?:string;incurredOn?:string;date?:string;plannedStartTime?:string;plannedEndTime?:string}>;
export type AssistantActionProposal=Readonly<{action:AssistantProposableAction;hints:AssistantProposalHints}>;
const fail=():never=>{throw Error('Assistant action proposal unavailable.');};
export const isAssistantProposableAction=(value:unknown):value is AssistantProposableAction=>typeof value==='string'&&Object.hasOwn(ASSISTANT_PROPOSAL_HINT_KEYS,value);

/** Strict hints for one proposable action, re-emitted in canonical key order. Every value is a string in
 * the declared date/time format; any other key, a non-string, a getter or a non-plain object refuses. */
export function captureAssistantProposalHints(action:unknown,value:unknown):AssistantProposalHints{
 if(!isAssistantProposableAction(action)||value===null||typeof value!=='object'||Array.isArray(value))return fail();
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return fail();
 const copy:Record<string,string>={};
 for(const key of Reflect.ownKeys(value)){
  if(typeof key!=='string')return fail();const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor||!('value'in descriptor)||!descriptor.enumerable||typeof descriptor.value!=='string')return fail();copy[key]=descriptor.value;
 }
 const parsed=SCHEMAS[action].safeParse(copy);if(!parsed.success)return fail();
 const out:Record<string,string>={};
 for(const spec of ASSISTANT_PROPOSAL_HINT_KEYS[action]){const key=spec.replace('?','');if(Object.hasOwn(copy,key))out[key]=copy[key];else if(!spec.endsWith('?'))return fail();}
 if(Object.keys(out).length!==Object.keys(copy).length)return fail();
 return Object.freeze(out) as AssistantProposalHints;
}

/** Protocol text, built only from the constants above (no user, tenant, locale or clock bytes). */
export const ASSISTANT_PROPOSAL_PROTOCOL=[
 'Propose only when the person asks to make one of these changes; proposing prepares and changes nothing. The person reviews a card, adds their own words and decision, and confirms it themselves.',
 'Proposable actions and their only hint keys (? optional): '+ASSISTANT_PROPOSABLE_ACTIONS.map(action=>`${action} {${ASSISTANT_PROPOSAL_HINT_KEYS[action].join(',')}}`).join('; ')+'.',
 'Hint dates are YYYY-MM-DD and times HH:MM, taken from the person\'s own words; omit an optional hint you were not given.',
 'Hints never contain IDs, names, reasons, remarks, notes, descriptions, amounts or a decision. For any other change use refuse human_review_required.',
].join(' ');

/** One own choice preselected, or a question. Never a guess and never a row outside `rows`. */
export type ProposalResolution<T>=Readonly<{kind:'one';row:T}>|Readonly<{kind:'several'}>|Readonly<{kind:'none'}>;
export type ProposalResolutionKind=ProposalResolution<unknown>['kind'];
export function resolveProposalChoice<T>(rows:readonly T[],matches:(row:T)=>boolean):ProposalResolution<T>{
 const found=rows.filter(matches);
 return found.length===1?Object.freeze({kind:'one',row:found[0]}):Object.freeze({kind:found.length===0?'none':'several'});
}
/** Leave cancel/edit: the person's own pending request, chosen by its start date when one was named. */
export const leaveProposalMatches=(hints:Pick<AssistantProposalHints,'startDate'>)=>(row:{startDate:string})=>hints.startDate===undefined||row.startDate===hints.startDate;
/** Claim cancellation: the person's own pending claim, chosen by its incurred date when one was named. */
export const claimProposalMatches=(hints:Pick<AssistantProposalHints,'incurredOn'>)=>(row:{incurredOn:string})=>hints.incurredOn===undefined||row.incurredOn===hints.incurredOn;
