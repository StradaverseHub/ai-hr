/** AI v2 W8 — the contract every loop detector meets, and the bounds on what a case may hold.
 *
 * A detector runs under the loop's sponsor's CURRENT authority (core/loops/run.ts resolves it every run), reads only
 * through native owners, and returns positive observations:
 *  - a subject the loop should prepare a card for (state open), or one where the person already acted and the owner's
 *    usual approval is pending (state waiting);
 *  - for a case the loop is tracking, whether its "done" condition now holds (state closed, reason done), whether the
 *    subject ended (inactive), no longer applies (superseded) or its moment passed (expired).
 * A tracked case the detector could not observe is left unchanged: disappearing from a read never proves completion
 * (ADR-0109). A detector never writes, never decides and never calls a model. */
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import type {LoopCaseState,LoopCloseReason,LoopFacts,LoopRead,LoopRecipient,LoopResolution} from './types';

export type TrackedCase=Readonly<{id:string;subjectKey:string;companyId:string;employmentId:string|null;state:LoopCaseState;facts:LoopFacts}>;
export type LoopObservation=Readonly<{subjectKey:string;companyId:string;employmentId:string|null;recipient:LoopRecipient;
 state:LoopCaseState;closeReason?:LoopCloseReason;resolution?:LoopResolution;facts:LoopFacts}>;
export type LoopDetectInput=Readonly<{companyIds:readonly string[];today:string;tracked:readonly TrackedCase[]}>;
export type LoopDetection=Readonly<{observations:readonly LoopObservation[];reads:readonly LoopRead[]}>;
export type LoopDetector=(sponsor:SessionContext,input:LoopDetectInput)=>Promise<LoopDetection>;

const short=z.string().max(64).regex(/^[^\n\r]*$/);
/** A case's facts: dates, clock times, counts and closed keys. No room for a name, a number or prose. */
export const LoopFactsSchema=z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/),
 z.union([short,z.number().finite(),z.boolean(),z.null(),z.array(short).max(20)])).refine(value=>Object.keys(value).length<=16);
const uuid=z.guid();
export const LoopObservationSchema=z.object({
 subjectKey:z.string().regex(/^[a-z]+:[0-9a-f-]{36}(:[0-9]{4}-[0-9]{2}(-[0-9]{2})?)?$/),companyId:uuid,employmentId:uuid.nullable(),
 recipient:z.enum(['hr','payroll','employee']),state:z.enum(['open','waiting','closed']),
 closeReason:z.enum(['done','inactive','superseded','expired']).optional(),resolution:z.enum(['as_prepared','changed','completed']).optional(),
 facts:LoopFactsSchema,
}).strict()
 .refine(value=>(value.state==='closed')===(value.closeReason!==undefined))
 .refine(value=>value.resolution===undefined||value.closeReason==='done')
 .refine(value=>(value.recipient==='payroll')===(value.employmentId===null));

/** HH:MM from a stored clock value (HH:MM or HH:MM:SS), or null. */
export const clockOf=(value:string|null|undefined)=>typeof value==='string'&&/^\d{2}:\d{2}/.test(value)?value.slice(0,5):null;
export const read=(tool:string,owner:string,status:LoopRead['status']='ok'):LoopRead=>Object.freeze({tool,owner,status});
export const unique=<T>(values:Iterable<T>)=>[...new Set(values)];
