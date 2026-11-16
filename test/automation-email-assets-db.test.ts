import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {saveAutomationEmailTemplate,listAutomationEmailTemplates,uploadAutomationEmailAsset,downloadAutomationEmailAsset,type AutomationEmailTemplate} from '../packs/automation/service';
let base:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'lifecycle','active');admin=adminCtx(base);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${base.tenantId}::uuid,'Fictional email author',${randomUUID()+'@assets.example.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${base.tenantId}::uuid and id=${admin.userId}::uuid`);
 admin={...admin,personId:person.id};
});
const draft=():AutomationEmailTemplate=>({id:randomUUID(),module:'probation',name:'Fictional email',active:true,subject:'Information',body:'Please read the attached information.',cc:[]});
describe('Native shared email asset receipts',()=>{
 it('owns bytes by actual tenant/template/revision, preserves versions and rejects forged receipts',async()=>{
  const template=draft();await saveAutomationEmailTemplate(admin,{template,retired:false,expectedRevision:0,reason:'Create fictional template'});
  const asset=await uploadAutomationEmailAsset(admin,{templateId:template.id,module:'probation',revision:1,kind:'file',name:'information.txt',content:Buffer.from('Fictional information only.\n')});
  expect(asset).toMatchObject({kind:'file',name:'information.txt',mimeType:'text/plain',size:28,by:'Fictional email author'});
  const bytes=await downloadAutomationEmailAsset(admin,asset.id);expect(bytes.content.toString()).toBe('Fictional information only.\n');
  expect(await uploadAutomationEmailAsset(admin,{templateId:template.id,module:'probation',revision:1,kind:'file',name:'information.txt',content:Buffer.from('Fictional information only.\n')})).toEqual(asset);
  await saveAutomationEmailTemplate(admin,{template:{...template,assets:[asset]},retired:false,expectedRevision:1,reason:'Include actual file'});
  expect((await listAutomationEmailTemplates(admin))[0].template.assets).toEqual([asset]);
  await expect(saveAutomationEmailTemplate(admin,{template:{...template,assets:[{...asset,contentHash:'b'.repeat(64)}]},retired:false,expectedRevision:2,reason:'Forged receipt'})).rejects.toMatchObject({code:'invalid'});
  await expect(uploadAutomationEmailAsset(admin,{templateId:template.id,module:'probation',revision:1,kind:'file',name:'late.txt',content:Buffer.from('Late')})).rejects.toMatchObject({code:'conflict'});
  const [old]=await owner.db.execute<{assets:unknown}>(sql`select assets from automation_email_template_version where tenant_id=${base.tenantId}::uuid and template_id=${template.id}::uuid and revision=1`);expect(old.assets).toEqual([]);
  await expect(withTenant(admin,tx=>tx.execute(sql`update lc_v9_email_asset set filename='changed.txt' where id=${asset.id}::uuid`))).rejects.toThrow();
 });
 it('refuses unavailable actors, cross-template/tenant references, false image bytes and direct app inserts',async()=>{
  const template=draft(),other=draft();for(const value of[template,other])await saveAutomationEmailTemplate(admin,{template:value,retired:false,expectedRevision:0,reason:'Create fictional template'});
  const asset=await uploadAutomationEmailAsset(admin,{templateId:template.id,module:'probation',revision:1,kind:'file',name:'information.txt',content:Buffer.from('Information')});
  await expect(saveAutomationEmailTemplate(admin,{template:{...other,assets:[asset]},retired:false,expectedRevision:1,reason:'Wrong source'})).rejects.toMatchObject({code:'invalid'});
  await expect(uploadAutomationEmailAsset(admin,{templateId:template.id,module:'probation',revision:1,kind:'image',name:'false.png',content:Buffer.from('Not a PNG')})).rejects.toThrow();
  const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${base.tenantId}::uuid,'Fictional ordinary employee',${randomUUID()+'@assets.example.test'}) returning id`);
  const userId=await createAppUser(base.tenantId,person.id,'employee'),plain={...admin,userId,personId:person.id,roles:['employee'],grants:undefined} as SessionContext;
  await expect(downloadAutomationEmailAsset(plain,asset.id)).rejects.toMatchObject({code:'forbidden'});
  await expect(uploadAutomationEmailAsset(plain,{templateId:template.id,module:'probation',revision:1,kind:'file',name:'information.txt',content:Buffer.from('Information')})).rejects.toMatchObject({code:'forbidden'});
  await expect(withTenant(plain,tx=>tx.execute(sql`insert into lc_v9_email_asset(tenant_id,email_template_id,kind,filename,mime_type,content,uploaded_by,uploaded_by_name,automation_module) values(${base.tenantId}::uuid,${template.id},'file','information.txt','text/plain',decode('SGk=','base64'),${userId}::uuid,'Fictional ordinary employee','probation')`))).rejects.toThrow();
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');await expect(downloadAutomationEmailAsset(adminCtx(foreign),asset.id)).rejects.toMatchObject({code:'forbidden'});
 });
});
