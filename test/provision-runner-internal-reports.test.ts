/** Closed command/env/dispatch contract only; no owner database or installed cron is exercised. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({createDb:vi.fn(),sweep:vi.fn(),ownerEnd:vi.fn(),appEnd:vi.fn(),admission:vi.fn()}));
vi.mock('../db/client',()=>({createDb:mocks.createDb,client:{end:mocks.appEnd}}));
vi.mock('../lib/employee-master-dispatch',()=>({installedReportDispatch:mocks.admission}));
vi.mock('../core/employee-master-delivery',()=>({sweepEmployeeMasterReports:mocks.sweep}));
import {provisionRunnerMode,validateInstalledInternalReportEnvironment,runInstalledInternalReportTick,runProvisionReportStage} from '../scripts/provision-runner';
import {internalReportRunnerEnvironment,parseInternalReportRunnerEnvironment} from '../deploy/identity-email/internal-report-install-model';
const valid=()=>({AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:'https://hr.example.test',DATABASE_URL:'postgres://ai_hr_app:synthetic-app@localhost:5433/fictional_report',MIGRATION_DATABASE_URL:'postgres://fictional_owner:synthetic-owner@localhost:5433/fictional_report',EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:'true',NODE_ENV:'production' as const,TZ:'Asia/Kuala_Lumpur',PATH:'/usr/bin:/bin'});
beforeEach(()=>{vi.clearAllMocks();mocks.ownerEnd.mockResolvedValue(undefined);mocks.appEnd.mockResolvedValue(undefined);mocks.createDb.mockReturnValue({db:{fictional:true},client:{end:mocks.ownerEnd}});mocks.admission.mockResolvedValue('dedicated');mocks.sweep.mockResolvedValue({attempted:1,sent:1,failed:0,uncertain:0,tenantsFailed:0});});
describe('closed installed internal report-only command',()=>{
 it('retains default dispatch and accepts only the exact smaller command, never an env skip flag',()=>{
  expect(provisionRunnerMode([])).toBe('default');expect(provisionRunnerMode(['--installed-internal-reports-only'])).toBe('installedInternalReportsOnly');
  for(const args of [['--skip-env'],['--installed-internal-reports-only','--provision'],['--internal'],['--installed-internal-reports-only=1'],['--installed-internal-reports-only','--scheduled-email=true']])expect(()=>provisionRunnerMode(args)).toThrow('Unknown provisioning runner command');
 });
 it('requires separate app/owner authorities for exactly the same database and canonical installed origin',()=>{
  expect(()=>validateInstalledInternalReportEnvironment(valid())).not.toThrow();
  for(const patch of [{AUTH_PROVIDER:'workos'},{AUTH_PUBLIC_ORIGIN:'http://hr.example.test'},{AUTH_PUBLIC_ORIGIN:'https://hr.example.test/'},{AUTH_PUBLIC_ORIGIN:'https://user:password@hr.example.test'},{MIGRATION_DATABASE_URL:''},{MIGRATION_DATABASE_URL:valid().DATABASE_URL},{MIGRATION_DATABASE_URL:'postgres://owner:synthetic@localhost:5433/other'},{DATABASE_URL:'postgres://owner:synthetic@localhost:5433/fictional_report'},{DATABASE_URL:valid().DATABASE_URL+'?options=-crole=postgres'},{DATABASE_URL:'postgres://ai_hr_app:synthetic@remote.example.test/fictional_report'}])expect(()=>validateInstalledInternalReportEnvironment({...valid(),...patch})).toThrow();
 });
 it.each(['true','false'])('accepts only the explicit literal capability %s before app imports',value=>expect(()=>validateInstalledInternalReportEnvironment({...valid(),EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:value})).not.toThrow());
 it.each([false,true])('admits canonical installed writer/parser output for capability %s',scheduledEmailEnabled=>{
  const values=valid(),raw=internalReportRunnerEnvironment({origin:values.AUTH_PUBLIC_ORIGIN,appDatabase:values.DATABASE_URL,ownerDatabase:values.MIGRATION_DATABASE_URL,scheduledEmailEnabled});
  expect(()=>validateInstalledInternalReportEnvironment(parseInternalReportRunnerEnvironment(raw))).not.toThrow();
 });
 it.each([undefined,'','TRUE','1',' true','true '])('rejects missing/malformed capability %s before owner work',async value=>{
  const previous=process.env;process.env={...valid(),EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:value};
  try{await expect(runInstalledInternalReportTick()).rejects.toThrow('scheduling capability');expect(mocks.admission).not.toHaveBeenCalled();expect(mocks.createDb).not.toHaveBeenCalled();expect(mocks.sweep).not.toHaveBeenCalled();}finally{process.env=previous;}
 });
 it.each(['AUTH_SESSION_KEY','WORKOS_API_KEY','IDENTITY_EMAIL_CLIENT_SECRET','WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET','NODE_OPTIONS','PROVISION_SKIP_ENV','IDENTITY_EMAIL_SOCKET'])('refuses inherited/private/override input before imports or any owner work: %s',key=>{
  expect(()=>validateInstalledInternalReportEnvironment({...valid(),[key]:'synthetic-private-or-override'})).toThrow('environment is not closed');
 });
 it('dispatches only canonical report sweep without reading an envfile, and closes both pools',async()=>{
  const previous=process.env,exit=process.exitCode;process.env=valid();
  const envLoader=vi.spyOn(process,'loadEnvFile').mockImplementation(()=>{throw new Error('Must never load any env file.');});
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  try{
   await runInstalledInternalReportTick();expect(envLoader).not.toHaveBeenCalled();expect(mocks.createDb).toHaveBeenCalledExactlyOnceWith(valid().MIGRATION_DATABASE_URL,{max:2});expect(mocks.sweep).toHaveBeenCalledExactlyOnceWith({fictional:true});expect(mocks.ownerEnd).toHaveBeenCalledWith({timeout:5});expect(mocks.appEnd).toHaveBeenCalledWith({timeout:5});
  }finally{process.env=previous;process.exitCode=exit;envLoader.mockRestore();log.mockRestore();}
 });
 it('requires ACTIVE trusted scheduling before any dedicated application work',async()=>{
  const previous=process.env;process.env=valid();mocks.admission.mockRejectedValue(new Error('Paused or untrusted marker'));
  try{await expect(runInstalledInternalReportTick()).rejects.toThrow('marker');expect(mocks.admission).toHaveBeenCalledWith('dedicated');expect(mocks.createDb).not.toHaveBeenCalled();expect(mocks.sweep).not.toHaveBeenCalled();}finally{process.env=previous;}
 });
 it('suppresses only default report stage when installed, and retains canonical legacy sweep when absent',async()=>{
  const owner={db:{fictional:true}} as never;mocks.admission.mockResolvedValue('suppressed');expect(await runProvisionReportStage(owner)).toBeNull();expect(mocks.sweep).not.toHaveBeenCalled();mocks.admission.mockResolvedValue('legacy');await runProvisionReportStage(owner);expect(mocks.sweep).toHaveBeenCalledExactlyOnceWith({fictional:true});
 });
 it('bad installed marker cannot silently restore default report dispatch',async()=>{mocks.admission.mockRejectedValue(new Error('Untrusted marker'));await expect(runProvisionReportStage({db:{}} as never)).rejects.toThrow('Untrusted marker');expect(mocks.sweep).not.toHaveBeenCalled();});
 it('rejects secret-bearing environment before creating/importing the dispatch connection',async()=>{
  const previous=process.env;process.env={...valid(),AUTH_SESSION_KEY:'synthetic-not-allowed'};
  try{await expect(runInstalledInternalReportTick()).rejects.toThrow('environment is not closed');expect(mocks.createDb).not.toHaveBeenCalled();expect(mocks.sweep).not.toHaveBeenCalled();}
  finally{process.env=previous;}
 });
 it('closes both pools even when report work or owner-pool shutdown fails',async()=>{
  const previous=process.env;process.env=valid();mocks.sweep.mockRejectedValue(new Error('Synthetic report refusal'));mocks.ownerEnd.mockRejectedValue(new Error('Synthetic pool close failure'));
  try{await expect(runInstalledInternalReportTick()).rejects.toThrow('Synthetic pool close failure');expect(mocks.appEnd).toHaveBeenCalledWith({timeout:5});}
  finally{process.env=previous;}
 });
});
it('keeps pre-import validation and exact branch before the default environment loader, without changing default jobs',()=>{
 const file=resolve(process.cwd(),'scripts/provision-runner.ts'),source=readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const runtimeImports=tree.statements.filter(ts.isImportDeclaration).filter(node=>!node.importClause?.isTypeOnly).map(node=>(node.moduleSpecifier as ts.StringLiteral).text);
 expect(runtimeImports).toEqual(['node:crypto']);
 const installedStart=source.indexOf('export async function runInstalledInternalReportTick()'),mainStart=source.indexOf('async function main()');expect(installedStart).toBeGreaterThan(0);expect(mainStart).toBeGreaterThan(installedStart);
 const installed=source.slice(installedStart,mainStart);expect(installed.length).toBeGreaterThan(500);expect(installed.indexOf('validateInstalledInternalReportEnvironment(process.env)')).toBeLessThan(installed.indexOf("await import('../db/client')"));expect(installed.indexOf("await installedReportDispatch('dedicated')")).toBeLessThan(installed.indexOf("await import('../db/client')"));expect(installed).not.toContain('loadEnv(');expect(installed).not.toContain('runProvisionTick(');expect(installed).not.toContain('sweepReplacementHolidayQueue(');
 const main=source.slice(mainStart,source.indexOf('// Run only when invoked directly'));expect(main.length).toBeGreaterThan(1000);expect(main.indexOf("mode==='installedInternalReportsOnly'")).toBeLessThan(main.indexOf('loadEnv();'));expect(main).toContain('runProvisionTick(owner)');expect(main).toContain('sweepReplacementHolidayQueue(owner)');expect(main).toContain('runProvisionReportStage(owner)');const reportStage=source.slice(source.indexOf('export async function runProvisionReportStage('),mainStart);expect(reportStage).toContain("await installedReportDispatch('default')");expect(reportStage).toContain('sweepEmployeeMasterReports(owner.db)');
 expect(source).toContain("if(process.argv.slice(2).includes('--installed-internal-reports-only'))console.error('Installed internal report tick failed.')");
});
