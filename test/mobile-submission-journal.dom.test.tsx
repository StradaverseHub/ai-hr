import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSubmissionJournal, PendingSubmissionConflict, SubmissionJournalUnavailable, type JournalPorts, type JournalSnapshot } from '../mobile/lib/submission-journal';
import { createSubmissionStorage } from '../mobile/lib/submission-storage';

const actorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',employmentId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scope={namespace:'https://hr.example.com/tenant-one',actorId,employmentId};
const clock=JSON.stringify({requestId,action:'in',lat:3,lng:101,accuracy:5,sampledAt:Date.now()});
const file={uri:'file:///cache/evidence',name:'attendance.jpg',mimeType:'image/jpeg',size:3};
const digest=async(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fixture(){
  let stored:JournalSnapshot|null=null,current=true;
  const bytes=new Uint8Array([1,2,3]);
  const ports:JournalPorts={
    assertCurrent(){if(!current)throw new Error('Session changed');},
    read:vi.fn(async()=>stored),commit:vi.fn(async(value)=>{stored=structuredClone(value);}),digest,
    readEvidence:vi.fn(async()=>bytes),storeEvidence:vi.fn(async()=>`${requestId}.sealed`),
    restoreEvidence:vi.fn(async()=>file),deleteEvidence:vi.fn(async()=>{}),
  };
  return {ports,journal:createSubmissionJournal(scope,ports),stored:()=>stored,changeSession:()=>{current=false;}};
}
describe('pending submission durability and ownership',()=>{
  it('persists preparation before a command exists, survives restart and reuses one stable reference',async()=>{
    const f=fixture(),entry=await f.journal.prepareClock('in',requestId);
    expect(entry).toMatchObject({kind:'clock',stage:'preparation',requestId});expect(f.stored()?.version).toBe(2);
    const restarted=createSubmissionJournal(scope,f.ports);
    expect(await restarted.prepareClock('in',actorId)).toEqual(entry);
    expect(await restarted.restore(entry)).toEqual({command:entry.command});
    expect(f.ports.commit).toHaveBeenCalledOnce();expect(f.ports.storeEvidence).not.toHaveBeenCalled();
    await expect(restarted.prepareClock('out',actorId)).rejects.toBeInstanceOf(PendingSubmissionConflict);
    await expect(createSubmissionJournal({...scope,actorId:employmentId},f.ports).pending()).rejects.toBeInstanceOf(SubmissionJournalUnavailable);
  });
  it('atomically replaces only the same prepared action/reference with an immutable command',async()=>{
    const f=fixture(),entry=await f.journal.prepareClock('in',requestId);
    await expect(f.journal.stage('clock',clock.replace(requestId,actorId))).rejects.toBeInstanceOf(PendingSubmissionConflict);
    await expect(f.journal.stage('clock',clock.replace('"in"','"out"'))).rejects.toBeInstanceOf(PendingSubmissionConflict);
    const staged=await f.journal.stage('clock',clock,file);
    expect(staged.createdAt).toBe(entry.createdAt);expect(staged.stage).toBeUndefined();expect(f.stored()?.version).toBe(1);
    expect(await f.journal.pending()).toEqual([staged]);
    await expect(f.journal.prepareClock('in',requestId)).rejects.toBeInstanceOf(PendingSubmissionConflict);
    expect(await f.journal.restore(staged)).toEqual({command:clock,file});
    const reads=vi.mocked(f.ports.readEvidence).mock.calls.length;
    expect(await f.journal.clockAttempt(requestId)).toEqual({requestId,action:'in',claimedAt:entry.createdAt});
    expect(f.ports.readEvidence).toHaveBeenCalledTimes(reads);
  });
  it('retains the unsent attempt after attachment or command persistence fails',async()=>{
    const f=fixture(),entry=await f.journal.prepareClock('in',requestId);
    vi.mocked(f.ports.commit).mockRejectedValueOnce(new Error('Full'));
    await expect(f.journal.stage('clock',clock,file)).rejects.toThrow('Full');
    expect(await createSubmissionJournal(scope,f.ports).pending()).toEqual([entry]);
    expect(await f.journal.pending()).toEqual([entry]);
  });
  it('records an attempt receipt without treating it as accepted attendance or resolving the attempt',async()=>{
    const f=fixture(),entry=await f.journal.prepareClock('in',requestId),receipt={requestId,receivedAt:new Date().toISOString()};
    await f.journal.markAttemptReported(requestId,receipt);
    const [saved]=await createSubmissionJournal(scope,f.ports).pending();
    expect(saved).toMatchObject({stage:'preparation',attemptReceipt:receipt,command:entry.command});
    expect((await f.journal.restore(saved)).command).toBe(entry.command);
    await expect(f.journal.markAttemptReported(requestId,{...receipt,requestId:actorId})).rejects.toThrow('changed');
  });
  it('restores the exact command and verified evidence after a fresh controller is created',async()=>{
    const f=fixture(),entry=await f.journal.stage('clock',clock,file);
    const restarted=createSubmissionJournal(scope,f.ports);
    expect(await restarted.pending()).toEqual([entry]);
    expect(await restarted.restore(entry)).toEqual({command:clock,file});
    expect(f.ports.commit).toHaveBeenCalledTimes(1);
    expect(f.ports.storeEvidence).toHaveBeenCalledBefore(f.ports.commit as ReturnType<typeof vi.fn>);
  });
  it('does not authorize sending when the durable commit fails',async()=>{
    const f=fixture();vi.mocked(f.ports.commit).mockRejectedValueOnce(new Error('Storage full'));
    const send=vi.fn();
    await expect(f.journal.stage('clock',clock,file).then(send)).rejects.toThrow('Storage full');
    expect(send).not.toHaveBeenCalled();expect(await f.journal.pending()).toEqual([]);
  });
  it('serializes duplicate taps and refuses a replacement command while unresolved',async()=>{
    const f=fixture();
    const [a,b]=await Promise.all([f.journal.stage('clock',clock,file),f.journal.stage('clock',clock,file)]);
    expect(a).toEqual(b);expect(f.ports.commit).toHaveBeenCalledTimes(1);
    await expect(f.journal.stage('clock',clock.replace('"in"','"out"'),file)).rejects.toBeInstanceOf(PendingSubmissionConflict);
  });
  it('serializes hydration with a first write so a late empty read cannot erase committed state',async()=>{
    const f=fixture();let release!:(value:null)=>void;
    vi.mocked(f.ports.read).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const loading=f.journal.pending();await Promise.resolve();await Promise.resolve();
    const staging=f.journal.stage('clock',clock);
    await Promise.resolve();expect(f.ports.read).toHaveBeenCalledTimes(1);
    release(null);expect(await loading).toEqual([]);const entry=await staging;
    expect(await f.journal.pending()).toEqual([entry]);expect(f.ports.read).toHaveBeenCalledTimes(1);
  });
  it('stops an obsolete account before evidence can be committed',async()=>{
    const f=fixture();vi.mocked(f.ports.readEvidence).mockImplementationOnce(async()=>{f.changeSession();return new Uint8Array([1,2,3]);});
    await expect(f.journal.stage('clock',clock,file)).rejects.toThrow('Session changed');
    expect(f.ports.storeEvidence).not.toHaveBeenCalled();expect(f.ports.commit).not.toHaveBeenCalled();
  });
  it('refuses a different account or employment to load the stored command',async()=>{
    const f=fixture();await f.journal.stage('clock',clock,file);
    for(const other of [{...scope,actorId:employmentId},{...scope,employmentId:actorId},{...scope,namespace:'https://another.example.com'}]){
      await expect(createSubmissionJournal(other,f.ports).pending()).rejects.toBeInstanceOf(SubmissionJournalUnavailable);
    }
  });
  it('refuses changed evidence and changed command metadata before recovery',async()=>{
    const f=fixture(),entry=await f.journal.stage('clock',clock,file);
    vi.mocked(f.ports.readEvidence).mockResolvedValueOnce(new Uint8Array([3,2,1]));
    await expect(f.journal.restore(entry)).rejects.toThrow('verification');
    f.stored()!.entries[0].command=clock.replace('"in"','"out"');
    const restarted=createSubmissionJournal(scope,f.ports);
    await expect(restarted.restore(entry)).rejects.toThrow('verification');
  });
  it('commits resolution before cleanup and never resurrects accepted evidence on cleanup failure',async()=>{
    const f=fixture();await f.journal.stage('clock',clock,file);
    vi.mocked(f.ports.deleteEvidence).mockRejectedValueOnce(new Error('Cleanup unavailable'));
    await expect(f.journal.resolve('clock',requestId)).rejects.toThrow('Cleanup unavailable');
    expect(await createSubmissionJournal(scope,f.ports).pending()).toEqual([]);
    expect(f.stored()!.revision).toBe(2);
  });
  it('rejects corrupted or ambiguous committed entries',async()=>{
    const f=fixture();await f.journal.stage('clock',clock,file);
    f.stored()!.entries.push(structuredClone(f.stored()!.entries[0]));
    await expect(createSubmissionJournal(scope,f.ports).pending()).rejects.toThrow('Invalid submission journal');
  });
});

describe('journal commit pointer crash boundaries',()=>{
  function fixtureStorage(){
    let pointer:string|null=null;
    const slots=new Map<number,Uint8Array>();
    const ports={assertCurrent(){},readPointer:vi.fn(async()=>pointer),writePointer:vi.fn(async(value:string)=>{pointer=value;}),
      readSlot:vi.fn(async(slot:0|1)=>slots.get(slot)??null),writeSlot:vi.fn(async(slot:0|1,value:Uint8Array)=>{slots.set(slot,value);}),
      // Crypto is a native port; these tests exercise the actual slot/pointer protocol.
      seal:vi.fn(async(value:Uint8Array)=>value),open:vi.fn(async(value:Uint8Array)=>value)};
    const store=()=>createSubmissionStorage(scope,ports);
    return {ports,store,slots,pointer:()=>pointer};
  }
  it('ignores a written slot when the commit pointer was never written',async()=>{
    const f=fixtureStorage();f.ports.writePointer.mockRejectedValueOnce(new Error('Crash'));
    const snapshot:JournalSnapshot={version:1,revision:1,scope,entries:[]};
    await expect(f.store().commit(snapshot)).rejects.toThrow('Crash');
    expect(f.slots.size).toBe(1);expect(await f.store().read()).toBeNull();
  });
  it('reads only the committed revision and refuses corruption without fallback',async()=>{
    const f=fixtureStorage();
    await f.store().commit({version:1,revision:1,scope,entries:[]});
    await f.store().commit({version:1,revision:2,scope,entries:[]});
    f.slots.set(0,new TextEncoder().encode('corrupt'));
    await expect(f.store().read()).rejects.toThrow('cannot be opened');
    expect(f.ports.readSlot).toHaveBeenCalledWith(0);
    expect(f.pointer()).toBe('2');
  });
  it('does not advance the pointer after a failed slot write or stale revision',async()=>{
    const f=fixtureStorage();f.ports.writeSlot.mockRejectedValueOnce(new Error('Disk full'));
    await expect(f.store().commit({version:1,revision:1,scope,entries:[]})).rejects.toThrow('Disk full');
    expect(f.ports.writePointer).not.toHaveBeenCalled();
    await expect(f.store().commit({version:1,revision:2,scope,entries:[]})).rejects.toThrow('revision changed');
  });
});
