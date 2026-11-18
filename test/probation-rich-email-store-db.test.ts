import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {automationEmailTemplateHistory,listAutomationEmailTemplates,saveAutomationEmailTemplate,uploadAutomationEmailAsset,downloadAutomationEmailAsset} from '../packs/automation/service';
import {convertProbationEmail,probationEmailLegacyBody} from '../lib/automation/probation-email-definition';
import {PROBATION_DEFAULTS} from '../app/automation/probation-defaults';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);});
const save=(template:Parameters<typeof saveAutomationEmailTemplate>[1]['template'],expectedRevision:number)=>saveAutomationEmailTemplate(admin,{template,expectedRevision,retired:false,reason:'Fictional rich editor test'});

describe('the moved Probation email builder uses its original canonical versions',()=>{
 it('keeps all four identities, content, CC, active state, authors and old revisions',async()=>{
  for(const original of PROBATION_DEFAULTS.emailTemplates){
   await save(original,0);
   const converted=convertProbationEmail(original);if(converted.state!=='ready')throw new Error('Default must convert');
   const moved={...original,body:probationEmailLegacyBody(converted.definition.bodyDoc),definition:converted.definition};
   await save(moved,1);
   const history=await automationEmailTemplateHistory(admin,original.id);
   expect(history.map(item=>item.revision)).toEqual([2,1]);
   expect(history.map(item=>item.savedBy)).toEqual([admin.userId,admin.userId]);
   expect(history[1].template).toEqual(original);expect(history[0].template).toEqual(moved);
   expect(history[0].template.id).toBe(original.id);
  }
  expect((await listAutomationEmailTemplates(admin,{module:'probation'})).map(item=>item.template.name)).toEqual(['Review form is open','Signing request','Week 1 KPI alert','Your probation letter']);
 });
 it('binds immutable upload receipts to their template and rejects forged or foreign receipts',async()=>{
  const original={...PROBATION_DEFAULTS.emailTemplates[0],id:randomUUID(),cc:[]};await save(original,0);
  const asset=await uploadAutomationEmailAsset(admin,{emailId:original.id,revision:1,kind:'file',name:'Fictional handbook.txt',content:Buffer.from('Fictional handbook')});
  const converted=convertProbationEmail(original);if(converted.state!=='ready')throw new Error('convert');
  converted.definition.files=[asset];await save({...original,definition:converted.definition},1);
  expect((await downloadAutomationEmailAsset(admin,asset.id)).content.toString()).toBe('Fictional handbook');
  await expect(save({...original,definition:{...converted.definition,files:[{...asset,contentHash:'f'.repeat(64)}]}},2)).rejects.toThrow();
  const other={...original,id:randomUUID()};await save(other,0);
  await expect(save({...other,definition:converted.definition},1)).rejects.toThrow();
  await expect(uploadAutomationEmailAsset(admin,{emailId:original.id,revision:1,kind:'file',name:'Late.txt',content:Buffer.from('late')})).rejects.toMatchObject({code:'conflict'});
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');
  await expect(downloadAutomationEmailAsset(adminCtx(foreign),asset.id)).rejects.toThrow();
  const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional staff',${randomUUID()+'@probation.example.test'}) returning id`);
  const user=await createAppUser(b.tenantId,p.id,'employee'),plain={...admin,userId:user,personId:p.id,roles:['employee'],grants:undefined};
  await expect(downloadAutomationEmailAsset(plain,asset.id)).rejects.toThrow();
  // Direct writes cannot mutate an upload after it was used in a queued snapshot.
  await expect(withTenant(admin,tx=>tx.execute(sql`update automation_email_asset set filename='Changed.txt' where id=${asset.id}::uuid`))).rejects.toThrow();
 });
 it('rejects unknown/sensitive rich fields while preserving unknown legacy tokens unchanged',async()=>{
  const original={...PROBATION_DEFAULTS.emailTemplates[0],id:randomUUID(),body:'Hello {{unknown.field}}',cc:[]};await save(original,0);
  expect(convertProbationEmail(original)).toEqual({state:'legacy',fields:['unknown.field']});
  expect((await listAutomationEmailTemplates(admin))[0].template.body).toBe(original.body);
  const converted=convertProbationEmail({...original,body:'Hello {{employee.name}}'});if(converted.state!=='ready')throw new Error('convert');
  converted.definition.bodyDoc={type:'doc',content:[{type:'paragraph',content:[{type:'field',attrs:{key:'employee.bankAccount'}}]}]};
  await expect(save({...original,definition:converted.definition},1)).rejects.toMatchObject({code:'invalid'});
 });
});
