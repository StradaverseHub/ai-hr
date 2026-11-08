/** Offline comparison mechanics only. Authentication of BOTH run/job/artifact
 * digests is an independent controller/API duty; this returns no permission. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {normalizeNotificationCanonicalInventory,nativeInventoryCanonical,nativeInventoryLimits} from './canonical-inventory';
import {inventoryHash,assertInventoryLedger,replayOwnerPaths} from './canonical-inventory-evidence';
import {validateFullCiRoleReceipt} from '../../../.github/ci/run-unit.mjs';
import {DB_BATCH_FILES} from '../../../.github/ci/manifest.mjs';
import {FULL_CI_ROLE_MODE,FULL_CI_ROLE_SOURCE,fullCiRoleReceiptBasename} from '../../../scripts/lib/discard-premigration';
import {catalogueReplayRoleHash} from '../../../.github/ci/notification-catalogue-replay.mjs';
import {notificationCatalogueSessionSchema} from './catalogue-session';
const object=z.record(z.string(),z.unknown());
const rowSchema=object.refine(value=>typeof value.oid==='string'&&value.oid.length>0,'Native signature required');
const nativeSchema=z.object({signature:z.string().min(1),raw:object}).passthrough();
/** Preserve ALL fields, including opaque default locations/OIDs/datum bytes. */
export function compareCanonicalFunctionRows(left:unknown,right:unknown,leftNative:unknown,rightNative:unknown){
 const a=z.array(rowSchema).min(1).max(100000).parse(left),b=z.array(rowSchema).min(1).max(100000).parse(right);
 const ar=z.array(nativeSchema).min(1).max(100000).parse(leftNative),br=z.array(nativeSchema).min(1).max(100000).parse(rightNative);
 const keyed=(rows:readonly Record<string,unknown>[],key:string)=>{const result=new Map<string,Record<string,unknown>>();for(const row of rows){const id=row[key];assert(typeof id==='string'&&id.length>0&&!result.has(id),'Duplicate or invalid canonical signature');result.set(id,row);}return result;};
 const am=keyed(a,'oid'),bm=keyed(b,'oid'),anm=keyed(ar,'signature'),bnm=keyed(br,'signature');
 const names=[...am.keys()].sort();assert.deepEqual(names,[...bm.keys()].sort(),'Bidirectional helper membership differs');assert.deepEqual(names,[...anm.keys()].sort());assert.deepEqual(names,[...bnm.keys()].sort());
 let shiftedFunctions=0,defaultFunctions=0;
 for(const name of names){
  const x=am.get(name)!,y=bm.get(name)!;
  assert.deepEqual(Object.keys(x).sort(),Object.keys(y).sort(),'Complete native function field membership differs');
  assert(Object.hasOwn(x,'proargdefaults')&&Object.hasOwn(x,'prosrc')&&Object.hasOwn(x,'prosqlbody')&&Object.hasOwn(x,'probin'),'Opaque native fields must never vanish');
  assert.equal(x.prosqlbody,null,'Unreviewed native body AST');assert.equal(x.probin,null,'Unreviewed external implementation');
  assert.equal(nativeInventoryCanonical(x),nativeInventoryCanonical(y),'Complete native ABI/owner/ACL/body/default metadata differs');
  const l=object.parse(anm.get(name)!.raw),r=object.parse(bnm.get(name)!.raw);
  assert(Object.hasOwn(l,'oid')&&Object.hasOwn(r,'oid'));assert(typeof l.oid==='string'||typeof l.oid==='number');assert(typeof r.oid==='string'||typeof r.oid==='number');
  if(String(l.oid)!==String(r.oid))shiftedFunctions++;
  assert.equal(nativeInventoryCanonical(l.proargdefaults),nativeInventoryCanonical(r.proargdefaults),'Exact raw default bytes differ');
  if(l.proargdefaults!==null)defaultFunctions++;
 }
 assert(shiftedFunctions>0,'Allocation replay inconclusive: canonical object OIDs did not change');
 return{functionCount:names.length,defaultFunctions,shiftedFunctions};
}
const frameKeys=['variation','source','controller','run','attempt','unit','planFingerprint'];
const decode=(bytes:Buffer)=>{
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=nativeInventoryLimits.fileBytes,'Complete bounded retained member required');
 const value:unknown=JSON.parse(bytes.toString('utf8'));assert(Buffer.from(nativeInventoryCanonical(value)+'\n').equals(bytes),'Noncanonical, duplicate-key or non-UTF8 retained bytes');return object.parse(value);
};
const withoutFrame=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([key])=>!frameKeys.includes(key)));
const sourceRecord=z.object({path:z.string().min(1),mode:z.enum(['100644','100755']),blob:z.string().regex(/^[a-f0-9]{40}$/),bytes:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/),text:z.string()}).passthrough();
function verifySource(source:Record<string,unknown>){
 const journal=sourceRecord.parse(source.journal),migrations=z.array(sourceRecord).min(1).max(10000).parse(source.migrations),unlisted=z.array(sourceRecord).max(10000).parse(source.unlistedSql);
 const prerequisites=z.record(z.string(),sourceRecord).parse(source.prerequisites),replay=z.record(z.string(),sourceRecord).parse(source.replayOwners);
 assert.deepEqual(Object.keys(prerequisites).sort(),Object.keys(FULL_CI_ROLE_SOURCE).sort());
 assert.deepEqual(Object.keys(replay).sort(),Object.keys(replayOwnerPaths).sort());
 for(const [name,path]of Object.entries(FULL_CI_ROLE_SOURCE))assert.equal(prerequisites[name].path,path);
 for(const [name,path]of Object.entries(replayOwnerPaths))assert.equal(replay[name].path,path);
 for(const row of [journal,...migrations,...unlisted,...Object.values(prerequisites),...Object.values(replay)]){
  const bytes=Buffer.from(row.text);assert.equal(bytes.toString('utf8'),row.text);assert.equal(bytes.length,row.bytes);assert.equal(inventoryHash(bytes),row.sha256);
  assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),row.blob,'Immutable source blob identity differs');
 }
 const parsed=z.object({version:z.literal('7'),dialect:z.literal('postgresql'),entries:z.array(z.object({idx:z.number().int().safe().nonnegative(),version:z.literal('7'),when:z.number().int().safe().positive(),tag:z.string().regex(/^[0-9]{4}_[a-z0-9_]+$/),breakpoints:z.boolean()}).strict()).min(1).max(10000)}).strict().parse(JSON.parse(journal.text));
 assert.equal(journal.path,'db/migrations/meta/_journal.json');assert.equal(parsed.entries.length,migrations.length);
 assert.equal(new Set(parsed.entries.map(row=>row.idx)).size,parsed.entries.length);assert.equal(new Set(parsed.entries.map(row=>row.tag)).size,parsed.entries.length);
 const originalMigrations=z.array(object).parse(source.migrations);
 for(const [index,row]of migrations.entries()){
  const entry=parsed.entries[index],original=originalMigrations[index];
  assert.equal(row.path,'db/migrations/'+entry.tag+'.sql');assert.equal(original.position,index);
  for(const key of ['idx','version','when','tag','breakpoints']as const)assert.equal(original[key],entry[key]);
 }
 assert.equal(source.unlistedSqlDisposition,'SOURCE_ONLY_NOT_IN_JOURNAL_NOT_CLAIMED_APPLIED');
 const paths=migrations.map(row=>row.path);assert.equal(new Set(unlisted.map(row=>row.path)).size,unlisted.length);for(const row of unlisted)assert(!paths.includes(row.path));
 for(const name of ['helper','wrapper','orchestration'])assert(prerequisites[name],'Complete original prerequisite sources required');
 for(const name of ['owner','contract','globalSetup','controllerReceipt','capture','comparison','query','normalizer','evidence'])assert(replay[name],'Complete replay source owner required');
 return{prerequisites,replay};
}
export type CanonicalReplayMembers={source:Buffer;raw:Buffer;normalized:Buffer;report:Buffer;prerequisite:Buffer};
/** No caller-supplied "accepted" field is recognized. Original complete native
 * members and their hashes remain required even when all compared rows agree. */
export function compareCanonicalReplayMembers(baseline:CanonicalReplayMembers,shift:CanonicalReplayMembers,expected:{candidate:string;controller:string}){
 assert(/^[a-f0-9]{40}$/.test(expected.candidate)&&/^[a-f0-9]{40}$/.test(expected.controller));
 const parse=(input:CanonicalReplayMembers,mode:'baseline'|'oid-shift')=>{
  const source=decode(input.source),raw=decode(input.raw),normalized=decode(input.normalized),report=decode(input.report);
  assert.deepEqual(Object.keys(source).sort(),[...frameKeys,'journal','migrations','unlistedSql','unlistedSqlDisposition','prerequisites','replayOwners'].sort());
  assert.deepEqual(Object.keys(raw).sort(),[...frameKeys,'session','roles','ledger','inventory'].sort());
  const owners=verifySource(source);
  for(const value of [source,raw,normalized,report]){
   assert.equal(value.variation,mode);assert.equal(value.source,expected.candidate);assert.equal(value.controller,expected.controller);
   for(const key of frameKeys)assert.equal(value[key],source[key],'Member frame binding differs');
  }
  assert.equal(report.kind,'NATIVE_CANONICAL_INVENTORY_DIAGNOSTIC_NOT_RELEASE');assert.equal(report.complete,true);assert.equal(report.socketClosed,true);assert.equal(report.expectedProfileAuthorized,false);assert.equal(report.releaseAuthorized,false);
  const members=z.array(z.object({file:z.string(),bytes:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).length(3).parse(report.members);
  const names=['notification-canonical-source.json','notification-canonical-raw.json','notification-canonical-normalized.json'];assert.deepEqual(members.map(row=>row.file).sort(),[...names].sort());
  for(const [index,bytes]of [input.source,input.raw,input.normalized].entries()){const row=members.find(member=>member.file===names[index])!;assert.equal(row.bytes,bytes.length);assert.equal(row.sha256,inventoryHash(bytes));}
  const migrations=z.array(z.object({sha256:z.string(),when:z.number()}).passthrough()).min(1).parse(source.migrations);assertInventoryLedger({migrations},raw.ledger);
  const actual=normalizeNotificationCanonicalInventory(raw.inventory);assert.equal(actual.unknownColumns.length,0,'Unknown native columns remain unapproved');
  assert.equal(nativeInventoryCanonical(withoutFrame(normalized)),nativeInventoryCanonical(actual),'Normalized member differs from complete retained raw facts');
  const inventory=object.parse(raw.inventory),functions=z.array(nativeSchema).parse(inventory.functions),session=notificationCatalogueSessionSchema.parse(raw.session),prerequisite=object.parse(report.prerequisites);
  const frame=z.object({source:z.string(),controller:z.string(),run:z.string().regex(/^[1-9][0-9]*$/),attempt:z.literal('1'),unit:z.string().regex(/^db-[a-f0-9]{16}$/),planFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough().parse(source);
  const file=mode==='baseline'?'test/notification-final-catalogue-baseline.test.ts':'test/notification-final-catalogue-oid-shift.test.ts';
  const binding={mode:FULL_CI_ROLE_MODE,candidate:frame.source,controller:frame.controller,runId:frame.run,attempt:frame.attempt,unit:frame.unit,offset:0,planFingerprint:frame.planFingerprint,batchSize:DB_BATCH_FILES,batchFiles:[file]};
  assert(Buffer.isBuffer(input.prerequisite)&&input.prerequisite.length>0&&input.prerequisite.length<=32768);
  const receipt:unknown=JSON.parse(input.prerequisite.toString('utf8'));assert(Buffer.from(JSON.stringify(receipt,null,2)+'\n').equals(input.prerequisite),'Original prerequisite wire bytes differ');
  assert.equal(prerequisite.file,fullCiRoleReceiptBasename(frame.unit,0));assert.equal(prerequisite.sha256,inventoryHash(input.prerequisite));assert.equal(nativeInventoryCanonical(receipt),nativeInventoryCanonical(prerequisite.raw));
  const actualProof=validateFullCiRoleReceipt(receipt,binding,{helperSha256:owners.prerequisites.helper.sha256,wrapperSha256:owners.prerequisites.wrapper.sha256,orchestrationSha256:owners.prerequisites.orchestration.sha256},{ownerSha256:owners.replay.owner.sha256,contractSha256:owners.replay.contract.sha256});
  assert.equal(nativeInventoryCanonical(actualProof),nativeInventoryCanonical(prerequisite.proof),'Canonical prerequisite proof differs from original receipt');
  const proof=object.parse(actualProof),replay=object.parse(proof.catalogueReplay),cluster=object.parse(replay.session);
  const original=object.parse(receipt),fixture=object.parse(original.fixture),expectedRoles={roles:fixture.roles,edges:fixture.edges};
  assert.equal(nativeInventoryCanonical(raw.roles),nativeInventoryCanonical(expectedRoles),'Captured native roles differ from the original prerequisite fixture');
  assert.equal(catalogueReplayRoleHash(raw.roles),replay.roleCatalogSha256,'Captured native role hash differs from the original prerequisite');
  assert.equal(replay.mode,mode);assert.equal(session.postmasterStart,cluster.postmasterStart);assert.equal(session.version,cluster.versionNumber);assert.equal(session.versionText,cluster.versionText);assert.equal(session.isolation,'repeatable read');assert.equal(session.readOnly,'on');
  for(const key of ['session','roles','ledger'])assert.equal(nativeInventoryCanonical(report[key]),nativeInventoryCanonical(raw[key]),'Report/native fact binding differs');
  return{source,raw,normalized:actual,functions};
 };
 const a=parse(baseline,'baseline'),b=parse(shift,'oid-shift');
 assert(a.source.unit!==b.source.unit,'Distinct independently scheduled unit identities required');
 assert.equal(nativeInventoryCanonical(withoutFrame(a.source)),nativeInventoryCanonical(withoutFrame(b.source)),'Complete ordered source/journal/prerequisite bytes differ');
 const result=compareCanonicalFunctionRows(a.normalized.normalized,b.normalized.normalized,a.functions,b.functions);
 return{kind:'COMPLETE_RAW_CATALOGUE_REPLAY_COMPARISON_NOT_PROFILE',...result,exactRawDefaultsEqual:true,expectedProfileAuthorized:false,releaseAuthorized:false,authentication:'Independent actual run/job/artifact API verification required; this function grants none'};
}
