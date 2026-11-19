/** Inactive6011v8 expected-target proofs; real APIs, owner transport and dates. UNRUN source only. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {createBusinessUnit} from '../core/admin';
import {setLabelGlobal} from '../core/system-labels';
import {hireEmployee} from '../core/org';
import {createMovementEvent,movementHistory,movementCorrectionBaseTx,applyDueMovementsTx} from '../core/movement';
import {prepareCompanyOrganisationRun,companyOrganisationRunReport,decideCompanyOrganisationRun,processCompanyOrganisationRun} from '../core/company-organisation';
import {approveContractSharedPosting,readContractSharedPostingApprovalJob} from '../packs/contracts/service';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {migrateTestDb,closeAll,owner,createAppUser} from './harness';
import {contractPostingFixture,releaseContractPosting,finishContractPostingJob} from './helpers/contract-posting-fixture';
beforeAll(migrateTestDb);afterAll(closeAll);
async function publishManaged(admin:SessionContext,b:{tenantId:string;companyId:string;deptA:string},start:string){
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional independent future Org checker',primaryEmail:randomUUID()+'@future-org.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
 const userId=await createAppUser(b.tenantId,employee.personId,'hr_admin');
 const checker:SessionContext={...admin,userId,personId:employee.personId,roles:['hr_admin'],grants:undefined};
 expect(checker.userId).not.toBe(admin.userId);expect(checker.personId).not.toBe(admin.personId);
 const unitId=(await createBusinessUnit(admin,{companyId:b.companyId,code:'FUTURE-ORG',name:'Fictional managed date replay unit'})).id;
 await setLabelGlobal(admin,{kind:'business_unit',labelId:unitId,isGlobal:true});
 const id=await prepareCompanyOrganisationRun(admin,{kind:'mapping',companyIds:[b.companyId],effectiveOn:start,changes:[{companyId:b.companyId,businessUnitId:unitId,parentCompanyId:null}]});
 const report=await companyOrganisationRunReport(checker,id);
 await decideCompanyOrganisationRun(checker,{id,digest:report.run.digest,approve:true,reason:'Independent review of fictional future-date mapping'});
 let run=await processCompanyOrganisationRun(admin,id);
 for(let attempt=0;attempt<30&&run.state==='staging';attempt++)run=await processCompanyOrganisationRun(admin,id);
 expect(run.state).toBe('published');return unitId;
}
async function facts(tenant:string,employment:string){
 const[row]=await owner.db.execute<{join:string|null;extended:string|null;counter:number;start:string;end:string;unit:string;department:string}>(sql`select e.join_date::text as "join",e.extended_confirmation_date::text as extended,e.contract_number as counter,e.contract_start_date::text as start,e.contract_end_date::text as end,a.business_unit_id as unit,a.department_id as department from public.employment e join public.assignment a on a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null where e.tenant_id=${tenant}::uuid and e.id=${employment}::uuid`);return row;
}
it.each(['joinDateChange','probationExtension'] as const)('preserves the genuinely applied unscheduled future %s through past Contract approval',async(kind)=>{
 const target=addCalendarMonths(todayInKualaLumpur().slice(0,7)+'-01',-1);let unitId='',futureDay='',extendedDay='';
 const f=await contractPostingFixture({endOn:addDaysIso(target,-1),beforeAdopt:async({admin,employee,b,start,today})=>{
  futureDay=addDaysIso(today,10);extendedDay=addDaysIso(futureDay,30);
  await createMovementEvent(admin,{employmentId:employee.employmentId,kind,effectiveDate:futureDay,...(kind==='probationExtension'?{endDate:extendedDay}:{}),remarks:'Fictional immediately applied future date decision'});
  const actual=await facts(b.tenantId,employee.employmentId);
  if(kind==='joinDateChange')expect(actual.join).toBe(futureDay);else expect(actual.extended).toBe(extendedDay);
  const rows=(await movementHistory(admin,employee.employmentId)).filter(row=>row.kind===kind&&row.effectiveDate===futureDay);
  expect(rows).toHaveLength(1);expect(rows[0].status).toBe('applied');
  expect(await withTenant(admin,tx=>movementCorrectionBaseTx(tx,admin,employee.employmentId,rows[0].id))).toMatchObject({scheduled:false,effectiveDate:futureDay});
  unitId=await publishManaged(admin,b,start);
 }});
 const before=await facts(f.b.tenantId,f.employee.employmentId);expect(before.unit).toBe(unitId);expect(before.counter).toBe(4);
 const previous=await owner.db.execute<{id:string;day:string}>(sql`select id,effective_on::text as day from public.employment_organisation_classification where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid order by effective_on,id`);
 expect(previous.length).toBeGreaterThan(0);expect(previous.some(row=>row.day===futureDay)).toBe(false);
 const[rights]=await withTenant(f.approver,tx=>tx.execute<{maintain:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain`));expect(rights.maintain).toBe(false);
 const posting=await releaseContractPosting(f),queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
 if(queued.postingStatus!=='pending')throw Error('A genuine first approval must queue.');
 expect(await facts(f.b.tenantId,f.employee.employmentId)).toEqual(before);
 const suffix=randomUUID().replaceAll('-',''),fn='_test_future_org_'+suffix,log='_test_future_org_log_'+suffix,trigger='test_future_org_'+suffix;
 for(const value of [queued.jobId,f.employee.employmentId,unitId])expect(value).toMatch(/^[0-9a-f-]{36}$/i);
 try{
  // Invoker observes the genuine separate plain-owner backend; it never creates a frame or changes NEW.
  await owner.client.unsafe(`CREATE TABLE app.${log}(direction text NOT NULL,denied integer NOT NULL);REVOKE ALL ON app.${log} FROM PUBLIC,ai_hr_app;
   CREATE FUNCTION app.${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $probe$
   DECLARE step app.contract_posting_replay_step;root public.domain_event;day_key date;company_key uuid;tags jsonb;blocked boolean;denied integer:=0;
   BEGIN
    IF NEW.job_id::text<>TG_ARGV[0] OR NEW.active_ordinal IS NULL THEN RETURN NEW;END IF;
    SELECT * INTO step FROM app.contract_posting_replay_step WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id AND xact_id=NEW.xact_id AND backend_pid=NEW.backend_pid AND ordinal=NEW.active_ordinal;
    SELECT * INTO root FROM public.domain_event WHERE tenant_id=NEW.tenant_id AND id=step.event_id AND subject_employment_id=NEW.employment_id;
    IF root.payload->'movement'->>'type' IS DISTINCT FROM TG_ARGV[1] THEN RAISE EXCEPTION 'Observe only the real date-only leg';END IF;
    day_key:=CASE TG_ARGV[1] WHEN 'joinDateChange' THEN (root.payload->'after'->>'joinDate')::date ELSE (root.payload->'movement'->>'effectiveDate')::date END;
    company_key:=CASE step.direction WHEN 'inverse' THEN step.company_before ELSE step.company_after END;
    IF day_key<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR day_key::text IS DISTINCT FROM TG_ARGV[2] OR NEW.xact_id<>txid_current() OR NEW.backend_pid<>pg_backend_pid() OR current_setting('app.bulk_job',true) IS DISTINCT FROM NEW.job_id::text THEN RAISE EXCEPTION 'Actual future date and live native frame required';END IF;
    tags:=app.contract_posting_company_org_tags(NEW.job_id,NEW.employment_id,company_key,day_key);
    IF tags->>'status' IS DISTINCT FROM 'ready' OR tags->>'businessUnitId' IS DISTINCT FROM TG_ARGV[3] THEN RAISE EXCEPTION 'Managed actual future source scope required';END IF;
    blocked:=false;BEGIN PERFORM app.contract_posting_company_org_tags(NEW.job_id,NEW.employment_id,company_key,day_key+1);EXCEPTION WHEN SQLSTATE '42501' THEN blocked:=true;END;
    IF NOT blocked THEN RAISE EXCEPTION 'Wrong future leg date admitted';END IF;denied:=denied+1;
    blocked:=false;BEGIN PERFORM app.contract_posting_record_org_tags(NEW.job_id,NEW.employment_id,company_key,day_key,'assignment');EXCEPTION WHEN SQLSTATE '42501' THEN blocked:=true;END;
    IF NOT blocked THEN RAISE EXCEPTION 'Future Assignment trigger admitted';END IF;denied:=denied+1;
    INSERT INTO app.${log} VALUES(step.direction,denied);RETURN NEW;
   END $probe$;
   REVOKE ALL ON FUNCTION app.${fn}() FROM PUBLIC,ai_hr_app;
   CREATE TRIGGER ${trigger} AFTER UPDATE OF active_ordinal ON app.contract_posting_replay_state FOR EACH ROW WHEN(NEW.active_ordinal IS NOT NULL AND OLD.active_ordinal IS DISTINCT FROM NEW.active_ordinal) EXECUTE FUNCTION app.${fn}('${queued.jobId}','${kind}','${futureDay}','${unitId}');`);
  await finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply');
  expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'applied'});
  expect(await owner.client.unsafe(`select direction,denied from app.${log} order by direction`)).toEqual([{direction:'inverse',denied:2},{direction:'replay',denied:2}]);
  expect(await facts(f.b.tenantId,f.employee.employmentId)).toEqual({...before,counter:5,start:f.newStart,end:f.newEnd});
  const classified=await owner.db.execute<{actor:string;unit:string;kind:string}>(sql`select actor_id as actor,tags->>'businessUnitId' as unit,actor_kind as kind from public.employment_organisation_classification where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and effective_on=${futureDay}::date`);
  expect(classified.length).toBeGreaterThan(0);expect(classified.every(row=>row.actor===f.approver.userId&&row.unit===unitId&&row.kind==='user')).toBe(true);
  const audit=await owner.db.execute<{actor:string;kind:string}>(sql`select actor_id as actor,payload->'bulkJob'->>'kind' as kind from public.domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.organisation-tagged' and payload->>'effectiveOn'=${futureDay} and payload->'bulkJob'->>'id'=${queued.jobId}`);
  expect(audit.length).toBeGreaterThan(0);expect(audit.every(row=>row.actor===f.approver.userId&&row.kind==='contract_posting_apply')).toBe(true);
 }finally{await owner.client.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON app.contract_posting_replay_state;DROP FUNCTION IF EXISTS app.${fn}();DROP TABLE IF EXISTS app.${log};`);}
},180_000);
it('keeps a genuine managed future Contract scheduled without early Personnel or Org mutation',async()=>{
 const f=await contractPostingFixture({future:true,beforeAdopt:async({admin,b,start})=>{await publishManaged(admin,b,start);}}),posting=await releaseContractPosting(f);
 const snapshot=async()=>{const[row]=await owner.db.execute(sql`select to_jsonb(e) as facts,(select jsonb_agg(to_jsonb(a) order by a.id) from public.assignment a where a.tenant_id=e.tenant_id and a.employment_id=e.id) as assignments,(select jsonb_agg(to_jsonb(c) order by c.id) from public.employment_organisation_classification c where c.tenant_id=e.tenant_id and c.employment_id=e.id) as classifications from public.employment e where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);return row;};
 const before=await snapshot(),queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});if(queued.postingStatus!=='pending')throw Error('A genuine future approval must queue.');
 expect(await snapshot()).toEqual(before);await finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply');
 expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'scheduled'});expect(await snapshot()).toEqual(before);
 expect(await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.today))).toMatchObject({applied:0});expect(await snapshot()).toEqual(before);
 const rows=(await movementHistory(f.admin,f.employee.employmentId)).filter(row=>row.kind==='contractRenewal'&&row.effectiveDate===f.newStart);expect(rows).toHaveLength(1);expect(rows[0].status).toBe('pending');
 expect(await owner.db.execute(sql`select id from public.domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.organisation-tagged' and payload->'bulkJob'->>'id'=${queued.jobId}`)).toHaveLength(0);
},180_000);
