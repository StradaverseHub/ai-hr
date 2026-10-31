/** The shared avatar read remains independent of Workforce, but cannot trust revoked/forged roles. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {roleAssignment,personPhoto} from '../db/schema';
import {hireEmployee} from '../core/org';
import {revokeRole} from '../core/admin';
import {getPersonPhoto,hasPersonPhoto,employmentPhotoIds,setPersonPhoto} from '../core/person-photo';
import {workforceRecord} from '../core/workforce-record';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
const session=vi.hoisted(()=>({ctx:null as SessionContext|null}));
vi.mock('../lib/session',()=>({getSession:async()=>{if(!session.ctx)throw Error('Actual fixture principal missing');return session.ctx;}}));
import {GET} from '../app/(app)/personnel/photo/[personId]/route';

let b:Base;
const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();session.ctx=null;
 await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);
});
afterAll(async()=>{try{await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);}finally{await closeAll();}});
async function hired(label:string,role:'employee'|'hr_admin'='employee'){
 const subject=await hireEmployee(admin(),{person:{fullName:label,primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,subject.personId,role);
 return {...subject,ctx:{tenantId:b.tenantId,userId,personId:subject.personId,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext};
}
async function photo(){
 const subject=await hired('Fictional photo owner');
 await setPersonPhoto(admin(),{personId:subject.personId,content:bytes,fileName:'fictional.png',mimeType:'image/png',sizeBytes:bytes.length});
 return subject;
}
async function request(ctx:SessionContext,personId:string,etag?:string){
 session.ctx=ctx;
 return GET(new Request(`http://localhost/personnel/photo/${personId}`,{headers:etag?{'If-None-Match':etag}:{}}),{params:Promise.resolve({personId})});
}
async function denyWorkforceView(){
 await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"canonical-photo-independent-purpose-fixture","operation":"read"}]'::jsonb where id='workforce.view'`);
 const ctx=admin(),before=await withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx));
 const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId:b.adminUserId,capabilityId:'workforce.view',companyId:b.companyId,effect:'deny' as const}};
 const preview=await previewAccessConfiguration(ctx,edit,accessConfigurationStore);
 await saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}

describe('current-principal and independent-purpose canonical photo consumers',()=>{
 it('preserves the independent current HR avatar course when Workforce view is explicitly denied',async()=>{
  const subject=await photo();
  expect((await getPersonPhoto(admin(),subject.personId))?.content).toEqual(bytes);
  await denyWorkforceView();
  expect(await workforceRecord(admin(),subject.employmentId)).toBeNull();
  // The canonical shared /me/directory avatar is not a new general Workforce byte grant.
  expect((await getPersonPhoto(admin(),subject.personId))?.content).toEqual(bytes);
  expect(await hasPersonPhoto(admin(),subject.personId)).toBe(true);
  expect(await employmentPhotoIds(admin(),[subject.employmentId])).toEqual(new Map([[subject.employmentId,subject.personId]]));
  const response=await request(admin(),subject.personId);expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
 });
 it('refuses another employee claiming HR roles at the shared byte, presence and bulk read seams',async()=>{
  const subject=await photo(),stranger=await hired('Fictional unrelated photo reader');
  expect(await getPersonPhoto(stranger.ctx,subject.personId)).toBeNull();
  expect((await getPersonPhoto(admin(),subject.personId))?.content).toEqual(bytes);
  const forged={...stranger.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  const observed={photo:await getPersonPhoto(forged,subject.personId),present:await hasPersonPhoto(forged,subject.personId),
   bulk:[...await employmentPhotoIds(forged,[subject.employmentId])],
   raw:await withTenant(forged,tx=>tx.select({id:personPhoto.id}).from(personPhoto).where(eq(personPhoto.personId,subject.personId))),
   routeStatus:(await request(forged,subject.personId)).status};
  expect(observed).toEqual({photo:null,present:false,bulk:[],raw:[],routeStatus:404});
 });
 it('refuses an actual cached HR role after its real grant is removed, including a matching held ETag',async()=>{
  const subject=await photo(),reviewer=await hired('Fictional revoked photo reader','hr_admin');
  const response=await request(reviewer.ctx,subject.personId);expect(response.status).toBe(200);
  const etag=response.headers.get('ETag');expect(etag).toBeTruthy();
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  const [grant]=await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(and(eq(roleAssignment.appUserId,reviewer.ctx.userId!),eq(roleAssignment.role,'hr_admin')));
  await revokeRole(admin(),{roleAssignmentId:grant.id});
  expect((await getPersonPhoto(admin(),subject.personId))?.content).toEqual(bytes);
  // Same session object and actual route, never a mocked photo owner or refreshed session.
  expect((await request(reviewer.ctx,subject.personId,etag!)).status).toBe(404);
  expect(await hasPersonPhoto(reviewer.ctx,subject.personId)).toBe(false);
  expect(await employmentPhotoIds(reviewer.ctx,[subject.employmentId])).toEqual(new Map());
 });
 it('applies hidden-own-photo policy using actual login ownership rather than a substituted JS Person',async()=>{
  const subject=await photo();expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(bytes);
  const fields=Object.fromEntries(essVisibleFields().map(field=>[field.id,field.id==='profile.personal_details.photo'?'hide':'viewOnly']));
  await saveProfileVisibilityPolicy(admin(),{policy:{version:3,fields,primaryOnly:[]},withdrawnReason:'Fictional hidden own photo acceptance'});
  expect(await getPersonPhoto(subject.ctx,subject.personId)).toBeNull();
  expect(await getPersonPhoto({...subject.ctx,personId:randomUUID()},subject.personId)).toBeNull();
  expect(await hasPersonPhoto({...subject.ctx,personId:randomUUID()},subject.personId)).toBe(false);
  expect(await employmentPhotoIds({...subject.ctx,personId:randomUUID()},[subject.employmentId])).toEqual(new Map());
  expect((await request({...subject.ctx,personId:randomUUID()},subject.personId)).status).toBe(404);
  expect((await getPersonPhoto(admin(),subject.personId))?.content).toEqual(bytes);
 });
});
