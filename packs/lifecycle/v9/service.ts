import { v9CompanySigners, v9SignatoryTitle } from '../../../lib/lifecycle-v9-signatories';
import { resolveV9CaseFields, validateV9CaseValue, offCaseFormValues } from '../../../lib/lifecycle-v9-case-form';
import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { withLifecycleTenant } from '../../../core/module-gate';
import { todayInKualaLumpur, timeInKualaLumpur } from '../../../lib/hr-date';
import type { NotificationSweepConnection } from '../../../core/notice-projection';
import { assertModuleEnabled } from '../../../core/entitlements';
import * as M from '../../../lib/lifecycle-v9-model';
import { v9EmploymentLabels } from '../../../lib/lifecycle-v9-employment';
import { projectNativeCase, nativeDocumentState } from '../../../lib/lifecycle-v9-native';
import { OnboardingError, nativeCaseFormValues, effectiveFacts as nativeFacts } from '../../../lib/onboarding-model';
import { changeV9Note, type CaseNoteCommand } from '../../../lib/lifecycle-v9-notes';
import { v9Defaults } from '../../../lib/lifecycle-v9-defaults';
import { parseV9Config, validateV9ConfigChange, v9Equal } from '../../../lib/lifecycle-v9-validation';
import { readSettlementTx, type SettlementView } from './settlement';
import { readV9PersonnelTx, pushV9PersonnelTx, lockV9PersonnelWritesTx, v9PersonnelWritableKeys } from '../../../core/lifecycle-v9-personnel';
import { onboardingFulfilmentGroupTx, onboardingHoldingsTx, onboardingReturnCatalogueTx, onboardingRecoverHoldingTx, onboardingCommand, onboardingV9ReadTx, onboardingV9StoreTx, onboardingSetupTx, onboardingEnableV9OffboardingTx, onboardingSaveGroupsTx, onboardingV9DefinitionsChangedTx, onboardingAssignmentLoadsTx, onboardingUnavailableTx } from '../onboarding/service';
import { issuedToTx, returnAssetTx } from '../../../core/lifecycle-assets';
import { lifecycleV9EmailIpc } from '../../../lib/lifecycle-v9-email-ipc';
import type { LifecycleV9DeliveryRequest, LifecycleV9DeliveryResult } from '../../../lib/lifecycle-v9-delivery-model';
import { resolveDocumentUpload } from '../../../core/employee-documents';

type Row = { id: string; revision: number; company_id: string; data: M.Case; native?: true };
export type DirectoryUser = { id: string; name: string };
export type Options = { users: DirectoryUser[]; companies: { id: string; name: string; registrationNo?: string; address?: string }[]; employees: { id: string; name: string; employeeNo: string; companyId: string }[]; signatoryCandidates?: Record<string,string[]>; signatoryCandidatesByModule?:Record<M.Module,Record<string,string[]>>; labels?: Partial<Record<M.RuleField, Record<string, string>>>; leaveTypes?: { id: string; name: string }[] };
export type Workspace = { permissions?:{onboarding:boolean;offboarding:boolean;administration:boolean}; config: M.Config | null; cases: M.Case[]; options: Options; canConfigure: boolean; actor: M.Actor; personnelWritableKeys: string[]; templateUsage?: M.TemplateUsage[]; definitionUsage?: M.DefinitionUsage[] };
export type OwnCase = Pick<M.Case, 'id' | 'number' | 'module' | 'revision' | 'state' | 'facts' | 'tasks' | 'items' | 'documents'> & { own: boolean; equipment?: { id: string; name: string; kind: 'device'|'system'; state: string; approval: string; handedAt: string|null; receipt: {status:'received'|'problem';at:string;by:string;note:string}|null }[] };
export type PendingReturns = { held:{id:string;name:string;kind:'system'|'device';group:string|null;source:'asset'|'onboarding';catalogueId?:string;requestNumber?:string}[]; catalogue:{id:string;name:string;kind:'system'|'device';group:string;active:boolean}[]; selected:string[] };
export type CaseDetail = { returns?:PendingReturns; case: M.Case; calculation: SettlementView | null; personnelWritableKeys: string[]; native?: { config: M.Config; actor: M.Actor } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identifier(value: string): string { if (!uuid.test(value)) throw new M.V9Error('A valid record identifier is required.'); return value; }
async function admin(tx: Tx, companyId?: string): Promise<void> {
  const [result] = await tx.execute<{ ok: boolean }>(companyId ? sql`select app.is_admin_for(${companyId}::uuid) as ok` : sql`select app.is_group_admin() as ok`);
  if (!result?.ok) throw new M.V9Error('You do not have permission to change this lifecycle record.', 'forbidden');
}
async function companySignersTx(tx:Tx,tenantId:string,companyId:string,module?:M.Module):Promise<string[]> {
  const users=await tx.execute<{id:string}>(sql`select u.id from app_user u where u.tenant_id=${tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id) and exists(select 1 from lc_onboarding_config cfg where cfg.tenant_id=u.tenant_id and ((${module??null}::text is null and (cfg.data->'access'->'offboarding' ? u.id::text or cfg.data->'access'->'onboarding' ? u.id::text)) or (${module??null}::text='off' and cfg.data->'access'->'offboarding' ? u.id::text) or (${module??null}::text='onb' and cfg.data->'access'->'onboarding' ? u.id::text))) and exists(select 1 from role_assignment r where r.tenant_id=u.tenant_id and r.app_user_id=u.id and r.role in ('super_admin','hr_admin') and (r.company_id is null or r.company_id=${companyId}::uuid)) order by u.id`);
  return users.map(user=>user.id);
}
async function actor(tx: Tx, ctx: SessionContext): Promise<M.Actor> {
  if (!ctx.userId) { const [owner] = await tx.execute<{ ok: boolean }>(sql`select current_user='ai_hr_owner' OR EXISTS(select 1 from pg_roles where rolname=current_user and rolsuper) as ok`); if (owner?.ok) return { id: 'system', name: 'System' }; throw new M.V9Error('Sign in to continue.', 'forbidden'); }
  const [user] = await tx.execute<{ id: string; name: string }>(sql`select u.id,coalesce(p.full_name,'User') as name from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  if (!user) throw new M.V9Error('Your account is not available.', 'forbidden'); return user;
}
async function configTx(tx: Tx, ctx: SessionContext, lock = false): Promise<M.Config | null> {
  const [row] = await tx.execute<{ data: M.Config }>(sql`select data from lc_v9_config where tenant_id=${ctx.tenantId}::uuid ${lock ? sql`for update` : sql``}`);
  if (!row) return null;
  const [shared] = await tx.execute<{ revision: number; data: { groups: M.Group[] } }>(sql`select revision,data from lc_onboarding_config where tenant_id=${ctx.tenantId}::uuid`);
  return { ...row.data, groups: shared?.data.groups ?? [], groupsRevision: shared?.revision ?? 0 };
}
async function lockTx(tx: Tx, ctx: SessionContext): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit-chain:' || ${ctx.tenantId}::uuid::text))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':onboarding'},0))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'lifecycle-v9:' + ctx.tenantId},0))`);
}
async function load(tx: Tx, ctx: SessionContext, id: string): Promise<Row> {
  const [row] = await tx.execute<Row>(sql`select id,revision,company_id,data from lc_v9_case where tenant_id=${ctx.tenantId}::uuid and id=${identifier(id)}::uuid for update`);
  if (!row) {
    const native = await onboardingV9ReadTx(ctx, tx, id);
    return { id: native.c.id, revision: native.row.revision, company_id: native.row.companyId, data: projectNativeCase(native.c, native.row.revision, native.documentState, native.employeeUserId, native.supervisorUserId), native: true };
  }
  await admin(tx, row.company_id); return row;
}
async function record(tx: Tx, ctx: SessionContext, id: string, employmentId: string, action: string): Promise<void> {
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'lifecycle-v9-case', aggregateId: id, eventType: `lifecycle-v9.${action}`, actor: actorOf(ctx), subjectEmploymentId: employmentId || null, payload: { caseId: id, action } });
}
async function store(tx: Tx, ctx: SessionContext, row: Row, next: M.Case, action: string): Promise<void> {
  if (row.native) {
    await onboardingV9StoreTx(ctx, tx, row.id, row.revision, nativeDocumentState(next), next.tasks.filter(task => task.status === 'done' && task.documentTemplate).map(task => task.id), action);
    return;
  }
  await tx.execute(sql`insert into lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) values(${ctx.tenantId}::uuid,${row.id}::uuid,${row.company_id}::uuid,${row.revision},${JSON.stringify(row.data)}::jsonb,${ctx.userId ?? null}::uuid)`);
  next.revision = row.revision + 1;
  const updated = await tx.execute<{ id: string }>(sql`update lc_v9_case set data=${JSON.stringify(next)}::jsonb,revision=${next.revision},updated_at=now() where id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and revision=${row.revision} returning id`);
  if (!updated.length) throw new M.V9Error('This case changed. Refresh it before trying again.', 'conflict');
  if (row.data.state !== 'cleared' && next.state === 'cleared' && next.finalFigures) await tx.execute(sql`insert into lc_v9_payroll_handover(id,tenant_id,company_id,case_id,employment_id,data) values(${next.finalFigures.payrollReference}::uuid,${ctx.tenantId}::uuid,${row.company_id}::uuid,${row.id}::uuid,${next.facts.employmentId}::uuid,${JSON.stringify(next.finalFigures)}::jsonb)`);
  if (row.data.state === 'cleared' && next.state !== 'cleared') await tx.execute(sql`update lc_v9_payroll_handover set status='withdrawn',updated_at=now() where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and status in ('pending','reviewed')`);
  await record(tx, ctx, row.id, next.facts.employmentId, action);
}
async function environment(tx: Tx, ctx: SessionContext, c: M.Case, config: M.Config): Promise<M.Environment> {
  const who = await actor(tx, ctx), today = todayInKualaLumpur();
  const users = await tx.execute<DirectoryUser>(sql`select u.id,coalesce(p.full_name,'User') as name from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  const dates = new Set([today, c.facts.lastDay, c.facts.joinDate, ...c.tasks.map(t => t.dueOn)]);
  const anchor = c.module === 'onb' ? c.facts.joinDate : c.facts.lastDay;
  if (M.validDate(anchor)) for (const cl of config.checklists.filter(x => x.module === c.module)) for (const t of cl.tasks) dates.add(M.taskDate(c.module, anchor, t.due));
  const unavailable = await onboardingUnavailableTx(tx, [...dates]);
  const sharedLoads = await onboardingAssignmentLoadsTx(tx);
  const company = await tx.execute<{ name: string; registrationNo: string; address: string }>(sql`select legal_name as name,coalesce(registration_no,'') as "registrationNo",concat_ws(', ',nullif(trim(address_line1),''),nullif(trim(address_line2),''),nullif(trim(address_line3),''),nullif(trim(postcode),''),nullif(trim(city),''),nullif(trim(state),''),nullif(trim(address_country),'')) as address from company where id=${c.facts.company}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  const [personnel] = await tx.execute<{ position: string | null; department: string | null; business_group: string | null }>(sql`select (select title from position where id::text=${c.facts.title} and tenant_id=${ctx.tenantId}::uuid) as position,(select name from department where id::text=${c.facts.department} and tenant_id=${ctx.tenantId}::uuid) as department,(select name from business_unit where id::text=${c.facts.businessGroup} and tenant_id=${ctx.tenantId}::uuid) as business_group`);
  const native = c.module === 'onb' ? await onboardingV9ReadTx(ctx, tx, c.id) : null;
  const nf = native ? nativeFacts(native.c) : null;
  const source = c.facts.employmentId ? await readV9PersonnelTx(tx, ctx, c.facts.employmentId) : { email: nf?.email ?? '', icNo: nf?.ic ?? '', passportNo: nf?.passport ?? '' };
  const fmt = (value: string) => M.validDate(value) ? value.slice(8) + '/' + value.slice(5, 7) + '/' + value.slice(0, 4) : '';
  const values: Record<string, string> = { ...source,
    'employee.name': c.facts.name, 'employee.empNo': c.facts.employeeNo, 'employee.position': personnel?.position ?? c.facts.title, 'employee.department': personnel?.department ?? c.facts.department,
    'employee.icNo': source.icNo ?? '', 'employee.passportNo': source.passportNo ?? '', 'employee.supervisor': users.find(u => u.id === c.facts.supervisorUserId)?.name ?? '',
    'company.name': company[0]?.name ?? '', 'joiner.joinDate': fmt(c.facts.joinDate), 'leaver.lastDay': fmt(c.facts.lastDay),
    'leaver.noticeDate': fmt(c.facts.noticeDate), 'leaver.type': c.facts.caseType, 'today.date': fmt(today), today: fmt(today),
    'signatory.name': who.name, 'onboarding.progress': M.work(c).percent + '%', name: c.facts.name, empNo: c.facts.employeeNo, company: company[0]?.name ?? '', position: personnel?.position ?? c.facts.title, group: personnel?.business_group ?? c.facts.businessGroup, icNo: source.icNo ?? '', email: source.email ?? '',
  };
  const signatory = config.companies?.find(co => co.companyId === c.facts.company);
  values['signatory.name'] = users.find(u => u.id === signatory?.signatoryUserId)?.name ?? '';
  values['signatory.title'] = v9SignatoryTitle(config,signatory?.signatoryUserId,c.facts.company);
  values['company.regNo'] = signatory?.letterhead?.registrationNo ?? company[0]?.registrationNo ?? '';
  values['company.address'] = signatory?.letterhead?.address ?? company[0]?.address ?? '';
  values['company.color'] = signatory?.letterhead?.color ?? '#4F46E5';
  values['employee.company']=company[0]?.name??'';values['employee.businessGroup']=personnel?.business_group??'';
  const caseFields=resolveV9CaseFields(c.module,config.caseForms?.[c.module]),caseValues=native?nativeCaseFormValues(native.c):offCaseFormValues(c);
  const caseLabels: Record<string,string>={name:c.facts.name,company:company[0]?.name??'',group:personnel?.business_group??'',dept:personnel?.department??'',position:personnel?.position??'',supervisor:users.find(user=>user.id===c.facts.supervisorUserId)?.name??'',ta:users.find(user=>user.id===c.facts.taUserId)?.name??''};
  for(const field of caseFields) values['case.'+field.key]=field.key in caseLabels?caseLabels[field.key]:field.type==='date'?fmt(caseValues[field.key]??''):caseValues[field.key]??'';

  const calculation = c.module === 'off' ? await readSettlementTx(tx, ctx, c, config) : null;
  if (calculation?.ready) Object.assign(values, { 'leave.remaining': String(calculation.remainingLeave), 'leave.encashDays': String(calculation.encashDays), 'leave.encashAmount': `${calculation.currency} ${calculation.amount!.toFixed(2)}`, 'leave.dailyRate': `${calculation.currency} ${calculation.dailyRate!.toFixed(2)}`, 'pay.finalPayDate': fmt(calculation.payDate) });
  return { today, now: new Date().toISOString(), actor: who, nextId: randomUUID,
    onLeave: (id, date) => unavailable.some(r => r.user_id === id && r.on_date === date),
    openLoad: id => Number(sharedLoads.find(load => load.user_id === id)?.task_load ?? 0),
    lastAssigned: id => { const last = sharedLoads.find(load => load.user_id === id)?.last_auto; return last ? Date.parse(last) || 0 : 0; },
    eligibleUser: id => users.some(u => u.id === id), userName: id => users.find(u => u.id === id)?.name ?? 'Unlinked user', mergeValues: values, signatoryUserId: signatory?.signatoryUserId ?? null, actorSignatoryTitle:v9SignatoryTitle(config,who.id,c.facts.company), requireDeliveryAck: true, ...(native && !c.facts.employeeUserId && z.email().max(320).regex(/^[\x21-\x7e]+$/).safeParse((native.c.caseContactEmail ?? nf?.email)?.trim()).success ? { onboardingContact: { email: (native.c.caseContactEmail ?? nf!.email).trim(), sourceRevision: native.c.sourceVersion } } : {}) };
}
async function pendingReturnsTx(tx:Tx,ctx:SessionContext,c:M.Case):Promise<PendingReturns> {
  const assets=c.facts.employeeNo.trim()?await issuedToTx(tx,c.facts.employeeNo,c.facts.company):[],holdings=await onboardingHoldingsTx(ctx,tx,c.facts.employmentId,c.facts.company);
  return {held:[...assets.map(asset=>({id:'asset:'+asset.id,name:`${asset.code} · ${asset.model??asset.assetType}`,kind:'device' as const,group:null,source:'asset' as const})),...holdings.map(item=>({id:'onboarding:'+item.itemId,name:item.name,kind:item.kind,group:item.group,source:'onboarding' as const,catalogueId:item.catalogueId,requestNumber:item.requestNumber}))],catalogue:await onboardingReturnCatalogueTx(ctx,tx,c.facts.company),selected:c.returnSelections??[]};
}
export async function v9CaseDetail(ctx: SessionContext, id: string): Promise<CaseDetail> {
  return withLifecycleTenant(ctx, async tx => {
    const row = await load(tx, ctx, id), config = await configTx(tx, ctx);
    if (!config) throw new M.V9Error('V9 configuration is not available.');
    return { ...(row.data.module==='off'&&row.data.state==='pending'?{returns:await pendingReturnsTx(tx,ctx,row.data)}:{}), case: row.data, calculation: await readSettlementTx(tx, ctx, row.data, config), personnelWritableKeys: v9PersonnelWritableKeys, ...(row.native ? { native: { config, actor: await actor(tx, ctx) } } : {}) };
  });
}

export async function v9PreviewEmail(ctx: SessionContext, caseId: string, emailId: string): Promise<M.EmailPreview> {
  emailId = z.string().min(1).max(120).parse(emailId);
  return withLifecycleTenant(ctx, async tx => {
    const row = await load(tx, ctx, caseId), config = await configTx(tx, ctx);
    if (!config) throw new M.V9Error('V9 configuration is not available.');
    return M.previewEmail(row.data, config, emailId, await environment(tx, ctx, row.data, config));
  });
}

export type UpdatedEmailPreview={sourceRevision:string;subject:string;body:string;to:string[];cc:string[];documents:{name:string;version:number}[];files:string[]};
function updatedEmailRevision(c:M.Case,config:M.Config,env:M.Environment,plan:ReturnType<typeof M.updatedDeliveryPlan>):string {
  const documentRef=(id:string)=>{const document=plan.case.documents.find(candidate=>candidate.id===id);return document?{templateId:document.templateId,version:document.version}:null;};
  return createHash('sha256').update(JSON.stringify({caseId:c.id,revision:c.revision,configRevision:config.revision,source:env.mergeValues,contact:env.onboardingContact??null,mail:{templateId:plan.mail.templateId,to:plan.mail.to,cc:plan.mail.cc,subject:plan.mail.subject,body:plan.mail.body,documents:plan.mail.documentIds.map(documentRef),files:plan.mail.fileIds,delivery:{...plan.mail.delivery,linkDocumentIds:plan.mail.delivery?.linkDocumentIds.map(documentRef),pdfDocumentIds:plan.mail.delivery?.pdfDocumentIds.map(documentRef)}}})).digest('hex');
}
async function updatedEmailAllowed(tx:Tx,id:string,mailId:string):Promise<void> {
  const [result]=await tx.execute<{ok:boolean}>(sql`select app.lc_v9_email_replaceable(${id}::uuid,${mailId}) as ok`);
  if(!result?.ok)throw new M.V9Error('This delivery receipt does not allow an updated copy. Review the recorded outcome.','conflict');
}
export async function v9PreviewUpdatedEmail(ctx:SessionContext,id:string,mailId:string):Promise<UpdatedEmailPreview> {
  mailId=commandId.parse(mailId);
  return withLifecycleTenant(ctx,async tx=>{
    const row=await load(tx,ctx,id),config=await configTx(tx,ctx);if(!config)throw new M.V9Error('V9 configuration is unavailable.');
    await updatedEmailAllowed(tx,id,mailId);const env=await environment(tx,ctx,row.data,config);let sequence=0;
    const plan=M.updatedDeliveryPlan(row.data,config,mailId,{...env,nextId:()=>`preview-${++sequence}`});
    return {sourceRevision:updatedEmailRevision(row.data,config,env,plan),subject:plan.mail.subject,body:plan.mail.body,to:plan.mail.delivery!.toNames,cc:plan.mail.delivery!.ccNames,documents:plan.mail.documentIds.map(id=>plan.case.documents.find(document=>document.id===id)!).map(document=>({name:document.name,version:document.version})),files:[...plan.mail.fileIds.map(id=>plan.case.files.find(file=>file.id===id)!.name),...(plan.mail.delivery?.assets??[]).map(asset=>asset.name)]};
  });
}

export async function v9Workspace(ctx: SessionContext): Promise<Workspace> {
  return withLifecycleTenant(ctx, async tx => {
    const who = await actor(tx, ctx); let config = await configTx(tx, ctx);
    const [permission] = await tx.execute<{ ok: boolean;onboarding:boolean;offboarding:boolean;administration:boolean }>(sql`select app.is_group_admin() as ok, app.onboarding_page_access() as onboarding, app.lc_v9_off_access() as offboarding, app.is_admin() as administration`);
    if(!config&&permission?.onboarding){const [shell]=await tx.execute<{data:M.Config|null}>(sql`select app.lc_v9_onboarding_shell() as data`);config=shell?.data??null;}
    const companies = await tx.execute<{ id: string; name: string; registrationNo: string; address: string }>(sql`select id,legal_name as name,coalesce(registration_no,'') as "registrationNo",concat_ws(', ',nullif(trim(address_line1),''),nullif(trim(address_line2),''),nullif(trim(address_line3),''),nullif(trim(postcode),''),nullif(trim(city),''),nullif(trim(state),''),nullif(trim(address_country),'')) as address from company where tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(id) order by legal_name,id`);
    if (!permission?.ok && !permission?.offboarding && !permission?.onboarding) throw new M.V9Error('Onboarding or Offboarding module access is required. Open your assigned lifecycle tasks instead.', 'forbidden');
    const users = await tx.execute<DirectoryUser>(sql`select u.id,coalesce(p.full_name,'User') as name from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id) order by name,u.id`);
    const signatoryCandidates=Object.fromEntries(await Promise.all(companies.map(async company=>[company.id,await companySignersTx(tx,ctx.tenantId,company.id)] as const)));
    const signatoryCandidatesByModule={onb:Object.fromEntries(await Promise.all(companies.map(async company=>[company.id,await companySignersTx(tx,ctx.tenantId,company.id,'onb')] as const))),off:Object.fromEntries(await Promise.all(companies.map(async company=>[company.id,await companySignersTx(tx,ctx.tenantId,company.id,'off')] as const)))};
    const employees = await tx.execute<{ id: string; name: string; employeeNo: string; companyId: string }>(sql`select e.id,p.full_name as name,e.employee_code as "employeeNo",e.company_id as "companyId" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(e.company_id) order by p.full_name,e.id`);
    const rows = config ? await tx.execute<{ data: M.Case }>(sql`select data from lc_v9_case where tenant_id=${ctx.tenantId}::uuid order by created_at desc,id desc`) : [];
    const masters = await tx.execute<{ kind: M.RuleField; id: string; name: string }>(sql`select 'businessGroup' as kind,id,name from business_unit where tenant_id=${ctx.tenantId}::uuid union all select 'department',id,name from department where tenant_id=${ctx.tenantId}::uuid union all select 'grade',id,name from job_grade where tenant_id=${ctx.tenantId}::uuid union all select 'title',id,title from position where tenant_id=${ctx.tenantId}::uuid`);
    const labels: NonNullable<Options['labels']> = { company: Object.fromEntries(companies.map(c => [c.id, c.name])), employmentType: v9EmploymentLabels, caseType: Object.fromEntries(['Resignation', 'Termination', 'Contract end', 'Retirement', 'Non-confirmation'].map(value => [value, value])) };
    for (const master of masters) (labels[master.kind] ??= {})[master.id] = master.name;
    const leaveTypes = await tx.execute<{ id: string; name: string }>(sql`select id,name from leave_type where tenant_id=${ctx.tenantId}::uuid and archived_at is null order by name,id`);
    const usage = config && permission?.ok ? await tx.execute<M.TemplateUsage>(sql`select template_id as "templateId",version,documents from app.lc_v9_document_usage()`) : [];
    const definitionUsage = config && permission?.ok ? await tx.execute<M.DefinitionUsage>(sql`select kind,definition_id as "definitionId",messages,runs from app.lc_v9_definition_usage()`) : [];
    return { permissions:{onboarding:!!permission?.onboarding,offboarding:!!permission?.offboarding,administration:!!permission?.ok||!!permission?.administration}, definitionUsage: [...definitionUsage], templateUsage: [...usage], config, cases: rows.map(r => r.data), options: { signatoryCandidates, signatoryCandidatesByModule, companies: [...companies], users: [...users], employees: [...employees], labels, leaveTypes: [...leaveTypes] }, canConfigure: !!permission?.ok, actor: who, personnelWritableKeys: v9PersonnelWritableKeys };
  });
}
export async function v9Setup(ctx: SessionContext): Promise<void> {
  if (!ctx.userId) throw new M.V9Error('Sign in to configure this workspace.', 'forbidden');
  await withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); await admin(tx);
    if (await configTx(tx, ctx)) throw new M.V9Error('V9 is already configured.', 'conflict');
    await onboardingSetupTx(ctx, tx);
    await onboardingEnableV9OffboardingTx(ctx,tx);
    const [previous] = await tx.execute<{ revision: number; data: { groups: M.Group[] } }>(sql`select revision,data from lc_onboarding_config where tenant_id=${ctx.tenantId}::uuid`);
    const config = v9Defaults(previous?.data.groups ?? []);
    for (const checklist of config.checklists) { checklist.ownerUserId = ctx.userId!; checklist.createdAt = new Date().toISOString(); }
    const shared = [...(previous?.data.groups ?? [])];
    for (const group of config.groups) if (!shared.some(g => g.id === group.id)) shared.push(group);
    const saved = await onboardingSaveGroupsTx(ctx, tx, previous!.revision, shared);
    config.groups = shared; config.groupsRevision = saved.revision;
    const masters = await tx.execute<{ kind: M.RuleField; id: string; name: string; code: string | null }>(sql`select 'businessGroup' as kind,id,name,code from business_unit where tenant_id=${ctx.tenantId}::uuid union all select 'company',id,legal_name,company_label from company where tenant_id=${ctx.tenantId}::uuid union all select 'department',id,name,label from department where tenant_id=${ctx.tenantId}::uuid union all select 'grade',id,name,code from job_grade where tenant_id=${ctx.tenantId}::uuid union all select 'title',id,title,label from position where tenant_id=${ctx.tenantId}::uuid`);
    const resolveRules = (rules: M.Rules) => { for (const key of Object.keys(rules) as M.RuleField[]) { if (key === 'employmentType' || key === 'caseType') continue; rules[key] = rules[key]?.flatMap(value => { if (uuid.test(value)) return [value]; const found = masters.filter(m => m.kind === key && [m.name.toLocaleLowerCase(), m.code?.toLocaleLowerCase()].includes(value.toLocaleLowerCase())); return found.length ? found.map(m => m.id) : [value]; }); } };
    for (const cl of config.checklists) resolveRules(cl.rules);
    for (const template of config.templates) resolveRules(template.rules);
    const definitions = await onboardingV9DefinitionsChangedTx(ctx, tx, config.groupsRevision!, config.checklists.filter(checklist => checklist.module === 'onb'), config.revision);
    config.groupsRevision = definitions.revision;
    await tx.execute(sql`insert into lc_v9_config(tenant_id,data) values(${ctx.tenantId}::uuid,${JSON.stringify(config)}::jsonb)`);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'lifecycle-v9-config', aggregateId: ctx.tenantId, eventType: 'lifecycle-v9.configured', actor: actorOf(ctx), payload: { version: 9 } });
  });
}
export async function v9SaveConfig(ctx: SessionContext, revision: number, input: unknown): Promise<M.ConfigSaveReceipt> {
  return withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); await admin(tx); const previous = await configTx(tx, ctx, true);
    if (!previous || previous.revision !== revision) throw new M.V9Error('Settings changed. Refresh before saving.', 'conflict');
    const config = parseV9Config(input, previous) as M.Config;
    const references = config.emails.flatMap(email => [...(email.files ?? []), ...(email.images ?? [])].map(asset => ({ emailId: email.id, asset })));
    if (references.length) {
      const ids = [...new Set(references.map(reference => reference.asset.id))];
      const assets = await tx.execute<EmailAssetRow>(sql`select *,octet_length(content) as size from lc_v9_email_asset where tenant_id=${ctx.tenantId}::uuid and id in (${sql.join(ids.map(id => sql`${id}::uuid`),sql`,`)})`);
      for (const reference of references) { const actual = assets.find(asset => asset.id === reference.asset.id && asset.email_template_id === reference.emailId); if (!actual || !v9Equal(emailAssetMetadata(actual), reference.asset)) throw new M.V9Error('An email file no longer matches its uploaded receipt. Upload or select the actual file again.', 'conflict'); }
    }
    const deletesVersion = previous.templates.some(template => { const retained = config.templates.find(next => next.id === template.id); return !retained || template.versions.some(version => !retained.versions.some(next => next.version === version.version)); });
    const usage = deletesVersion ? await tx.execute<M.TemplateUsage>(sql`select template_id as "templateId",version,documents from app.lc_v9_document_usage()`) : [];
    validateV9ConfigChange(previous, config, [...usage]);
    const removedDefinitions = [...previous.templates.filter(template => !config.templates.some(next => next.id === template.id)).map(template => ({ kind: 'document', id: template.id })), ...previous.emails.filter(email => !config.emails.some(next => next.id === email.id)).map(email => ({ kind: 'email', id: email.id }))];
    if (removedDefinitions.length) {
      const references = await tx.execute<M.DefinitionUsage>(sql`select kind,definition_id as "definitionId",messages,runs from app.lc_v9_definition_usage()`);
      for (const removed of removedDefinitions) if (references.some(reference => reference.kind === removed.kind && reference.definitionId === removed.id && (reference.messages > 0 || reference.runs > 0))) throw new M.V9Error(removed.kind === 'email' ? 'An email with delivery or workflow history cannot be deleted. Turn it off instead.' : 'A template with workflow history cannot be deleted. Retire it instead.');
    }

    if (config.groupsRevision !== previous.groupsRevision) throw new M.V9Error('Assignment groups changed. Refresh before saving.', 'conflict');
    if (!v9Equal(config.groups, previous.groups)) {
      const saved = await onboardingSaveGroupsTx(ctx, tx, previous.groupsRevision!, config.groups);
      config.groupsRevision = saved.revision;
    }
    const users = await tx.execute<{ id: string }>(sql`select id from app_user where tenant_id=${ctx.tenantId}::uuid and archived_at is null`);
    if (config.groups.some(g => g.members.some(id => !users.some(u => u.id === id)))) throw new M.V9Error('A group includes an unavailable user.');
    const recipientRoles = [...config.emails.flatMap(email => email.cc), ...config.workflows.flatMap(workflow => workflow.steps.flatMap(step => 'to' in step ? [...(Array.isArray(step.to) ? step.to : [step.to]), ...step.cc] : [] ))];
    for (const role of recipientRoles) {
      if (role.startsWith('person:') && !users.some(user => user.id === role.slice(7))) throw new M.V9Error('Choose an available person from this tenant for the recipient.');
      if (role.startsWith('group:') && !config.groups.some(group => group.id === role.slice(6))) throw new M.V9Error('Choose an existing assignment group for the recipient.');
    }

    if (config.bpRules.some(r => !users.some(u => u.id === r.userId)) || config.companies?.some(c => c.signatoryUserId && !users.some(u => u.id === c.signatoryUserId))) throw new M.V9Error('Choose an available user for the PBP and company signatory.');
    const companies = await tx.execute<{ id: string }>(sql`select id from company where tenant_id=${ctx.tenantId}::uuid`);
    if (config.companies?.some(c => !companies.some(co => co.id === c.companyId))) throw new M.V9Error('Choose an available company.');
    for(const company of config.companies??[]) {
      const allowed=v9CompanySigners(config,company.companyId),eligible=await companySignersTx(tx,ctx.tenantId,company.companyId);
      if(company.signatoryUserId&&!allowed.includes(company.signatoryUserId))throw new M.V9Error('The default signatory must remain on the company’s permitted list.');
      if(allowed.some(id=>!eligible.includes(id)))throw new M.V9Error('Choose available company HR accounts for permitted signers.');
    }
    if(Object.keys(config.signatoryTitles??{}).some(id=>!users.some(user=>user.id===id)))throw new M.V9Error('A signatory title refers to an unavailable account.');
    const removed = previous.workflows.filter(workflow => !config.workflows.some(next => next.id === workflow.id)).map(workflow => workflow.id);
    if (removed.length) {
      const history = await tx.execute<{ id: string }>(sql`with records as (
        select id,data->'runs' as runs from lc_v9_case where tenant_id=${ctx.tenantId}::uuid
        union all select case_id,data->'runs' from lc_v9_case_revision where tenant_id=${ctx.tenantId}::uuid
        union all select case_id,data->'lifecycleV9'->'runs' from lc_onboarding_private where tenant_id=${ctx.tenantId}::uuid
        union all select case_id,data->'lifecycleV9'->'runs' from lc_onboarding_private_revision where tenant_id=${ctx.tenantId}::uuid
      ) select id from records where exists(select 1 from jsonb_array_elements(coalesce(runs,'[]'::jsonb)) r where r->>'workflowId' in (${sql.join(removed.map(id => sql`${id}`), sql`, `)})) limit 1`);
      if (history.length) throw new M.V9Error('A workflow has already run on a record. Keep it for history and pause it instead.');
    }
    await tx.execute(sql`insert into lc_v9_config_revision(tenant_id,revision,data,actor_user_id) values(${ctx.tenantId}::uuid,${revision},${JSON.stringify(previous)}::jsonb,${ctx.userId}::uuid)`);
    const who = await actor(tx, ctx);
    for (const checklist of config.checklists) {
      const before = previous.checklists.find(before => before.id === checklist.id), owner = before?.ownerUserId;
      if (owner && checklist.ownerUserId && checklist.ownerUserId !== owner) throw new M.V9Error('Keep the checklist owner while editing its settings.');
      checklist.ownerUserId = owner ?? who.id; checklist.createdAt = before?.createdAt ?? new Date().toISOString();
    }
    for (const template of config.templates) for (const version of template.versions) {
      const before = previous.templates.find(t => t.id === template.id)?.versions.find(v => v.version === version.version);
      if (!before || before.state === 'draft' && !v9Equal(before, version)) { version.at = todayInKualaLumpur(); version.by = who.name; }
    }
    config.revision = revision + 1;
    const beforeChecklists = previous.checklists.filter(checklist => checklist.module === 'onb'), nextChecklists = config.checklists.filter(checklist => checklist.module === 'onb');
    if (!v9Equal(beforeChecklists, nextChecklists) || !v9Equal(previous.caseForms?.onb, config.caseForms?.onb)) {
      const definitions = await onboardingV9DefinitionsChangedTx(ctx, tx, config.groupsRevision!, nextChecklists, config.revision);
      config.groupsRevision = definitions.revision;
    }
    await tx.execute(sql`update lc_v9_config set data=${JSON.stringify(config)}::jsonb,revision=${config.revision},updated_at=now() where tenant_id=${ctx.tenantId}::uuid`);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'lifecycle-v9-config', aggregateId: ctx.tenantId, eventType: 'lifecycle-v9.configurationChanged', actor: actorOf(ctx), payload: { revision: config.revision } });
    return { revision: config.revision, groupsRevision: config.groupsRevision ?? 0, versionStamps: config.templates.flatMap(template => template.versions.map(version => ({ templateId: template.id, version: version.version, state: version.state, at: version.at, by: version.by }))) };
  });
}

export async function v9CreateOffboarding(ctx: SessionContext, input: { employmentId: string; type: M.ExitType; noticeDate: string; lastDay: string }): Promise<string> {
  input = z.object({ employmentId: z.string().uuid(), type: z.enum(['Resignation', 'Termination', 'Contract end', 'Retirement', 'Non-confirmation']), noticeDate: z.string(), lastDay: z.string() }).strict().parse(input);
  identifier(input.employmentId);
  if (!M.validDate(input.lastDay) || !M.validDate(input.noticeDate)) throw new M.V9Error('Enter valid notice and last working dates.');
  if (input.lastDay < input.noticeDate) throw new M.V9Error('Last working day cannot be before notice date.');
  return withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx);
    const config = await configTx(tx, ctx); if (!config) throw new M.V9Error('Set up V9 first.');
    const [employee] = await tx.execute<{ id: string; company_id: string; person_id: string; name: string; employee_no: string; hired_on: string; grade_id: string | null; confirmation_date: string | null; final_confirmation_date: string | null; probation_end_date: string | null; provisional_end_on: string | null }>(sql`select e.id,e.company_id,e.person_id,p.full_name as name,e.employee_code as employee_no,coalesce(e.join_date,e.hired_on)::text as hired_on,e.grade_id,e.confirmation_date::text,e.final_confirmation_date::text,e.probation_end_date::text,e.provisional_end_on::text from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.id=${input.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid for update of e`);
    if (!employee) throw new M.V9Error('Employee not found or unavailable.', 'not_found'); await admin(tx, employee.company_id);
    const [openExit] = await tx.execute<{ id: string }>(sql`select id from lc_v9_case where tenant_id=${ctx.tenantId}::uuid and employment_id=${employee.id}::uuid and module='off' and data->>'state' in ('pending','submitted') limit 1`);
    if (openExit) throw new M.V9Error('This employee already has an open offboarding case. Open it from Leavers.', 'conflict');
    const [assignment] = await tx.execute<{ department_id: string | null; business_unit_id: string | null; position_id: string | null; employment_type: string | null }>(sql`select department_id,business_unit_id,position_id,employment_type from assignment where employment_id=${employee.id}::uuid and tenant_id=${ctx.tenantId}::uuid and superseded_at is null and valid_from<=${todayInKualaLumpur()}::date and (valid_to is null or valid_to>${todayInKualaLumpur()}::date) order by valid_from desc,id limit 1`);
    const logins = await tx.execute<{ id: string }>(sql`select id from app_user where tenant_id=${ctx.tenantId}::uuid and person_id=${employee.person_id}::uuid and archived_at is null order by id`);
    const managers = await tx.execute<{ id: string }>(sql`select u.id from reporting_line r join employment e on e.id=r.manager_employment_id and e.tenant_id=r.tenant_id join app_user u on u.person_id=e.person_id and u.tenant_id=e.tenant_id and u.archived_at is null where r.tenant_id=${ctx.tenantId}::uuid and r.subordinate_employment_id=${employee.id}::uuid and r.line_type='administrative' and r.superseded_at is null and r.valid_from<=${todayInKualaLumpur()}::date and (r.valid_to is null or r.valid_to>${todayInKualaLumpur()}::date) order by r.valid_from desc,r.id,u.id`);
    const { nextNumber } = await import('../../../core/lifecycle-base');
    const id = randomUUID(), number = await nextNumber(tx, 'OFB9');
    const c: M.Case = { version: 9, id, number, module: 'off', revision: 1, state: 'pending', facts: { confirmationDate: employee.confirmation_date, finalConfirmationDate: employee.final_confirmation_date, probationEndDate: employee.probation_end_date, provisionalEndOn: employee.provisional_end_on, name: employee.name, employeeNo: employee.employee_no, employmentId: employee.id, personId: employee.person_id, joinDate: employee.hired_on, lastDay: input.lastDay, noticeDate: input.noticeDate, employeeUserId: logins.length === 1 ? logins[0].id : null, supervisorUserId: managers.length === 1 ? managers[0].id : null, pbpUserId: null, taUserId: null, company: employee.company_id, businessGroup: assignment?.business_unit_id ?? '', department: assignment?.department_id ?? '', grade: employee.grade_id ?? '', title: assignment?.position_id ?? '', employmentType: assignment?.employment_type ?? '', caseType: input.type }, checklistId: null, checklistName: '', override: 'automatic', tasks: [], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: '', submittedAt: null, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: input.lastDay, finalFigures: null, review: null };
    const who = await actor(tx, ctx); c.log.push({ id: randomUUID(), at: new Date().toISOString(), actor: who, action: 'case.created', detail: 'Created from Personnel Management.' });
    c.sourceRevision = createHash('sha256').update(JSON.stringify({ employee, assignment })).digest('hex');
    await tx.execute(sql`insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,data) values(${id}::uuid,${ctx.tenantId}::uuid,${employee.company_id}::uuid,${employee.id}::uuid,'off',${number},${JSON.stringify(c)}::jsonb)`);
    await record(tx, ctx, id, employee.id, 'created'); return id;
  });
}
export type Command = CaseNoteCommand
  | { type: 'pmPush'; id: string }
  | { type: 'pmPushSelected' | 'pmKeep'; ids: string[] }
  | { type: 'caseFormSave'; values: Record<string,string>; reason: string; submit: boolean }
  | { type: 'submit' }
  | { type: 'task'; id: string; status: M.Task['status']; reason: string }
  | { type: 'generate'; template: string }
  | { type: 'emailSend' | 'emailTest'; emailId: string }
  | { type: 'emailEdit'; emailId: string; subject: string; body: string }
  | { type: 'documentTextEdit'; id: string; edits: Record<string, string> }
  | { type: 'documentSave'; id: string; values: Record<string, string> }
  | { type: 'documentSignatory'; id:string; userId:string }
  | { type: 'documentSign'; id: string; signature: Pick<M.Signature, 'method' | 'value' | 'consent'> }
  | { type: 'documentRefresh'; id: string }
  | { type: 'clear'; sourceRevision: string; reason: string }
  | { type: 'settlementOptions'; options: NonNullable<M.Case['settlementOptions']>; reason: string }
  | { type: 'cancel' | 'reopen'; reason: string }
  | { type: 'emailRetry'; id: string; reason: string }
  | {type:'emailReplace';id:string;reason:string;sourceRevision:string}
  | { type: 'runWorkflows' }
  | { type: 'retryWorkflow' | 'startWorkflow'; workflowId: string }
  | { type: 'override'; checklist: string }
  | {type:'returnSelections';ids:string[]}
  | { type: 'assign' | 'assignItem'; id: string; userId: string }
  | { type: 'item'; id: string; status: M.Item['status']; reason: string };
const commandId = z.string().min(1).max(120), reasonText = z.string().max(4000);
const commandSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('note'),id:commandId.optional(),context:commandId,body:z.string().max(10000),mentions:z.array(z.string().uuid()).max(50),deleted:z.boolean().optional()}).strict(),
  z.object({ type: z.literal('pmPush'), id: commandId }).strict(),
  z.object({ type: z.literal('pmPushSelected'), ids: z.array(commandId).min(1).max(500) }).strict(),
  z.object({ type: z.literal('pmKeep'), ids: z.array(commandId).min(1).max(500) }).strict(),
  z.object({ type: z.literal('caseFormSave'), values: z.record(commandId,z.string().max(10000)).refine(value=>Object.keys(value).length<=100), reason: reasonText, submit: z.boolean() }).strict(),
  z.object({type:z.literal('returnSelections'),ids:z.array(commandId).max(100).refine(ids=>new Set(ids).size===ids.length)}).strict(),
  z.object({ type: z.literal('submit') }).strict(), z.object({ type: z.literal('runWorkflows') }).strict(),
  z.object({ type: z.literal('retryWorkflow'), workflowId: commandId }).strict(),
  z.object({ type: z.literal('startWorkflow'), workflowId: commandId }).strict(),
  z.object({ type: z.literal('task'), id: commandId, status: z.enum(['todo', 'progress', 'done', 'notNeeded']), reason: reasonText }).strict(),
  z.object({ type: z.literal('generate'), template: commandId }).strict(),
  z.object({ type: z.literal('emailSend'), emailId: commandId }).strict(), z.object({ type: z.literal('emailTest'), emailId: commandId }).strict(),
  z.object({type:z.literal('emailReplace'),id:commandId,reason:reasonText.min(1),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({ type: z.literal('emailRetry'), id: commandId, reason: reasonText }).strict(),
  z.object({ type: z.literal('emailEdit'), emailId: commandId, subject: z.string().min(1).max(1000), body: z.string().max(20000) }).strict(),
  z.object({ type: z.literal('documentTextEdit'), id: commandId, edits: z.record(commandId, z.string().max(20000)).refine(value => Object.keys(value).length <= 500) }).strict(),
  z.object({ type: z.literal('documentSave'), id: commandId, values: z.record(commandId, z.string().max(20000)) }).strict(),
  z.object({type:z.literal('documentSignatory'),id:commandId,userId:z.string().uuid()}).strict(),
  z.object({ type: z.literal('documentSign'), id: commandId, signature: z.object({ method: z.enum(['typed', 'drawn']), value: z.string().min(1).max(500000), consent: z.literal(true) }).strict() }).strict(),
  z.object({ type: z.literal('documentRefresh'), id: commandId }).strict(),
  z.object({ type: z.literal('clear'), sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), reason: reasonText }).strict(),
  z.object({ type: z.literal('settlementOptions'), reason: reasonText.min(1), options: z.object({ keepSourceDate: z.boolean(), offsetLeave: z.boolean(), override: z.object({ date: z.string().refine(M.validDate), reason: reasonText.min(1), kind: z.enum(['earlyRelease', 'waived', 'payInLieu', 'immediate', 'other']) }).strict().nullable(), reduceEncashment: z.object({ days: z.number().min(0).max(10000), reason: reasonText.min(1) }).strict().nullable() }).strict() }).strict(),
  z.object({ type: z.literal('cancel'), reason: reasonText }).strict(), z.object({ type: z.literal('reopen'), reason: reasonText }).strict(),
  z.object({ type: z.literal('override'), checklist: commandId }).strict(), z.object({ type: z.literal('assign'), id: commandId, userId: z.string().uuid() }).strict(), z.object({ type: z.literal('assignItem'), id: commandId, userId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('item'), id: commandId, status: z.enum(['todo', 'progress', 'done', 'notReturned', 'notNeeded']), reason: reasonText }).strict(),
]);
export async function v9Command(ctx: SessionContext, id: string, revision: number, command: Command): Promise<void> {
  command = commandSchema.parse(command);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new M.V9Error('A current case revision is required.');
  await withLifecycleTenant(ctx, async tx => {
    if (command.type === 'pmPush' || command.type === 'pmPushSelected') await lockV9PersonnelWritesTx(tx, ctx);
    await lockTx(tx, ctx);
    const row = await load(tx, ctx, id); if (row.revision !== revision) throw new M.V9Error('This case changed. Refresh before trying again.', 'conflict');
    const config = await configTx(tx, ctx); if (!config) throw new M.V9Error('V9 configuration is unavailable.');
    const c = structuredClone(row.data); let env = await environment(tx, ctx, c, config);
    if (row.native && !['generate', 'emailSend', 'emailTest', 'emailEdit', 'emailRetry', 'emailReplace', 'documentTextEdit', 'documentSave', 'documentSignatory', 'documentSign', 'documentRefresh', 'runWorkflows', 'retryWorkflow', 'startWorkflow', 'pmKeep', 'pmPush', 'pmPushSelected'].includes(command.type)) throw new M.V9Error('Use the onboarding case controls for this change.');
    if (row.native && ['pmPush', 'pmPushSelected'].includes(command.type) && !c.facts.employmentId) throw new M.V9Error('Activate this Personnel draft before applying its proposed changes.');
    if(command.type==='note')changeV9Note(c,env,command);
    if(command.type==='returnSelections'){
      if(c.module!=='off'||c.state!=='pending')throw new M.V9Error('Return selections can change only before submission.');
      const available=await onboardingReturnCatalogueTx(ctx,tx,c.facts.company),previous=new Set(c.returnSelections??[]);
      if(command.ids.some(id=>!previous.has(id)&&!available.some(item=>item.id===id&&item.active)))throw new M.V9Error('Choose an active item from the existing catalogue.');
      c.returnSelections=[...command.ids];M.appendLog(c,env,'returns.selectionChanged',`${command.ids.length} additional return/revoke items selected.`);
    }
    if (command.type === 'caseFormSave') {
      if (c.module !== 'off' || !['pending','submitted'].includes(c.state)) throw new M.V9Error('Reopen this case before editing its fields.');
      const fields = resolveV9CaseFields('off',config.caseForms?.off), before = offCaseFormValues(c);
      for (const [key,value] of Object.entries(command.values)) {
        const field = fields.find(field=>field.key===key);
        if (!field || field.source !== 'case') throw new M.V9Error('Personnel fields are locked. Edit them in Personnel Management.');
        try { validateV9CaseValue(field,value); } catch (error) { throw new M.V9Error(error instanceof Error ? error.message : 'Review the case fields.'); }
      }
      const values = { ...before, ...command.values };
      if (c.state==='submitted' && Object.entries(command.values).some(([key,value])=>['type','notice','revokeMode','revokeDate','pbp'].includes(key)&&value!==before[key]) && !command.reason.trim()) throw new M.V9Error('Record a reason for changing the submitted case details.');
      if (!['Resignation','Termination','Contract end','Retirement','Non-confirmation'].includes(values.type) || !M.validDate(values.notice) || values.notice>c.facts.lastDay) throw new M.V9Error('Choose a valid case type and notice date on or before the last working day.');
      if (!['lastday','date'].includes(values.revokeMode) || values.revokeMode==='date'&&!M.validDate(values.revokeDate)) throw new M.V9Error('Choose when access must be revoked.');
      if (values.pbp && !env.eligibleUser(values.pbp)) throw new M.V9Error('Choose an available People Business Partner.');
      const priorRevoke = c.revokeDate;
      c.facts.caseType=values.type;c.facts.noticeDate=values.notice;c.facts.pbpUserId=values.pbp||null;c.revokeMode=values.revokeMode as 'lastday'|'date';c.revokeDate=c.revokeMode==='lastday'?c.facts.lastDay:values.revokeDate;
      c.caseValues={...c.caseValues,...Object.fromEntries(Object.entries(command.values).filter(([key])=>fields.some(field=>field.key===key&&field.custom)))};
      if (c.revokeDate!==priorRevoke) for (const item of c.items) if (!M.isResolved(item.status) && item.status!=='notReturned' && item.dueOn===priorRevoke) item.dueOn=c.revokeDate;
      env=await environment(tx,ctx,c,config);
      M.appendLog(c,env,'case.fieldsSaved',command.reason.trim()?'Case form updated: '+command.reason.trim():'Case form updated.');
    }
    if (command.type === 'submit' || command.type === 'caseFormSave' && command.submit) {
      M.submit(c, config, env);
      if (c.module === 'off') {
        const fulfillingGroup = await onboardingFulfilmentGroupTx(ctx, tx), group = config.groups.find(g => g.id === fulfillingGroup), extra: Record<string, number> = {};
        for (const task of c.tasks) if (task.assignee) extra[task.assignee] = (extra[task.assignee] ?? 0) + 1;
        const assets = c.facts.employeeNo.trim()?await issuedToTx(tx, c.facts.employeeNo, c.facts.company):[];
        c.items = assets.map(asset => {
          const assigned = M.assign(config, group?.id ?? null, c.revokeDate, env, extra, 'memberOrder');
          if (assigned.userId) extra[assigned.userId] = (extra[assigned.userId] ?? 0) + 1;
          return { id: randomUUID(), name: `${asset.code} · ${asset.model ?? asset.assetType}`, kind: 'device' as const, sourceId: asset.id, group: group?.id ?? null, assignee: assigned.userId, dueOn: c.revokeDate, status: 'todo' as const, reason: '' };
        });
        const catalogue=await onboardingReturnCatalogueTx(ctx,tx,c.facts.company),selections=(c.returnSelections??[]).map(id=>catalogue.find(item=>item.id===id&&item.active));
        if(selections.some(item=>!item))throw new M.V9Error('An additional return item is no longer available. Review the catalogue selections before submission.');
        const holdings = await onboardingHoldingsTx(ctx, tx, c.facts.employmentId!, c.facts.company);
        for (const holding of holdings) {
          const groupId = config.groups.some(group => group.id === holding.group) ? holding.group : null;
          const assigned = M.assign(config, groupId, c.revokeDate, env, extra, 'memberOrder');
          if (assigned.userId) extra[assigned.userId] = (extra[assigned.userId] ?? 0) + 1;
          c.items.push({ id: randomUUID(), name: holding.name, kind: holding.kind, sourceId: null, nativeSource: { caseId: holding.caseId, requestId: holding.requestId, requestNumber: holding.requestNumber, itemId: holding.itemId }, group: groupId, assignee: assigned.userId, dueOn: c.revokeDate, status: 'todo', reason: '' });
        }
        for(const item of selections){
          if(!item||holdings.some(holding=>holding.catalogueId===item.id))continue;
          const groupId=config.groups.some(group=>group.id===item.group)?item.group:null,assigned=M.assign(config,groupId,c.revokeDate,env,extra,'memberOrder');
          if(assigned.userId)extra[assigned.userId]=(extra[assigned.userId]??0)+1;
          c.items.push({id:randomUUID(),name:item.name,kind:item.kind,sourceId:null,sourceCatalogueId:item.id,group:groupId,assignee:assigned.userId,dueOn:c.revokeDate,status:'todo',reason:''});
        }
        c.returnSelections=[];
        M.appendLog(c, env, 'returns.created', `${assets.length} issued inventory assets and ${holdings.length} handed onboarding items loaded from their original records.`);
      }
      for (const w of config.workflows) { M.runWorkflow(c, config, w, env, 'submitted'); M.runWorkflow(c, config, w, env, 'date'); }
    }
    else if (command.type === 'caseFormSave') { /* Stored with the case revision below. */ }
    else if (command.type === 'pmPush' || command.type === 'pmPushSelected' || command.type === 'pmKeep') {
      const ids = command.type === 'pmPush' ? [command.id] : command.ids;
      if (new Set(ids).size !== ids.length) throw new M.V9Error('Review each proposed change once.');
      const proposals = ids.map(id => c.pmChanges.find(proposal => proposal.id === id));
      if (proposals.some(proposal => !proposal || proposal.status === 'pushed' || proposal.status === 'rejected')) throw new M.V9Error('This proposal is unavailable or already applied.');
      if (c.state !== 'submitted') throw new M.V9Error('Reopen this case before applying Personnel changes.');
      for (const proposal of proposals) {
        if (!proposal) throw new M.V9Error('Proposal unavailable.');
        if (command.type === 'pmKeep') {
          proposal.status = 'rejected';
          M.appendLog(c, env, 'personnel.kept', `${proposal.field}: kept on the case only`);
        } else {
          proposal.status = await pushV9PersonnelTx(tx, ctx, { employmentId: c.facts.employmentId, field: proposal.field, before: proposal.before, after: proposal.after });
          M.appendLog(c, env, proposal.status === 'pushed' ? 'personnel.pushed' : 'personnel.conflict', `${proposal.field}: ${proposal.status === 'pushed' ? 'reviewed change applied' : 'Personnel source changed; review in Personnel Management'}`);
        }
      }
    }
    else if (command.type === 'task') M.completeTask(c, command.id, command.status, command.reason, env);
    else if (command.type === 'generate') M.generate(c, config, command.template, env);
    else if (command.type === 'emailSend' || command.type === 'emailTest') M.queueEmail(c, config, command.emailId, env, command.type === 'emailTest');
    else if (command.type === 'emailRetry') {
      const [receipt] = await tx.execute<{ allowed: boolean }>(sql`select app.lc_v9_email_retryable(${c.id}::uuid,${command.id}) as allowed`);
      if (!receipt?.allowed) throw new M.V9Error('The recorded delivery or saved copy does not allow a retry. Review the delivery before sending another copy.', 'conflict');
      M.retryEmail(c, config, command.id, command.reason, env);
    }
    else if(command.type==='emailReplace'){
      if(!command.reason.trim())throw new M.V9Error('Record why this updated copy is needed.');
      await updatedEmailAllowed(tx,c.id,command.id);const plan=M.updatedDeliveryPlan(c,config,command.id,env);
      if(updatedEmailRevision(c,config,env,plan)!==command.sourceRevision)throw new M.V9Error('The copy or its sources changed. Review the updated preview again.','conflict');
      plan.mail.retryReason=command.reason.trim();c.documents=plan.case.documents;c.mails=plan.case.mails;c.log=plan.case.log;
      M.appendLog(c,env,'email.updatedCopyQueued',command.reason.trim());
    }
    else if (command.type === 'emailEdit') { if (!config.emails.some(e => e.id === command.emailId && e.module === c.module) || command.body.length > 20000 || command.subject.length > 1000) throw new M.V9Error('Choose an available email and keep its content within the allowed length.'); c.emailEdits = { ...c.emailEdits, [command.emailId]: { subject: command.subject, body: command.body } }; M.appendLog(c, env, 'email.edited', 'Email text changed for this person only.'); }
    else if (command.type === 'documentTextEdit') M.editDocumentText(c, config, command.id, command.edits, env);
    else if (command.type === 'documentSave') M.saveDocument(c, command.id, command.values, 'hr', env);
    else if(command.type==='documentSignatory') {
      const document=c.documents.find(document=>document.id===command.id),template=config.templates.find(template=>template.id===document?.templateId);
      if(c.state!=='submitted'||!document||document.status!=='draft'||document.hrSignature||document.employeeSignature||(document.hrStep??template?.hrStep)!=='before'||M.documentDeliveryReserved(c,document.id))throw new M.V9Error('Only an unsigned document awaiting HR signature can change signatory.');
      const eligible=await companySignersTx(tx,ctx.tenantId,c.facts.company,c.module);
      if(!v9CompanySigners(config,c.facts.company).includes(command.userId)||!eligible.includes(command.userId))throw new M.V9Error('Choose a permitted company HR signatory.');
      document.signatoryUserId=command.userId;document.mergeValues??={};document.mergeValues['signatory.name']=env.userName(command.userId);document.mergeValues['signatory.title']=v9SignatoryTitle(config,command.userId,c.facts.company);
      for(const field of document.fields)if(field.owner==='pmLocked'&&['signatory.name','signatory.title'].includes(field.pmKey??''))document.values[field.id]=document.mergeValues[field.pmKey!]??'';
      M.appendLog(c,env,'document.signatoryChanged',`${document.name} · ${env.userName(command.userId)}`);
    }
    else if (command.type === 'documentSign') {
      const document=c.documents.find(document=>document.id===command.id),template=config.templates.find(template=>template.id===document?.templateId);
      if((document?.hrStep??template?.hrStep)==='before'&&(!v9CompanySigners(config,c.facts.company).includes(env.actor.id)||!(await companySignersTx(tx,ctx.tenantId,c.facts.company,c.module)).includes(env.actor.id)))throw new M.V9Error('This account is no longer a permitted company HR signatory.');
      M.signDocument(c, config, command.id, 'hr', { ...command.signature, by: env.actor, at: env.now }, env);
      if(c.documents.find(document=>document.id===command.id)?.status==='hrsigned')for(const workflow of config.workflows)M.runWorkflow(c,config,workflow,env,'hrSigned');
    }
    else if (command.type === 'documentRefresh') { const document = c.documents.find(d => d.id === command.id); if (!document || document.status !== 'draft' || M.documentDeliveryReserved(c, command.id)) throw new M.V9Error('Only an unsigned draft not reserved for email delivery can refresh its source values.'); document.signatoryUserId ??= env.signatoryUserId ?? null; document.mergeValues = M.documentMergeValues(document,{...env.mergeValues,'signatory.name':document.signatoryUserId?env.userName(document.signatoryUserId):'','signatory.title':v9SignatoryTitle(config,document.signatoryUserId,c.facts.company)}); for (const field of document.fields) if (field.owner === 'pmLocked' && field.pmKey) document.values[field.id] = document.mergeValues[field.pmKey] ?? ''; M.appendLog(c, env, 'document.refreshed', document.name); }
    else if (command.type === 'settlementOptions') { if (!['pending', 'submitted'].includes(c.state)) throw new M.V9Error('Reopen this case before changing its figures.'); c.settlementOptions = command.options; M.appendLog(c, env, 'settlement.adjusted', command.reason); }
    else if (command.type === 'clear') {
      const calculation = await readSettlementTx(tx, ctx, c, config);
      if (!calculation?.ready || calculation.lastDay !== c.facts.lastDay) throw new M.V9Error('Complete the Leave/Payroll sources and resolve the last working day before clearance.');
      if (calculation.sourceRevision !== command.sourceRevision) throw new M.V9Error('The final figures changed. Review them again before clearance.', 'conflict');
      M.close(c, { sourceRevision: calculation.sourceRevision, lastDay: calculation.lastDay, leaveDays: String(calculation.encashDays), amount: calculation.amount!.toFixed(2), currency: calculation.currency, payDate: calculation.payDate, lockedAt: env.now, payrollReference: randomUUID() }, command.reason, env);
    }
    else if (command.type === 'cancel') M.cancel(c, command.reason, env);
    else if (command.type === 'reopen') M.reopen(c, command.reason, env);
    else if (command.type === 'runWorkflows') {
      for (const w of config.workflows) M.runWorkflow(c, config, w, env, 'date');
      const calculation = c.module === 'off' ? await readSettlementTx(tx, ctx, c, config) : null;
      const figures = calculation?.ready && calculation.lastDay === c.facts.lastDay ? { sourceRevision: calculation.sourceRevision, lastDay: calculation.lastDay, leaveDays: String(calculation.encashDays), amount: calculation.amount!.toFixed(2), currency: calculation.currency, payDate: calculation.payDate, lockedAt: env.now, payrollReference: randomUUID() } : null;
      M.lastDayCheck(c, config, env, figures);
    }
    else if (command.type === 'startWorkflow') {
      const workflow=config.workflows.find(workflow=>workflow.id===command.workflowId&&workflow.module===c.module);
      if(!workflow||workflow.status!=='published'||c.state!=='submitted')throw new M.V9Error('Choose a live workflow on an open case.');
      if(!M.workflowMatches(c,workflow,env.today))throw new M.V9Error('This case does not match the workflow conditions.');
      if(c.runs.some(run=>run.workflowId===workflow.id&&['waiting','failed'].includes(run.status)))M.runWorkflow(c,config,workflow,env,'resume');
      else M.runWorkflow(c,config,workflow,env,'manual',{startNow:true});
      M.appendLog(c,env,'workflow.startedByHand',workflow.name);
    }
    else if (command.type === 'retryWorkflow') { const workflow = config.workflows.find(w => w.id === command.workflowId); if (!workflow) throw new M.V9Error('Workflow not found.'); M.runWorkflow(c, config, workflow, env, 'resume'); }
    else if (command.type === 'override') { if (c.state !== 'pending') throw new M.V9Error('The submitted checklist is frozen.'); c.override = command.checklist; M.matchChecklist(config, c); M.appendLog(c, env, 'checklist.overridden', command.checklist); }
    else if (command.type === 'assign') {
      if (c.state !== 'submitted') throw new M.V9Error('This case is not open.');
      const task = c.tasks.find(t => t.id === command.id); if (!task) throw new M.V9Error('Task not found.');
      if (M.isResolved(task.status)) throw new M.V9Error('Completed work keeps its recorded owner.');
      if (!config.groups.some(g => g.id === task.group && g.members.includes(command.userId)) || !env.eligibleUser(command.userId)) throw new M.V9Error('Choose an eligible member of the task group.');
      task.assignee = command.userId; task.assignmentFailure = null; M.appendLog(c, env, 'task.reassigned', `${task.name} · ${env.userName(command.userId)}`, { userId: command.userId, groupId: task.group! });
    } else if (command.type === 'assignItem') {
      if (c.state !== 'submitted') throw new M.V9Error('This case is not open.');
      const item = c.items.find(item => item.id === command.id); if (!item) throw new M.V9Error('Item not found.');
      if (M.isResolved(item.status) || item.status === 'notReturned') throw new M.V9Error('Completed work keeps its recorded owner.');
      if (!config.groups.some(group => group.id === item.group && group.members.includes(command.userId)) || !env.eligibleUser(command.userId)) throw new M.V9Error('Choose an eligible member of the providing group.');
      item.assignee = command.userId;
      M.appendLog(c, env, 'item.reassigned', `${item.name} · ${env.userName(command.userId)}`, { userId: command.userId, groupId: item.group! });
    } else if (command.type === 'item') {
      if (c.state !== 'submitted') throw new M.V9Error('This case is not open.');
      const item = c.items.find(i => i.id === command.id); if (!item) throw new M.V9Error('Item not found.');
      if (['notNeeded', 'notReturned'].includes(command.status) && !command.reason.trim()) throw new M.V9Error('Record a reason for this item.');
      if (item.kind === 'device' && item.sourceId && command.status === 'done' && item.status !== 'done') {
        const assets = await issuedToTx(tx, c.facts.employeeNo, c.facts.company), asset = assets.find(a => a.id === item.sourceId);
        if (!asset) throw new M.V9Error('The asset register changed. Review who holds this device before marking it returned.', 'conflict');
        await returnAssetTx(tx, ctx, asset.code, { requisitionNumber: c.number });
      }
      if (item.nativeSource && command.status === 'done' && item.status !== 'done') await onboardingRecoverHoldingTx(ctx, tx, c.facts.employmentId!, c.facts.company, item.nativeSource, c.id, command.reason);
      if ((item.sourceId || item.nativeSource) && item.status === 'done' && command.status !== 'done') throw new M.V9Error('This recovery is already recorded on its issuing record. Correct that record before reopening the item.');
      item.status = command.status; item.reason = command.reason.trim(); M.appendLog(c, env, 'item.updated', `${item.name}: ${item.status}`);
    }
    for (const w of config.workflows) if (c.runs.some(r => r.workflowId === w.id && r.status === 'waiting')) M.runWorkflow(c, config, w, env, 'resume');
    await store(tx, ctx, row, c, command.type);
  });
}
/** Native submission and the privileged minute worker use the same idempotent workflow transition. */
export async function v9NativeTransitionTx(ctx: SessionContext, tx: Tx, id: string, now = new Date(), dates = true): Promise<{ revision: number; changed: boolean }> {
  const native = await onboardingV9ReadTx(ctx, tx, id), config = await configTx(tx, ctx);
  if (!config || !native.c.v9DefinitionRevision && !native.documentState || native.c.state === 'pending') return { revision: native.row.revision, changed: false };
  const c = projectNativeCase(native.c, native.row.revision, native.documentState, native.employeeUserId, native.supervisorUserId);
  const env = await environment(tx, ctx, c, config); env.today = todayInKualaLumpur(now); env.now = now.toISOString();
  env.mergeValues.today = env.mergeValues['today.date'] = env.today.slice(8) + '/' + env.today.slice(5, 7) + '/' + env.today.slice(0, 4);
  if (c.state === 'submitted') for (const workflow of config.workflows) {
    M.runWorkflow(c, config, workflow, env, 'submitted');
    if (c.runs.some(run => run.workflowId === workflow.id && run.status === 'waiting')) M.runWorkflow(c, config, workflow, env, 'resume');
    if (dates) M.runWorkflow(c, config, workflow, env, 'date');
  }
  else for (const mail of c.mails) if (mail.status === 'pending') mail.status = 'cancelled';
  const state = nativeDocumentState(c);
  if (v9Equal(state, native.documentState)) return { revision: native.row.revision, changed: false };
  await onboardingV9StoreTx(ctx, tx, id, native.row.revision, state, c.tasks.filter(task => task.status === 'done' && task.documentTemplate).map(task => task.id), 'workflow');
  return { revision: native.row.revision + 1, changed: true };
}
/** Existing privileged maintenance connection; daily dates run after 08:00 Malaysia time. */
export async function v9Sweep(ctx: SessionContext, connection: NotificationSweepConnection, now = new Date()) {
  assertModuleEnabled(ctx, 'lifecycle');
  if (ctx.userId) return { processed: 0, failed: 0 };
  const dates = timeInKualaLumpur(now) >= '08:00';
  const ids = await connection.withTenant(ctx, async tx => {
    const [permission] = await tx.execute<{ ok: boolean }>(sql`select current_user='ai_hr_owner' OR EXISTS(select 1 from pg_roles where rolname=current_user and rolsuper) as ok`);
    if (!permission?.ok) throw new M.V9Error('Lifecycle scheduling requires the storage owner.', 'forbidden');
    return tx.execute<{ id: string }>(sql`select id from lc_v9_case where tenant_id=${ctx.tenantId}::uuid and data->>'state'='submitted' order by updated_at,id`);
  });
  const output = { processed: 0, failed: 0 };
  for (const { id } of ids) try {
    const changed = await connection.withTenant(ctx, async tx => {
      await lockTx(tx, ctx);
      const [row] = await tx.execute<Row>(sql`select id,company_id,revision,data from lc_v9_case where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and data->>'state'='submitted' for update skip locked`);
      if (!row) return false; const config = await configTx(tx, ctx); if (!config) return false;
      const c = structuredClone(row.data), env = await environment(tx, ctx, c, config);
      env.today = todayInKualaLumpur(now); env.now = now.toISOString();
      for (const w of config.workflows) { if (c.runs.some(r => r.workflowId === w.id && r.status === 'waiting')) M.runWorkflow(c, config, w, env, 'resume'); if (dates) M.runWorkflow(c, config, w, env, 'date'); }
      const calculation = dates && c.module === 'off' ? await readSettlementTx(tx, ctx, c, config) : null;
      const figures = calculation?.ready && calculation.lastDay === c.facts.lastDay ? { sourceRevision: calculation.sourceRevision, lastDay: calculation.lastDay, leaveDays: String(calculation.encashDays), amount: calculation.amount!.toFixed(2), currency: calculation.currency, payDate: calculation.payDate, lockedAt: env.now, payrollReference: randomUUID() } : null;
      if (dates) M.lastDayCheck(c, config, env, figures);
      if (JSON.stringify(c) === JSON.stringify(row.data)) return false;
      await store(tx, ctx, row, c, 'scheduled'); return true;
    });
    if (changed) output.processed++;
  } catch { output.failed++; }
  const nativeIds = await connection.withTenant(ctx, tx => tx.execute<{ id: string }>(sql`select c.id from lc_onboarding_case c where c.tenant_id=${ctx.tenantId}::uuid and c.data->>'state'='submitted' and (c.data ? 'v9DefinitionRevision' or exists(select 1 from lc_onboarding_private p where p.case_id=c.id and p.tenant_id=c.tenant_id and p.data ? 'lifecycleV9')) order by c.created_at,c.id`));
  for (const { id } of nativeIds) try {
    const changed = await connection.withTenant(ctx, async tx => { await lockTx(tx, ctx); return v9NativeTransitionTx(ctx, tx, id, now, dates); });
    if (changed.changed) output.processed++;
  } catch { output.failed++; }
  return output;
}
/** Durable transport worker. Each claim/start/receipt is committed separately from external SMTP. */
export async function v9DeliverEmails(ctx: SessionContext, connection: NotificationSweepConnection, send: (request: LifecycleV9DeliveryRequest) => Promise<LifecycleV9DeliveryResult> = lifecycleV9EmailIpc) {
  assertModuleEnabled(ctx, 'lifecycle');
  if (ctx.userId) throw new M.V9Error('Lifecycle delivery requires the storage owner.', 'forbidden');
  type Job = { id: string; case_id: string | null; onboarding_case_id: string | null; company_id: string; mail_id: string; status: string; lease_token: string | null; started_at: string | null; error_code: string | null; payload: { documents: M.Document[] } };
  async function readCase(tx: Tx, job: Job): Promise<Row> {
    if (job.onboarding_case_id) {
      const native = await onboardingV9ReadTx(ctx, tx, job.onboarding_case_id);
      return { id: native.c.id, revision: native.row.revision, company_id: native.row.companyId, data: projectNativeCase(native.c, native.row.revision, native.documentState, native.employeeUserId, native.supervisorUserId), native: true };
    }
    const [row] = await tx.execute<Row>(sql`select id,revision,company_id,data from lc_v9_case where tenant_id=${ctx.tenantId}::uuid and id=${job.case_id}::uuid for update`);
    if (!row || row.company_id !== job.company_id) throw new M.V9Error('Delivery subject changed.', 'conflict');
    return row;
  }
  async function reconcile(tx: Tx, job: Job) {
    const row = await readCase(tx, job), c = structuredClone(row.data), mail = c.mails.find(mail => mail.id === job.mail_id);
    if (!mail || !['sent','failed','uncertain','cancelled','retry'].includes(job.status)) return;
    const status = job.status === 'retry' ? 'failed' : job.status as M.Mail['status'];
    if (mail.status === status && mail.failure === job.error_code) { await tx.execute(sql`update lc_v9_email_delivery set projected_at=now() where id=${job.id}::uuid and tenant_id=${ctx.tenantId}::uuid`); return; }
    if (status === 'sent') {
      const config = await configTx(tx, ctx); if (!config) return;
      // The private receipt, never the IPC response alone, proves the SMTP acknowledgement.
      const env = await environment(tx, ctx, c, config);
      const unchanged = new Set(job.payload.documents.filter(frozen => c.documents.some(current => v9Equal(current, frozen))).map(document => document.id));
      mail.status = 'sending'; M.markDelivered(c, mail.id, env, unchanged);
      if (c.state === 'submitted' && mail.documentIds.some(id => !unchanged.has(id))) M.appendLog(c, env, 'email.documentChanged', 'The queued copy was delivered. A changed current document needs review before release.');
    } else { mail.status = status; mail.failure = job.error_code; }
    await store(tx, ctx, row, c, 'emailReceipt');
    await tx.execute(sql`update lc_v9_email_delivery set projected_at=now() where id=${job.id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  }
  const output = { attempted: 0, sent: 0, held: 0, failed: 0 };
  const pending = await connection.withTenant(ctx, async tx => {
    const [owner] = await tx.execute<{ ok: boolean }>(sql`select current_user='ai_hr_owner' OR EXISTS(select 1 from pg_roles where rolname=current_user and rolsuper) as ok`);
    if (!owner?.ok) throw new M.V9Error('Lifecycle delivery requires the storage owner.', 'forbidden');
    await lockTx(tx, ctx);
    await tx.execute(sql`update lc_v9_email_delivery set status='uncertain',completed_at=now(),error_code='uncertain',projected_at=null,updated_at=now() where tenant_id=${ctx.tenantId}::uuid and status='sending' and lease_until<=now()`);
    await tx.execute(sql`update lc_v9_email_delivery set status='queued',lease_token=null,lease_until=null,updated_at=now() where tenant_id=${ctx.tenantId}::uuid and status='leased' and started_at is null and lease_until<=now()`);
    const receipts = await tx.execute<Job>(sql`select * from lc_v9_email_delivery where tenant_id=${ctx.tenantId}::uuid and status in ('sent','failed','uncertain','cancelled','retry') and projected_at is null order by updated_at,id limit 100`);
    const ids = await tx.execute<{ id: string }>(sql`select id from lc_v9_email_delivery where tenant_id=${ctx.tenantId}::uuid and status='queued' and next_attempt_at<=now() order by next_attempt_at,id limit 25`);
    return { receipts, ids };
  });
  for (const receipt of pending.receipts) try {
    await connection.withTenant(ctx, async tx => { await lockTx(tx, ctx); const [job] = await tx.execute<Job>(sql`select * from lc_v9_email_delivery where id=${receipt.id}::uuid and tenant_id=${ctx.tenantId}::uuid for update`); if (job) await reconcile(tx, job); });
  } catch { output.failed++; }
  for (const { id } of pending.ids) {
    try {
      const claim = await connection.withTenant(ctx, async tx => {
        await lockTx(tx, ctx);
        const [job] = await tx.execute<Job>(sql`select * from lc_v9_email_delivery where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and status='queued' and next_attempt_at<=now() for update skip locked`);
        if (!job) return null;
        assertModuleEnabled(ctx, 'lifecycle', job.company_id);
        const row = await readCase(tx, job), c = structuredClone(row.data), mail = c.mails.find(mail => mail.id === job.mail_id);
        if (c.state !== 'submitted' || !mail || !mail.delivery || !['pending','sending'].includes(mail.status)) {
          await tx.execute(sql`update lc_v9_email_delivery set status='cancelled',error_code='notEligible',updated_at=now() where id=${id}::uuid`); return null;
        }
        const token = randomUUID(); mail.status = 'sending'; mail.failure = null;
        await store(tx, ctx, row, c, 'emailClaimed');
        await tx.execute(sql`update lc_v9_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where id=${id}::uuid and started_at is null`);
        return { deliveryId: id, leaseToken: token };
      });
      if (!claim) continue;
      output.attempted++;
      let response: LifecycleV9DeliveryResult | null = null;
      try { response = await send(claim); } catch { /* Only the durable started/receipt state determines replay safety. */ }
      const status = await connection.withTenant(ctx, async tx => {
        await lockTx(tx, ctx);
        let [job] = await tx.execute<Job>(sql`select * from lc_v9_email_delivery where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and lease_token=${claim.leaseToken}::uuid for update`);
        if (!job) return 'uncertain';
        if (job.status === 'leased' && !job.started_at) {
          const held = response?.outcome === 'skipped' && response.error === 'relayUnavailable';
          const error = response?.outcome === 'skipped' ? response.error ?? 'notEligible' : 'notEligible';
          [job] = await tx.execute<Job>(sql`update lc_v9_email_delivery set status=${held ? 'queued' : 'failed'},error_code=${error},lease_token=null,lease_until=null,next_attempt_at=now()+interval '5 minutes',updated_at=now() where id=${id}::uuid returning *`);
          if (held) {
            const row = await readCase(tx, job), c = structuredClone(row.data), mail = c.mails.find(mail => mail.id === job.mail_id);
            if (mail) { mail.status = c.state === 'submitted' ? 'pending' : 'cancelled'; mail.failure = error; await store(tx, ctx, row, c, 'emailHeld'); }
            return 'held';
          }
        } else if (job.status === 'sending') {
          [job] = await tx.execute<Job>(sql`update lc_v9_email_delivery set status='uncertain',completed_at=now(),error_code='uncertain',updated_at=now() where id=${id}::uuid returning *`);
        }
        await reconcile(tx, job); return job.status;
      });
      if (status === 'sent') output.sent++; else if (status === 'held' || status === 'uncertain') output.held++; else output.failed++;
    } catch { output.failed++; }
  }
  return output;
}
export async function v9OwnWork(ctx: SessionContext): Promise<OwnCase[]> {
  return withLifecycleTenant(ctx, async tx => {
    await actor(tx, ctx);
    const rows = await tx.execute<{ data: OwnCase }>(sql`select app.lc_v9_work(null) as data union all select app.onboarding_v9_work() as data`);
    return rows.map(r => r.data);
  });
}
export async function v9OwnTask(ctx: SessionContext, input: { caseId: string; revision: number; taskId: string; status: 'todo' | 'progress' | 'done'; reason: string }): Promise<void> {
  input = z.object({ caseId: z.string().uuid(), revision: z.number().int().positive(), taskId: commandId, status: z.enum(['todo', 'progress', 'done']), reason: reasonText }).strict().parse(input);
  const native = await withLifecycleTenant(ctx, async tx => { await actor(tx, ctx); const [row] = await tx.execute<{ native: boolean }>(sql`select exists(select 1 from lc_onboarding_case where id=${input.caseId}::uuid and tenant_id=${ctx.tenantId}::uuid) as native`); return row?.native; });
  if (native) { await onboardingCommand(ctx, input.caseId, input.revision, { type: 'task', taskId: input.taskId, status: input.status }); return; }
  await withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); await actor(tx, ctx);
    const [result] = await tx.execute<{ employment: string }>(sql`select app.lc_v9_self_task(${input.caseId}::uuid,${input.revision},${input.taskId},${input.status},${input.reason}) as employment`);
    if (!result?.employment) throw new M.V9Error('Task not available.', 'not_found');
    await record(tx, ctx, input.caseId, result.employment, 'assignedTaskUpdated');
  });
}
/** A subject reports a device return; only the providing team/HR records actual recovery. */
export async function v9ReportOwnReturn(ctx: SessionContext, input: {caseId:string;revision:number;itemId:string;note:string}): Promise<void> {
  input=z.object({caseId:z.string().uuid(),revision:z.number().int().positive(),itemId:commandId,note:reasonText}).strict().parse(input);
  await withLifecycleTenant(ctx,async tx=>{
    await lockTx(tx,ctx);await actor(tx,ctx);
    const [result]=await tx.execute<{employment:string}>(sql`select app.lc_v9_report_return(${input.caseId}::uuid,${input.revision},${input.itemId},${input.note}) as employment`);
    if(!result?.employment)throw new M.V9Error('Return declaration not available.');
    await record(tx,ctx,input.caseId,result.employment,'returnReported');
  });
}
/** Employee receipt describes the handed item without changing approval, fulfilment or issuance. */
export async function v9OwnEquipmentReceipt(ctx:SessionContext,input:{caseId:string;revision:number;itemId:string;status:'received'|'problem';note:string}):Promise<void> {
  input=z.object({caseId:z.string().uuid(),revision:z.number().int().positive(),itemId:commandId,status:z.enum(['received','problem']),note:reasonText}).strict().parse(input);
  await withLifecycleTenant(ctx,async tx=>{
    await lockTx(tx,ctx);await actor(tx,ctx);
    const [result]=await tx.execute<{employment:string}>(sql`select app.onboarding_v9_receipt(${input.caseId}::uuid,${input.revision},${input.itemId},${input.status},${input.note}) as employment`);
    if(!result?.employment)throw new M.V9Error('Equipment receipt not available.');
    await record(tx,ctx,input.caseId,result.employment,'equipmentReceipt');
  });
}
/** V9 adds only the formats explicitly accepted by its supplied file picker. */
async function resolveV9Upload(name: string, content: Buffer): Promise<{ mimeType: string }> {
  if (!content.length || content.length > 10485760 || !/\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|txt|csv)$/i.test(name)) throw new M.V9Error('Unsupported V9 file.');
  if (/\.csv$/i.test(name)) { resolveDocumentUpload('upload.txt', content); return { mimeType: 'text/csv' }; }
  if (/\.(gif|webp)$/i.test(name)) { const mimeType = /\.gif$/i.test(name) ? 'image/gif' : 'image/webp'; await (await import('../../../lib/email-design/assets')).validateEmailRaster(content, mimeType); return { mimeType }; }
  return resolveDocumentUpload(name, content);
}
export async function v9UploadFile(ctx: SessionContext, input: { caseId: string; revision: number; slot: string; name: string; content: Buffer }): Promise<string> {
  identifier(input.caseId);
  if (!ctx.userId || !Number.isSafeInteger(input.revision) || input.revision < 1 || !input.name || input.name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(input.name) || !input.slot || input.slot.length > 240 || !Buffer.isBuffer(input.content) || !input.content.length || input.content.length > 10 * 1024 * 1024) throw new M.V9Error('Choose a supported file of at most 10 MB with a safe filename.');
  const content = Buffer.from(input.content), contentHash = createHash('sha256').update(content).digest('hex');
  let mimeType: string;
  try { mimeType = (await resolveV9Upload(input.name, content)).mimeType; } catch { throw new M.V9Error('The file contents do not match a supported PDF, Word, Excel, image or text file.'); }
  return withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); const row = await load(tx, ctx, input.caseId), config = await configTx(tx, ctx);
    if (!config || !['pending', 'submitted'].includes(row.data.state)) throw new M.V9Error('This case is not open for uploads.');
    const retained = row.data.files.find(f => f.slot === input.slot && f.contentHash === contentHash);
    if (retained) return retained.id;
    const previousFile = row.data.files.find(file => file.slot === input.slot);
    if (previousFile && row.data.mails.some(mail => !mail.test && ['pending','sending','uncertain'].includes(mail.status) && mail.fileIds.includes(previousFile.id))) throw new M.V9Error('This file is reserved for a queued delivery. Review that delivery before replacing it.', 'conflict');
    if (row.revision !== input.revision) throw new M.V9Error('This case changed. Refresh before uploading.', 'conflict');
    const slots = [...config.emails.filter(e => e.module === row.data.module).flatMap(e => e.slots.map(s => `${e.id}:${s.id}`)), ...config.workflows.filter(w => w.module === row.data.module).flatMap(w => w.steps.filter(s => s.type === 'waitFile').map(s => s.slot)), ...row.data.runs.flatMap(r => r.definition?.steps.filter(s => s.type === 'waitFile').map(s => s.slot) ?? [])];
    if (!slots.includes(input.slot)) throw new M.V9Error('Choose a configured attachment slot for this case.');
    const id = randomUUID();
    await tx.execute(sql`insert into lc_v9_file(id,tenant_id,case_id,onboarding_case_id,company_id,slot,filename,mime_type,content,uploaded_by) values(${id}::uuid,${ctx.tenantId}::uuid,${row.native ? null : row.id}::uuid,${row.native ? row.id : null}::uuid,${row.company_id}::uuid,${input.slot},${input.name},${mimeType},decode(${content.toString('base64')},'base64'),${ctx.userId}::uuid)`);
    const c = structuredClone(row.data), env = await environment(tx, ctx, c, config);
    c.files = [...c.files.filter(f => f.slot !== input.slot), { id, slot: input.slot, name: input.name, storageId: id, contentHash }];
    M.appendLog(c, env, 'file.uploaded', `${input.name} · ${input.slot}`);
    for (const workflow of config.workflows) if (c.runs.some(r => r.workflowId === workflow.id && r.status === 'waiting')) M.runWorkflow(c, config, workflow, env, 'resume');
    await store(tx, ctx, row, c, 'fileUploaded'); return id;
  });
}
export async function v9DownloadFile(ctx: SessionContext, caseId: string, fileId: string): Promise<{ name: string; mimeType: string; content: Buffer }> {
  identifier(caseId); identifier(fileId);
  return withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); const row = await load(tx, ctx, caseId);
    const [file] = await tx.execute<{ filename: string; mime_type: string; bytes: string }>(sql`select filename,mime_type,encode(content,'base64') as bytes from lc_v9_file where id=${fileId}::uuid and tenant_id=${ctx.tenantId}::uuid and (case_id=${row.id}::uuid or onboarding_case_id=${row.id}::uuid)`);
    if (!file) throw new M.V9Error('File not found or unavailable.', 'not_found');
    await record(tx, ctx, row.id, row.data.facts.employmentId, 'fileDownloaded');
    return { name: file.filename, mimeType: file.mime_type, content: Buffer.from(file.bytes, 'base64') };
  });
}
export async function v9OwnDocument(ctx: SessionContext, input: { caseId: string; revision: number; documentId: string; values: Record<string, string>; signature?: Pick<M.Signature, 'method' | 'value' | 'consent'> }): Promise<void> {
  identifier(input.caseId);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !input.documentId || input.documentId.length > 120 || JSON.stringify(input.values).length > 1048576) throw new M.V9Error('Invalid document details.');
  await withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); await actor(tx, ctx);
    const [result] = await tx.execute<{ employment: string }>(sql`select app.lc_v9_self_document(${input.caseId}::uuid,${input.revision},${input.documentId},${JSON.stringify(input.values)}::jsonb,${input.signature ? JSON.stringify(input.signature) : null}::jsonb) as employment`);
    if (!result?.employment) throw new M.V9Error('Document not available.', 'not_found');
    await record(tx, ctx, input.caseId, result.employment, input.signature ? 'employeeDocumentSigned' : 'employeeDocumentSaved');
  });
}

type EmailAssetRow = { id: string; email_template_id: string; kind: 'file' | 'image'; filename: string; mime_type: string; size: number; content_hash: string; created_at: string; uploaded_by_name: string };
function emailAssetMetadata(row: EmailAssetRow): M.EmailAsset { return { id: row.id, kind: row.kind, name: row.filename, mimeType: row.mime_type, size: Number(row.size), contentHash: row.content_hash, at: new Date(row.created_at).toISOString(), by: row.uploaded_by_name }; }
/** Immutable bytes are uploaded first; the ordinary versioned definition writer links the receipt. */
export async function v9UploadEmailAsset(ctx: SessionContext, input: { revision: number; emailId: string; kind: 'file' | 'image'; name: string; content: Buffer }): Promise<M.EmailAsset> {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !['file','image'].includes(input.kind) || !input.name || !/\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|txt|csv)$/i.test(input.name) || input.name.length > 180 || /[\x00-\x1f\x7f/\\:]/.test(input.name) || !Buffer.isBuffer(input.content) || !input.content.length || input.content.length > (input.kind === 'image' ? 1048576 : 10485760)) throw new M.V9Error('Choose a supported file of at most 10 MB, or an email image of at most 1 MB.');
  const content = Buffer.from(input.content); let mimeType: string;
  try { mimeType = (await resolveV9Upload(input.name, content)).mimeType; } catch { throw new M.V9Error('The file contents do not match a supported PDF, Word, Excel, image or text file.'); }
  if (input.kind === 'image') {
    if (!['image/png','image/jpeg','image/gif','image/webp'].includes(mimeType)) throw new M.V9Error('Use PNG, JPG, GIF or WebP for an email image.');
    try { await (await import('../../../lib/email-design/assets')).validateEmailAsset(content, mimeType); } catch { throw new M.V9Error('Choose a readable PNG, JPG, GIF or WebP email image within the supported dimensions.'); }
  }
  return withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); await admin(tx); const who = await actor(tx, ctx), config = await configTx(tx, ctx, true);
    if (!config || config.revision !== input.revision) throw new M.V9Error('Settings changed. Refresh before uploading.', 'conflict');
    const email = config.emails.find(email => email.id === input.emailId); if (!email) throw new M.V9Error('Email template not found.', 'not_found');
    const hash = createHash('sha256').update(content).digest('hex');
    const [existing] = await tx.execute<EmailAssetRow>(sql`select *,octet_length(content) as size from lc_v9_email_asset where tenant_id=${ctx.tenantId}::uuid and email_template_id=${email.id} and kind=${input.kind} and filename=${input.name} and content_hash=${hash} order by created_at,id limit 1`);
    if (existing) return emailAssetMetadata(existing);
    const [row] = await tx.execute<EmailAssetRow>(sql`insert into lc_v9_email_asset(tenant_id,email_template_id,kind,filename,mime_type,content,uploaded_by,uploaded_by_name) values(${ctx.tenantId}::uuid,${email.id},${input.kind},${input.name},${mimeType},decode(${content.toString('base64')},'base64'),${who.id}::uuid,${who.name}) returning *,octet_length(content) as size`);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'lifecycle-v9-email-asset', aggregateId: row.id, eventType: 'lifecycle-v9.emailAssetUploaded', actor: actorOf(ctx), payload: { emailTemplateId: email.id, kind: input.kind, bytes: content.length, contentHash: hash } });
    return emailAssetMetadata(row);
  });
}
export async function v9DownloadEmailAsset(ctx: SessionContext, id: string): Promise<{ name: string; mimeType: string; content: Buffer }> {
  identifier(id);
  return withLifecycleTenant(ctx, async tx => {
    await actor(tx, ctx);
    const [row] = await tx.execute<{ filename: string; mime_type: string; bytes: string }>(sql`select a.filename,a.mime_type,encode(a.content,'base64') as bytes from lc_v9_email_asset a where a.id=${id}::uuid and a.tenant_id=${ctx.tenantId}::uuid and (a.uploaded_by=${ctx.userId}::uuid or exists(select 1 from lc_v9_config c cross join lateral jsonb_array_elements(c.data->'emails') e cross join lateral jsonb_array_elements(coalesce(e->'files','[]'::jsonb)||coalesce(e->'images','[]'::jsonb)) f where c.tenant_id=a.tenant_id and e->>'id'=a.email_template_id and f->>'id'=a.id::text))`);
    if (!row) throw new M.V9Error('Email file not found or unavailable.', 'not_found');
    return { name: row.filename, mimeType: row.mime_type, content: Buffer.from(row.bytes, 'base64') };
  });
}
/** Authorized saved instance only: HR scope or the linked employee's released-document projection. */
export async function v9DownloadDocument(ctx: SessionContext, caseId: string, documentId: string): Promise<{ name: string; content: Uint8Array }> {
  identifier(caseId); documentId = commandId.parse(documentId);
  let document: M.Document | undefined, reference = '';
  try {
    const detail = await v9CaseDetail(ctx, caseId); document = detail.case.documents.find(d => d.id === documentId); reference = detail.case.number;
  } catch (error) {
    if (!(error instanceof M.V9Error || error instanceof OnboardingError) || !['forbidden', 'not_found'].includes(error.code)) throw error;
    const own = (await v9OwnWork(ctx)).find(c => c.id === caseId); document = own?.documents.find(d => d.id === documentId); reference = own?.number ?? '';
  }
  if (!document) throw new M.V9Error('Document not found or unavailable.', 'not_found');
  const { renderV9DocumentPdf } = await import('../../../lib/lifecycle-v9-pdf');
  const result = await renderV9DocumentPdf(document, reference);
  return { name: document.name.replace(/[^\p{L}\p{N} ._()-]/gu, '_') + '.pdf', content: result.bytes };
}
