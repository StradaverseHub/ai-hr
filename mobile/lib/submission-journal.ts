/** Pending evidence is a local claim. Only a server receipt can establish an accepted submission. */
import { ClockCommand, LeaveCommand,ClockPreparation,ClockAttemptReceipt } from '../../lib/mobile-api/contract';
import { z } from 'zod';
import {ClockSourceSignals} from '../../lib/mobile-clock-integrity';
export type SubmissionKind = 'clock' | 'leave';
export type SubmissionScope = { namespace: string; actorId: string; employmentId: string };
export type EvidenceFile = { uri: string; name: string; mimeType: string; size: number };
export type JournalEntry = {
  kind: SubmissionKind; requestId: string; command: string; digest: string; createdAt: number;
  stage?:'preparation';attemptReceipt?:ClockAttemptReceipt;
  integrity?:{version:1;source:ClockSourceSignals};
  evidence?: { reference: string; name: string; mimeType: string; size: number; digest: string };
};
export type JournalSnapshot = { version: 1|2|3; revision: number; scope: SubmissionScope; entries: JournalEntry[] };
export class PendingSubmissionConflict extends Error {}
export class SubmissionJournalUnavailable extends Error {}
export class SubmissionJournalFull extends SubmissionJournalUnavailable {}
export type JournalPorts = {
  assertCurrent(): void;
  read(): Promise<JournalSnapshot | null>;
  commit(value: JournalSnapshot): Promise<void>;
  digest(value: string | Uint8Array): Promise<string>;
  readEvidence(file: EvidenceFile): Promise<Uint8Array>;
  storeEvidence(kind: SubmissionKind, id: string, bytes: Uint8Array): Promise<string>;
  restoreEvidence(reference: string, file: Omit<EvidenceFile, 'uri'>): Promise<EvidenceFile>;
  deleteEvidence(reference: string): Promise<void>;
  discardRestored?: (file:EvidenceFile)=>Promise<void>;
  reclaim?: (snapshot:JournalSnapshot)=>Promise<void>;
};
const digestSchema=z.string().regex(/^[0-9a-f]{64}$/);
const scopeSchema=z.object({namespace:z.string().min(1).max(2048),actorId:z.string().uuid(),employmentId:z.string().uuid()}).strict();
const entrySchema=z.object({
  kind:z.enum(['clock','leave']),requestId:z.string().uuid(),command:z.string().max(16384),digest:digestSchema,
  createdAt:z.number().int().positive(),
  stage:z.literal('preparation').optional(),attemptReceipt:ClockAttemptReceipt.optional(),
  integrity:z.object({version:z.literal(1),source:ClockSourceSignals}).strict().optional(),
  evidence:z.object({reference:z.string().regex(/^[0-9a-f-]{36}\.sealed$/),name:z.string().min(1).max(200),
    mimeType:z.string().min(1).max(100),size:z.number().int().positive().max(10*1024*1024),digest:digestSchema}).strict().optional(),
}).strict();
/** Reject corrupt committed state; an older empty state must never substitute for it. */
function digestData(kind:SubmissionKind,command:string,evidence:unknown,integrity?:JournalEntry['integrity']){return JSON.stringify([kind,command,evidence,...(integrity?[integrity]:[])]);}
export function parseJournalSnapshot(value:unknown,scope:SubmissionScope):JournalSnapshot {
  try {
    const snapshot=z.object({version:z.union([z.literal(1),z.literal(2),z.literal(3)]),revision:z.number().int().positive(),scope:scopeSchema,entries:z.array(entrySchema).max(2)}).strict().parse(value);
    if(snapshot.scope.namespace!==scope.namespace||snapshot.scope.actorId!==scope.actorId||snapshot.scope.employmentId!==scope.employmentId)throw new Error();
    if(new Set(snapshot.entries.map(e=>e.kind)).size!==snapshot.entries.length)throw new Error();
    for(const entry of snapshot.entries){
      if(entry.integrity&&(snapshot.version!==3||entry.kind!=='clock'||entry.stage))throw new Error();
      if(entry.stage==='preparation'&&(snapshot.version===1||entry.kind!=='clock'||entry.evidence))throw new Error();
      if(entry.attemptReceipt&&(entry.stage!=='preparation'||entry.attemptReceipt.requestId!==entry.requestId))throw new Error();
      const parsed=(entry.stage==='preparation'?ClockPreparation:entry.kind==='clock'?ClockCommand:LeaveCommand).parse(JSON.parse(entry.command));
      if(parsed.requestId!==entry.requestId||entry.kind==='clock'&&(entry.evidence?.size??0)>2*1024*1024)throw new Error();
      if(entry.stage==='preparation'&&ClockPreparation.parse(parsed).claimedAt!==entry.createdAt)throw new Error();
    }
    return snapshot;
  } catch {throw new SubmissionJournalUnavailable('Invalid submission journal');}
}

/** One serialized journal per actor/employment. File/crypto ownership is behind explicit native ports. */
export function createSubmissionJournal(rawScope: SubmissionScope, ports: JournalPorts) {
  const checkedScope=scopeSchema.safeParse(rawScope);
  if(!checkedScope.success)throw new SubmissionJournalUnavailable('Invalid submission scope');
  const scope=checkedScope.data;
  let state:JournalSnapshot|undefined;
  let writes:Promise<unknown>=Promise.resolve();
  function enqueue<T>(run:()=>Promise<T>):Promise<T>{const next=writes.then(run);writes=next.catch(()=>{});return next;}
  async function load(){
    ports.assertCurrent();
    if(!state){
      const stored=await ports.read();ports.assertCurrent();
      state=stored?parseJournalSnapshot(stored,scope):{version:1,revision:0,scope:{...scope},entries:[]};
      try{await ports.reclaim?.(state);}catch{/* Cleanup must never erase or hide a committed pending entry. */}
      ports.assertCurrent();
    }
    return state;
  }
  async function commit(entries:JournalEntry[]){
    const previous=await load();
    const next:JournalSnapshot={...previous,version:entries.some(entry=>entry.integrity)?3:entries.some(entry=>entry.stage==='preparation')?2:1,revision:previous.revision+1,entries};
    ports.assertCurrent();try{await ports.commit(next);ports.assertCurrent();state=next;}catch(error){state=undefined;throw error;}
    try{await ports.reclaim?.(next);}catch{/* Durable state remains authoritative if cleanup needs a later retry. */}
    ports.assertCurrent();
  }
  return {
    pending(){return enqueue(async()=>{const snapshot=await load();return structuredClone(snapshot.entries);});},
    prepareClock(action:'in'|'out',requestId:string){return enqueue(async()=>{
      const previous=await load(),candidate=ClockPreparation.safeParse({requestId,action,claimedAt:Date.now()});
      if(!candidate.success)throw new SubmissionJournalUnavailable('Invalid clock preparation');
      const existing=previous.entries.find(entry=>entry.kind==='clock');
      if(existing){
        if(existing.stage!=='preparation'||ClockPreparation.parse(JSON.parse(existing.command)).action!==action)
          throw new PendingSubmissionConflict('Review the saved clock attempt before replacing it');
        const digest=await ports.digest(JSON.stringify(['clock',existing.command,null]));ports.assertCurrent();
        if(digest!==existing.digest)throw new SubmissionJournalUnavailable('Pending attempt failed verification');
        return structuredClone(existing);
      }
      const command=JSON.stringify(candidate.data),digest=await ports.digest(JSON.stringify(['clock',command,null]));ports.assertCurrent();
      const entry:JournalEntry={kind:'clock',stage:'preparation',requestId,command,digest,createdAt:candidate.data.claimedAt};
      await commit([...previous.entries,entry]);return structuredClone(entry);
    });},
    markAttemptReported(requestId:string,receipt:ClockAttemptReceipt){return enqueue(async()=>{
      const snapshot=await load(),checked=ClockAttemptReceipt.parse(receipt);
      const entry=snapshot.entries.find(entry=>entry.kind==='clock'&&entry.requestId===requestId);
      if(entry?.stage!=='preparation'||checked.requestId!==requestId)throw new SubmissionJournalUnavailable('Pending attempt changed');
      await commit(snapshot.entries.map(value=>value===entry?{...entry,attemptReceipt:checked}:value));
    });},
    clockAttempt(requestId:string){return enqueue(async()=>{
      const snapshot=await load(),entry=snapshot.entries.find(value=>value.kind==='clock'&&value.requestId===requestId);
      if(!entry)throw new SubmissionJournalUnavailable('Pending clock attempt unavailable');
      const expected=await ports.digest(digestData('clock',entry.command,entry.evidence?{name:entry.evidence.name,mimeType:entry.evidence.mimeType,size:entry.evidence.size,digest:entry.evidence.digest}:null,entry.integrity));ports.assertCurrent();
      if(expected!==entry.digest)throw new SubmissionJournalUnavailable('Pending attempt failed verification');
      const parsed=(entry.stage==='preparation'?ClockPreparation:ClockCommand).parse(JSON.parse(entry.command));
      return ClockPreparation.parse({requestId:entry.requestId,action:parsed.action,claimedAt:entry.createdAt});
    });},
    stage(kind:SubmissionKind,command:string,rawFile?:EvidenceFile,source?:ClockSourceSignals){
      const file=rawFile?{...rawFile}:undefined;let integrity:JournalEntry['integrity'];
      try{if(source!==undefined){if(kind!=='clock')throw new Error();integrity={version:1,source:ClockSourceSignals.parse(source)};}}catch{return Promise.reject(new SubmissionJournalUnavailable('Invalid source metadata'));}
      return enqueue(async()=>{
      const previous=await load();
      let parsed:ReturnType<typeof ClockCommand.parse>|ReturnType<typeof LeaveCommand.parse>;
      try{if(!['clock','leave'].includes(kind)||new TextEncoder().encode(command).byteLength>16384)throw new Error();parsed=(kind==='clock'?ClockCommand:LeaveCommand).parse(JSON.parse(command));}
      catch{throw new SubmissionJournalUnavailable('Invalid pending command');}
      let bytes:Uint8Array|undefined,fileDigest:string|undefined;
      if(file){
        const cap=(kind==='clock'?2:10)*1024*1024;
        if(!file.name||file.name.length>200||!file.mimeType||file.mimeType.length>100||!Number.isSafeInteger(file.size)||file.size<1||file.size>cap)throw new SubmissionJournalUnavailable('Invalid pending evidence');
        bytes=await ports.readEvidence(file);ports.assertCurrent();
        if(bytes.byteLength!==file.size)throw new SubmissionJournalUnavailable('Pending evidence changed');
        fileDigest=await ports.digest(bytes);ports.assertCurrent();
      }
      const digest=await ports.digest(digestData(kind,command,file?{name:file.name,mimeType:file.mimeType,size:file.size,digest:fileDigest}:null,integrity));ports.assertCurrent();
      const existing=previous.entries.find(e=>e.kind===kind);
      if(existing){
        if(existing.stage==='preparation'){
          if(kind!=='clock'||existing.requestId!==parsed.requestId||ClockPreparation.parse(JSON.parse(existing.command)).action!==ClockCommand.parse(parsed).action)
            throw new PendingSubmissionConflict('Review the saved clock attempt before replacing it');
          if(await ports.digest(JSON.stringify(['clock',existing.command,null]))!==existing.digest)throw new SubmissionJournalUnavailable('Pending attempt failed verification');
          ports.assertCurrent();
        }else{
        if(existing.requestId!==parsed.requestId||existing.digest!==digest)throw new PendingSubmissionConflict('Resolve the pending submission before replacing it');
        return structuredClone(existing);
        }
      }
      const reference=bytes?await ports.storeEvidence(kind,parsed.requestId,bytes):undefined;
      ports.assertCurrent();
      const entry:JournalEntry={kind,requestId:parsed.requestId,command,digest,createdAt:existing?.createdAt??Date.now(),...(integrity?{integrity}:{}),
        ...(file&&reference?{evidence:{reference,name:file.name,mimeType:file.mimeType,size:file.size,digest:fileDigest!}}:{})};
      // This await is the durable boundary. Callers must never send the command before it resolves.
      await commit([...previous.entries.filter(value=>value!==existing),entry]);
      return structuredClone(entry);
    });},
    restore(entry:JournalEntry){return enqueue(async()=>{
      const snapshot=await load();
      const owned=snapshot.entries.find(e=>e.kind===entry.kind&&e.requestId===entry.requestId&&e.digest===entry.digest);
      if(!owned)throw new SubmissionJournalUnavailable('Pending submission changed');
      const expected=await ports.digest(digestData(owned.kind,owned.command,owned.evidence?{name:owned.evidence.name,mimeType:owned.evidence.mimeType,size:owned.evidence.size,digest:owned.evidence.digest}:null,owned.integrity));ports.assertCurrent();
      if(expected!==owned.digest)throw new SubmissionJournalUnavailable('Pending command failed verification');
      if(!owned.evidence)return {command:owned.command};
      const file=await ports.restoreEvidence(owned.evidence.reference,owned.evidence);
      try{ports.assertCurrent();const bytes=await ports.readEvidence(file);ports.assertCurrent();
       if(bytes.byteLength!==owned.evidence.size||await ports.digest(bytes)!==owned.evidence.digest)throw new SubmissionJournalUnavailable('Pending evidence failed verification');
       ports.assertCurrent();return {command:owned.command,file};
      }catch(error){try{await ports.discardRestored?.(file);}catch{}throw error;}
    });},
    resolve(kind:SubmissionKind,requestId:string){return enqueue(async()=>{
      const snapshot=await load(),entry=snapshot.entries.find(e=>e.kind===kind&&e.requestId===requestId);
      if(!entry)return;
      await commit(snapshot.entries.filter(e=>e!==entry));
      // A failed cleanup cannot resurrect an accepted command; the committed empty state owns it.
      if(entry.evidence)await ports.deleteEvidence(entry.evidence.reference);
    });},
  };
}
