/** DB-free boundary guards complement, rather than substitute for, the actual-role SQL suite. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE,XLSX_EMAIL_ATTACHMENT_MAX_BYTES} from '../lib/email-attachment';
const migration=readFileSync(new URL('../db/migrations/0552_employee_master_internal_delivery.sql',import.meta.url),'utf8');
function definition(name:string){
 const marker='FUNCTION '+name+'(',begin=migration.indexOf(marker),end=migration.indexOf('--> statement-breakpoint',begin);
 expect(begin,name).toBeGreaterThanOrEqual(0);expect(end,name).toBeGreaterThan(begin);
 const value=migration.slice(begin,end);expect(value.length,name).toBeGreaterThan(150);return value;
}
describe('internal report SQL authority stays nonce-bound and dependency-based',()=>{
 it('requires real543 and adds exactly the3nullable occurrence audit columns without another queue/Auth store',()=>{
  expect(migration).toContain("to_regprocedure('app.internal_auth_read(text,boolean)')");
  expect([...migration.matchAll(/ADD COLUMN (artifact_[a-z_]+) (text|integer)/g)].map(match=>match[1]).sort()).toEqual(['artifact_byte_length','artifact_content_type','artifact_sha256']);
  expect(migration).not.toMatch(/CREATE TABLE|CREATE ROLE|ALTER ROLE|GRANT.*internal_auth_read|CREATE (?:OR REPLACE )?FUNCTION app\.internal_auth_(?:read|write|delete|revoke)\(/);
  const schema=readFileSync(new URL('../db/schema.ts',import.meta.url),'utf8'),begin=schema.indexOf('export const customReportOccurrence ='),end=schema.indexOf('// ─',begin);
  expect(begin).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(begin);
  const occurrence=schema.slice(begin,end);expect(occurrence).toContain("artifactSha256:text('artifact_sha256')");expect(occurrence).toContain("artifactByteLength:integer('artifact_byte_length')");expect(occurrence).toContain("artifactContentType:text('artifact_content_type')");
  expect(occurrence).not.toMatch(/artifact(?:Sha256|ByteLength|ContentType):[^\n,]*notNull/);
 });
 it('pins the exact shared XLSX limit/MIME and keeps both start APIs on one transition',()=>{
  expect(migration).toContain('artifact_byte_length BETWEEN 1 AND '+XLSX_EMAIL_ATTACHMENT_MAX_BYTES);
  expect(migration).toContain("artifact_content_type='"+XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE+"'");
  const common=definition('identity_email.start_report_bound'),legacy=definition('identity_email.start_report'),internal=definition('app.internal_auth_report_start');
  expect(common).toContain("SET status='started'");expect(common).toContain("artifact_sha256=p_artifact->>'sha256'");
  expect(legacy).toContain('identity_email.start_report_bound(p_id,p_token,p_issuer,p_target,NULL)');
  expect(internal).toContain("identity_email.start_report_bound(p_id,p_token,fresh->>'issuer',fresh->'target',p_artifact)");
  expect(legacy).not.toContain('UPDATE public.custom_report_occurrence');expect(internal).not.toContain('UPDATE public.custom_report_occurrence');
 });
 it('keeps occurrence/report/schedule locks ahead of Auth locks and Person ahead of preference, without alternate advisory keys',()=>{
  const value=definition('app.internal_auth_report_lock_context');
  const markers=['FROM public.custom_report_occurrence','FROM public.custom_report r','FROM public.custom_report_schedule','pg_try_advisory_xact_lock','FROM public.app_internal_auth_record','FROM public.app_user','FROM public.person','FROM public.employment','FROM public.app_external_identity','FROM public.role_assignment','FROM public.notification_email_policy','FROM public.notification_pref'];
  let prior=-1;for(const marker of markers){const index=value.indexOf(marker);expect(index,marker).toBeGreaterThan(prior);prior=index;}
  expect(value).toContain("'internal-auth:'||lock_key");expect(value).toContain("'internal-auth:email-state'");expect(value).toContain("'workflow-email-policy:'||job.tenant_id");expect(value).toContain("'workflow-email-consent:'||job.tenant_id");
  expect(value.match(/LIMIT 1001 FOR SHARE NOWAIT/g)).toHaveLength(3);
  expect(value.match(/IF n>1000 THEN RAISE program_limit_exceeded/g)).toHaveLength(3);
  expect(value).toContain("current_setting('transaction_isolation')<>'read committed'");
 });
 it('adds no generic Auth key/subject lookup or transport privilege and restores temporary timeout on success',()=>{
  const context=definition('identity_email.internal_report_context'),lock=definition('app.internal_auth_report_lock_context');
  expect(context).toContain("v_issuer:=p_origin||'/auth/'||job.tenant_id::text");expect(context).toContain('identity_email.report_target(p_id,p_token,v_issuer)');
  expect(context).not.toContain('app_internal_auth_record');expect(lock).not.toMatch(/SELECT[^;]*sealed/);
  expect(lock).toContain("r.record_key='credential:'||lock_key");expect(lock).toContain("r.record_key='email-state'");
  expect(lock).toContain("set_config('lock_timeout',prior_timeout,true)");expect(lock).toContain('WHEN lock_not_available OR deadlock_detected OR serialization_failure');
  const grants=migration.split('\n').filter(line=>/^GRANT /.test(line));expect(grants).toHaveLength(5);
  expect(grants.every(line=>line.includes('TO ai_hr_app')||line.startsWith('GRANT SELECT('))).toBe(true);
  expect(migration).not.toContain('TO aihr_identity_email');
  for(const name of ['identity_email.internal_report_context','app.internal_auth_report_context','app.employee_master_internal_render_context','app.internal_auth_report_lock_context','identity_email.start_report_bound','identity_email.start_report','app.internal_auth_report_start'])expect(definition(name)).toContain('SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp');
 });
});
