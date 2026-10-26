import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { attendanceCcUpgradeReady } from '../deploy/identity-email/workflow-capability';
describe('root workflow-email upgrade boundaries',()=>{
 it.each([null,{},[],{version:1},{version:1,attendanceCc:false},{version:1,attendanceCc:'true'},{version:'1',attendanceCc:true},{version:2,attendanceCc:true}])('refuses a legacy or malformed capability response %#',value=>{
  expect(attendanceCcUpgradeReady(200,value)).toBe(false);
 });
 it('requires successful HTTP status without treating delivery readiness as installation capability',()=>{
  const installed={version:1,attendanceCc:true,ready:false};
  expect(attendanceCcUpgradeReady(200,installed)).toBe(true);
  expect(attendanceCcUpgradeReady(503,installed)).toBe(false);
  expect(attendanceCcUpgradeReady(undefined,installed)).toBe(false);
  const upgrade=readFileSync('deploy/identity-email/upgrade-workflow.ts','utf8');
  expect(upgrade).toContain('attendanceCcUpgradeReady(res.statusCode,JSON.parse(body))');
 });
 it('uses a single embedded checked service bundle and preserves the root-owned runtime boundary',()=>{
  const upgrade=readFileSync('deploy/identity-email/upgrade-workflow.ts','utf8'),builder=readFileSync('scripts/build-workflow-email-upgrade.ts','utf8');
  expect(builder).toContain('WORKFLOW_EMAIL_AGENT_BASE64');expect(builder).toContain('WORKFLOW_EMAIL_AGENT_SHA256');
  expect(upgrade).toContain("createHash('sha256').update(bytes).digest('hex')!==WORKFLOW_EMAIL_AGENT_SHA256");
  expect(upgrade).toContain("s.uid!==0||(s.mode&0o022)!==0");expect(upgrade).toContain("process.getuid?.()!==0");
  expect(upgrade).not.toContain("'/opt/node20/bin/node'");expect(upgrade).not.toContain('KEYCLOAK_WEB_CLIENT_SECRET');
 });
 it('does not give the private service general table access or shared app helper execution',()=>{
  const grants=readFileSync('deploy/identity-email/database.ts','utf8');
  const start=grants.indexOf('export function workflowEmailDatabaseGrants');expect(start).toBeGreaterThan(0);const body=grants.slice(start);expect(body.length).toBeGreaterThan(200);
  expect(body).toContain('identity_email.delivery_target');expect(body).not.toMatch(/GRANT.*(?:SELECT|INSERT|UPDATE|DELETE)|SCHEMA app/);
 });
 it('uses TLS with certificate validation and disables arbitrary message attachments or URL loading',()=>{
  const src=readFileSync('deploy/identity-email/smtp.ts','utf8');expect(src).toContain("secure:c.security==='tls'");expect(src).toContain("c.security==='starttls'?{requireTLS:true}");expect(src).toContain('rejectUnauthorized:true');expect(src).toContain("minVersion:'TLSv1.2'");expect(src).toContain('disableFileAccess:true,disableUrlAccess:true');
 });
});
