/** Inactive6011v2 companion proof. Requires normal installation of the reviewed full-row snapshot owner.
 * Instruments only genuine fixed-worker transitions; no hand-built frame, receipt, cursor or capability.
 */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {createBusinessUnit,createCompany} from '../core/admin';
import {setLabelGlobal} from '../core/system-labels';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent} from '../core/movement';
import {prepareCompanyOrganisationRun,companyOrganisationRunReport,decideCompanyOrganisationRun,processCompanyOrganisationRun,deriveCompanyOrganisationTx} from '../core/company-organisation';
import {createBatch,generatePayslips,closeBatch} from '../packs/payroll/service';
import {approveContractSharedPosting,readContractSharedPostingApprovalJob} from '../packs/contracts/service';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {migrateTestDb,closeAll,owner,createAppUser,setModule,entitledCtx} from './harness';
import {contractPostingFixture,releaseContractPosting,finishContractPostingJob} from './helpers/contract-posting-fixture';

beforeAll(migrateTestDb);afterAll(closeAll);
it('uses managed Org classification and the exact emitted snapshot rows inside a genuine group-only posting job',async()=>{
 const targetStart=addCalendarMonths(todayInKualaLumpur().slice(0,7)+'-01',-1);
 let unitId='',otherCompanyId='',checkerEmploymentId='',checkerPersonId='',checkerUserId='';
 const f=await contractPostingFixture({endOn:addDaysIso(targetStart,-1),beforeAdopt:async({admin,employee,b,start,newStart})=>{
  expect((await withTenant(admin,tx=>deriveCompanyOrganisationTx(tx,admin,{companyId:b.companyId,asOf:start}))).status).toBe('legacy');
  // The actual recorded movements precede publication. No classification exists at their dates yet.
  await createMovementEvent(admin,{employmentId:employee.employmentId,kind:'transfer',effectiveDate:addDaysIso(newStart,5),departmentId:b.deptB,remarks:'Fictional later legacy department decision'});
  await createMovementEvent(admin,{employmentId:employee.employmentId,kind:'salaryAdjustment',effectiveDate:addDaysIso(newStart,10),basicSalary:5291.42,remarks:'Fictional later legacy salary decision'});
  const checkerEmployee=await hireEmployee(admin,{person:{fullName:'Fictional independent Org checker',primaryEmail:randomUUID()+'@org-posting.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
  checkerEmploymentId=checkerEmployee.employmentId;checkerPersonId=checkerEmployee.personId;
  await setCompensation(admin,{employmentId:checkerEmploymentId,basicSalary:3100,effectiveFrom:start});
  checkerUserId=await createAppUser(b.tenantId,checkerPersonId,'hr_admin');
  const checker:SessionContext={...admin,userId:checkerUserId,personId:checkerPersonId,roles:['hr_admin'],grants:undefined};
  expect(checker.userId).not.toBe(admin.userId);expect(checker.personId).not.toBe(admin.personId);
  const unit=await createBusinessUnit(admin,{companyId:b.companyId,code:'CONTRACT-MANAGED',name:'Fictional published Contract unit'});unitId=unit.id;
  await setLabelGlobal(admin,{kind:'business_unit',labelId:unitId,isGlobal:true});
  otherCompanyId=(await createCompany(admin,{legalName:'Fictional wrong-scope company'})).id;
  const runId=await prepareCompanyOrganisationRun(admin,{kind:'mapping',companyIds:[b.companyId],effectiveOn:start,changes:[{companyId:b.companyId,businessUnitId:unitId,parentCompanyId:null}]});
  const report=await companyOrganisationRunReport(checker,runId);
  await decideCompanyOrganisationRun(checker,{id:runId,digest:report.run.digest,approve:true,reason:'Independent review of actual fictional mapping and population'});
  let published=await processCompanyOrganisationRun(admin,runId);
  for(let attempt=0;attempt<30&&published.state==='staging';attempt++)published=await processCompanyOrganisationRun(admin,runId);
  expect(published.state).toBe('published');
 }});
 expect(unitId&&otherCompanyId&&checkerEmploymentId&&checkerUserId).toBeTruthy();
 const dates=[addDaysIso(f.newStart,5),addDaysIso(f.newStart,10)];
 expect(dates.every(day=>addDaysIso(day,1)<=f.today)).toBe(true);
 const classificationsBefore=await owner.db.execute<{id:string;day:string;unit:string;status:string}>(sql`select id,effective_on::text as day,tags->>'businessUnitId' as unit,tags->>'status' as status from public.employment_organisation_classification where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid order by effective_on,id`);
 expect(classificationsBefore.length).toBeGreaterThan(0);expect(classificationsBefore.every(row=>row.day===f.start&&row.unit===unitId&&row.status==='ready')).toBe(true);
 const posting=await releaseContractPosting(f);
 await setModule(f.b.tenantId,'payroll','active');const payrollAdmin={...f.admin,entitlements:(await entitledCtx(f.b)).entitlements};
 await requirePackFor('MY').statutory.set(payrollAdmin,{personId:f.employee.personId,icNumber:'900101010001',taxCategory:1,numChildren:0});
 await requirePackFor('MY').statutory.set(payrollAdmin,{personId:checkerPersonId,icNumber:'900101010002',taxCategory:1,numChildren:0});
 const{batchId}=await createBatch(payrollAdmin,{companyId:f.b.companyId,payPeriod:targetStart.slice(0,7),scope:{employmentIds:[f.employee.employmentId,checkerEmploymentId]}});
 await generatePayslips(payrollAdmin,{batchId});await closeBatch(payrollAdmin,{batchId});
 const slips=await owner.db.execute<{id:string;employment:string;row:Record<string,unknown>}>(sql`select id,employment_id as employment,to_jsonb(p) as row from public.payslip p where tenant_id=${f.b.tenantId}::uuid and batch_id=${batchId}::uuid order by id`);
 expect(slips).toHaveLength(2);const subjectSlip=slips.find(row=>row.employment===f.employee.employmentId)!,otherSlip=slips.find(row=>row.employment===checkerEmploymentId)!;expect(subjectSlip&&otherSlip).toBeTruthy();
 const[closedBefore]=await owner.db.execute<{row:Record<string,unknown>}>(sql`select to_jsonb(b) as row from public.payroll_batch b where tenant_id=${f.b.tenantId}::uuid and id=${batchId}::uuid`);
 expect(closedBefore.row.status).toBe('closed');
 const[unpreserved]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.information_payslip_snapshot where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid`);expect(unpreserved.n).toBe(0);
 const[rights]=await withTenant(f.approver,tx=>tx.execute<{maintain:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain`));expect(rights.maintain).toBe(false);
 const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});if(queued.postingStatus!=='pending')throw Error('A genuine first approval must queue.');

 const suffix=randomUUID().replaceAll('-',''),log='_test_contract_org_snapshot_'+suffix,orgFn='_test_contract_org_frame_'+suffix,snapshotFn='_test_contract_snapshot_row_'+suffix;
 const orgTrigger='test_contract_org_'+suffix,snapshotTrigger='test_contract_snapshot_'+suffix;
 // Identifiers and trigger arguments below are generated hex or actual native UUIDs, never user SQL.
 for(const value of [queued.jobId,checkerEmploymentId,otherCompanyId,unitId,subjectSlip.id,otherSlip.id,checkerUserId,f.employee.employmentId])expect(value).toMatch(/^[0-9a-f-]{36}$/i);
 try{
  await owner.client.unsafe(`CREATE TABLE app.${log}(kind text NOT NULL,direction text,denied integer NOT NULL,backend_pid integer NOT NULL);
   REVOKE ALL ON app.${log} FROM PUBLIC,ai_hr_app;
   CREATE FUNCTION app.${orgFn}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $probe$
   DECLARE step app.contract_posting_replay_step;root public.domain_event;actual_day date;actual_company uuid;tags jsonb;blocked boolean;denied integer:=0;
   BEGIN
    IF NEW.job_id::text<>TG_ARGV[0] OR NEW.active_ordinal IS NULL THEN RETURN NEW;END IF;
    IF NEW.backend_pid<>pg_backend_pid() OR NEW.xact_id<>txid_current() OR NEW.job_id::text IS DISTINCT FROM current_setting('app.bulk_job',true)
    THEN RAISE EXCEPTION 'The probe must run in the actual worker leg';END IF;
    SELECT * INTO step FROM app.contract_posting_replay_step WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id AND xact_id=NEW.xact_id AND backend_pid=NEW.backend_pid AND ordinal=NEW.active_ordinal;
    SELECT * INTO root FROM public.domain_event WHERE tenant_id=NEW.tenant_id AND id=step.event_id AND subject_employment_id=NEW.employment_id;
    actual_day:=coalesce(root.payload->'movement'->>'effectiveDate',root.payload->>'effectiveDate')::date;
    actual_company:=CASE step.direction WHEN 'inverse' THEN step.company_before ELSE step.company_after END;
    IF actual_day IS NULL OR actual_day+1>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Use an exact past native source date';END IF;
    tags:=app.contract_posting_company_org_tags(NEW.job_id,NEW.employment_id,actual_company,actual_day);
    IF tags->>'status' IS DISTINCT FROM 'ready' OR tags->>'businessUnitId' IS DISTINCT FROM TG_ARGV[3] THEN RAISE EXCEPTION 'The actual native leg must see the published mapping';END IF;
    blocked:=false;BEGIN PERFORM app.contract_posting_company_org_tags(NEW.job_id,TG_ARGV[1]::uuid,actual_company,actual_day);EXCEPTION WHEN SQLSTATE '42501' THEN blocked:=true;END;
    IF NOT blocked THEN RAISE EXCEPTION 'Wrong actual subject admitted';END IF;denied:=denied+1;
    blocked:=false;BEGIN PERFORM app.contract_posting_company_org_tags(NEW.job_id,NEW.employment_id,actual_company,actual_day+1);EXCEPTION WHEN SQLSTATE '42501' THEN blocked:=true;END;
    IF NOT blocked THEN RAISE EXCEPTION 'Wrong still-past native date admitted';END IF;denied:=denied+1;
    blocked:=false;BEGIN PERFORM app.contract_posting_company_org_tags(NEW.job_id,NEW.employment_id,TG_ARGV[2]::uuid,actual_day);EXCEPTION WHEN SQLSTATE '42501' THEN blocked:=true;END;
    IF NOT blocked THEN RAISE EXCEPTION 'Wrong actual company admitted';END IF;denied:=denied+1;
    blocked:=false;BEGIN PERFORM app.contract_posting_record_org_tags(NEW.job_id,NEW.employment_id,actual_company,actual_day,'hire');EXCEPTION WHEN SQLSTATE '42501' THEN blocked:=true;END;
    IF NOT blocked THEN RAISE EXCEPTION 'Wrong private writer trigger admitted';END IF;denied:=denied+1;
    INSERT INTO app.${log}(kind,direction,denied,backend_pid) VALUES('org',step.direction,denied,pg_backend_pid());
    RETURN NEW;
   END $probe$;
   REVOKE ALL ON FUNCTION app.${orgFn}() FROM PUBLIC,ai_hr_app;
   CREATE TRIGGER ${orgTrigger} AFTER UPDATE OF active_ordinal ON app.contract_posting_replay_state FOR EACH ROW
    WHEN(NEW.active_ordinal IS NOT NULL AND OLD.active_ordinal IS DISTINCT FROM NEW.active_ordinal)
    EXECUTE FUNCTION app.${orgFn}('${queued.jobId}','${checkerEmploymentId}','${otherCompanyId}','${unitId}');
   CREATE FUNCTION app.${snapshotFn}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $probe$
   DECLARE original_row jsonb;altered jsonb;denied integer:=0;
   BEGIN
    IF NEW.employment_id::text<>TG_ARGV[1] OR current_setting('app.bulk_job',true) IS DISTINCT FROM TG_ARGV[0] THEN RETURN NEW;END IF;
    original_row:=to_jsonb(NEW);
    IF app.contract_posting_snapshot_insert_allowed(original_row) IS NOT TRUE THEN RAISE EXCEPTION 'The actual emitted canonical snapshot must be admitted';END IF;
    FOR altered IN SELECT original_row||jsonb_build_object('grade','Fictional forged grade')
     UNION ALL SELECT original_row||jsonb_build_object('employment_type',CASE WHEN NEW.employment_type='full_time' THEN 'contract' ELSE 'full_time' END)
     UNION ALL SELECT original_row||jsonb_build_object('hired_on',NEW.hired_on+1)
     UNION ALL SELECT original_row||jsonb_build_object('join_date',coalesce(NEW.join_date,DATE '2000-01-01')+1)
     UNION ALL SELECT original_row||jsonb_build_object('document_metadata',coalesce(NEW.document_metadata,'{}'::jsonb)||jsonb_build_object('testForged',true))
     UNION ALL SELECT original_row||jsonb_build_object('employment_id',TG_ARGV[2]::uuid)
     UNION ALL SELECT original_row||jsonb_build_object('payslip_id',TG_ARGV[3]::uuid)
     UNION ALL SELECT original_row||jsonb_build_object('company_id',TG_ARGV[4]::uuid)
     UNION ALL SELECT original_row||jsonb_build_object('recorded_by',TG_ARGV[5]::uuid)
     UNION ALL SELECT original_row||jsonb_build_object('created_at',NEW.created_at+interval '1 second')
    LOOP
     IF app.contract_posting_snapshot_insert_allowed(altered) IS NOT FALSE THEN RAISE EXCEPTION 'A changed snapshot row was admitted';END IF;
     denied:=denied+1;
    END LOOP;
    INSERT INTO app.${log}(kind,direction,denied,backend_pid) VALUES('snapshot',NULL,denied,pg_backend_pid());
    RETURN NEW;
   END $probe$;
   REVOKE ALL ON FUNCTION app.${snapshotFn}() FROM PUBLIC,ai_hr_app;
   CREATE TRIGGER ${snapshotTrigger} BEFORE INSERT ON public.information_payslip_snapshot FOR EACH ROW
    EXECUTE FUNCTION app.${snapshotFn}('${queued.jobId}','${f.employee.employmentId}','${checkerEmploymentId}','${otherSlip.id}','${otherCompanyId}','${checkerUserId}');`);
  await finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply');
  expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'applied'});
  const probes=await owner.client.unsafe<{kind:string;direction:string|null;denied:number;backend_pid:number}[]>(`select kind,direction,denied,backend_pid from app.${log} order by kind,direction`);
  expect(probes.filter(row=>row.kind==='org').length).toBeGreaterThanOrEqual(4);expect(new Set(probes.filter(row=>row.kind==='org').map(row=>row.direction))).toEqual(new Set(['inverse','replay']));
  expect(probes.filter(row=>row.kind==='org').every(row=>row.denied===4)).toBe(true);
  expect(probes.filter(row=>row.kind==='snapshot')).toHaveLength(1);expect(probes.find(row=>row.kind==='snapshot')?.denied).toBe(10);
  const classified=await owner.db.execute<{id:string;day:string;unit:string;status:string;actor:string;kind:string}>(sql`select id,effective_on::text as day,tags->>'businessUnitId' as unit,tags->>'status' as status,actor_id as actor,actor_kind as kind from public.employment_organisation_classification where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid order by effective_on,id`);
  const newRows=classified.filter(row=>!classificationsBefore.some(old=>old.id===row.id));expect(newRows.length).toBeGreaterThan(0);
  for(const day of dates)expect(newRows.some(row=>row.day===day)).toBe(true);
  expect(newRows.every(row=>row.unit===unitId&&row.status==='ready'&&row.kind==='user'&&row.actor===f.approver.userId)).toBe(true);
  const audit=await owner.db.execute<{day:string;actor:string;job:string;kind:string;unit:string}>(sql`select payload->>'effectiveOn' as day,actor_id as actor,payload->'bulkJob'->>'id' as job,payload->'bulkJob'->>'kind' as kind,payload->'after'->>'businessUnitId' as unit from public.domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.organisation-tagged' and payload->'bulkJob'->>'id'=${queued.jobId} order by sequence`);
  expect(audit.length).toBeGreaterThan(0);expect(audit.every(row=>row.actor===f.approver.userId&&row.job===queued.jobId&&row.kind==='contract_posting_apply'&&row.unit===unitId)).toBe(true);
  for(const row of newRows)expect(audit.some(event=>event.day===row.day)).toBe(true);
  const[final]=await owner.db.execute<{unit:string;department:string;salary:string;counter:number;start:string;end:string}>(sql`select a.business_unit_id as unit,a.department_id as department,c.basic_salary::text as salary,e.contract_number as counter,e.contract_start_date::text as start,e.contract_end_date::text as end from public.employment e join public.assignment a on a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null join public.compensation c on c.tenant_id=e.tenant_id and c.employment_id=e.id and c.valid_to is null and c.superseded_at is null where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);
  expect(final).toEqual({unit:unitId,department:f.b.deptB,salary:'5291.42',counter:5,start:f.newStart,end:f.newEnd});
  expect(await owner.db.execute(sql`select id,employment_id as employment,to_jsonb(p) as row from public.payslip p where tenant_id=${f.b.tenantId}::uuid and batch_id=${batchId}::uuid order by id`)).toEqual(slips);
  const[closedAfter]=await owner.db.execute<{row:Record<string,unknown>}>(sql`select to_jsonb(b) as row from public.payroll_batch b where tenant_id=${f.b.tenantId}::uuid and id=${batchId}::uuid`);expect(closedAfter).toEqual(closedBefore);
 }finally{
  await owner.client.unsafe(`DROP TRIGGER IF EXISTS ${orgTrigger} ON app.contract_posting_replay_state;
   DROP TRIGGER IF EXISTS ${snapshotTrigger} ON public.information_payslip_snapshot;
   DROP FUNCTION IF EXISTS app.${orgFn}();DROP FUNCTION IF EXISTS app.${snapshotFn}();DROP TABLE IF EXISTS app.${log};`);
 }
},180_000);
