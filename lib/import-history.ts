/** Shared import history vocabulary (ADR-0155). Client-safe: no database or server imports. */
export const IMPORT_KINDS=['cost_allocations','bank_statutory','employee_full','movement','information_correction'] as const;
export type ImportKind=typeof IMPORT_KINDS[number];
export const IMPORT_EVENT_KINDS=['previewed','confirmed','failed','reverted','revert_failed'] as const;
export type ImportEventKind=typeof IMPORT_EVENT_KINDS[number];
export const isImportKind=(value:unknown):value is ImportKind=>typeof value==='string'&&(IMPORT_KINDS as readonly string[]).includes(value);

/** Every kind's plan carries these generic fields; anything else is kind-specific. */
export type ImportPlanBase={version:1;previewHash:string;counts:{total:number;valid:number;invalid:number};issues:{rowNum:number;reason:string}[]};
/** The confirmed event's detail. Counts are per item (one item per employee or record the kind writes). */
export type ImportConfirmedDetail={succeeded:number;failed:number};

export type ImportAttemptStatus='validated'|'invalid'|'succeeded'|'partial'|'failed'|'reverted';
/** The status is DERIVED from the append-only events, so the badge and the audit trail cannot disagree. */
export function importAttemptStatus(plan:Pick<ImportPlanBase,'counts'|'issues'>|null|undefined,events:readonly {kind:ImportEventKind;detail:Record<string,unknown>}[]):ImportAttemptStatus{
 if(events.some(e=>e.kind==='reverted'))return'reverted';
 const confirmed=events.find(e=>e.kind==='confirmed');
 if(confirmed){const d=confirmed.detail as Partial<ImportConfirmedDetail>;const ok=Number(d.succeeded??0),bad=Number(d.failed??0);return ok===0?'failed':bad>0?'partial':'succeeded';}
 if(events.some(e=>e.kind==='failed'))return'failed';
 if(!plan||plan.issues?.length||!plan.counts?.valid)return'invalid';
 return'validated';
}
/** Counts shown in the list: succeeded/failed after confirmation, otherwise the preview's valid/invalid. */
export function importAttemptCounts(plan:Pick<ImportPlanBase,'counts'>|null|undefined,events:readonly {kind:ImportEventKind;detail:Record<string,unknown>}[]){
 const confirmed=events.find(e=>e.kind==='confirmed');
 if(confirmed){const d=confirmed.detail as Partial<ImportConfirmedDetail>;return{succeeded:Number(d.succeeded??0),failed:Number(d.failed??0)};}
 return{succeeded:0,failed:Number(plan?.counts?.invalid??0)};
}
export const IMPORT_REVERT_REASON_MAX=1000;
export function normalizeImportRevertReason(raw:unknown){
 const reason=typeof raw==='string'?raw.trim():'';
 return reason.length>=3&&reason.length<=IMPORT_REVERT_REASON_MAX?reason:null;
}
