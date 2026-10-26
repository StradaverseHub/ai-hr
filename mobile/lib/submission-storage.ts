import { parseJournalSnapshot, SubmissionJournalUnavailable, type JournalSnapshot, type SubmissionScope } from './submission-journal';

/** The native adapter encrypts each slot and keeps only the committed revision in SecureStore. */
export type SubmissionStoragePorts = {
  assertCurrent():void;
  readPointer():Promise<string|null>;
  writePointer(value:string):Promise<void>;
  readSlot(slot:0|1):Promise<Uint8Array|null>;
  writeSlot(slot:0|1,value:Uint8Array,snapshot:JournalSnapshot):Promise<void>;
  seal(value:Uint8Array):Promise<Uint8Array>;
  open(value:Uint8Array):Promise<Uint8Array>;
};
const MAX_BYTES=65536;
function revision(value:string|null){
  if(value===null)return 0;
  if(!/^[1-9][0-9]{0,14}$/.test(value)||!Number.isSafeInteger(Number(value)))throw new SubmissionJournalUnavailable('Invalid submission revision');
  return Number(value);
}

/** Never fall back to another slot: that could hide an already transmitted pending command. */
export function createSubmissionStorage(scope:SubmissionScope,ports:SubmissionStoragePorts){
  return {
    async read():Promise<JournalSnapshot|null>{
      ports.assertCurrent();const current=revision(await ports.readPointer());ports.assertCurrent();
      if(!current)return null; // An orphaned uncommitted file never authorized a network send.
      const encrypted=await ports.readSlot(current%2 as 0|1);ports.assertCurrent();
      if(!encrypted||encrypted.byteLength>MAX_BYTES+64)throw new SubmissionJournalUnavailable('Missing submission journal');
      try {
        const plaintext=await ports.open(encrypted);ports.assertCurrent();
        if(plaintext.byteLength>MAX_BYTES)throw new Error();
        const snapshot=parseJournalSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)),scope);
        if(snapshot.revision!==current)throw new Error();
        return snapshot;
      } catch {throw new SubmissionJournalUnavailable('Submission journal cannot be opened');}
    },
    async commit(snapshot:JournalSnapshot){
      const checked=parseJournalSnapshot(snapshot,scope);
      ports.assertCurrent();const current=revision(await ports.readPointer());ports.assertCurrent();
      if(checked.revision!==current+1)throw new SubmissionJournalUnavailable('Submission revision changed');
      const plaintext=new TextEncoder().encode(JSON.stringify(checked));
      if(plaintext.byteLength>MAX_BYTES)throw new SubmissionJournalUnavailable('Submission journal is full');
      const encrypted=await ports.seal(plaintext);ports.assertCurrent();
      if(encrypted.byteLength>MAX_BYTES+64)throw new SubmissionJournalUnavailable('Submission journal is full');
      await ports.writeSlot(checked.revision%2 as 0|1,encrypted,checked);ports.assertCurrent();
      // Recheck before the commit point; only one serialized owner may use this scope.
      if(revision(await ports.readPointer())!==current)throw new SubmissionJournalUnavailable('Submission revision changed');
      ports.assertCurrent();await ports.writePointer(String(checked.revision));ports.assertCurrent();
    },
  };
}
