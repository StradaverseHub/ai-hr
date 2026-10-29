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
import { v9Defaults } from '../../../lib/lifecycle-v9-defaults';
import { parseV9Config, validateV9ConfigChange, v9Equal } from '../../../lib/lifecycle-v9-validation';
import { readSettlementTx, type SettlementView } from './settlement';
import { readV9PersonnelTx, pushV9PersonnelTx, lockV9PersonnelWritesTx, v9PersonnelWritableKeys } from '../../../core/lifecycle-v9-personnel';
import { onboardingSetupTx, onboardingSaveGroupsTx, onboardingAssignmentLoadsTx, onboardingUnavailableTx } from '../onboarding/service';
import { issuedToTx, returnAssetTx } from '../../../core/lifecycle-assets';
import { resolveDocumentUpload } from '../../../core/employee-documents';

type Row = { id: string; revision: number; company_id: string; data: M.Case };
export type DirectoryUser = { id: string; name: string };
export type Options = { users: DirectoryUser[]; companies: { id: string; name: string }[]; employees: { id: string; name: string; employeeNo: string; companyId: string }[]; labels?: Partial<Record<M.RuleField, Record<string, string>>>; leaveTypes?: { id: string; name: string }[] };
export type Workspace = { config: M.Config | null; cases: M.Case[]; options: Options; canConfigure: boolean; actor: M.Actor; personnelWritableKeys: string[] };
export type OwnCase = Pick<M.Case, 'id' | 'number' | 'module' | 'revision' | 'state' | 'facts' | 'tasks' | 'items' | 'documents'> & { own: boolean };
export type CaseDetail = { case: M.Case; calculation: SettlementView | null; personnelWritableKeys: string[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identifier(value: string): string { if (!uuid.test(value)) throw new M.V9Error('A valid record identifier is required.'); return value; }
async function admin(tx: Tx, companyId?: string): Promise<void> {
  const [result] = await tx.execute<{ ok: boolean }>(companyId ? sql`select app.is_admin_for(${companyId}::uuid) as ok` : sql`select app.is_group_admin() as ok`);
  if (!result?.ok) throw new M.V9Error('You do not have permission to change this lifecycle record.', 'forbidden');
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
  if (!row) throw new M.V9Error('Case not found or unavailable.', 'not_found'); await admin(tx, row.company_id); return row;
}
async function record(tx: Tx, ctx: SessionContext, id: string, employmentId: string, action: string): Promise<void> {
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'lifecycle-v9-case', aggregateId: id, eventType: `lifecycle-v9.${action}`, actor: actorOf(ctx), subjectEmploymentId: employmentId, payload: { caseId: id, action } });
}
async function store(tx: Tx, ctx: SessionContext, row: Row, next: M.Case, action: string): Promise<void> {
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
  const company = await tx.execute<{ name: string }>(sql`select legal_name as name from company where id=${c.facts.company}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  const [personnel] = await tx.execute<{ position: string | null; department: string | null; business_group: string | null; email: string | null }>(sql`select pos.title as position,dept.name as department,bu.name as business_group,p.primary_email as email from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id left join position pos on pos.id::text=${c.facts.title} and pos.tenant_id=e.tenant_id left join department dept on dept.id::text=${c.facts.department} and dept.tenant_id=e.tenant_id left join business_unit bu on bu.id::text=${c.facts.businessGroup} and bu.tenant_id=e.tenant_id where e.id=${c.facts.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid`);
  const source = await readV9PersonnelTx(tx, ctx, c.facts.employmentId);
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
  values['signatory.title'] = signatory?.signatoryTitle ?? '';
  const calculation = c.module === 'off' ? await readSettlementTx(tx, ctx, c, config) : null;
  if (calculation?.ready) Object.assign(values, { 'leave.remaining': String(calculation.remainingLeave), 'leave.encashDays': String(calculation.encashDays), 'leave.encashAmount': `${calculation.currency} ${calculation.amount!.toFixed(2)}`, 'leave.dailyRate': `${calculation.currency} ${calculation.dailyRate!.toFixed(2)}`, 'pay.finalPayDate': fmt(calculation.payDate) });
  return { today, now: new Date().toISOString(), actor: who, nextId: randomUUID,
    onLeave: (id, date) => unavailable.some(r => r.user_id === id && r.on_date === date),
    openLoad: id => Number(sharedLoads.find(load => load.user_id === id)?.task_load ?? 0),
    lastAssigned: id => { const last = sharedLoads.find(load => load.user_id === id)?.last_auto; return last ? Date.parse(last) || 0 : 0; },
    eligibleUser: id => users.some(u => u.id === id), userName: id => users.find(u => u.id === id)?.name ?? 'Unlinked user', mergeValues: values, signatoryUserId: signatory?.signatoryUserId ?? null };
}
export async function v9CaseDetail(ctx: SessionContext, id: string): Promise<CaseDetail> {
  return withLifecycleTenant(ctx, async tx => {
    const row = await load(tx, ctx, id), config = await configTx(tx, ctx);
    if (!config) throw new M.V9Error('V9 configuration is not available.');
    return { case: row.data, calculation: await readSettlementTx(tx, ctx, row.data, config), personnelWritableKeys: v9PersonnelWritableKeys };
  });
}

export async function v9Workspace(ctx: SessionContext): Promise<Workspace> {
  return withLifecycleTenant(ctx, async tx => {
    const who = await actor(tx, ctx), config = await configTx(tx, ctx);
    const [permission] = await tx.execute<{ ok: boolean }>(sql`select app.is_group_admin() as ok`);
    const companies = await tx.execute<{ id: string; name: string }>(sql`select id,legal_name as name from company where tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(id) order by legal_name,id`);
    if (!permission?.ok && !companies.length) throw new M.V9Error('HR administration access is required. Open your assigned lifecycle tasks instead.', 'forbidden');
    const users = await tx.execute<DirectoryUser>(sql`select u.id,coalesce(p.full_name,'User') as name from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id) order by name,u.id`);
    const employees = await tx.execute<{ id: string; name: string; employeeNo: string; companyId: string }>(sql`select e.id,p.full_name as name,e.employee_code as "employeeNo",e.company_id as "companyId" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(e.company_id) order by p.full_name,e.id`);
    const rows = config ? await tx.execute<{ data: M.Case }>(sql`select data from lc_v9_case where tenant_id=${ctx.tenantId}::uuid order by created_at desc,id desc`) : [];
    const masters = await tx.execute<{ kind: M.RuleField; id: string; name: string }>(sql`select 'businessGroup' as kind,id,name from business_unit where tenant_id=${ctx.tenantId}::uuid union all select 'department',id,name from department where tenant_id=${ctx.tenantId}::uuid union all select 'grade',id,name from job_grade where tenant_id=${ctx.tenantId}::uuid union all select 'title',id,title from position where tenant_id=${ctx.tenantId}::uuid`);
    const labels: NonNullable<Options['labels']> = { company: Object.fromEntries(companies.map(c => [c.id, c.name])), employmentType: { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Intern' }, caseType: Object.fromEntries(['Resignation', 'Termination', 'Contract end', 'Retirement', 'Non-confirmation'].map(value => [value, value])) };
    for (const master of masters) (labels[master.kind] ??= {})[master.id] = master.name;
    const leaveTypes = await tx.execute<{ id: string; name: string }>(sql`select id,name from leave_type where tenant_id=${ctx.tenantId}::uuid and archived_at is null order by name,id`);
    return { config, cases: rows.map(r => r.data), options: { companies: [...companies], users: [...users], employees: [...employees], labels, leaveTypes: [...leaveTypes] }, canConfigure: !!permission?.ok, actor: who, personnelWritableKeys: v9PersonnelWritableKeys };
  });
}
export async function v9Setup(ctx: SessionContext): Promise<void> {
  await withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); await admin(tx);
    if (await configTx(tx, ctx)) throw new M.V9Error('V9 is already configured.', 'conflict');
    await onboardingSetupTx(ctx, tx);
    const [previous] = await tx.execute<{ revision: number; data: { groups: M.Group[] } }>(sql`select revision,data from lc_onboarding_config where tenant_id=${ctx.tenantId}::uuid`);
    const config = v9Defaults(previous?.data.groups ?? []);
    const shared = [...(previous?.data.groups ?? [])];
    for (const group of config.groups) if (!shared.some(g => g.id === group.id)) shared.push(group);
    const saved = await onboardingSaveGroupsTx(ctx, tx, previous!.revision, shared);
    config.groups = shared; config.groupsRevision = saved.revision;
    const masters = await tx.execute<{ kind: M.RuleField; id: string; name: string; code: string | null }>(sql`select 'businessGroup' as kind,id,name,code from business_unit where tenant_id=${ctx.tenantId}::uuid union all select 'company',id,legal_name,company_label from company where tenant_id=${ctx.tenantId}::uuid union all select 'department',id,name,label from department where tenant_id=${ctx.tenantId}::uuid union all select 'grade',id,name,code from job_grade where tenant_id=${ctx.tenantId}::uuid union all select 'title',id,title,label from position where tenant_id=${ctx.tenantId}::uuid`);
    const resolveRules = (rules: M.Rules) => { for (const key of Object.keys(rules) as M.RuleField[]) { if (key === 'employmentType' || key === 'caseType') continue; rules[key] = rules[key]?.flatMap(value => { if (uuid.test(value)) return [value]; const found = masters.filter(m => m.kind === key && [m.name.toLocaleLowerCase(), m.code?.toLocaleLowerCase()].includes(value.toLocaleLowerCase())); return found.length ? found.map(m => m.id) : [value]; }); } };
    for (const cl of config.checklists) resolveRules(cl.rules);
    for (const template of config.templates) resolveRules(template.rules);
    await tx.execute(sql`insert into lc_v9_config(tenant_id,data) values(${ctx.tenantId}::uuid,${JSON.stringify(config)}::jsonb)`);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'lifecycle-v9-config', aggregateId: ctx.tenantId, eventType: 'lifecycle-v9.configured', actor: actorOf(ctx), payload: { version: 9 } });
  });
}
export async function v9SaveConfig(ctx: SessionContext, revision: number, input: unknown): Promise<void> {
  const config = parseV9Config(input) as M.Config;
  await withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); await admin(tx); const previous = await configTx(tx, ctx, true);
    if (!previous || previous.revision !== revision) throw new M.V9Error('Settings changed. Refresh before saving.', 'conflict');
    validateV9ConfigChange(previous, config);
    if (config.groupsRevision !== previous.groupsRevision) throw new M.V9Error('Assignment groups changed. Refresh before saving.', 'conflict');
    if (!v9Equal(config.groups, previous.groups)) {
      const saved = await onboardingSaveGroupsTx(ctx, tx, previous.groupsRevision!, config.groups);
      config.groupsRevision = saved.revision;
    }
    const users = await tx.execute<{ id: string }>(sql`select id from app_user where tenant_id=${ctx.tenantId}::uuid and archived_at is null`);
    if (config.groups.some(g => g.members.some(id => !users.some(u => u.id === id)))) throw new M.V9Error('A group includes an unavailable user.');
    if (config.bpRules.some(r => !users.some(u => u.id === r.userId)) || config.companies?.some(c => c.signatoryUserId && !users.some(u => u.id === c.signatoryUserId))) throw new M.V9Error('Choose an available user for the PBP and company signatory.');
    const companies = await tx.execute<{ id: string }>(sql`select id from company where tenant_id=${ctx.tenantId}::uuid`);
    if (config.companies?.some(c => !companies.some(co => co.id === c.companyId))) throw new M.V9Error('Choose an available company.');
    const removed = previous.workflows.filter(workflow => !config.workflows.some(next => next.id === workflow.id)).map(workflow => workflow.id);
    if (removed.length) {
      const history = await tx.execute<{ id: string }>(sql`select id from lc_v9_case where tenant_id=${ctx.tenantId}::uuid and exists(select 1 from jsonb_array_elements(data->'runs') r where r->>'workflowId' in (${sql.join(removed.map(id => sql`${id}`), sql`, `)})) limit 1`);
      if (history.length) throw new M.V9Error('A workflow has already run on a record. Keep it for history and pause it instead.');
    }
    await tx.execute(sql`insert into lc_v9_config_revision(tenant_id,revision,data,actor_user_id) values(${ctx.tenantId}::uuid,${revision},${JSON.stringify(previous)}::jsonb,${ctx.userId}::uuid)`);
    config.revision = revision + 1;
    await tx.execute(sql`update lc_v9_config set data=${JSON.stringify(config)}::jsonb,revision=${config.revision},updated_at=now() where tenant_id=${ctx.tenantId}::uuid`);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'lifecycle-v9-config', aggregateId: ctx.tenantId, eventType: 'lifecycle-v9.configurationChanged', actor: actorOf(ctx), payload: { revision: config.revision } });
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
    const [employee] = await tx.execute<{ id: string; company_id: string; person_id: string; name: string; employee_no: string; hired_on: string; grade_id: string | null }>(sql`select e.id,e.company_id,e.person_id,p.full_name as name,e.employee_code as employee_no,coalesce(e.join_date,e.hired_on)::text as hired_on,e.grade_id from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.id=${input.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid for update of e`);
    if (!employee) throw new M.V9Error('Employee not found or unavailable.', 'not_found'); await admin(tx, employee.company_id);
    const [assignment] = await tx.execute<{ department_id: string | null; business_unit_id: string | null; position_id: string | null; employment_type: string | null }>(sql`select department_id,business_unit_id,position_id,employment_type from assignment where employment_id=${employee.id}::uuid and tenant_id=${ctx.tenantId}::uuid and superseded_at is null and valid_from<=${todayInKualaLumpur()}::date and (valid_to is null or valid_to>${todayInKualaLumpur()}::date) order by valid_from desc,id limit 1`);
    const logins = await tx.execute<{ id: string }>(sql`select id from app_user where tenant_id=${ctx.tenantId}::uuid and person_id=${employee.person_id}::uuid and archived_at is null order by id`);
    const managers = await tx.execute<{ id: string }>(sql`select u.id from reporting_line r join employment e on e.id=r.manager_employment_id and e.tenant_id=r.tenant_id join app_user u on u.person_id=e.person_id and u.tenant_id=e.tenant_id and u.archived_at is null where r.tenant_id=${ctx.tenantId}::uuid and r.subordinate_employment_id=${employee.id}::uuid and r.line_type='administrative' and r.superseded_at is null and r.valid_from<=${todayInKualaLumpur()}::date and (r.valid_to is null or r.valid_to>${todayInKualaLumpur()}::date) order by r.valid_from desc,r.id,u.id`);
    const { nextNumber } = await import('../../../core/lifecycle-base');
    const id = randomUUID(), number = await nextNumber(tx, 'OFB9');
    const c: M.Case = { version: 9, id, number, module: 'off', revision: 1, state: 'pending', facts: { name: employee.name, employeeNo: employee.employee_no, employmentId: employee.id, personId: employee.person_id, joinDate: employee.hired_on, lastDay: input.lastDay, noticeDate: input.noticeDate, employeeUserId: logins.length === 1 ? logins[0].id : null, supervisorUserId: managers.length === 1 ? managers[0].id : null, pbpUserId: null, taUserId: null, company: employee.company_id, businessGroup: assignment?.business_unit_id ?? '', department: assignment?.department_id ?? '', grade: employee.grade_id ?? '', title: assignment?.position_id ?? '', employmentType: assignment?.employment_type ?? '', caseType: input.type }, checklistId: null, checklistName: '', override: 'automatic', tasks: [], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: '', submittedAt: null, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: input.lastDay, finalFigures: null, review: null };
    const who = await actor(tx, ctx); c.log.push({ id: randomUUID(), at: new Date().toISOString(), actor: who, action: 'case.created', detail: 'Created from Personnel Management.' });
    c.sourceRevision = createHash('sha256').update(JSON.stringify({ employee, assignment })).digest('hex');
    await tx.execute(sql`insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,data) values(${id}::uuid,${ctx.tenantId}::uuid,${employee.company_id}::uuid,${employee.id}::uuid,'off',${number},${JSON.stringify(c)}::jsonb)`);
    await record(tx, ctx, id, employee.id, 'created'); return id;
  });
}
export type Command =
  | { type: 'pmPush'; id: string }
  | { type: 'pmPushSelected' | 'pmKeep'; ids: string[] }
  | { type: 'submit' }
  | { type: 'task'; id: string; status: M.Task['status']; reason: string }
  | { type: 'generate'; template: string }
  | { type: 'emailSend' | 'emailTest'; emailId: string }
  | { type: 'emailEdit'; emailId: string; subject: string; body: string }
  | { type: 'documentSave'; id: string; values: Record<string, string> }
  | { type: 'documentSign'; id: string; signature: Pick<M.Signature, 'method' | 'value' | 'consent'> }
  | { type: 'documentRefresh'; id: string }
  | { type: 'clear'; sourceRevision: string; reason: string }
  | { type: 'settlementOptions'; options: NonNullable<M.Case['settlementOptions']>; reason: string }
  | { type: 'cancel' | 'reopen'; reason: string }
  | { type: 'runWorkflows' }
  | { type: 'retryWorkflow'; workflowId: string }
  | { type: 'override'; checklist: string }
  | { type: 'assign'; id: string; userId: string }
  | { type: 'item'; id: string; status: M.Item['status']; reason: string };
const commandId = z.string().min(1).max(120), reasonText = z.string().max(4000);
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pmPush'), id: commandId }).strict(),
  z.object({ type: z.literal('pmPushSelected'), ids: z.array(commandId).min(1).max(500) }).strict(),
  z.object({ type: z.literal('pmKeep'), ids: z.array(commandId).min(1).max(500) }).strict(),
  z.object({ type: z.literal('submit') }).strict(), z.object({ type: z.literal('runWorkflows') }).strict(),
  z.object({ type: z.literal('retryWorkflow'), workflowId: commandId }).strict(),
  z.object({ type: z.literal('task'), id: commandId, status: z.enum(['todo', 'progress', 'done', 'notNeeded']), reason: reasonText }).strict(),
  z.object({ type: z.literal('generate'), template: commandId }).strict(),
  z.object({ type: z.literal('emailSend'), emailId: commandId }).strict(), z.object({ type: z.literal('emailTest'), emailId: commandId }).strict(),
  z.object({ type: z.literal('emailEdit'), emailId: commandId, subject: z.string().min(1).max(1000), body: z.string().max(20000) }).strict(),
  z.object({ type: z.literal('documentSave'), id: commandId, values: z.record(commandId, z.string().max(20000)) }).strict(),
  z.object({ type: z.literal('documentSign'), id: commandId, signature: z.object({ method: z.enum(['typed', 'drawn']), value: z.string().min(1).max(500000), consent: z.literal(true) }).strict() }).strict(),
  z.object({ type: z.literal('documentRefresh'), id: commandId }).strict(),
  z.object({ type: z.literal('clear'), sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), reason: reasonText }).strict(),
  z.object({ type: z.literal('settlementOptions'), reason: reasonText.min(1), options: z.object({ keepSourceDate: z.boolean(), offsetLeave: z.boolean(), override: z.object({ date: z.string().refine(M.validDate), reason: reasonText.min(1), kind: z.enum(['earlyRelease', 'waived', 'payInLieu', 'immediate', 'other']) }).strict().nullable(), reduceEncashment: z.object({ days: z.number().min(0).max(10000), reason: reasonText.min(1) }).strict().nullable() }).strict() }).strict(),
  z.object({ type: z.literal('cancel'), reason: reasonText }).strict(), z.object({ type: z.literal('reopen'), reason: reasonText }).strict(),
  z.object({ type: z.literal('override'), checklist: commandId }).strict(), z.object({ type: z.literal('assign'), id: commandId, userId: z.string().uuid() }).strict(),
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
    const c = structuredClone(row.data), env = await environment(tx, ctx, c, config);
    if (command.type === 'submit') {
      M.submit(c, config, env);
      if (c.module === 'off') {
        const group = config.groups.find(g => g.id === 'g-tech' || g.name === 'Group Tech'), extra: Record<string, number> = {};
        for (const task of c.tasks) if (task.assignee) extra[task.assignee] = (extra[task.assignee] ?? 0) + 1;
        const assets = await issuedToTx(tx, c.facts.employeeNo, c.facts.company);
        c.items = assets.map(asset => {
          const assigned = M.assign(config, group?.id ?? null, c.revokeDate, env, extra, 'memberOrder');
          if (assigned.userId) extra[assigned.userId] = (extra[assigned.userId] ?? 0) + 1;
          return { id: randomUUID(), name: `${asset.code} · ${asset.model ?? asset.assetType}`, kind: 'device' as const, sourceId: asset.id, group: group?.id ?? null, assignee: assigned.userId, dueOn: c.revokeDate, status: 'todo' as const, reason: '' };
        });
        M.appendLog(c, env, 'returns.created', `${c.items.length} return items loaded from the asset register.`);
      }
      for (const w of config.workflows) { M.runWorkflow(c, config, w, env, 'submitted'); M.runWorkflow(c, config, w, env, 'date'); }
    }
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
    else if (command.type === 'emailEdit') { if (!config.emails.some(e => e.id === command.emailId && e.module === c.module) || command.body.length > 20000 || command.subject.length > 1000) throw new M.V9Error('Choose an available email and keep its content within the allowed length.'); c.emailEdits = { ...c.emailEdits, [command.emailId]: { subject: command.subject, body: command.body } }; M.appendLog(c, env, 'email.edited', 'Email text changed for this person only.'); }
    else if (command.type === 'documentSave') M.saveDocument(c, command.id, command.values, 'hr', env);
    else if (command.type === 'documentSign') M.signDocument(c, config, command.id, 'hr', { ...command.signature, by: env.actor, at: env.now }, env);
    else if (command.type === 'documentRefresh') { const document = c.documents.find(d => d.id === command.id); if (!document || document.status !== 'draft') throw new M.V9Error('Only an unsigned draft can refresh its source values.'); document.mergeValues = { ...env.mergeValues }; document.signatoryUserId = env.signatoryUserId ?? null; for (const field of document.fields) if (field.owner === 'pmLocked' && field.pmKey) document.values[field.id] = env.mergeValues[field.pmKey] ?? ''; M.appendLog(c, env, 'document.refreshed', document.name); }
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
      const calculation = await readSettlementTx(tx, ctx, c, config);
      const figures = calculation?.ready && calculation.lastDay === c.facts.lastDay ? { sourceRevision: calculation.sourceRevision, lastDay: calculation.lastDay, leaveDays: String(calculation.encashDays), amount: calculation.amount!.toFixed(2), currency: calculation.currency, payDate: calculation.payDate, lockedAt: env.now, payrollReference: randomUUID() } : null;
      M.lastDayCheck(c, config, env, figures);
    }
    else if (command.type === 'retryWorkflow') { const workflow = config.workflows.find(w => w.id === command.workflowId); if (!workflow) throw new M.V9Error('Workflow not found.'); M.runWorkflow(c, config, workflow, env, 'resume'); }
    else if (command.type === 'override') { if (c.state !== 'pending') throw new M.V9Error('The submitted checklist is frozen.'); c.override = command.checklist; M.matchChecklist(config, c); M.appendLog(c, env, 'checklist.overridden', command.checklist); }
    else if (command.type === 'assign') {
      if (c.state !== 'submitted') throw new M.V9Error('This case is not open.');
      const task = c.tasks.find(t => t.id === command.id); if (!task) throw new M.V9Error('Task not found.');
      if (!config.groups.some(g => g.id === task.group && g.members.includes(command.userId)) || !env.eligibleUser(command.userId)) throw new M.V9Error('Choose an eligible member of the task group.');
      task.assignee = command.userId; task.assignmentFailure = null; M.appendLog(c, env, 'task.reassigned', `${task.name} · ${env.userName(command.userId)}`, { userId: command.userId, groupId: task.group! });
    } else if (command.type === 'item') {
      if (c.state !== 'submitted') throw new M.V9Error('This case is not open.');
      const item = c.items.find(i => i.id === command.id); if (!item) throw new M.V9Error('Item not found.');
      if (['notNeeded', 'notReturned'].includes(command.status) && !command.reason.trim()) throw new M.V9Error('Record a reason for this item.');
      if (item.kind === 'device' && item.sourceId && command.status === 'done' && item.status !== 'done') {
        const assets = await issuedToTx(tx, c.facts.employeeNo, c.facts.company), asset = assets.find(a => a.id === item.sourceId);
        if (!asset) throw new M.V9Error('The asset register changed. Review who holds this device before marking it returned.', 'conflict');
        await returnAssetTx(tx, ctx, asset.code, { requisitionNumber: c.number });
      }
      if (item.sourceId && item.status === 'done' && command.status !== 'done') throw new M.V9Error('This return is already recorded in the asset register. Use the asset register to correct it before reopening the item.');
      item.status = command.status; item.reason = command.reason.trim(); M.appendLog(c, env, 'item.updated', `${item.name}: ${item.status}`);
    }
    for (const w of config.workflows) if (c.runs.some(r => r.workflowId === w.id && r.status === 'waiting')) M.runWorkflow(c, config, w, env, 'resume');
    await store(tx, ctx, row, c, command.type);
  });
}
/** Called only by the existing privileged maintenance connection, after 08:00 Malaysia time. */
export async function v9Sweep(ctx: SessionContext, connection: NotificationSweepConnection, now = new Date()) {
  assertModuleEnabled(ctx, 'lifecycle');
  if (ctx.userId || timeInKualaLumpur(now) < '08:00') return { processed: 0, failed: 0 };
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
      for (const w of config.workflows) { if (c.runs.some(r => r.workflowId === w.id && r.status === 'waiting')) M.runWorkflow(c, config, w, env, 'resume'); M.runWorkflow(c, config, w, env, 'date'); }
      const calculation = await readSettlementTx(tx, ctx, c, config);
      const figures = calculation?.ready && calculation.lastDay === c.facts.lastDay ? { sourceRevision: calculation.sourceRevision, lastDay: calculation.lastDay, leaveDays: String(calculation.encashDays), amount: calculation.amount!.toFixed(2), currency: calculation.currency, payDate: calculation.payDate, lockedAt: env.now, payrollReference: randomUUID() } : null;
      M.lastDayCheck(c, config, env, figures);
      if (JSON.stringify(c) === JSON.stringify(row.data)) return false;
      await store(tx, ctx, row, c, 'scheduled'); return true;
    });
    if (changed) output.processed++;
  } catch { output.failed++; }
  return output;
}
export async function v9OwnWork(ctx: SessionContext): Promise<OwnCase[]> {
  return withLifecycleTenant(ctx, async tx => {
    await actor(tx, ctx);
    const rows = await tx.execute<{ data: OwnCase }>(sql`select app.lc_v9_work(null) as data`);
    return rows.map(r => r.data);
  });
}
export async function v9OwnTask(ctx: SessionContext, input: { caseId: string; revision: number; taskId: string; status: 'todo' | 'progress' | 'done'; reason: string }): Promise<void> {
  input = z.object({ caseId: z.string().uuid(), revision: z.number().int().positive(), taskId: commandId, status: z.enum(['todo', 'progress', 'done']), reason: reasonText }).strict().parse(input);
  await withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); await actor(tx, ctx);
    const [result] = await tx.execute<{ employment: string }>(sql`select app.lc_v9_self_task(${input.caseId}::uuid,${input.revision},${input.taskId},${input.status},${input.reason}) as employment`);
    if (!result?.employment) throw new M.V9Error('Task not available.', 'not_found');
    await record(tx, ctx, input.caseId, result.employment, 'assignedTaskUpdated');
  });
}
export async function v9UploadFile(ctx: SessionContext, input: { caseId: string; revision: number; slot: string; name: string; content: Buffer }): Promise<string> {
  identifier(input.caseId);
  if (!ctx.userId || !Number.isSafeInteger(input.revision) || input.revision < 1 || !input.name || input.name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(input.name) || !input.slot || input.slot.length > 240 || !Buffer.isBuffer(input.content) || !input.content.length || input.content.length > 10 * 1024 * 1024) throw new M.V9Error('Choose a supported file of at most 10 MB with a safe filename.');
  const content = Buffer.from(input.content), contentHash = createHash('sha256').update(content).digest('hex');
  let mimeType: string;
  try { mimeType = resolveDocumentUpload(input.name, content).mimeType; } catch { throw new M.V9Error('The file contents do not match a supported PDF, Word, Excel, image or text file.'); }
  return withLifecycleTenant(ctx, async tx => {
    await lockTx(tx, ctx); const row = await load(tx, ctx, input.caseId), config = await configTx(tx, ctx);
    if (!config || !['pending', 'submitted'].includes(row.data.state)) throw new M.V9Error('This case is not open for uploads.');
    const retained = row.data.files.find(f => f.slot === input.slot && f.contentHash === contentHash);
    if (retained) return retained.id;
    if (row.revision !== input.revision) throw new M.V9Error('This case changed. Refresh before uploading.', 'conflict');
    const slots = [...config.emails.filter(e => e.module === row.data.module).flatMap(e => e.slots.map(s => `${e.id}:${s.id}`)), ...config.workflows.filter(w => w.module === row.data.module).flatMap(w => w.steps.filter(s => s.type === 'waitFile').map(s => s.slot)), ...row.data.runs.flatMap(r => r.definition?.steps.filter(s => s.type === 'waitFile').map(s => s.slot) ?? [])];
    if (!slots.includes(input.slot)) throw new M.V9Error('Choose a configured attachment slot for this case.');
    const id = randomUUID();
    await tx.execute(sql`insert into lc_v9_file(id,tenant_id,case_id,company_id,slot,filename,mime_type,content,uploaded_by) values(${id}::uuid,${ctx.tenantId}::uuid,${row.id}::uuid,${row.company_id}::uuid,${input.slot},${input.name},${mimeType},decode(${content.toString('base64')},'base64'),${ctx.userId}::uuid)`);
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
    const [file] = await tx.execute<{ filename: string; mime_type: string; bytes: string }>(sql`select filename,mime_type,encode(content,'base64') as bytes from lc_v9_file where id=${fileId}::uuid and tenant_id=${ctx.tenantId}::uuid and case_id=${row.id}::uuid`);
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
