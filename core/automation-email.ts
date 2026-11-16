/**
 * Shared automation email template store (ADR docs/adr/2026-11-15-probation-shared-automation.md; migration 5743).
 *
 * Reads run under row security: only people who can configure a template's module see it. Saves go through
 * app.automation_email_template_save, which owns authority, tenancy, revision order, module stability, retirement and
 * bounds. Before the call this service checks meaning against the module catalogue (CC recipients must exist; merge
 * fields the module never supplies are warnings). Everything for one save runs in one transaction; reads are bounded.
 *
 * `active: false` turns a template off: a Send email step that uses it is skipped and noted on the case (runtime: the
 * Probation execution slice). Retiring is final.
 */
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {withScopedLifecycleTenant} from './module-gate';
import {automationCatalogue} from '../lib/automation/catalogues';
import {AUTOMATION_MODULES,type AutomationModule} from '../lib/automation/catalogue';
import type {AutomationRecipient} from '../lib/automation/workflow';
import {automationEmailMergeWarnings,automationEmailTemplateProblems,type AutomationEmailTemplate} from '../lib/automation/email';
import {AutomationError} from './automation-store';
import {automationReferencesTx} from './automation-builder';

export const MAX_LISTED_EMAIL_TEMPLATES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoredAutomationEmailTemplate = { template: AutomationEmailTemplate; revision: number; retired: boolean; savedAt: string; savedBy: string };
type Row = { templateId: string; revision: number; module: AutomationModule; name: string; active: boolean; subject: string; body: string; cc: AutomationRecipient[]; retired: boolean; savedAt: string; savedBy: string };

function mapDatabaseError(e: unknown): never {
  const state = pgSqlState(e), message = e instanceof Error ? e.message : 'The save was refused.';
  if (state === '42501') throw new AutomationError('forbidden', 'You cannot configure this.');
  if (state === '40001') throw new AutomationError('conflict', 'This changed since you opened it. Reload before saving.');
  if (state === '22023') throw new AutomationError('invalid', message);
  throw e;
}

/** Latest revision of every email template the user may configure, retired ones included, optionally for one module. */
export async function listAutomationEmailTemplates(ctx: SessionContext, filter: { module?: AutomationModule } = {}): Promise<StoredAutomationEmailTemplate[]> {
  if (filter.module && !AUTOMATION_MODULES.includes(filter.module)) throw new AutomationError('invalid', 'Unknown module.');
  return withScopedLifecycleTenant(ctx, async tx => {
    const rows = await tx.execute<Row>(sql`
      select distinct on (template_id) template_id as "templateId", revision, module, name, active, subject, body, cc, retired, saved_at as "savedAt", saved_by as "savedBy"
      from automation_email_template_version
      where tenant_id = app.current_tenant_id() and (${filter.module ?? null}::text is null or module = ${filter.module ?? null}::text)
      order by template_id, revision desc
      limit ${MAX_LISTED_EMAIL_TEMPLATES}`);
    return rows.map(r => ({ template: { id: r.templateId, module: r.module, name: r.name, active: r.active, subject: r.subject, body: r.body, cc: r.cc }, revision: r.revision, retired: r.retired, savedAt: r.savedAt, savedBy: r.savedBy }))
      .sort((a, b) => a.template.name.localeCompare(b.template.name) || a.template.id.localeCompare(b.template.id));
  });
}

/** Saves the next revision. A template must be valid to save (workflows send it as is); retiring skips the checks. */
export async function saveAutomationEmailTemplate(ctx: SessionContext, input: { template: AutomationEmailTemplate; retired: boolean; expectedRevision: number; reason: string }): Promise<{ revision: number; warnings: string[] }> {
  const { template } = input, catalogue = automationCatalogue(template.module);
  if (!catalogue) throw new AutomationError('invalid', 'This module does not use the shared builders yet.');
  if (!UUID.test(template.id)) throw new AutomationError('invalid', 'Unknown email template.');
  const people = [...new Set(template.cc.flatMap(r => r.kind === 'person' ? [r.userId] : []))].filter(id => UUID.test(id));
  return withScopedLifecycleTenant(ctx, async tx => {
    // Authority first, so someone who cannot configure the module learns nothing from the catalogue checks.
    const [allowed] = await tx.execute<{ ok: boolean }>(sql`select app.automation_can_configure(${template.module}) as ok`);
    if (!allowed?.ok) throw new AutomationError('forbidden', 'You cannot configure this.');
    if (!input.retired) {
      const problems = automationEmailTemplateProblems(template, catalogue, await automationReferencesTx(tx, people));
      if (problems.length) throw new AutomationError('invalid', 'Fix the email template before saving it.', problems);
    }
    try {
      const [row] = await tx.execute<{ revision: number }>(sql`select app.automation_email_template_save(${template.id}::uuid, ${template.module}, ${template.name}, ${template.active}, ${template.subject}, ${template.body}, ${JSON.stringify(template.cc)}::jsonb, ${input.retired}, ${input.expectedRevision}, ${input.reason}) as revision`);
      return { revision: row.revision, warnings: automationEmailMergeWarnings(template, catalogue) };
    } catch (e) { mapDatabaseError(e); }
  });
}
