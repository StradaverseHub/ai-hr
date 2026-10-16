import {describe,expect,it} from 'vitest';
import {reportRenderDatabase} from '../deploy/identity-email/render-config';
import {masterRendererRequest,masterRenderContext} from '../deploy/identity-email/render-context';
import {masterReportDatabaseGrants} from '../deploy/identity-email/database';
import {randomUUID} from 'node:crypto';
describe('isolated managed report renderer contract',()=>{
 it('permits an explicit unprivileged app role on the same database, never the owner/private-worker credential',()=>{
  const mail='postgres://aihr_identity_email:private@127.0.0.1:5432/hr';expect(reportRenderDatabase('postgres://ai_hr_app:app@127.0.0.1:5432/hr',mail).username).toBe('ai_hr_app');
  for(const value of ['postgres://owner:owner@127.0.0.1/hr','postgres://aihr_identity_email:private@127.0.0.1/hr','postgres://ai_hr_app:app@127.0.0.1/other','postgres://ai_hr_app:app@127.0.0.1/hr?options=-c%20role%3Downer','postgres://ai_hr_app:app@remote.test/hr'])expect(()=>reportRenderDatabase(value,mail)).toThrow();
 });
 it('refuses path, scope, addresses, workbooks and principal flags in the private child request',()=>{
  const base={phase:'render',occurrenceId:randomUUID(),leaseToken:randomUUID(),expectedAccessStamp:'a'.repeat(64)};expect(masterRendererRequest.safeParse(base).success).toBe(true);
  for(const [key,value]of Object.entries({path:'/tmp/other',scopeIds:[randomUUID()],email:'other@example.test',bytes:'contents',roles:['super_admin'],grants:[]}))expect(masterRendererRequest.safeParse({...base,[key]:value}).success).toBe(false);
 });
 it('preserves all six fractional timestamp digits in consent revisions',()=>{
  expect(masterRenderContext.shape.consentUpdatedAt.safeParse('2024-01-01T00:00:00.123456Z').success).toBe(true);expect(masterRenderContext.shape.consentUpdatedAt.safeParse('2024-01-01T00:00:00.123Z').success).toBe(false);
 });
 it('grants the mail worker only leased target/start/finish, never queue/claim or direct table privileges',()=>{
  const grants=masterReportDatabaseGrants('quoted"role');expect(grants.join('\n')).toContain('"quoted""role"');expect(grants.join('\n')).toContain('identity_email.report_target');expect(grants.join('\n')).not.toMatch(/queue_report|claim_reports|GRANT (SELECT|INSERT|UPDATE|DELETE)/);
 });
});
