import { parseJournalSnapshot, SubmissionJournalUnavailable, type JournalSnapshot, type SubmissionScope } from './submission-journal';

/** The native adapter encrypts each slot and keeps only the committed revision in SecureStore. */
export type SealedJournalStoragePorts<T> = {
  assertCurrent():void;
  readPointer():Promise<string|null>;
  writePointer(value:string):Promise<void>;
  readSlot(slot:0|1):Promise<Uint8Array|null>;
  writeSlot(slot:0|1,value:Uint8Array,snapshot:T):Promise<void>;
  seal(value:Uint8Array):Promise<Uint8Array>;
  open(value:Uint8Array):Promise<Uint8Array>;
};
export type SubmissionStoragePorts=SealedJournalStoragePorts<JournalSnapshot>;
function revision(value:string|null,error:(message:string)=>Error){
  if(value===null)return 0;
  if(!/^[1-9][0-9]{0,14}$/.test(value)||!Number.isSafeInteger(Number(value)))throw error('Invalid submission revision');
  return Number(value);
}

/** Never fall back to another slot: that could hide an already transmitted pending command. */
export function createSubmissionStorage(scope:SubmissionScope,ports:SubmissionStoragePorts){
  return createSealedJournalStorage(value=>parseJournalSnapshot(value,scope),ports,{maximumBytes:65536,error:message=>new SubmissionJournalUnavailable(message)});
}
/** One serialized owner, exact secure commit pointer, bounded authenticated slots. Enrollment also
 * refuses orphan slots without a pointer; it must not recreate an intent beside an unknown native key. */
export function createSealedJournalStorage<T extends {revision:number}>(parse:(value:unknown)=>T,ports:SealedJournalStoragePorts<T>,options:{maximumBytes:number;error:(message:string)=>Error;refuseOrphanSlots?:boolean}){
  const MAX_BYTES=options.maximumBytes,fail=options.error;
  if(!Number.isSafeInteger(MAX_BYTES)||MAX_BYTES<1||MAX_BYTES>1048576)throw fail('Invalid journal bound');
  return {
    async read():Promise<T|null>{
      ports.assertCurrent();const current=revision(await ports.readPointer(),fail);ports.assertCurrent();
      if(!current){
        if(options.refuseOrphanSlots){const a=await ports.readSlot(0);ports.assertCurrent();const b=await ports.readSlot(1);ports.assertCurrent();if(a||b)throw fail('Journal commit pointer is unavailable');}
        return null;
      }
      const encrypted=await ports.readSlot(current%2 as 0|1);ports.assertCurrent();
      if(!encrypted||encrypted.byteLength>MAX_BYTES+64)throw fail('Missing submission journal');
      try {
        const plaintext=await ports.open(encrypted);ports.assertCurrent();
        if(plaintext.byteLength>MAX_BYTES)throw new Error();
        const snapshot=parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)));
        if(snapshot.revision!==current)throw new Error();
        return snapshot;
      } catch {ports.assertCurrent();throw fail('Submission journal cannot be opened');}
    },
    async commit(snapshot:T){
      const checked=parse(snapshot);
      ports.assertCurrent();const current=revision(await ports.readPointer(),fail);ports.assertCurrent();
      if(checked.revision!==current+1)throw fail('Submission revision changed');
      const plaintext=new TextEncoder().encode(JSON.stringify(checked));
      if(plaintext.byteLength>MAX_BYTES)throw fail('Submission journal is full');
      const encrypted=await ports.seal(plaintext);ports.assertCurrent();
      if(encrypted.byteLength>MAX_BYTES+64)throw fail('Submission journal is full');
      await ports.writeSlot(checked.revision%2 as 0|1,encrypted,checked);ports.assertCurrent();
      // Recheck before the commit point; only one serialized owner may use this scope.
      if(revision(await ports.readPointer(),fail)!==current)throw fail('Submission revision changed');
      ports.assertCurrent();await ports.writePointer(String(checked.revision));ports.assertCurrent();
    },
  };
}
