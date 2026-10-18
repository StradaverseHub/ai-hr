import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {installedWebPrincipal,installedInternalConfiguration,internalReportSenderDatabase,internalReportRunnerDatabase,internalReportRunnerEnvironment,parseInternalReportRunnerEnvironment,assertInternalReportSchedulingEnabled,internalReportSenderGrants,forbiddenSenderFunctionsSql} from '../deploy/identity-email/internal-report-install-model';
import {employeeMasterDeliverySocket} from '../lib/employee-master-delivery-ipc';
import {reportRenderOrigin} from '../deploy/identity-email/render-config';
const source=(name:string)=>readFileSync(new URL('../deploy/identity-email/'+name,import.meta.url),'utf8');
const principal={unit:'fictional-web.service',user:'fictional-web',group:'fictional-web',uid:1001,gid:1001,pid:1234,dynamicUser:'no'};
const env={AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:'https://report-acceptance.invalid',AUTH_SESSION_KEY:'a'.repeat(64),DATABASE_URL:'postgres://ai_hr_app:fictional@127.0.0.1:5432/ai_hr_report_delivery_acceptance'};
describe('internal report installation boundaries',()=>{
 it('routes internal report IPC to its fixed keyless sender and preserves external socket defaults',()=>{
  expect(employeeMasterDeliverySocket({AUTH_PROVIDER:'internal',IDENTITY_EMAIL_SOCKET:'/run/old-external.sock'})).toBe('/run/aihr-internal-report.sock');expect(employeeMasterDeliverySocket({AUTH_PROVIDER:'keycloak',IDENTITY_EMAIL_SOCKET:'/run/old-external.sock'})).toBe('/run/old-external.sock');expect(employeeMasterDeliverySocket({})).toBe('/run/aihr-identity-email.sock');
 });
 it('takes fixed non-root already-running principal and canonical current internal configuration',()=>{
  expect(installedWebPrincipal(principal)).toEqual(principal);expect(installedInternalConfiguration(env)).toEqual({origin:env.AUTH_PUBLIC_ORIGIN,key:env.AUTH_SESSION_KEY,database:env.DATABASE_URL,scheduledEmailEnabled:false});
 });
 it.each([{uid:0},{gid:0},{pid:0},{dynamicUser:'yes'},{unit:'../../other.service'},{user:'root user'}])('refuses ambiguous/root/dynamic identity %j',change=>expect(()=>installedWebPrincipal({...principal,...change})).toThrow());
 it.each([{AUTH_PROVIDER:'keycloak'},{AUTH_SESSION_KEY:'bad'},{AUTH_PUBLIC_ORIGIN:'http://report-acceptance.invalid'},{MIGRATION_DATABASE_URL:'postgres://owner:secret@127.0.0.1/db'},{DATABASE_URL:'postgres://owner:secret@127.0.0.1:5432/ai_hr_report_delivery_acceptance'}])('refuses provider/key/owner substitute %j',change=>expect(()=>installedInternalConfiguration({...env,...change})).toThrow());
 it('accepts only exact same named local DB and separate sender role, no parameter overrides',()=>{
  const good='postgres://aihr_identity_email:fictional@127.0.0.1:5432/ai_hr_report_delivery_acceptance';expect(internalReportSenderDatabase(good,env.DATABASE_URL).username).toBe('aihr_identity_email');
  for(const bad of [good.replace('aihr_identity_email','ai_hr_app'),good.replace('5432','5433'),good.replace('127.0.0.1','foreign.invalid'),good.replace('ai_hr_report_delivery_acceptance','production'),good+'?options=-c%20role%3Dpostgres',good+'#fragment'])expect(()=>internalReportSenderDatabase(bad,env.DATABASE_URL)).toThrow();
 });
 it('requires separately supplied exact-database owner and emits only shell-safe key-free runner values',()=>{
  const owner='postgres://existing_owner:fictional@127.0.0.1:5432/ai_hr_report_delivery_acceptance';expect(internalReportRunnerDatabase(owner,env.DATABASE_URL).username).toBe('existing_owner');
  for(const bad of [env.DATABASE_URL,owner.replace('existing_owner','aihr_identity_email'),owner.replace('5432','5433'),owner+'?options=-crole%3Dpostgres'])expect(()=>internalReportRunnerDatabase(bad,env.DATABASE_URL)).toThrow();
  const content=internalReportRunnerEnvironment({origin:env.AUTH_PUBLIC_ORIGIN,appDatabase:env.DATABASE_URL,ownerDatabase:owner,scheduledEmailEnabled:false});expect(content).not.toContain('AUTH_SESSION_KEY');expect(content.split('\n').filter(Boolean).map(line=>line.split('=')[0])).toEqual(['AUTH_PROVIDER','AUTH_PUBLIC_ORIGIN','DATABASE_URL','MIGRATION_DATABASE_URL','EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','NODE_ENV','TZ','HOME','PATH','LANG']);
  const tricky=internalReportRunnerEnvironment({origin:env.AUTH_PUBLIC_ORIGIN,appDatabase:env.DATABASE_URL,ownerDatabase:owner+"'$()`",scheduledEmailEnabled:false});expect(tricky).toContain("'\\''");expect(tricky).toContain('$()`');
 });
 it.each([undefined,'false','TRUE','1',' true','true ','true'])('derives scheduling only from exact actual-web value %s',value=>{
  expect(installedInternalConfiguration({...env,EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:value}).scheduledEmailEnabled).toBe(value==='true');
 });
 it.each([false,true])('roundtrips the required typed capability %s through the closed canonical writer',enabled=>{
  const input={origin:env.AUTH_PUBLIC_ORIGIN,appDatabase:env.DATABASE_URL,ownerDatabase:env.DATABASE_URL.replace('ai_hr_app','fixture_owner'),scheduledEmailEnabled:enabled};
  const raw=internalReportRunnerEnvironment(input),parsed=parseInternalReportRunnerEnvironment(Buffer.from(raw));
  expect(parsed.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED).toBe(String(enabled));expect(Object.keys(parsed)).toHaveLength(10);
  const web=installedInternalConfiguration({...env,EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:String(enabled)});
  if(enabled)expect(()=>assertInternalReportSchedulingEnabled(web,raw)).not.toThrow();else expect(()=>assertInternalReportSchedulingEnabled(web,raw)).toThrow(/held/);
  for(const patch of [undefined,'true','false',1,null])expect(()=>Reflect.apply(internalReportRunnerEnvironment,null,[{...input,scheduledEmailEnabled:patch}])).toThrow('typed');
  for(const value of ['', 'TRUE','1',' true','true '])expect(()=>parseInternalReportRunnerEnvironment(raw.replace(`EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED='${enabled}'`, `EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED='${value}'`))).toThrow();
  for(const invalid of [raw.replace(/^EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED=.*\n/m,''),raw+"EXTRA='false'\n",raw+"EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED='true'\n",raw.replace("TZ='UTC'","TZ='UTC' #comment"),raw.replace("HOME='/nonexistent'","HOME='/root'"),raw.replace("NODE_ENV='production'","NODE_ENV='development'"),raw.replace(/^AUTH_PUBLIC_ORIGIN=.*$/m,"AUTH_PUBLIC_ORIGIN=''"),raw.slice(0,-1),'x'.repeat(16385)])expect(()=>parseInternalReportRunnerEnvironment(invalid)).toThrow();
  expect(()=>parseInternalReportRunnerEnvironment(new Uint8Array([255]))).toThrow();
 });
 it('refuses a held web, a stale held runner, or a different installed profile even when the caller opts in',()=>{
  const web=installedInternalConfiguration({...env,EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:'true'}),input={origin:web.origin,appDatabase:web.database,ownerDatabase:web.database.replace('ai_hr_app','fixture_owner'),scheduledEmailEnabled:true};
  expect(()=>assertInternalReportSchedulingEnabled({...web,scheduledEmailEnabled:false},internalReportRunnerEnvironment(input))).toThrow('held');
  expect(()=>assertInternalReportSchedulingEnabled(web,internalReportRunnerEnvironment({...input,scheduledEmailEnabled:false}))).toThrow('held');
  for(const patch of [{origin:'https://other.invalid'},{appDatabase:input.appDatabase.replace('5432','5433')},{ownerDatabase:input.appDatabase}])expect(()=>assertInternalReportSchedulingEnabled(web,internalReportRunnerEnvironment({...input,...patch}))).toThrow();
 });
 it('validates key-free renderer origin without calling Auth configuration',()=>{
  expect(reportRenderOrigin(env.AUTH_PUBLIC_ORIGIN)).toBe(env.AUTH_PUBLIC_ORIGIN);for(const url of ['http://fixture.invalid','https://user:password@fixture.invalid','https://fixture.invalid/path','https://fixture.invalid?issuer=other','https://fixture.invalid#x'])expect(()=>reportRenderOrigin(url)).toThrow();
 });
 it('revokes existing direct report authority and tests effective inherited/PUBLIC and generic Auth authority',()=>{
  expect(internalReportSenderGrants.join(';')).toContain('REVOKE EXECUTE ON FUNCTION identity_email.report_target');expect(internalReportSenderGrants.join(';')).toContain('identity_email.start_report');expect(internalReportSenderGrants.join(';')).toContain('identity_email.finish_report');
  expect(forbiddenSenderFunctionsSql).toContain('has_function_privilege');expect(forbiddenSenderFunctionsSql).toContain("internal_auth_%");expect(forbiddenSenderFunctionsSql).toContain('internal_report_context');
  const install=source('upgrade-internal-reports.ts');expect(install).toContain("'/proc/'+principal.pid+'/environ'");expect(install).toContain("show('MainPID')");expect(install).toContain('forbiddenSenderFunctionsSql');expect(install).toContain('has_table_privilege');expect(install).not.toContain('usermod');expect(install).toContain('scheduledEmailEnabled:web.scheduledEmailEnabled');
  // Match the actual push destination, never a drop-in's content mentioning renderer.env.
  const tree=ts.createSourceFile('upgrade-internal-reports.ts',install,ts.ScriptTarget.Latest,true);
  const privateWorkers:{destination:ts.BinaryExpression;call:ts.CallExpression}[]=[];
  function visit(node:ts.Node){
   if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='changes'&&node.expression.name.text==='push'){
    expect(node.arguments).toHaveLength(1);const tuple=node.arguments[0];expect(ts.isArrayLiteralExpression(tuple)).toBe(true);
    if(ts.isArrayLiteralExpression(tuple)){
     const destination=tuple.elements[0];
     if(ts.isBinaryExpression(destination)&&ts.isStringLiteral(destination.right)&&/^\/(broker|sender|renderer)\.env$/.test(destination.right.text))privateWorkers.push({destination,call:node});
    }
   }
   ts.forEachChild(node,visit);
  }
  visit(tree);expect(privateWorkers).toHaveLength(3);
  expect(privateWorkers.map(({destination})=>destination.right.getText(tree)).sort()).toEqual(["'/broker.env'","'/renderer.env'","'/sender.env'"]);
  for(const {destination,call} of privateWorkers){
   expect(destination.operatorToken.kind).toBe(ts.SyntaxKind.PlusToken);expect(destination.left.getText(tree)).toBe('config');
   expect(call.getText(tree)).not.toMatch(/scheduledEmailEnabled|EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED/);
  }
 });
 it('keeps external renderer socket default0600 and only reviewed internal bundle installs0660 client group',()=>{
  expect(source('aihr-report-renderer.socket')).toContain('SocketMode=0600');expect(source('build-internal-reports.ts')).toContain('SocketGroup=aihr-report-clients');expect(source('build-internal-reports.ts')).toContain('SocketMode=0660');
  expect(source('aihr-report-auth@.service')).toContain('SupplementaryGroups=aihr-report-clients');expect(source('aihr-report-auth@.service')).not.toContain('SupplementaryGroups=aihr-report-files');
 });
 it('caps combined dispatch192 inside outer768 and keeps renderer512 sibling',()=>{
  expect(source('aihrmanagedmail-dispatch.slice')).toContain('MemoryMax=192M');expect(source('aihrmanagedmail.slice')).toContain('MemoryMax=768M');expect(source('aihr-report-renderer@.service')).toContain('MemoryMax=512M');expect(source('aihr-report-renderer@.service')).toContain('Slice=aihrmanagedmail.slice');
  for(const unit of ['aihr-report-auth@.service','aihr-internal-report.service'])expect(source(unit)).toContain('Slice=aihrmanagedmail-dispatch.slice');
 });
 it('supervisor waits child exit and client pins whole activation retirement before forwarding',()=>{
  const peer=source('report-auth-peer.py');expect(peer).toContain('socket.SO_PEERCRED');expect(peer).toContain('uid != sender.pw_uid');expect(peer).toContain('RESPONSE_MAX = 512 * 1024');expect(peer).toContain('os.killpg(child.pid, signal.SIGKILL)');
  const wait=peer.indexOf('if child.wait('),send=peer.indexOf('peer.sendmsg('),client=peer.indexOf('def client_main()'),retired=peer.indexOf('wait_retirement(',client),publish=peer.indexOf('sys.stdout.buffer.write(reply)',client);expect(wait).toBeGreaterThan(0);expect(send).toBeGreaterThan(wait);expect(client).toBeGreaterThanOrEqual(0);expect(retired).toBeGreaterThan(client);expect(publish).toBeGreaterThan(retired);expect(publish-client).toBeGreaterThan(100);expect(peer).not.toContain('peer.shutdown(socket.SHUT_WR)');
  expect(peer).toContain('REPORT_AUTH_BROKER_PEER_UID=str(uid)');expect(peer).not.toContain("request['uid']");
 });
 it('renderer internal origin/query is keyless while preserving compatibility query',()=>{
  const renderer=source('report-renderer.ts'),peer=source('renderer-peer.py');expect(renderer).toContain('app.employee_master_internal_render_context');expect(renderer).toContain('app.employee_master_render_context');expect(renderer).toContain("reportRenderOrigin(process.env.AUTH_PUBLIC_ORIGIN??'')");expect(renderer).toContain('process.env.AUTH_SESSION_KEY');
  const begin=peer.indexOf('allowed ='),end=peer.indexOf('os.execve(');expect(begin).toBeGreaterThan(0);expect(end).toBeGreaterThan(begin);expect(peer.slice(begin,end)).toContain('AUTH_PUBLIC_ORIGIN');expect(peer.slice(begin,end)).not.toContain('AUTH_SESSION_KEY');
 });
});
