/** Pure replay observations are never native profile or authorization tokens. */
import {expect,it} from 'vitest';
import {catalogueReplayMode,validateCatalogueReplayReceipt,catalogueReplayRoleHash} from '../.github/ci/notification-catalogue-replay.mjs';
const hashes={ownerSha256:'a'.repeat(64),contractSha256:'b'.repeat(64)};
const binding={candidate:'c'.repeat(40),controller:'d'.repeat(40),runId:'123',attempt:'1',unit:'db-0123456789abcdef',planFingerprint:'e'.repeat(64),batchFiles:['test/notification-final-catalogue-baseline.test.ts']};
function example(){return{version:1,kind:'NATIVE_CATALOGUE_REPLAY_PREREQUISITE_NOT_PROFILE',mode:'baseline',candidate:binding.candidate,controller:binding.controller,runId:binding.runId,attempt:binding.attempt,unit:binding.unit,planFingerprint:binding.planFingerprint,sourceHashes:hashes,
 session:{database:'postgres',pid:123,backendStart:'2026-11-08 00:00:00.123456+00',postmasterStart:'2026-11-08T00:00:00.123456Z',versionNumber:160015,versionText:'PostgreSQL 16.15 fixed fixture',session:'postgres',current:'postgres',loopback:true},roleCatalogSha256:'f'.repeat(64),allocation:null,objectsAbsent:true,quiescence:{sameCluster:true,ownedPresent:false,observerPid:124,observerStart:'2026-11-08 00:00:01.123456+00',observedAt:'2026-11-08 00:00:02.123456+00',postmasterStart:'2026-11-08T00:00:00.123456Z'},releaseAuthorized:false};}
it('recognizes only actual exact sole replay units, retaining ordinary mode and refusing mixed selection',()=>{
 expect(catalogueReplayMode(binding.batchFiles)).toBe('baseline');expect(catalogueReplayMode(['test/notification-final-catalogue-oid-shift.test.ts'])).toBe('oid-shift');
 expect(catalogueReplayMode(['test/ordinary.test.ts'])).toBeNull();expect(catalogueReplayMode(['test/notification-final-catalogue-baseline.test.ts.extra'])).toBeNull();
 expect(()=>catalogueReplayMode([...binding.batchFiles,'test/ordinary.test.ts'])).toThrow();expect(()=>catalogueReplayMode([...binding.batchFiles,...binding.batchFiles])).toThrow();
});
it('requires complete independently supplied source/cluster/role observations without treating them as permission',()=>{
 const row=example();expect(validateCatalogueReplayReceipt(row,binding,hashes)).toBe(row);
 for(const change of [{mode:'unknown'},{version:true},{unit:'db-other'},{planFingerprint:'0'.repeat(64)},{candidate:'0'.repeat(40)},{controller:'0'.repeat(40)},{runId:'124'},{attempt:'2'},{objectsAbsent:false},{releaseAuthorized:true},{extra:true},{allocation:{}}])expect(()=>validateCatalogueReplayReceipt({...row,...change},binding,hashes)).toThrow();
 for(const change of [{database:'ai_hr_dev'},{loopback:false},{current:'ai_hr_app'},{session:'ai_hr_owner'},{pid:0},{versionNumber:170000},{postmasterStart:'2026-11-08'},{unknown:true}])expect(()=>validateCatalogueReplayReceipt({...row,session:{...row.session,...change}},binding,hashes)).toThrow();
 expect(()=>validateCatalogueReplayReceipt(row,binding,{...hashes,ownerSha256:'0'.repeat(64)})).toThrow();expect(()=>validateCatalogueReplayReceipt(row,binding,{ownerSha256:hashes.ownerSha256})).toThrow();
});
it('requires all six distinct actual allocated object identities and complete native hashes only in shift mode',()=>{
 const facts={objects:[{oid:20000}],dependencies:[{objid:20000}],shared:[]};
 const selected={...binding,batchFiles:['test/notification-final-catalogue-oid-shift.test.ts']},allocation={namespaceOid:20000,enumOid:20001,enumArrayOid:20002,heapOid:20003,rowTypeOid:20004,rowArrayOid:20005,nativeRowsSha256:catalogueReplayRoleHash(facts.objects),dependenciesSha256:catalogueReplayRoleHash({dependencies:facts.dependencies,shared:facts.shared}),facts};
 const row={...example(),mode:'oid-shift',allocation};expect(validateCatalogueReplayReceipt(row,selected,hashes)).toBe(row);
 for(const change of [{namespaceOid:0},{heapOid:20000},{rowTypeOid:'20004'},{enumArrayOid:4294967296},{nativeRowsSha256:'claimed'},{dependenciesSha256:null},{extra:true}])expect(()=>validateCatalogueReplayReceipt({...row,allocation:{...allocation,...change}},selected,hashes)).toThrow();
 expect(()=>validateCatalogueReplayReceipt({...row,allocation:null},selected,hashes)).toThrow();expect(()=>validateCatalogueReplayReceipt(row,binding,hashes)).toThrow();
});
