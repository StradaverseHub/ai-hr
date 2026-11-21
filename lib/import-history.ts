/** Shared import history vocabulary (ADR-0155). Client-safe: no database or server imports. */
export const IMPORT_KINDS=['cost_allocations','bank_statutory','employee_full','movement','information_correction'] as const;
export type ImportKind=typeof IMPORT_KINDS[number];
export const IMPORT_EVENT_KINDS=['previewed','confirmed','failed','reverted','revert_failed'] as const;
export type ImportEventKind=typeof IMPORT_EVENT_KINDS[number];
export const isImportKind=(value:unknown):value is ImportKind=>typeof value==='string'&&(IMPORT_KINDS as readonly string[]).includes(value);
/** ccd3a65c — section imports that keep only a run summary (employee_import_run), listed beside the attempts.
 * 'full' and 'bank_statutory' runs are not listed: those files already appear as attempts. */
export const IMPORT_RUN_KINDS=['profile','family','qualification','emergency'] as const;
export type ImportRunKind=typeof IMPORT_RUN_KINDS[number];
export const isImportRunKind=(value:unknown):value is ImportRunKind=>typeof value==='string'&&(IMPORT_RUN_KINDS as readonly string[]).includes(value);
/** The Import History filter order: the import page's own choice order. */
export const IMPORT_HISTORY_KINDS=['employee_full','profile','movement','bank_statutory','family','qualification','emergency','cost_allocations','information_correction'] as const satisfies readonly (ImportKind|ImportRunKind)[];
export type ImportHistoryKind=typeof IMPORT_HISTORY_KINDS[number];
export const isImportHistoryKind=(value:unknown):value is ImportHistoryKind=>isImportKind(value)||isImportRunKind(value);
/** Total rows in the file, rows saved and rows not saved, for the Import History columns. */
export function importAttemptTotals(plan:Pick<ImportPlanBase,'counts'>|null|undefined,events:readonly {kind:ImportEventKind;detail:Record<string,unknown>}[]){
 const total=Number(plan?.counts?.total??0),confirmed=events.find(e=>e.kind==='confirmed');
 if(confirmed){const d=confirmed.detail as Partial<ImportConfirmedDetail>&{unchanged?:number};return{total,successful:Number(d.succeeded??0),failed:Number(d.failed??0)};}
 return{total,successful:0,failed:Number(plan?.counts?.invalid??0)};
}

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
