/** Inactive6011v7 expected-target proof: real correction before/after publication and dated BU remapping.
 * Publication-after-correction exposes V5’s missing row edge; dated remapping exposes V6’s BU edge. No PASS claimed.
 * Classification is idempotent at the existing correction date; the probe proves the actual
 * boundary INSERT consumed its native witness, while a real later salary inverse produces a new job audit.
 */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {createBusinessUnit} from '../core/admin';
import {setLabelGlobal} from '../core/system-labels';
import {hireEmployee} from '../core/org';
import {createMovementEvent} from '../core/movement';
import {previewInformationCorrection,correctInformation} from '../core/information-correction';
import {prepareCompanyOrganisationRun,companyOrganisationRunReport,decideCompanyOrganisationRun,processCompanyOrganisationRun} from '../core/company-organisation';
import {approveContractSharedPosting,readContractSharedPostingApprovalJob} from '../packs/contracts/service';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {migrateTestDb,closeAll,owner,createAppUser} from './harness';
import {contractPostingFixture,releaseContractPosting,finishContractPostingJob} from './helpers/contract-posting-fixture';

beforeAll(migrateTestDb);afterAll(closeAll);
it.each(['before','after','at-boundary'] as const)('reapplies a real retained correction with managed Org publication %s',async(publicationOrder)=>{
 const target=addCalendarMonths(todayInKualaLumpur().slice(0,7)+'-01',-1);
 let unitId='',initialUnitId='',correctedAssignmentId='',foreignEmploymentId='';
 const f=await contractPostingFixture({endOn:addDaysIso(target,-1),beforeAdopt:async({admin,employee,b,start,newStart})=>{
  const checkerEmployee=await hireEmployee(admin,{person:{fullName:'Fictional independent retained Org checker',primaryEmail:randomUUID()+'@retained-org.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
  foreignEmploymentId=checkerEmployee.employmentId;
  const checkerUserId=await createAppUser(b.tenantId,checkerEmployee.personId,'hr_admin');
  const checker:SessionContext={...admin,userId:checkerUserId,personId:checkerEmployee.personId,roles:['hr_admin'],grants:undefined};
  expect(checker.userId).not.toBe(admin.userId);expect(checker.personId).not.toBe(admin.personId);
  unitId=(await createBusinessUnit(admin,{companyId:b.companyId,code:'RETAINED-ORG',name:'Fictional retained managed unit'})).id;
  initialUnitId=unitId;
  await setLabelGlobal(admin,{kind:'business_unit',labelId:unitId,isGlobal:true});
  const publish=async(effectiveOn=start)=>{
   const runId=await prepareCompanyOrganisationRun(admin,{kind:'mapping',companyIds:[b.companyId],effectiveOn,changes:[{companyId:b.companyId,businessUnitId:unitId,parentCompanyId:null}]});
   const report=await companyOrganisationRunReport(checker,runId);
   await decideCompanyOrganisationRun(checker,{id:runId,digest:report.run.digest,approve:true,reason:'Independent review of fictional retained managed mapping'});
   let result=await processCompanyOrganisationRun(admin,runId);
   for(let attempt=0;attempt<30&&result.state==='staging';attempt++)result=await processCompanyOrganisationRun(admin,runId);
   expect(result.state).toBe('published');
  };
  if(publicationOrder!=='after')await publish();
  const input={employmentId:employee.employmentId,changes:{departmentId:b.deptB},effectiveOn:addDaysIso(newStart,5),reason:'Fictional later independent placement correction'};
  const preview=await previewInformationCorrection(admin,input);
  await correctInformation(admin,{...input,fingerprint:preview.fingerprint,method:'manual'});
  const[corrected]=await owner.db.execute<{id:string}>(sql`select id from public.assignment where tenant_id=${b.tenantId}::uuid and employment_id=${employee.employmentId}::uuid and valid_to is null and superseded_at is null`);
  correctedAssignmentId=corrected.id;
  if(publicationOrder==='after')await publish();
  if(publicationOrder==='at-boundary'){
   unitId=(await createBusinessUnit(admin,{companyId:b.companyId,code:'RETAINED-ORG-B',name:'Fictional boundary managed unit'})).id;
   await setLabelGlobal(admin,{kind:'business_unit',labelId:unitId,isGlobal:true});
   await publish(input.effectiveOn);
  }
  // Compensation has no Assignment replacement; its real inverse classifies this distinct date.
  await createMovementEvent(admin,{employmentId:employee.employmentId,kind:'salaryAdjustment',effectiveDate:addDaysIso(newStart,10),basicSalary:5291.42,remarks:'Fictional later salary decision retained through Contract replay'});
 }});
 const boundaryDay=addDaysIso(f.newStart,5),salaryDay=addDaysIso(f.newStart,10);expect(salaryDay<f.today).toBe(true);
 const facts=async()=>{
  const[row]=await owner.db.execute<{assignmentId:string;unit:string;department:string;day:string;salary:string;counter:number;start:string;end:string}>(sql`
   select a.id as "assignmentId",a.business_unit_id as unit,a.department_id as department,a.valid_from::text as day,
    c.basic_salary::text as salary,e.contract_number as counter,e.contract_start_date::text as start,e.contract_end_date::text as end
   from public.employment e join public.assignment a on a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null
   join public.compensation c on c.tenant_id=e.tenant_id and c.employment_id=e.id and c.valid_to is null and c.superseded_at is null
   where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);return row;
 };
 const before=await facts();expect(before).toMatchObject({unit:unitId,department:f.b.deptB,day:boundaryDay,salary:'5291.42',counter:4});
 // The probe expects the actual current mapped row, including a real publication replacement.
 if(publicationOrder!=='before')expect(before.assignmentId).not.toBe(correctedAssignmentId);
 else expect(before.assignmentId).toBe(correctedAssignmentId);
 if(publicationOrder==='at-boundary'){
  expect(unitId).not.toBe(initialUnitId);
  const[cover]=await owner.db.execute<{unit:string;department:string}>(sql`select business_unit_id as unit,department_id as department from public.assignment where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and superseded_at is null and valid_from<${boundaryDay}::date and valid_to=${boundaryDay}::date`);
  expect(cover).toEqual({unit:initialUnitId,department:f.b.deptA});
 }
 const correctionsBefore=await owner.db.execute<{row:Record<string,unknown>}>(sql`select to_jsonb(d) as row from public.domain_event d where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.information.corrected' order by sequence`);
 expect(correctionsBefore).toHaveLength(1);
 expect(correctionsBefore[0].row.payload).toMatchObject({fields:['departmentId']});
 const classificationsBefore=await owner.db.execute<{id:string;day:string}>(sql`select id,effective_on::text as day from public.employment_organisation_classification where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid order by effective_on,id`);
 expect(classificationsBefore.some(row=>row.day===boundaryDay)).toBe(true);
 expect(classificationsBefore.some(row=>row.day===salaryDay)).toBe(false);
 const[rights]=await withTenant(f.approver,tx=>tx.execute<{maintain:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain`));expect(rights.maintain).toBe(false);
 const posting=await releaseContractPosting(f);
 const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
 if(queued.postingStatus!=='pending')throw Error('A genuine first approval must queue.');
 const suffix=randomUUID().replaceAll('-',''),log='_test_retained_org_'+suffix,fn='_test_retained_org_probe_'+suffix,trigger='zzz_test_retained_org_'+suffix;
 const captureLog='_test_retained_capture_'+suffix,captureFn='_test_retained_capture_probe_'+suffix,captureTrigger='test_retained_capture_'+suffix,wrongJobId=randomUUID();
 const[foreignAssignment]=await owner.db.execute<{id:string}>(sql`select id from public.assignment where tenant_id=${f.b.tenantId}::uuid and employment_id=${foreignEmploymentId}::uuid and valid_to is null and superseded_at is null`);
 for(const value of [queued.jobId,f.employee.employmentId,before.assignmentId,unitId,foreignEmploymentId,foreignAssignment.id,wrongJobId])expect(value).toMatch(/^[0-9a-f-]{36}$/i);
 try{
  // A permanent TEST-ONLY trigger is visible to the genuine separate plain-owner backend.
  // Alphabetical AFTER ordering observes the native organisation_assignment_record callback.
  await owner.client.unsafe(`CREATE TABLE app.${captureLog}(row_count integer NOT NULL,negative_checks integer NOT NULL,actual_frame boolean NOT NULL);
   REVOKE ALL ON app.${captureLog} FROM PUBLIC,ai_hr_app;
   CREATE FUNCTION app.${captureFn}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $probe$
   DECLARE actual_rows jsonb;actual_row jsonb;denied integer:=0;
   BEGIN
    IF NEW.job_id::text<>TG_ARGV[0] THEN RETURN NEW;END IF;
    SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) INTO actual_rows FROM public.assignment a WHERE a.tenant_id=NEW.tenant_id AND a.employment_id=NEW.employment_id;
    SELECT to_jsonb(a) INTO actual_row FROM public.assignment a WHERE a.tenant_id=NEW.tenant_id AND a.employment_id=NEW.employment_id AND a.id=TG_ARGV[1]::uuid;
    IF NEW.rows IS DISTINCT FROM actual_rows OR NEW.row_count IS DISTINCT FROM jsonb_array_length(actual_rows)
     OR NEW.rows_hash IS DISTINCT FROM app.bulk_job_value_digest(actual_rows) OR actual_row IS NULL
     OR NEW.xact_id<>txid_current() OR NEW.backend_pid<>pg_backend_pid() OR NEW.login_name<>session_user
     OR current_setting('app.bulk_job',true) IS DISTINCT FROM NEW.job_id::text
     OR app.contract_posting_assignment_org_before_row(NEW.job_id,NEW.employment_id,TG_ARGV[1]::uuid) IS DISTINCT FROM actual_row
    THEN RAISE EXCEPTION 'Observe the complete actual native Assignment before-row capture';END IF;
    IF app.contract_posting_assignment_org_before_row(TG_ARGV[4]::uuid,NEW.employment_id,TG_ARGV[1]::uuid) IS NOT NULL THEN RAISE EXCEPTION 'Wrong job admitted';END IF;denied:=denied+1;
    IF app.contract_posting_assignment_org_before_row(NEW.job_id,TG_ARGV[2]::uuid,TG_ARGV[1]::uuid) IS NOT NULL THEN RAISE EXCEPTION 'Actual foreign subject admitted';END IF;denied:=denied+1;
    IF app.contract_posting_assignment_org_before_row(NEW.job_id,NEW.employment_id,TG_ARGV[3]::uuid) IS NOT NULL THEN RAISE EXCEPTION 'Actual foreign Assignment admitted';END IF;denied:=denied+1;
    -- Corrupt only the existing real capture inside a deliberately rolled-back subtransaction.
    -- Never manufacture a valid frame/row/hash; the exact native proof must be restored afterwards.
    BEGIN
     UPDATE app.contract_posting_assignment_org_before c SET rows_hash=app.bulk_job_value_digest(NEW.rows||jsonb_build_array('test-invalid-capture-hash'))
      WHERE c.tenant_id=NEW.tenant_id AND c.job_id=NEW.job_id AND c.employment_id=NEW.employment_id AND c.xact_id=NEW.xact_id AND c.backend_pid=NEW.backend_pid;
     IF app.contract_posting_assignment_org_before_row(NEW.job_id,NEW.employment_id,TG_ARGV[1]::uuid) IS NOT NULL THEN RAISE EXCEPTION 'Changed stored capture hash admitted';END IF;
     RAISE EXCEPTION 'Rollback only the invalid-hash test' USING ERRCODE='ZX001';
    EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
    END;
    IF app.contract_posting_assignment_org_before_row(NEW.job_id,NEW.employment_id,TG_ARGV[1]::uuid) IS DISTINCT FROM actual_row
     OR NOT EXISTS(SELECT 1 FROM app.contract_posting_assignment_org_before c WHERE c.tenant_id=NEW.tenant_id AND c.job_id=NEW.job_id AND c.employment_id=NEW.employment_id AND c.xact_id=NEW.xact_id AND c.backend_pid=NEW.backend_pid AND to_jsonb(c)=to_jsonb(NEW))
    THEN RAISE EXCEPTION 'Negative test must restore the exact genuine capture';END IF;denied:=denied+1;
    INSERT INTO app.${captureLog} VALUES(NEW.row_count,denied,true);
    RETURN NEW;
   END $probe$;
   REVOKE ALL ON FUNCTION app.${captureFn}() FROM PUBLIC,ai_hr_app;
   CREATE TRIGGER ${captureTrigger} AFTER INSERT ON app.contract_posting_assignment_org_before FOR EACH ROW EXECUTE FUNCTION app.${captureFn}('${queued.jobId}','${before.assignmentId}','${foreignEmploymentId}','${foreignAssignment.id}','${wrongJobId}');
   CREATE TABLE app.${log}(inserted_id uuid NOT NULL,retained_id uuid NOT NULL,kind text NOT NULL,actual_frame boolean NOT NULL);
   REVOKE ALL ON app.${log} FROM PUBLIC,ai_hr_app;
   CREATE FUNCTION app.${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $probe$
   DECLARE permit app.contract_posting_assignment_org_permit;
   BEGIN
    IF NEW.employment_id::text<>TG_ARGV[1] OR current_setting('app.bulk_job',true) IS DISTINCT FROM TG_ARGV[0] THEN RETURN NEW;END IF;
    SELECT p.* INTO permit FROM app.contract_posting_assignment_org_permit p WHERE p.job_id=TG_ARGV[0]::uuid AND p.tenant_id=NEW.tenant_id AND p.employment_id=NEW.employment_id;
    IF permit.id IS NULL THEN RETURN NEW;END IF;
    IF permit.retained_assignment_id::text<>TG_ARGV[2] OR permit.inserted_id IS DISTINCT FROM NEW.id
     OR permit.xact_id<>txid_current() OR permit.backend_pid<>pg_backend_pid() OR permit.login_name<>session_user
     OR permit.effective_on IS DISTINCT FROM NEW.valid_from OR permit.company_id IS DISTINCT FROM NEW.company_id
     OR permit.inserted_hash IS DISTINCT FROM app.bulk_job_value_digest(to_jsonb(NEW))
     OR app.contract_posting_assignment_org_consumed_company(permit.job_id,NEW.employment_id,NEW.valid_from) IS DISTINCT FROM NEW.company_id
     OR NEW.business_unit_id::text IS DISTINCT FROM TG_ARGV[3]
    THEN RAISE EXCEPTION 'Observe only the exact consumed native retained boundary witness';END IF;
    INSERT INTO app.${log} VALUES(NEW.id,permit.retained_assignment_id,'boundary',true);
    RETURN NEW;
   END $probe$;
   REVOKE ALL ON FUNCTION app.${fn}() FROM PUBLIC,ai_hr_app;
   CREATE TRIGGER ${trigger} AFTER INSERT ON public.assignment FOR EACH ROW EXECUTE FUNCTION app.${fn}('${queued.jobId}','${f.employee.employmentId}','${before.assignmentId}','${unitId}');`);
  await finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply');
  expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'applied'});
  const captures=await owner.client.unsafe<{row_count:number;negative_checks:number;actual_frame:boolean}[]>(`select * from app.${captureLog}`);
  expect(captures).toHaveLength(1);expect(captures[0].row_count).toBeGreaterThan(1);expect(captures[0]).toMatchObject({negative_checks:4,actual_frame:true});
  const observed=await owner.client.unsafe<{inserted_id:string;retained_id:string;kind:string;actual_frame:boolean}[]>(`select * from app.${log}`);
  expect(observed).toHaveLength(1);expect(observed[0]).toMatchObject({retained_id:before.assignmentId,kind:'boundary',actual_frame:true});
  const final=await facts();expect(final.assignmentId).toBe(observed[0].inserted_id);expect(final.assignmentId).not.toBe(before.assignmentId);
  expect(final).toEqual({...before,assignmentId:observed[0].inserted_id,counter:5,start:f.newStart,end:f.newEnd});
  const reapplied=await owner.db.execute<{boundaries:{date:string;insertedId:string;liftedId:string}[]}>(sql`select payload->'boundaries' as boundaries from public.domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.information.boundary.reapplied' order by sequence`);
  expect(reapplied.some(event=>event.boundaries.some(row=>row.date===boundaryDay&&row.insertedId===final.assignmentId&&row.liftedId===before.assignmentId))).toBe(true);
  const classified=await owner.db.execute<{id:string;day:string;unit:string;actor:string;kind:string}>(sql`select id,effective_on::text as day,tags->>'businessUnitId' as unit,actor_id as actor,actor_kind as kind from public.employment_organisation_classification where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid order by effective_on,id`);
  const added=classified.filter(row=>!classificationsBefore.some(old=>old.id===row.id));
  expect(added.length).toBeGreaterThan(0);expect(added.some(row=>row.day===salaryDay)).toBe(true);
  expect(added.every(row=>row.unit===unitId&&row.actor===f.approver.userId&&row.kind==='user')).toBe(true);
  const audit=await owner.db.execute<{day:string;actor:string;job:string;kind:string;unit:string}>(sql`select payload->>'effectiveOn' as day,actor_id as actor,payload->'bulkJob'->>'id' as job,payload->'bulkJob'->>'kind' as kind,payload->'after'->>'businessUnitId' as unit from public.domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.organisation-tagged' and payload->'bulkJob'->>'id'=${queued.jobId} order by sequence`);
  expect(audit.some(row=>row.day===salaryDay)).toBe(true);expect(audit.every(row=>row.actor===f.approver.userId&&row.job===queued.jobId&&row.kind==='contract_posting_apply'&&row.unit===unitId)).toBe(true);
  expect(await owner.db.execute(sql`select to_jsonb(d) as row from public.domain_event d where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.information.corrected' order by sequence`)).toEqual(correctionsBefore);
  const[remaining]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.contract_posting_assignment_org_permit where tenant_id=${f.b.tenantId}::uuid and job_id=${queued.jobId}::uuid`);expect(remaining.n).toBe(0);
 }finally{
  await owner.client.unsafe(`DROP TRIGGER IF EXISTS ${captureTrigger} ON app.contract_posting_assignment_org_before;DROP FUNCTION IF EXISTS app.${captureFn}();DROP TABLE IF EXISTS app.${captureLog};DROP TRIGGER IF EXISTS ${trigger} ON public.assignment;DROP FUNCTION IF EXISTS app.${fn}();DROP TABLE IF EXISTS app.${log};`);
 }
},180_000);
