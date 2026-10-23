/** Fictional Home review records. Every database import follows the exact local-target guard. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {board1LocalAcceptanceTarget} from './board1-local-acceptance-target';

const acceptance=board1LocalAcceptanceTarget();
const target=process.env.BOARD1_HOME_FIXTURE_TARGET??'home';
const targets={
 home:{database:acceptance.homeDatabase,receipt:'home-fixture.json',tenant:'Fictional Board 1 Home Acceptance'},
 notice:{database:'ai_hr_board1_notice_acceptance',receipt:'notice-fixture.json',tenant:'Fictional Board 1 Notice Acceptance'},
 personal:{database:'ai_hr_board1_personal_home_acceptance',receipt:'personal-home-fixture.json',tenant:'Fictional Board 1 Personal Home Acceptance'},
} as const;
if(!Object.hasOwn(targets,target))throw Error('Choose an explicit allowed fictional fixture target.');
const selected=targets[target as keyof typeof targets],name=selected.database;
if(process.env.BOARD1_ACCEPTANCE_TARGET==='release20261023'&&target!=='home')throw Error('The release target uses the fresh Home fixture only.');
const destination=acceptance.directory+'/'+selected.receipt;
const tenantName=selected.tenant;
for(const raw of [process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL]){
 const url=new URL(raw??'');
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)
  ||url.port!=='5433'||url.pathname!=='/'+name||url.search||url.hash)
  throw Error('Only the named disposable local Board 1 Home database is allowed.');
}
if(process.env.NODE_ENV==='production')throw Error('Development fixture only.');
process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;
process.env.TEST_MIGRATION_DATABASE_URL=process.env.MIGRATION_DATABASE_URL;

async function main(){
 await mkdir(acceptance.directory,{recursive:true,mode:0o700});
 const {default:postgres}=await import('postgres');
 const ownerUrl=process.env.MIGRATION_DATABASE_URL!;
 const adminUrl=new URL(ownerUrl);adminUrl.pathname='/postgres';
 const admin=postgres(adminUrl.toString(),{max:1});
 const prior=await readFile(destination,'utf8').then(JSON.parse,()=>null);
 try{
  const existing=await admin`SELECT 1 FROM pg_database WHERE datname=${name}`;
  if(existing.length&&!prior)throw Error('Named database already exists without its fixture receipt; refusing to adopt or reset it.');
  if(!existing.length&&prior)throw Error('Fixture receipt exists without its database; refusing to recreate identities.');
  if(!existing.length)await admin.unsafe('CREATE DATABASE "'+name+'"');
  await admin.unsafe('GRANT CONNECT ON DATABASE "'+name+'" TO ai_hr_app');
 }finally{await admin.end({timeout:5});}
 const {drizzle}=await import('drizzle-orm/postgres-js');
 const {migrate}=await import('drizzle-orm/postgres-js/migrator');
 const journal=JSON.parse(await readFile('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string}[]};
 const digest=createHash('sha256');
 digest.update(JSON.stringify(journal));
 for(const entry of journal.entries)digest.update(await readFile('db/migrations/'+entry.tag+'.sql'));
 const schemaFingerprint=digest.digest('hex');
 if(prior&&prior.schemaFingerprint!==schemaFingerprint)throw Error('Fixture schema source changed; allocate a new named database instead of replaying changed migrations.');
 const migration=postgres(ownerUrl,{max:1});
 try{await migrate(drizzle(migration),{migrationsFolder:'db/migrations'});}finally{await migration.end({timeout:5});}
 const {seedCatalogsAt}=await import('./seed-catalogs');await seedCatalogsAt(ownerUrl);
 const {owner,seedBase,entitledCtx,createAppUser,closeAll}=await import('../test/harness');
 const {eq,and}=await import('drizzle-orm'),s=await import('../db/schema');
 const {hireEmployee}=await import('../core/org');
 const {todayInKualaLumpur}=await import('../lib/hr-date');
 const {seedEmployeeHomeCardCatalog}=await import('../core/dashboard-card-config');
 const {saveEmployeeHomeConfiguration}=await import('../core/employee-home-configuration');
 const {defaultEmployeeHomeConfiguration}=await import('../lib/employee-home-defaults');
 try{
  if(prior){
   const [tenant]=await owner.db.select().from(s.tenant).where(eq(s.tenant.id,prior.tenantId));
   if(tenant?.name!==tenantName)throw Error('Fictional tenant receipt no longer matches.');
   for(const user of Object.values(prior.people) as {userId:string;personId:string;employmentId:string}[]){
    const [login]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.id,user.userId),eq(s.appUser.tenantId,tenant.id)));
    const [employment]=await owner.db.select().from(s.employment).where(and(eq(s.employment.id,user.employmentId),eq(s.employment.tenantId,tenant.id)));
    if(login?.personId!==user.personId||employment?.personId!==user.personId)throw Error('Fictional principal receipt no longer matches.');
   }
   console.log('Existing fictional Home identities and migration fingerprint verified; saved settings preserved.');return;
  }
  const b=await seedBase();
  await owner.db.update(s.tenant).set({name:tenantName}).where(eq(s.tenant.id,b.tenantId));
  await owner.db.update(s.company).set({legalName:'Fictional Home Operations A'}).where(eq(s.company.id,b.companyId));
  const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Home Services B'}).returning();
  const [otherDept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:other.id,name:'Fictional Services'}).returning();
  const ctx={...await entitledCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]};
  const date=todayInKualaLumpur();
  const people:Record<string,{userId:string;personId:string;employmentId:string;name:string}>={};
  for(const [key,fullName,role,companyId,departmentId] of [
   ['scopedHr','Fictional Home HR A','hr_admin',b.companyId,b.deptA],
   ['employee','Fictional Home Amina','employee',b.companyId,b.deptA],
   ['manager','Fictional Home Chen','manager',b.companyId,b.deptA],
   ['foreignEmployee','Fictional Home Balan','employee',other.id,otherDept.id],
  ] as const){
   const hired=await hireEmployee(ctx,{person:{fullName,primaryEmail:'home-'+key+'@example.test'},companyId,departmentId,employmentType:'full_time',hiredOn:date});
   const userId=await createAppUser(b.tenantId,hired.personId,role);
   if(key==='scopedHr')await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
   people[key]={...hired,userId,name:fullName};
  }
  await owner.db.update(s.appUser).set({onboardedAt:new Date()}).where(eq(s.appUser.tenantId,b.tenantId));
  await owner.db.transaction(tx=>seedEmployeeHomeCardCatalog(tx,b.tenantId));
  const configuration=defaultEmployeeHomeConfiguration();configuration.templates.find(row=>row.key==='calm')!.text.en='Fictional Company B private Home wording.';
  await saveEmployeeHomeConfiguration(ctx,{companyId:other.id,audienceRole:'employee',expectedOrdinal:0,configuration,reason:'Fictional foreign-company refusal witness'});
  await writeFile(destination,JSON.stringify({...b,otherCompanyId:other.id,date,people,database:name,schemaFingerprint,
   notice:'Fictional local Home editor review only; not production acceptance.'},null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log('Created fictional Home review identities and foreign-company version; identifiers saved privately.');
 }finally{await closeAll();}
}
main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
