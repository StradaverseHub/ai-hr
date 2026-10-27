import {describe,expect,it} from 'vitest';
import {elapsedBetweenClockSnapshots,elapsedFromServerExchange} from '../mobile/lib/clock-elapsed';
const runtimeId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherRuntime='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const anchor={localOnly:true,source:'ios_continuous',runtimeId,bootId:null,elapsedBeforeNs:'9007199254741000',elapsedAfterNs:'9007199254741010',wallTimeMs:1000000};
const current={...anchor,elapsedBeforeNs:'9007199254742000',elapsedAfterNs:'9007199254742010',wallTimeMs:1000001};
describe('app-local elapsed time evidence',()=>{
  it('keeps exact interval bounds above JavaScript integer precision and ignores wall-clock changes',()=>{
    const result=elapsedBetweenClockSnapshots(anchor,current);
    expect(result).toEqual({status:'elapsed',minimumNs:'990',maximumNs:'1010',continuity:'same_process',verification:'not_verified'});
    expect(elapsedBetweenClockSnapshots(anchor,{...current,wallTimeMs:-1000000})).toEqual(result);
  });
  it('does not fabricate iOS boot continuity after a process restart even if its counter is larger',()=>{
    expect(elapsedBetweenClockSnapshots(anchor,{...current,runtimeId:otherRuntime})).toEqual({status:'unknown',reason:'continuity_unknown'});
  });
  it('can compare Android app events across process restart only when the local boot counter agrees',()=>{
    const a={...anchor,source:'android_elapsed_realtime',bootId:'12'},b={...current,source:'android_elapsed_realtime',bootId:'12',runtimeId:otherRuntime};
    expect(elapsedBetweenClockSnapshots(a,b)).toMatchObject({status:'elapsed',continuity:'same_boot'});
    expect(elapsedBetweenClockSnapshots(a,{...b,bootId:'13'})).toEqual({status:'unknown',reason:'boot_changed'});
    expect(elapsedBetweenClockSnapshots(a,{...b,bootId:null})).toEqual({status:'unknown',reason:'continuity_unknown'});
  });
  it('rejects contradictory boot markers even when a claimed runtime identifier matches',()=>{
    expect(elapsedBetweenClockSnapshots({...anchor,source:'android_elapsed_realtime',bootId:'12'},{...current,source:'android_elapsed_realtime',bootId:'13'})).toEqual({status:'unknown',reason:'boot_changed'});
  });
  it('keeps source changes and reversed/overlapping counters unverified',()=>{
    expect(elapsedBetweenClockSnapshots(anchor,{...current,source:'android_elapsed_realtime',bootId:'1'})).toEqual({status:'unknown',reason:'source_changed'});
    expect(elapsedBetweenClockSnapshots(anchor,{...current,elapsedBeforeNs:'1',elapsedAfterNs:'2'})).toEqual({status:'unknown',reason:'counter_discontinuity'});
  });
  it('refuses malformed, oversized and non-local snapshots rather than deriving a time',()=>{
    for(const changed of [{localOnly:false},{runtimeId:'bad'},{elapsedBeforeNs:'private invalid value'},{elapsedAfterNs:'18446744073709551616'},{bootId:'forbidden-ios-boot-id'},{verified:true}])
      expect(elapsedBetweenClockSnapshots({...anchor,...changed},current)).toEqual({status:'unknown',reason:'invalid_snapshot'});
  });
  it('returns only elapsed durations, without raw uptime, boot identity, runtime identity or wall time',()=>{
    const result=elapsedBetweenClockSnapshots(anchor,current),encoded=JSON.stringify(result);
    for(const field of ['bootId','runtimeId','wallTimeMs','elapsedBeforeNs','elapsedAfterNs',runtimeId,anchor.elapsedBeforeNs])expect(encoded).not.toContain(field);
  });
});


describe('server-exchange elapsed uncertainty',()=>{
 const request={...anchor,elapsedBeforeNs:'100',elapsedAfterNs:'110'};
 const response={...anchor,elapsedBeforeNs:'300',elapsedAfterNs:'310'};
 const event={...anchor,elapsedBeforeNs:'1000',elapsedAfterNs:'1010'};
 it('includes the full exchange uncertainty instead of treating receipt time as the server issuance instant',()=>{
  expect(elapsedFromServerExchange(request,response,event)).toEqual({status:'elapsed',minimumNs:'690',maximumNs:'910',continuity:'same_process',verification:'not_verified'});
  expect(elapsedBetweenClockSnapshots(response,event)).toMatchObject({minimumNs:'690',maximumNs:'710'});
 });
 it('does not use wall time or timezone-like wall changes to narrow an interval',()=>{
  expect(elapsedFromServerExchange({...request,wallTimeMs:5000000},{...response,wallTimeMs:-2000000},{...event,wallTimeMs:7000000})).toEqual(elapsedFromServerExchange(request,response,event));
 });
 it('keeps a restarted iPhone exchange unknown even with increasing counters',()=>{
  expect(elapsedFromServerExchange(request,response,{...event,runtimeId:otherRuntime})).toEqual({status:'unknown',reason:'continuity_unknown'});
 });
 it('allows Android continuity across process restart only with the same local boot marker',()=>{
  const a={...request,source:'android_elapsed_realtime',bootId:'12'},b={...response,source:'android_elapsed_realtime',bootId:'12'},c={...event,source:'android_elapsed_realtime',bootId:'12',runtimeId:otherRuntime};
  expect(elapsedFromServerExchange(a,b,c)).toMatchObject({status:'elapsed',minimumNs:'690',maximumNs:'910',continuity:'same_boot',verification:'not_verified'});
  expect(elapsedFromServerExchange(a,b,{...c,bootId:'13'})).toEqual({status:'unknown',reason:'boot_changed'});
 });
 it('refuses reversed exchanges, events before receipt and inconsistent sources',()=>{
  expect(elapsedFromServerExchange(response,request,event)).toMatchObject({status:'unknown',reason:'counter_discontinuity'});
  expect(elapsedFromServerExchange(request,event,response)).toMatchObject({status:'unknown',reason:'counter_discontinuity'});
  expect(elapsedFromServerExchange(request,{...response,source:'android_elapsed_realtime',bootId:'1'},event)).toMatchObject({status:'unknown',reason:'source_changed'});
 });
 it('exposes only unverified interval evidence, never native clock/boot snapshots',()=>{
  const result=elapsedFromServerExchange(request,response,event);
  expect(Object.keys(result).sort()).toEqual(['continuity','maximumNs','minimumNs','status','verification']);
  expect(JSON.stringify(result)).not.toContain(runtimeId);expect(result).not.toHaveProperty('wallTimeMs');expect(result).not.toHaveProperty('bootId');
 });
});
