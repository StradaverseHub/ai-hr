/** Bank & Statutory background import transport and presentation contract. */
export const BANK_IMPORT_MAX_BYTES=128*1024*1024;
export const BANK_IMPORT_MAX_ROWS=250_000;
export const BANK_IMPORT_CHUNK_BYTES=1024*1024;
export const BANK_IMPORT_BATCH_ROWS=100;
export const BANK_IMPORT_PAGE_ROWS=100;
export const BANK_IMPORT_ACTIVE_STATES=['uploading','queued','validating','ready','importing'] as const;
export type BankImportState=typeof BANK_IMPORT_ACTIVE_STATES[number]|'completed'|'failed'|'cancelled';
export type BankImportProgress={id:string;sourceName:string;state:BankImportState;total:number;validated:number;valid:number;invalid:number;unchanged:number;processed:number;saved:number;failed:number;uploadedBytes:number;sourceBytes:number;attemptId:string|null;error:string|null;updatedAt:string;createdAt:string};
export const bankImportActive=(state:BankImportState)=> (BANK_IMPORT_ACTIVE_STATES as readonly string[]).includes(state);
export function bankImportPercent(job:BankImportProgress){
 const total=job.state==='uploading'?job.sourceBytes:job.total;
 const done=job.state==='uploading'?job.uploadedBytes:job.state==='importing'||job.state==='completed'?job.processed:job.validated;
 return total>0?Math.min(100,Math.floor(done/total*100)):0;
}
