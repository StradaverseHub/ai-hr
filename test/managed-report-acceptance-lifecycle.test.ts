/** Pure lifecycle models only: no child, /proc, DB, VM, cron or signal is touched. */
import {describe,it,expect} from 'vitest';
import {captureAcceptanceGroup,acceptanceProcessStat,acceptanceGroupMembers,stopOwnedAcceptanceGroup,bindAcceptanceActivationReceipt,bindAcceptanceActivationMarker,type AcceptanceProcessPin,type AcceptanceActivationBinding} from '../scripts/managed-report-acceptance-lifecycle';
const pin={pid:42,startTicks:'1000'};
const stat=(pid=42,start='1000',group=42,session=42)=>`${pid} (child with ) spaces) S 1 ${group} ${session} ${Array(15).fill('0').join(' ')} ${start} 0`;
describe('exact detached process-group ownership',()=>{
 it('captures kernel fields after the final comm delimiter',()=>{expect(acceptanceProcessStat(stat())).toEqual({...pin,group:42,session:42});expect(captureAcceptanceGroup(stat(),42)).toEqual(pin);});
 it('refuses a nonleader or a different spawned PID',()=>{expect(()=>captureAcceptanceGroup(stat(42,'1000',41),42)).toThrow();expect(()=>captureAcceptanceGroup(stat(),43)).toThrow();});
 it('keeps descendants after their leader closes',()=>{expect(acceptanceGroupMembers(pin,[{pid:43,startTicks:'1001',group:42,session:42}])).toEqual([{pid:43,startTicks:'1001'}]);});
 it('refuses PID reuse, foreign sessions and members older than the captured lifetime',()=>{for(const item of [{...pin,startTicks:'2000',group:42,session:42},{pid:43,startTicks:'1001',group:42,session:43},{pid:43,startTicks:'999',group:42,session:42}])expect(()=>acceptanceGroupMembers(pin,[item])).toThrow();});
 it('refuses an unbounded inventory or malformed kernel stat',()=>{expect(()=>acceptanceGroupMembers(pin,Array(10001).fill({...pin,group:42,session:42}))).toThrow();expect(()=>acceptanceProcessStat('42 invalid')).toThrow();});
});
function io(sequence:readonly (readonly AcceptanceProcessPin[])[],signalError?:string){let now=0,index=0;const signals:string[]=[];return {signals,io:{members:async()=>sequence[Math.min(index++,sequence.length-1)],signal:(value:'SIGTERM'|'SIGKILL')=>{signals.push(value);if(signalError)throw Object.assign(new Error('signal refused'),{code:signalError});},now:()=>now,delay:async(ms:number)=>{now+=ms;}}};}
describe('bounded absence before cleanup can release its lock',()=>{
 it('does not signal an already absent group',async()=>{const test=io([[]]);await stopOwnedAcceptanceGroup(test.io);expect(test.signals).toEqual([]);});
 it('waits for descendants to disappear after TERM',async()=>{const test=io([[pin],[pin],[]]);await stopOwnedAcceptanceGroup(test.io);expect(test.signals).toEqual(['SIGTERM']);});
 it('escalates then requires independently observed absence',async()=>{let alive=true,now=0;const signals:string[]=[];await stopOwnedAcceptanceGroup({members:async()=>alive?[pin]:[],signal:s=>{signals.push(s);if(s==='SIGKILL')alive=false;},now:()=>now,delay:async ms=>{now+=ms;}});expect(signals).toEqual(['SIGTERM','SIGKILL']);expect(now).toBe(2000);});
 it('propagates EPERM and never treats it as disappearance',async()=>{const test=io([[pin]],'EPERM');await expect(stopOwnedAcceptanceGroup(test.io)).rejects.toMatchObject({code:'EPERM'});expect(test.signals).toEqual(['SIGTERM']);});
 it('allows ESRCH only when the separate inventory becomes absent',async()=>{const test=io([[pin],[]],'ESRCH');await stopOwnedAcceptanceGroup(test.io);expect(test.signals).toEqual(['SIGTERM']);});
 it('refuses remaining members after a bounded KILL wait even on ESRCH',async()=>{const test=io([[pin]],'ESRCH');await expect(stopOwnedAcceptanceGroup(test.io)).rejects.toThrow('remains after SIGKILL');expect(test.signals).toEqual(['SIGTERM','SIGKILL']);expect(test.io.now()).toBe(7000);});
});
const sha='a'.repeat(64),id='038ab3bb-05bc-4535-a604-c2a4c4ee76ce';
const expected:AcceptanceActivationBinding={inventorySha256:sha,node20Path:'/opt/node20/bin/node',node20Sha256:sha,marker:{version:1,purpose:'aihr-internal-report-dispatch',runnerUser:'aihrweb',runnerGroup:'aihrweb',runnerUid:1001,runnerGid:1001,candidateRoot:'/opt/ai-hr',sourcePins:{'lib/employee-master-dispatch.ts':sha,'scripts/provision-runner.ts':sha},runtimeSha256:sha,instanceSha256:sha,cronSha256:sha}};
const marker={...expected.marker,state:'paused' as const,installationId:id};
const receipt={version:1,installationId:id,inventorySha256:sha,legacyUser:'aihrweb',legacyUid:1001,node20Path:expected.node20Path,node20Sha256:sha,marker,beforeMarker:null,beforeCron:null};
describe('partial activation ownership without a fabricated rollback receipt',()=>{
 it('binds an actual canonical receipt to the pre-activation source/runtime/instance inventory',()=>{expect(bindAcceptanceActivationReceipt(receipt,id,expected)).toEqual(marker);});
 it.each([{installationId:'1053a9da-98c9-407f-9bdd-a5d2c23745dd'},{inventorySha256:'b'.repeat(64)},{node20Path:'/other/node'},{legacyUid:1002},{beforeCron:'existing'},{unexpected:true},{marker:{...marker,instanceSha256:'b'.repeat(64)}},{marker:{...marker,state:'active'}}])('refuses changed or unknown receipt authority %j',change=>{expect(()=>bindAcceptanceActivationReceipt({...receipt,...change},id,expected)).toThrow();});
 it('compares strict canonical marker meaning independently of object insertion order',()=>{const reordered=Object.fromEntries(Object.entries(marker).reverse()) as typeof marker;expect(bindAcceptanceActivationMarker({...marker,state:'active'},reordered)).toEqual({...marker,state:'active'});expect(()=>bindAcceptanceActivationMarker({...reordered,unknown:true},marker)).toThrow();});
 it('accepts either paused or active state only on the exact owned installation',()=>{expect(bindAcceptanceActivationMarker(marker,marker)).toEqual(marker);expect(bindAcceptanceActivationMarker({...marker,state:'active'},marker)).toEqual({...marker,state:'active'});expect(()=>bindAcceptanceActivationMarker({...marker,sourcePins:{...marker.sourcePins,'scripts/provision-runner.ts':'b'.repeat(64)}},marker)).toThrow();});
});
