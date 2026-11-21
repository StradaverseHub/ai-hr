/** Test mail uses the same durable queue/private sender, addressed only to the authenticated template editor. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {AutomationError} from './automation-store';
import {automationCatalogue} from '../lib/automation/catalogues';
import {automationEmailSampleValues} from '../lib/automation-email-preview';
import {fillAutomationMergeFields} from '../lib/automation/email';
import {pgSqlState} from '../lib/db-error';
const schema=z.object({templateId:z.uuid(),revision:z.number().int().positive(),sample:z.enum(['complete','noDecision']),requestId:z.uuid()}).strict();
export async function testAutomationEmail(ctx:SessionContext,raw:unknown):Promise<{deliveryId:string}>{
 const parsed=schema.safeParse(raw);
 if(!parsed.success)throw new AutomationError('invalid','Save the email template before sending a test.');
 const input=parsed.data;
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [template]=await tx.execute<{module:'contract_staff'|'probation';subject:string}>(sql`select module,subject from automation_email_template_version where tenant_id=app.current_tenant_id() and template_id=${input.templateId}::uuid and revision=${input.revision}`);
  const catalogue=template?automationCatalogue(template.module):null;
  if(!template||!catalogue)throw new AutomationError('forbidden','This email template is unavailable.');
  const values=automationEmailSampleValues(catalogue,input.sample);
  // A real case link is never included in a fictional test. The sender makes this shared editor link absolute.
  values['case.link']='/automation/templates';
  try{
   const [row]=await tx.execute<{id:string}>(sql`select app.automation_email_test_queue(${input.templateId}::uuid,${input.revision},${input.requestId}::uuid,${fillAutomationMergeFields(template.subject,values)},${JSON.stringify(values)}::jsonb) as id`);
   return {deliveryId:row.id};
  }catch(error){
   const state=pgSqlState(error);
   if(state==='42501')throw new AutomationError('forbidden','You cannot send a test for this template.');
   if(state==='40001')throw new AutomationError('conflict','This template changed. Reload before sending the test.');
   if(state==='22023')throw new AutomationError('invalid',error instanceof Error?error.message:'The test could not be queued.');
   throw error;
  }
 });
}
