/** Pure boundary/source checks only; no VM, database, enrollment, TLS or SMTP evidence. */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {internalReportAcceptanceMarker,reportAcceptanceHumanReady,reportAcceptanceComponents,reportAcceptanceMode,reportAcceptanceDatabase,reportAcceptanceSameEndpoint,REPORT_ACCEPTANCE_ORIGIN} from '../scripts/managed-report-acceptance-model';
const sha='a'.repeat(64),candidate='b'.repeat(40);
const marker={version:2,purpose:'disposable-internal-report-acceptance',vm:'board16-report-linux',database:'ai_hr_report_delivery_acceptance',candidateRoot:'/opt/ai-hr',origin:REPORT_ACCEPTANCE_ORIGIN,runId:randomUUID(),candidateSha:candidate,machineSha256:sha,fixtureSha256:sha,installerSha256:sha,componentsSha256:sha,caSha256:sha,certificateSha256:sha,serverKeySha256:sha,nodeSha256:sha,runtimePath:'/opt/node22/bin/node',webUnit:'aihr-report-acceptance.service'};
describe('one closed internal report acceptance course',()=>{
 it.each(['prepare','configure','verify'] as const)('accepts exact stage %s',stage=>expect(reportAcceptanceMode([stage])).toBe(stage));
 it.each([[],['verify','--skip-auth'],['prepare','ai_hr'],['install'],['verify-controls']].map(args=>({args})))('refuses unknown/combined stages $args',({args})=>expect(()=>reportAcceptanceMode(args)).toThrow());
 it('binds only the owned VM/current source/HTTPS named target',()=>{expect(internalReportAcceptanceMarker.parse(marker)).toEqual(marker);});
 it.each([{version:1},{origin:'http://localhost:3543'},{database:'ai_hr'},{candidateRoot:'/srv/candidate'},{vm:'default'},{webUnit:'aihr.service'},{runtimePath:'/opt/../bin/node'},{emailVerified:true},{skipMfa:true},{smtp:{host:'remote.test'}},{candidateSha:'HEAD'}])('refuses marker drift or an authority flag %j',change=>expect(()=>internalReportAcceptanceMarker.parse({...marker,...change})).toThrow());
 it('requires exact recipient UI report identities and no consent/MFA assertion fields',()=>{
  const ready={version:1,runId:marker.runId,candidateSha:candidate,reviewedInventorySha256:sha,reports:{weekly:{reportId:randomUUID(),scheduleId:randomUUID()},monthly:{reportId:randomUUID(),scheduleId:randomUUID()}}};
  expect(reportAcceptanceHumanReady.parse(ready)).toEqual(ready);
  expect(()=>reportAcceptanceHumanReady.parse({...ready,verifiedMfa:true})).toThrow();
  expect(()=>reportAcceptanceHumanReady.parse({...ready,reports:{...ready.reports,monthly:ready.reports.weekly}})).toThrow();
 });
 it('accepts only the eight reviewed installed component basenames, never paths or config secrets',()=>{
  const components=Object.fromEntries(['internal-report-agent.cjs','report-auth-broker.cjs','report-renderer.cjs','internal-report-schedule.cjs','internal-report-tick','report-auth-peer.py','renderer-peer.py','verify-internal-report-isolation.py'].map(name=>[name,sha]));
  expect(reportAcceptanceComponents.parse(components)).toEqual(components);expect(()=>reportAcceptanceComponents.parse({...components,'../other.cjs':sha})).toThrow();expect(()=>reportAcceptanceComponents.parse({...components,DATABASE_URL:'private'})).toThrow();
 });
 it('allows only distinct authenticated roles on the exact VM loopback DB',()=>{
  const app=reportAcceptanceDatabase('postgres://ai_hr_app:private@127.0.0.1:5432/ai_hr_report_delivery_acceptance','ai_hr_app'),owner=reportAcceptanceDatabase('postgres://ai_hr_owner:private@127.0.0.1:5432/ai_hr_report_delivery_acceptance');
  expect(()=>reportAcceptanceSameEndpoint(app,owner)).not.toThrow();expect(()=>reportAcceptanceSameEndpoint(app,app)).toThrow();
 });
 it.each(['postgres://ai_hr_app:private@remote.test:5432/ai_hr_report_delivery_acceptance','postgres://ai_hr_app:private@127.0.0.1:5433/ai_hr_report_delivery_acceptance','postgres://ai_hr_app:private@127.0.0.1:5432/ai_hr','postgres://ai_hr_app@127.0.0.1:5432/ai_hr_report_delivery_acceptance','postgres://ai_hr_app:private@127.0.0.1:5432/ai_hr_report_delivery_acceptance?options=x'])('refuses endpoint override %s',url=>expect(()=>reportAcceptanceDatabase(url,'ai_hr_app')).toThrow());
});
describe('staged runner keeps canonical human and installed authority',()=>{
 it('does not manufacture Auth/binding/consent or write an alternative cron',()=>{
  const source=readFileSync(path.join(process.cwd(),'scripts/dev-managed-report-acceptance.ts'),'utf8');
  expect(source).not.toMatch(/saveNotificationEmailPreferences|saveNotificationEmailPolicy|writeRecord\(|bootstrapInternalOwner\(|insert\(s\.(appExternalIdentity|deploymentIdentityOperator|notificationPref|appInternalAuthRecord)\)|emailVerified\s*:\s*true|totpSecret\s*:/);
  expect(source).not.toMatch(/(?:command|run)\(['"]crontab|KEYCLOAK|providerToken|\/identity\/realms|createWriteStream/);
  expect(source).toContain("[SCHEDULE,'--activate'");expect(source).toContain("[SCHEDULE,'--rollback'");expect(source).toContain('assertActiveCredential(tx,c)');expect(source).toContain('readActiveRelayTx(tx)');expect(source).toContain('resolveEmployeeMasterRecipients');
 });
 it('does not publish a verified receipt before successful owned-resource cleanup',()=>{
  const source=readFileSync(path.join(process.cwd(),'scripts/dev-managed-report-acceptance.ts'),'utf8');
  const end=source.indexOf('main().then(async completed=>'),cleanup=source.indexOf('await cleanup();',end),receipt=source.indexOf('cleanup:\'VERIFIED\'',end);
  expect(end).toBeGreaterThanOrEqual(0);expect(cleanup).toBeGreaterThan(end);expect(receipt).toBeGreaterThan(cleanup);expect(receipt-cleanup).toBeGreaterThan(30);
  expect(source).toContain('confirmOwnedReportArtifactRemoval');expect(source).toContain('assertOwnedReportArtifactAbsent');expect(source).toContain('verification-started');expect(source).toContain("'--signal=KILL','aihr-internal-report.service'");expect(source).toContain("['dispatch',192]");expect(source).toContain('await liveLease(consent)');
 });
});

/** These contracts fail against 1afb's known lifecycle gaps; runtime regressions follow with the repair. */
describe('reviewed acceptance lifecycle regressions',()=>{
 const source=()=>readFileSync(path.join(process.cwd(),'scripts/dev-managed-report-acceptance.ts'),'utf8');
 it('selects the checked candidate working directory before database imports or writers',()=>{
  const text=source(),root=text.indexOf("'Trusted source root required.'"),cwd=text.indexOf('process.chdir(ROOT)',root),imports=text.indexOf("await import('../db/client')");
  expect(root).toBeGreaterThanOrEqual(0);expect(cwd).toBeGreaterThan(root);expect(imports).toBeGreaterThan(cwd);expect(imports-cwd).toBeGreaterThan(100);
 });
 it('binds a pre-activation inventory and recovers partial ownership before canonical rollback',()=>{
  const text=source(),baseline=text.indexOf('activationBaseline=await captureActivationBaseline'),attempt=text.indexOf('activationAttempted=true',baseline),activate=text.indexOf("[SCHEDULE,'--activate'",attempt);
  expect(baseline).toBeGreaterThanOrEqual(0);expect(attempt).toBeGreaterThan(baseline);expect(activate).toBeGreaterThan(attempt);expect(activate-baseline).toBeGreaterThan(50);
  const cleanupStart=text.indexOf('async function cleanup()'),recover=text.indexOf('await recoverPartialActivation()',cleanupStart),rollback=text.indexOf("[SCHEDULE,'--rollback'",cleanupStart);
  expect(cleanupStart).toBeGreaterThanOrEqual(0);expect(recover).toBeGreaterThan(cleanupStart);expect(rollback).toBeGreaterThan(recover);expect(rollback-recover).toBeGreaterThan(30);
  expect(text).toContain('Cleanup unresolved; owned lock retained.');expect(text).not.toContain('if(child.pid)try{process.kill');
 });
 it('awaits child-group absence and successful cleanup before releasing the exact owned lock',()=>{
  const text=source(),cleanupStart=text.indexOf('async function cleanup()'),drain=text.indexOf('await drainOwnedChildren()',cleanupStart),release=text.indexOf('await releaseOwnedLock()',cleanupStart);
  expect(cleanupStart).toBeGreaterThanOrEqual(0);expect(drain).toBeGreaterThan(cleanupStart);expect(release).toBeGreaterThan(drain);expect(release-drain).toBeGreaterThan(200);
  expect(text).toContain('if(!failure)await releaseOwnedLock()');expect(text).toContain('stopOwnedAcceptanceGroup');expect(text).toContain('processGroupGate');
 });
});

describe('interrupted canonical scheduler lock remains an unresolved cleanup',()=>{
 it('checks canonical lock absence before activation and before any outer lock release',()=>{
  const text=readFileSync(path.join(process.cwd(),'scripts/dev-managed-report-acceptance.ts'),'utf8');
  const baseline=text.indexOf('async function captureActivationBaseline('),capture=text.indexOf('await assertSchedulingLockAbsent()',baseline),recover=text.indexOf('async function recoverPartialActivation()',baseline);
  expect(baseline).toBeGreaterThanOrEqual(0);expect(capture).toBeGreaterThan(baseline);expect(recover).toBeGreaterThan(capture);expect(recover-baseline).toBeGreaterThan(100);
  const cleanup=text.indexOf('async function cleanup()'),drain=text.indexOf('await drainOwnedChildren()',cleanup),closed=text.indexOf('await assertSchedulingLockAbsent()',drain),discovery=text.indexOf('await recoverPartialActivation()',drain);
  expect(cleanup).toBeGreaterThanOrEqual(0);expect(drain).toBeGreaterThan(cleanup);expect(closed).toBeGreaterThan(drain);expect(discovery).toBeGreaterThan(closed);
  const release=text.indexOf('async function releaseOwnedLock()'),check=text.indexOf('await assertSchedulingLockAbsent()',release),unlink=text.indexOf("await fs.unlink('/run/aihr-report-acceptance.lock')",release);
  expect(release).toBeGreaterThanOrEqual(0);expect(check).toBeGreaterThan(release);expect(unlink).toBeGreaterThan(check);expect(unlink-release).toBeGreaterThan(100);
 });
 it('uses the canonical lock path and refuses rather than removes an unknown scheduler lock',()=>{
  const text=readFileSync(path.join(process.cwd(),'scripts/dev-managed-report-acceptance.ts'),'utf8');
  const helper=text.indexOf('async function assertSchedulingLockAbsent()'),end=text.indexOf('async function receiptNames()',helper);
  expect(helper).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(helper);expect(end-helper).toBeGreaterThan(100);
  const body=text.slice(helper,end);expect(body).toContain('absentFile(INTERNAL_REPORT_SCHEDULE_LOCK)');expect(body).toContain('Canonical scheduling lock remains; owned acceptance lock retained.');
  expect(text).toMatch(/import \{[^\n]*INTERNAL_REPORT_SCHEDULE_LOCK[^\n]*\} from '..\/deploy\/identity-email\/report-scheduling'/);
  expect(text).not.toMatch(/(?:unlink|rm)\(INTERNAL_REPORT_SCHEDULE_LOCK/);
 });
});
