/** Unit composition only: real AEAD/Auth leaves, captured SQL. No DB/SMTP/Linux assertion. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {vi} from 'vitest';
import {executeReportBrokerRequest,type ReportBrokerDependencies} from '../lib/internal-auth/report-broker';
import {reportBrokerRequest,reportBrokerResponse} from '../lib/internal-auth/report-broker-model';
import {openReportInspection,reportProofDigest} from '../lib/internal-auth/report-broker-proof';
import {encryptRecord} from '../lib/internal-auth/crypto';
import {parseCredential,type Credential} from '../lib/internal-auth/credential';
import type {AuthSql} from '../lib/internal-auth/record-store';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE} from '../lib/email-attachment';
const origin='https://broker.test',tenant=randomUUID(),owner=randomUUID(),recipient=randomUUID(),person=randomUUID(),ownerSubject=randomUUID(),recipientSubject=randomUUID();
const nonce={occurrenceId:randomUUID(),leaseToken:randomUUID()},now=Date.now(),stamp='a'.repeat(64);
const artifact={sha256:'b'.repeat(64),byteLength:37,contentType:XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE};
const identity=(subject:string,userId:string,personId:string|null)=>({issuer:origin+'/auth/'+tenant,subject,userId,personId,createdAt:new Date(now).toISOString().replace('Z','000Z')});
const target={tenantId:tenant,ownerUserId:owner,recipientUserId:recipient,recipientEmploymentId:randomUUID(),reportId:randomUUID(),reportVersion:1,scheduleId:randomUUID(),scheduleRevision:randomUUID(),reviewedDigest:'c'.repeat(64),locale:'en' as const,consentAfterSequence:0,policyAfterSequence:0,consentUpdatedAt:identity(ownerSubject,owner,null).createdAt,policyUpdatedAt:identity(ownerSubject,owner,null).createdAt,consentVerifiedAt:identity(ownerSubject,owner,null).createdAt,ownerGrants:[{role:'hr_admin',companyId:null}],recipientGrants:[{role:'hr_admin',companyId:null}],ownerPersonId:null,recipientPersonId:person,accessStamp:stamp,companyIds:[randomUUID()],subject:recipientSubject,email:'recipient@example.test'};
const baseContext={target,issuer:origin+'/auth/'+tenant,bindings:{owner:identity(ownerSubject,owner,null),recipient:identity(recipientSubject,recipient,person)},leaseUntil:new Date(now+120_000).toISOString().replace('Z','000Z')};
const credential=(subject:string,email:string):Credential=>({subject,tenantId:tenant,issuer:baseContext.issuer,organization:'fictional',username:subject===ownerSubject?'owner':'recipient',email,emailVerified:true,enabled:true,password:'synthetic-existing-hash',mustChange:false,version:randomUUID(),totpSecret:'synthetic-existing-factor',lastStep:1,recoveryHashes:[]});
const relay={config:{host:'smtp.example.test',port:465,security:'tls' as const,from:'sender@example.test',fromName:'Fictional',replyTo:'',auth:true,user:'relay'},password:'synthetic-active-secret'};
beforeEach(()=>{vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN',origin);vi.stubEnv('AUTH_SESSION_KEY','9'.repeat(64));});
afterEach(()=>vi.unstubAllEnvs());
function fixture(){
 const context=structuredClone(baseContext),credentials=new Map([[ownerSubject,credential(ownerSubject,'owner@example.test')],[recipientSubject,credential(recipientSubject,'recipient@example.test')]]),events:string[]=[];
 let revision='R'.repeat(43),active:typeof relay|null=relay,lockStatus='ready',startStatus='started',inTransaction=false,started=false,clock=now;
 const unsafe=vi.fn(async(statement:string,args:unknown[]=[])=>{
  if(!inTransaction)throw new Error('Escaped transaction');events.push(statement);
  if(statement.includes('current_user as name'))return [{name:'ai_hr_app',rolsuper:false,rolbypassrls:false,privileged:false}];
  if(statement.includes('internal_auth_report_lock_context'))return [{value:lockStatus==='ready'?{status:'ready',context}:{status:lockStatus}}];
  if(statement.includes('app.internal_auth_read')){
   const key=String(args[0]);expect(args[1]).toBe(true);const value=key==='email-state'?{revision,active,drafts:{operator:{password:'draft-secret'}}}:credentials.get(key.slice('credential:'.length));
   return value===undefined?[]:[{sealed:encryptRecord(value,key,null)}];
  }
  if(statement.includes('app.principal_by_identity'))return [{app_user_id:args[1]===ownerSubject?owner:recipient,tenant_id:tenant}];
  if(statement.includes('internal_auth_report_start')){started=true;return [{value:startStatus}];}
  return [];
 });
 const tx={unsafe} as unknown as AuthSql;
 const transaction:ReportBrokerDependencies['transaction']=async work=>{
  expect(inTransaction).toBe(false);events.push('BEGIN');inTransaction=true;const before=started;
  try{const result=await work(tx);events.push('COMMIT');return result;}
  catch(error){started=before;events.push('ROLLBACK');throw error;}
  finally{inTransaction=false;}
 };
 const authorizeArtifact=vi.fn(async()=>{expect(inTransaction).toBe(false);events.push('RENDERER');return {accessStamp:stamp,artifact};});
 const d:ReportBrokerDependencies={transaction,authorizeArtifact,now:()=>clock};
 return {context,credentials,events,unsafe,d,authorizeArtifact,get started(){return started;},set revision(value:string){revision=value;},set active(value:typeof relay|null){active=value;},set lockStatus(value:string){lockStatus=value;},set startStatus(value:string){startStatus=value;},set clock(value:number){clock=value;}};
}
async function inspected(f:ReturnType<typeof fixture>){const result=await executeReportBrokerRequest({phase:'inspect',...nonce},f.d);if(!('ok' in result)||!result.ok||result.phase!=='inspect')throw new Error('Expected inspection');return result;}
function request(proof:string){return {phase:'start' as const,...nonce,inspectionProof:proof,expectedArtifact:artifact};}
describe('closed model and canonical credential structural projection',()=>{
 it.each([{phase:'inspect',...nonce,email:target.email},{phase:'start',...nonce,inspectionProof:'A',expectedArtifact:artifact,verified:true},{phase:'status',occurrenceId:nonce.occurrenceId},{phase:'read',key:'email-state'}])('refuses extra authority/unknown variants: %j',value=>{expect(reportBrokerRequest.safeParse(value).success).toBe(false);});
 it('retains canonical nullable/false values and rejects malformed private records without inventing defaults',()=>{
  const original=credential(ownerSubject,'owner@example.test');expect(parseCredential(original)).toEqual(original);
  expect(parseCredential({...original,password:null,enabled:false,mustChange:true,totpSecret:null,lastStep:-1})).toMatchObject({password:null,enabled:false,lastStep:-1});
  for(const bad of [{...original,enabled:'true'},{...original,emailVerified:1},{...original,recoveryHashes:null},{...original,password:'x'.repeat(1025)},{...original,version:'not-version'},{...original,callerVerified:true}])expect(parseCredential(bad)).toBeNull();
 });
});
describe('inspection AEAD, role separation and committed one-attempt output',()=>{
 it('emits no relay/credential/private draft on inspect; authorizes before BEGIN then returns active relay only after COMMIT',async()=>{
  const f=fixture(),inspection=await inspected(f);expect(inspection).not.toHaveProperty('relay');expect(JSON.stringify(inspection)).not.toContain('synthetic');
  const proof=openReportInspection(inspection.inspectionProof,nonce,now)!;expect(proof.identities.owner.userId).toBe(owner);expect(proof.identities.recipient.userId).toBe(recipient);expect(proof.identities.owner.personId).toBeNull();
  f.events.length=0;const result=await executeReportBrokerRequest(request(inspection.inspectionProof),f.d);
  expect(result).toEqual({ok:true,phase:'start',target,artifact,relay});expect(f.events[0]).toBe('RENDERER');expect(f.events[1]).toBe('BEGIN');expect(f.events.at(-1)).toBe('COMMIT');expect(f.started).toBe(true);expect(JSON.stringify(result)).not.toContain('draft-secret');
  expect(f.events.filter(event=>event==='BEGIN')).toHaveLength(1);expect(f.events.some(event=>event.includes('set local statement_timeout'))).toBe(true);
 });
 it('refuses tamper, foreign nonce, wrong purpose/origin and expired proof before renderer/DB',async()=>{
  const f=fixture(),inspection=await inspected(f),claims=openReportInspection(inspection.inspectionProof,nonce,now)!;
  const bytes=Buffer.from(inspection.inspectionProof,'base64url');bytes[bytes.length-1]^=1;
  expect(openReportInspection(bytes.toString('base64url'),nonce,now)).toBeNull();expect(openReportInspection(inspection.inspectionProof,{...nonce,leaseToken:randomUUID()},now)).toBeNull();
  expect(openReportInspection(encryptRecord(claims,'credential:'+ownerSubject,now+60_000),nonce,now)).toBeNull();
  expect(openReportInspection(inspection.inspectionProof,nonce,now+60_000)).toBeNull();
  vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://other.test');expect(openReportInspection(inspection.inspectionProof,nonce,now)).toBeNull();vi.stubEnv('AUTH_PUBLIC_ORIGIN',origin);
  f.events.length=0;expect(await executeReportBrokerRequest(request(bytes.toString('base64url')),f.d)).toEqual({ok:false,reason:'notEligible'});expect(f.events).toEqual([]);
 });
 it.each(['ownerVersion','recipientVersion','ownerBinding','recipientBinding','target','relay','expiredDuringRenderer'] as const)('rolls back on inspected proof drift: %s',async kind=>{
  const f=fixture(),inspection=await inspected(f);f.events.length=0;
  if(kind==='ownerVersion')f.credentials.get(ownerSubject)!.version=randomUUID();
  if(kind==='recipientVersion')f.credentials.get(recipientSubject)!.version=randomUUID();
  if(kind==='ownerBinding')f.context.bindings.owner.createdAt=new Date(now+1).toISOString().replace('Z','000Z');
  if(kind==='recipientBinding')f.context.bindings.recipient.createdAt=new Date(now+1).toISOString().replace('Z','000Z');
  if(kind==='target')f.context.target.policyAfterSequence++;
  if(kind==='relay')f.revision='S'.repeat(43);
  if(kind==='expiredDuringRenderer')f.authorizeArtifact.mockImplementationOnce(async()=>{f.clock=now+60_000;return {accessStamp:stamp,artifact};});
  expect(await executeReportBrokerRequest(request(inspection.inspectionProof),f.d)).toEqual({ok:false,reason:'notEligible'});expect(f.started).toBe(false);expect(f.events).toContain('ROLLBACK');
 });
 it.each([{enabled:false},{mustChange:true},{totpSecret:null},{emailVerified:false},{email:'another@example.test'},{tenantId:randomUUID()},{subject:randomUUID()},{issuer:origin+'/auth/'+randomUUID()}])('uses canonical recipient active and exact identity checks: %j',async patch=>{
  const f=fixture(),inspection=await inspected(f);Object.assign(f.credentials.get(recipientSubject)!,patch);
  expect(await executeReportBrokerRequest(request(inspection.inspectionProof),f.d)).toEqual({ok:false,reason:'notEligible'});expect(f.started).toBe(false);
 });
 it('refuses a sender constraint mismatch before opening any final transaction',async()=>{
  const f=fixture(),inspection=await inspected(f);f.events.length=0;
  expect(await executeReportBrokerRequest({...request(inspection.inspectionProof),expectedArtifact:{...artifact,sha256:'d'.repeat(64)}},f.d)).toEqual({ok:false,reason:'generationFailed'});expect(f.events).toEqual(['RENDERER']);expect(f.started).toBe(false);
 });
 it.each(['busy','notEligible','unavailable'])('rolls back a final SQL refusal, never returning relay: %s',async status=>{
  const f=fixture(),inspection=await inspected(f);f.startStatus=status;f.events.length=0;
  expect(await executeReportBrokerRequest(request(inspection.inspectionProof),f.d)).toEqual({ok:false,reason:status});expect(f.started).toBe(false);expect(f.events.at(-1)).toBe('ROLLBACK');
 });
 it('never turns unexpected storage/tamper failure into empty success or a legacy result',async()=>{
  const f=fixture(),failure=new Error('synthetic private SQL detail');f.unsafe.mockImplementationOnce(async()=>{throw failure;});
  await expect(executeReportBrokerRequest({phase:'inspect',...nonce},f.d)).rejects.toBe(failure);expect(f.events).toContain('ROLLBACK');
 });
 it('status has only boolean availability and reads no target or credentials',async()=>{
  const f=fixture();f.unsafe.mockImplementation(async(statement:string,args:unknown[]=[])=>{
   f.events.push(statement);if(statement.includes('current_user as name'))return [{name:'ai_hr_app',rolsuper:false,rolbypassrls:false,privileged:false}];
   if(statement.includes('internal_auth_read')){expect(args).toEqual(['email-state',false]);return [{sealed:encryptRecord({revision:'initial',active:null,drafts:{someone:{password:'private'}}},'email-state',null)}];}return [];
  });
  expect(await executeReportBrokerRequest({phase:'status'},f.d)).toEqual({available:false});expect(f.events.some(value=>value.includes('report_lock_context'))).toBe(false);expect(reportBrokerResponse.safeParse({available:true,relay}).success).toBe(false);
 });
 it('canonical digest preserves ordered grants but ignores object property insertion order',()=>{
  expect(reportProofDigest({a:1,b:[1,2]})).toBe(reportProofDigest({b:[1,2],a:1}));expect(reportProofDigest([1,2])).not.toBe(reportProofDigest([2,1]));
 });
});
it('runtime composition graph has no singleton connection/session or legacy store/service import',()=>{
 const root=fileURLToPath(new URL('..',import.meta.url)),seen=new Set<string>();
 const visit=(file:string)=>{
  if(seen.has(file))return;seen.add(file);const source=readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  for(const node of tree.statements){
   if(!ts.isImportDeclaration(node)&&!ts.isExportDeclaration(node))continue;
   if(ts.isImportDeclaration(node)&&(node.importClause?.isTypeOnly||node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&!node.importClause.name&&node.importClause.namedBindings.elements.every(item=>item.isTypeOnly)))continue;
   if(ts.isExportDeclaration(node)&&node.isTypeOnly)continue;
   if(!node.moduleSpecifier||!ts.isStringLiteral(node.moduleSpecifier))continue;const name=node.moduleSpecifier.text;
   expect(name).not.toMatch(/db\/client|web-session|(?:^|\/)session$|^next|^postgres$|internal-auth\/(?:store|service)$|^\.\/(?:store|service)$/);
   if(name.startsWith('.'))visit(resolve(dirname(file),name+'.ts'));
  }
 };
 visit(root+'/lib/internal-auth/report-broker.ts');expect(seen.size).toBeGreaterThan(10);
});

it('one-shot entry closes its max1 pool before serializing any reply and retains independent deadlines',()=>{
 const source=readFileSync(resolve(process.cwd(),'deploy/identity-email/report-auth-broker.ts'),'utf8');
 const pool=source.indexOf('const pool=postgres('),closed=source.indexOf('await pool.end('),output=source.indexOf("process.stdout.write(body+");
 expect(pool).toBeGreaterThan(0);expect(closed).toBeGreaterThan(pool);expect(output).toBeGreaterThan(closed);
 expect(source.slice(pool,closed)).toContain('max:1');expect(source).toContain('setTimeout(()=>process.exit(1),5_000)');expect(source).toContain('setTimeout(()=>process.exit(1),34_000)');
 expect(source).toContain('REPORT_AUTH_BROKER_PEER_UID');expect(source).toContain('peer!==mail||peer===uid');
 expect(source).not.toContain('error.message');expect(source).not.toContain('console.log');
});
