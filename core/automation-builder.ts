/**
 * Reads and one bounded batch command behind the shared "HR Automation" builders (ADR
 * docs/adr/2026-11-15-probation-shared-automation.md, decision 1 and 2; migrations 5740 and 5743).
 *
 * Every read is set-based, bounded and runs under the caller's row security. Each first asks the database who may
 * configure (app.automation_can_configure / _any), so someone who configures nothing learns nothing here.
 * Organisation option lists are reference data for routing rows (business group, company, department, job title);
 * values are the same identifiers the Personnel facts carry (company ids; job title text from `position`).
 */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {withScopedLifecycleTenant} from './module-gate';
import {automationCatalogue} from '../lib/automation/catalogues';
import {automationWorkflowProblems,type AutomationReferences,type AutomationWorkflow} from '../lib/automation/workflow';
import {routingProblems,type Routing} from '../lib/automation/routing';
import {automationEmailTemplateProblems,type AutomationEmailTemplate} from '../lib/automation/email';
import {AutomationError,MAX_LISTED_ROUTINGS} from './automation-store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_ROUTING_OPTION_COMPANIES = 500;
export const MAX_ROUTING_OPTION_DEPARTMENTS = 2000;
export const MAX_ROUTING_OPTION_TITLES = 1000;
export const MAX_PEOPLE_NAMES = 500;
export const MAX_PEOPLE_SEARCH = 20;

export type AutomationBuilderAccess = { probation: boolean; any: boolean };
export type AutomationOption = { id: string; name: string };
export type AutomationRoutingOptions = {
  businessGroups: AutomationOption[];
  companies: (AutomationOption & { businessGroupId: string })[];
  departments: (AutomationOption & { companyId: string })[];
  jobTitles: string[];
  /** Job grade codes as Probation stores them on a case (prefix JG / GRADE removed). */
  jobGrades: string[];
};

/** Reference checks for saving: live routings, existing assignment groups, active people. Three bounded statements. */
export async function automationReferencesTx(tx: Tx, people: readonly string[]): Promise<AutomationReferences> {
  const routingRows = await tx.execute<{ id: string; retired: boolean }>(sql`select distinct on (routing_id) routing_id as id, retired from automation_routing_version where tenant_id = app.current_tenant_id() order by routing_id, revision desc limit ${MAX_LISTED_ROUTINGS}`);
  const groupRows = await tx.execute<{ id: string }>(sql`select group_id as id from app.automation_assignment_groups()`);
  const ids = people.filter(id => UUID.test(id)).slice(0, MAX_PEOPLE_NAMES);
  const personRows = ids.length ? await tx.execute<{ id: string }>(sql`select u.id from app.automation_active_users(${`{${ids.join(',')}}`}::uuid[]) as u(id)`) : [];
  const routings = new Set(routingRows.filter(r => !r.retired).map(r => r.id)), groups = new Set(groupRows.map(r => r.id)), persons = new Set(personRows.map(r => r.id));
  return { routingExists: id => routings.has(id), groupExists: id => groups.has(id), personExists: id => persons.has(id) };
}

/** Who may configure what in the shared builders, as the database answers it (5740). */
export function automationBuilderAccess(ctx: SessionContext): Promise<AutomationBuilderAccess> {
  return withScopedLifecycleTenant(ctx, async tx => {
    const [row] = await tx.execute<AutomationBuilderAccess>(sql`select app.automation_can_configure('probation') as probation, app.automation_can_configure_any() as any`);
    return { probation: !!row?.probation, any: !!row?.any };
  });
}

/** Assignment groups (ids and names only; members stay with the On/Off Boarding configuration). At most 500. */
export function automationAssignmentGroups(ctx: SessionContext): Promise<AutomationOption[]> {
  return withScopedLifecycleTenant(ctx, async tx => [...await tx.execute<AutomationOption>(sql`select group_id as id, group_name as name from app.automation_assignment_groups()`)]);
}

async function requireAnyTx(tx: Tx) {
  const [allowed] = await tx.execute<{ ok: boolean }>(sql`select app.automation_can_configure_any() as ok`);
  if (!allowed?.ok) throw new AutomationError('forbidden', 'You cannot configure this.');
}

/** Option lists for routing rows and condition values. Five bounded statements under row security. */
export function automationRoutingOptions(ctx: SessionContext): Promise<AutomationRoutingOptions> {
  return withScopedLifecycleTenant(ctx, async tx => {
    await requireAnyTx(tx);
    const companies = await tx.execute<AutomationOption & { businessGroupId: string }>(sql`
      select c.id, c.legal_name as name, coalesce(c.parent_company_id, c.id) as "businessGroupId"
      from company c where c.tenant_id = app.current_tenant_id() and c.archived_at is null
      order by c.legal_name, c.id limit ${MAX_ROUTING_OPTION_COMPANIES}`);
    const businessGroups = await tx.execute<AutomationOption>(sql`
      select distinct bg.id, bg.legal_name as name
      from company c join company bg on bg.id = coalesce(c.parent_company_id, c.id) and bg.tenant_id = c.tenant_id
      where c.tenant_id = app.current_tenant_id() and c.archived_at is null
      order by name, bg.id limit ${MAX_ROUTING_OPTION_COMPANIES}`);
    const departments = await tx.execute<AutomationOption & { companyId: string }>(sql`
      select d.id, d.name, d.company_id as "companyId" from department d
      where d.tenant_id = app.current_tenant_id() and d.archived_at is null
      order by d.name, d.id limit ${MAX_ROUTING_OPTION_DEPARTMENTS}`);
    const titles = await tx.execute<{ title: string }>(sql`
      select distinct btrim(p.title) as title from position p
      where p.tenant_id = app.current_tenant_id() and p.archived_at is null and btrim(p.title) <> ''
      order by title limit ${MAX_ROUTING_OPTION_TITLES}`);
    const grades = await tx.execute<{ code: string }>(sql`
      select distinct regexp_replace(upper(g.code), '^(JG|GRADE)[ -]*', '', 'g') as code from job_grade g
      where g.tenant_id = app.current_tenant_id() and g.archived_at is null
      order by code limit 500`);
    return { businessGroups: [...businessGroups], companies: [...companies], departments: [...departments], jobTitles: titles.map(t => t.title), jobGrades: grades.map(g => g.code) };
  });
}

/** Display names for people already named in definitions. At most 500 ids; unknown ids are left out. */
export function automationPeopleNames(ctx: SessionContext, ids: readonly string[]): Promise<AutomationOption[]> {
  const wanted = [...new Set(ids.filter(id => UUID.test(id)))].slice(0, MAX_PEOPLE_NAMES);
  if (!wanted.length) return Promise.resolve([]);
  return withScopedLifecycleTenant(ctx, async tx => {
    await requireAnyTx(tx);
    return [...await tx.execute<AutomationOption>(sql`
      select u.id, p.full_name as name from app_user u join person p on p.id = u.person_id and p.tenant_id = u.tenant_id
      where u.tenant_id = app.current_tenant_id() and u.id = any(${`{${wanted.join(',')}}`}::uuid[])
      order by p.full_name, u.id`)];
  });
}

/** People search for "Named people" and routing rows: active users the viewer may see, at most 20 matches. */
export function searchAutomationPeople(ctx: SessionContext, query: string): Promise<AutomationOption[]> {
  const search = query.trim().slice(0, 100);
  if (search.length < 2) return Promise.resolve([]);
  return withScopedLifecycleTenant(ctx, async tx => {
    await requireAnyTx(tx);
    return [...await tx.execute<AutomationOption>(sql`
      select u.id, p.full_name as name from app_user u join person p on p.id = u.person_id and p.tenant_id = u.tenant_id
      where u.tenant_id = app.current_tenant_id() and u.archived_at is null and not app.login_blocked(u.id)
        and position(lower(${search}) in lower(p.full_name)) > 0 and app.access_workforce_person(p.id, 'workforce.view')
      order by p.full_name, u.id limit ${MAX_PEOPLE_SEARCH}`)];
  });
}

export type AutomationDefaults = { workflows: readonly AutomationWorkflow[]; emailTemplates: readonly AutomationEmailTemplate[]; routings: readonly Routing[] };
export type AutomationDefaultsResult = { installed: { workflows: number; emailTemplates: number; routings: number }; alreadyPresent: number };
export const MAX_DEFAULT_DEFINITIONS = 60;

/**
 * Installs a module's shipped defaults in ONE transaction: routings, then email templates, then workflows, each saved
 * at revision 1 through its own database writer (authority, bounds and audit stay there). Idempotent by fixed ids: a
 * definition that already exists, retired or not, is left exactly as it is. Workflows are always installed Paused;
 * they may carry problems (for example a routing with no rows yet) and must be reviewed before they go live.
 */
export async function installAutomationDefaults(ctx: SessionContext, defaults: AutomationDefaults): Promise<AutomationDefaultsResult> {
  const count = defaults.workflows.length + defaults.emailTemplates.length + defaults.routings.length;
  if (!count || count > MAX_DEFAULT_DEFINITIONS) throw new AutomationError('invalid', 'The default set is empty or too large.');
  const modules = new Set([...defaults.workflows.map(w => w.module), ...defaults.emailTemplates.map(t => t.module)]);
  if (modules.size !== 1) throw new AutomationError('invalid', 'Install the defaults of one module at a time.');
  const module = [...modules][0], catalogue = automationCatalogue(module);
  if (!catalogue) throw new AutomationError('invalid', 'This module does not use the shared builders yet.');
  const ids = [...defaults.workflows.map(w => w.id), ...defaults.emailTemplates.map(t => t.id), ...defaults.routings.map(r => r.id)];
  if (ids.some(id => !UUID.test(id)) || new Set(ids).size !== ids.length) throw new AutomationError('invalid', 'Each default needs its own id.');
  return withScopedLifecycleTenant(ctx, async tx => {
    const [allowed] = await tx.execute<{ ok: boolean }>(sql`select app.automation_can_configure(${module}) as ok`);
    if (!allowed?.ok) throw new AutomationError('forbidden', 'You cannot configure this.');
    const array = (list: readonly string[]) => sql`${`{${list.join(',')}}`}::uuid[]`;
    // Three bounded existence reads; nothing loops over tenant data.
    const existing = new Set([
      ...(await tx.execute<{ id: string }>(sql`select distinct workflow_id as id from automation_workflow_version where tenant_id = app.current_tenant_id() and workflow_id = any(${array(defaults.workflows.map(w => w.id))})`)).map(r => r.id),
      ...(await tx.execute<{ id: string }>(sql`select distinct template_id as id from automation_email_template_version where tenant_id = app.current_tenant_id() and template_id = any(${array(defaults.emailTemplates.map(t => t.id))})`)).map(r => r.id),
      ...(await tx.execute<{ id: string }>(sql`select distinct routing_id as id from automation_routing_version where tenant_id = app.current_tenant_id() and routing_id = any(${array(defaults.routings.map(r => r.id))})`)).map(r => r.id),
    ]);
    const groups = new Set((await tx.execute<{ id: string }>(sql`select group_id as id from app.automation_assignment_groups()`)).map(r => r.id));
    const installed = { workflows: 0, emailTemplates: 0, routings: 0 }, reason = 'Installed the default ' + catalogue.label + ' automation';
    try {
      for (const routing of defaults.routings) {
        if (existing.has(routing.id)) continue;
        const problems = routingProblems(routing, id => groups.has(id));
        if (problems.length) throw new AutomationError('invalid', 'A default routing is not valid.', problems);
        await tx.execute(sql`select app.automation_routing_save(${routing.id}::uuid, ${routing.name}, ${JSON.stringify(routing.rows)}::jsonb, false, 0, ${reason})`);
        installed.routings++;
      }
      // References after the routings above exist in this transaction.
      const refs = await automationReferencesTx(tx, []);
      for (const template of defaults.emailTemplates) {
        if (existing.has(template.id)) continue;
        const problems = automationEmailTemplateProblems(template, catalogue, refs);
        if (problems.length) throw new AutomationError('invalid', 'A default email template is not valid.', problems);
        await tx.execute(sql`select app.automation_rich_email_template_save(${template.id}::uuid, ${template.module}, ${template.name}, ${template.active}, ${template.subject}, ${template.body}, ${JSON.stringify(template.cc)}::jsonb, false, 0, ${reason}, null::jsonb)`);
        installed.emailTemplates++;
      }
      for (const workflow of defaults.workflows) {
        if (existing.has(workflow.id)) continue;
        // Installed Paused even when it has problems (for example a routing with no rows yet), never Live.
        const { status, required, ...definition } = workflow;
        if (status === 'retired' || automationWorkflowProblems(workflow, catalogue, refs).some(problem => problem.includes('unknown') || problem.includes('this module has no'))) throw new AutomationError('invalid', `The default workflow “${workflow.name}” does not fit this module.`);
        await tx.execute(sql`select app.automation_workflow_save(${workflow.id}::uuid, ${workflow.module}, 'paused', ${required}, ${JSON.stringify(definition)}::jsonb, 0, ${reason})`);
        installed.workflows++;
      }
    } catch (e) {
      if (e instanceof AutomationError) throw e;
      const state = pgSqlState(e);
      if (state === '42501') throw new AutomationError('forbidden', 'You cannot configure this.');
      if (state === '40001') throw new AutomationError('conflict', 'This changed since you opened it. Reload and try again.');
      if (state === '22023') throw new AutomationError('invalid', e instanceof Error ? e.message : 'A default was refused.');
      throw e;
    }
    return { installed, alreadyPresent: ids.filter(id => existing.has(id)).length };
  });
}
