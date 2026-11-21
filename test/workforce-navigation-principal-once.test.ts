/** Verify the live shared navigation against the previous native predicate. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {and,eq,sql,type SQL} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appUser,company,roleAssignment} from '../db/schema';
import {lockAccessConfigurationReadTx} from '../core/access-configuration-lock';
import {canOpenWorkforce} from '../core/workforce-access';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {hireEmployee} from '../core/org';
import type {AccessConfigurationCommand} from '../lib/access-configuration-command';

beforeAll(migrateTestDb);
afterAll(closeAll);

const original=sql`select (
 exists(select 1 from company where tenant_id=app.current_tenant_id() and app.access_workforce_projection_company(id))
 or app.access_workforce_unassigned('workforce.view')
) as allowed`;

async function execute(tx:Tx,query:SQL){
 const [row]=await tx.execute<{allowed:boolean}>(query);
 return row?.allowed===true;
}
function run(ctx:SessionContext,query:SQL){
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  return execute(tx,query);
 });
}
async function change(actor:SessionContext,command:AccessConfigurationCommand){
 const before=await withTenant(actor,tx=>accessConfigurationStore.loadCurrent(tx,actor));
 const edit={expectedRevision:before.snapshot.revision,command};
 const preview=await previewAccessConfiguration(actor,edit,accessConfigurationStore);
 await saveAccessConfiguration(actor,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}
function override(actor:SessionContext,userId:string,companyId:string,effect:'allow'|'deny'){
 return change(actor,{kind:'setOverride',userId,capabilityId:'workforce.view',companyId,effect});
}

it('preserves live Workforce navigation authority while proving the principal once across the RLS-visible set',async()=>{
 await resetDb();
 const b=await seedBase(),foreign=await seedBase(),root=adminCtx(b);
 const [savedCapability]=await owner.db.execute<{supported:boolean;bindings:unknown}>(sql`select supported,bindings from access_capability where id='workforce.view'`);
 expect(savedCapability).toBeDefined();
 try{
  const [child]=await owner.db.insert(company).values({tenantId:b.tenantId,parentCompanyId:b.companyId,legalName:'Fictional Workforce child'}).returning({id:company.id});
  await owner.db.insert(company).values(Array.from({length:21},(_,i)=>({tenantId:b.tenantId,parentCompanyId:b.companyId,legalName:'Fictional navigation company '+i})));
  const worker=await hireEmployee(root,{person:{fullName:'Fictional Workforce navigation reader',primaryEmail:randomUUID()+'@example.invalid'},
   companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(b.tenantId,worker.personId,'employee');
  const employee={...root,userId,personId:worker.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  const [hrUser]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning({id:appUser.id});
  await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:hrUser.id,role:'hr_admin',companyId:b.companyId});
  const hr={...root,userId:hrUser.id,personId:undefined,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]} satisfies SessionContext;
  const anonymous={...root,userId:undefined,personId:undefined};
  const checks:string[]=[];
  async function compare(label:string,ctx:SessionContext,expected:boolean){
   expect(await canOpenWorkforce(ctx),label+' current public owner').toBe(expected);
   expect(await run(ctx,original),label+' exact SQL').toBe(expected);
   checks.push(label);
  }
  await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id='workforce.view'`);
  await compare('dormant employee denied',employee,false);
  await compare('dormant company HR admitted',hr,true);
  await compare('dormant group admin admitted',root,true);
  await compare('no login denied',anonymous,false);
  const phases:{mode:string;variant:string;reads:number;elapsedMs:number}[]=[];
  async function measure(mode:string){
   for(const [variant,query]of [['before',()=>run(employee,original)],['after',()=>canOpenWorkforce(employee)],['after-repeat',()=>canOpenWorkforce(employee)],['before-repeat',()=>run(employee,original)]] as const){
    const start=performance.now(),reads=5;
    for(let i=0;i<reads;i++)expect(await query()).toBe(false);
    phases.push({mode,variant,reads,elapsedMs:performance.now()-start});
   }
  }
  await measure('dormant');
  await owner.db.execute(sql`update access_capability set supported=true,
   bindings='[{"owner":"fictional-navigation-test","operation":"read"}]'::jsonb where id='workforce.view'`);
  await compare('active employee without grant denied',employee,false);
  await measure('active');
  const groupId=randomUUID();
  await change(root,{kind:'createGroup',groupId,name:'Fictional Workforce navigation grant'});
  await change(root,{kind:'replaceGroupGrants',groupId,grants:[{capabilityId:'workforce.view',companyId:null}]});
  await change(root,{kind:'setMembership',groupId,userId,companyId:b.companyId,enabled:true});
  await compare('active effective group membership admitted',employee,true);
  await override(root,userId,b.companyId,'deny');
  await compare('active deny supersedes group membership',employee,false);
  await change(root,{kind:'setMembership',groupId,userId,companyId:b.companyId,enabled:false});
  await override(root,userId,b.companyId,'allow');
  await compare('active company subtree allowance',employee,true);
  await override(root,userId,child.id,'deny');
  await compare('active child denial leaves parent allowance intact',employee,true);
  await override(root,userId,b.companyId,'deny');
  await compare('active deny supersedes allowance',employee,false);
  await override(root,userId,b.companyId,'allow');
  await owner.db.delete(roleAssignment).where(and(eq(roleAssignment.appUserId,userId),eq(roleAssignment.tenantId,b.tenantId)));
  await compare('stale claimed role denied despite grant',employee,false);
  const foreignCarrier={...employee,tenantId:foreign.tenantId};
  await compare('foreign tenant carrier denied',foreignCarrier,false);

  const comparisons=['dormant','active'].map(mode=>{
   const before=phases.filter(p=>p.mode===mode&&p.variant.startsWith('before'));
   const after=phases.filter(p=>p.mode===mode&&p.variant.startsWith('after'));
   const bestBeforeMs=Math.min(...before.map(p=>p.elapsedMs)),worstAfterMs=Math.max(...after.map(p=>p.elapsedMs));
   return {mode,bestBeforeMs,worstAfterMs,noRegression:worstAfterMs<=bestBeforeMs};
  });
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'workforce-navigation-native-probe.json'),
   JSON.stringify({releaseEligible:false,scope:'isolated app-role carrier timings',checks,phases,comparisons},null,2));
 }finally{
  await owner.db.execute(sql`update access_capability set supported=${savedCapability.supported},
   bindings=${JSON.stringify(savedCapability.bindings)}::jsonb where id='workforce.view'`);
 }
},120000);
