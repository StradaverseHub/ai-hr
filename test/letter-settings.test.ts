import {afterAll,beforeEach,it,expect,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import type {SessionContext} from '../db/client';
import {saveLetterPolicy,getLetterPolicy,listLetterPolicies,saveLetterPermission,readLetterPermissions,addLetterAsset,listLetterSignatories,letterCompanyAccess} from '../core/letters';
import type {LetterPolicy} from '../lib/letter-workflow';
import type {NotificationEmailTransport} from '../core/notification-email-delivery';
import type {NotificationEmailStatus} from '../lib/notification-email-model';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,signerId:string;
const relay=(status:NotificationEmailStatus|null):NotificationEmailTransport=>async<T>()=>status as unknown as T;
function policy():LetterPolicy{return {version:1,stages:[{key:'signatory',label:'Authorised signatory',userIds:[signerId],allowDelegation:false}],signatoryUserId:signerId,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:false};}
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','https://letters.fixture.test/callback');await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');ctx=await entitledCtx(b);
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional settings signatory',primaryEmail:'settings-signer@fixture.test'}).returning();signerId=await createAppUser(b.tenantId,person.id,'hr_admin');
});afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
it('rejects stale configuration saves and pages only the latest immutable policy per category',async()=>{
 const first=await saveLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation',enabled:true,policy:policy(),expectedOrdinal:0});
 await expect(saveLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation',enabled:true,policy:{...policy(),retentionDays:730},expectedOrdinal:0})).rejects.toMatchObject({code:'stale'});
 expect(await getLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation'})).toMatchObject({id:first.id,ordinal:1,policy:{retentionDays:365}});
 const next=await saveLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation',enabled:true,policy:{...policy(),retentionDays:730},expectedOrdinal:1});await saveLetterPolicy(ctx,{companyId:b.companyId,category:'alpha',enabled:false,policy:policy(),expectedOrdinal:0});
 const page=await listLetterPolicies(ctx,{companyId:b.companyId,limit:1});expect(page).toMatchObject({rows:[{category:'alpha'}],nextCursor:'alpha'});expect(await listLetterPolicies(ctx,{companyId:b.companyId,limit:1,cursor:page.nextCursor!})).toMatchObject({rows:[{id:next.id,ordinal:2}],nextCursor:null});expect((await owner.db.select().from(s.letterPolicyVersion).where(eq(s.letterPolicyVersion.id,first.id)))[0].policy.retentionDays).toBe(365);
});
it('does not turn email on from SMTP readiness alone or from an unavailable private sender',async()=>{
 const input={companyId:b.companyId,category:'confirmation',enabled:true,policy:{...policy(),emailNotifications:true},expectedOrdinal:0};
 for(const status of [null,{version:1 as const,ready:false,letters:true},{version:1 as const,ready:true}])await expect(saveLetterPolicy(ctx,input,{transport:relay(status)})).rejects.toMatchObject({code:'configuration',detail:'emailTransport'});
 expect(await owner.db.select().from(s.letterPolicyVersion)).toHaveLength(0);await saveLetterPolicy(ctx,input,{transport:relay({version:1,ready:true,letters:true})});expect(await getLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation'})).toMatchObject({policy:{emailNotifications:true}});
});
it('uses the displayed grant override as a witness rather than silently overwriting a later change',async()=>{
 const input={companyId:b.companyId,role:'employee',capability:'issue' as const};await saveLetterPermission(ctx,{...input,allowed:false,expectedAllowed:null});await expect(saveLetterPermission(ctx,{...input,allowed:true,expectedAllowed:null})).rejects.toMatchObject({code:'stale'});expect(await readLetterPermissions(ctx,b.companyId)).toContainEqual({role:'employee',capability:'issue',allowed:false});await saveLetterPermission(ctx,{...input,allowed:true,expectedAllowed:false});expect(await readLetterPermissions(ctx,b.companyId)).toContainEqual({role:'employee',capability:'issue',allowed:true});
});
it('rejects a fake PNG before preserving an immutable asset',async()=>{
 const fake=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(fake);fake.writeUInt32BE(1,16);fake.writeUInt32BE(1,20);await expect(addLetterAsset(ctx,{companyId:b.companyId,kind:'letterhead',name:'Not an image',content:fake})).rejects.toMatchObject({code:'invalid',detail:'png'});expect(await owner.db.select().from(s.letterAsset)).toHaveLength(0);
});
it('lets a settings-only administrator choose eligible names without granting letter-content access',async()=>{
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional configuration administrator',primaryEmail:'configuration-admin@fixture.test'}).returning(),userId=await createAppUser(b.tenantId,person.id,'employee');await saveLetterPermission(ctx,{companyId:b.companyId,role:'employee',capability:'settings',allowed:true});const editor={...ctx,userId,personId:person.id,roles:['employee']};expect(await letterCompanyAccess(editor)).toContainEqual(expect.objectContaining({id:b.companyId,settings:true,read:false}));const choices=await listLetterSignatories(editor,{companyId:b.companyId,limit:25});expect(choices.rows).toContainEqual({id:signerId,name:'Fictional settings signatory'});expect(choices.rows.every(row=>Object.keys(row).sort().join(',')==='id,name')).toBe(true);
});
