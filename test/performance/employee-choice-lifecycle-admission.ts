/** Actual mode admission BEFORE file SQL. The supplied JSON is never authority:
 * real singleton admission, native ancestor identities and source-owned commands
 * must independently agree. No factory/caller environment override is accepted. */
import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {z} from 'zod';
import {admitSingletonTest} from '../helpers/ci-singleton-admission';
import {employeeLifecycleFile,EMPLOYEE_LIFECYCLE_PROFILE_SHA256} from '../../.github/ci/employee-lifecycle-profile.mjs';
import {employeeLifecycleRead,employeeLifecycleHash,employeeLifecycleProcess,EMPLOYEE_LIFECYCLE_CONTROLLER_SOURCES} from '../../.github/ci/employee-lifecycle-context.mjs';
const decimal=z.string().regex(/^[1-9][0-9]{0,19}(?![\s\S])/),sha=z.string().regex(/^[0-9a-f]{40}(?![\s\S])/),digest=z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
const processIdentity=z.object({pid:z.number().int().positive(),parent:z.number().int().nonnegative(),group:z.number().int().positive(),session:z.number().int().positive(),start:decimal,exe:z.string(),argv:z.array(z.string()).length(4)}).strict();
const preparation=z.object({version:z.literal(1),mode:z.literal('full-ci-singleton'),source:sha,controller:sha,run:decimal,attempt:z.literal('1'),unit:z.string().regex(/^db-[0-9a-f]{16}(?![\s\S])/),file:z.string(),stage:z.string(),fingerprint:digest,registrySha256:digest,sourceRoot:z.string(),automation:z.string(),evidenceDirectory:z.string(),anchorPath:z.string(),parent:processIdentity,resourceContextSha256:digest,resourceNonceSha256:digest,controllerSources:z.record(z.string(),digest),releaseAuthorized:z.literal(false)}).strict();
const contextSchema=preparation.extend({preparationSha256:digest,singletonPath:z.string(),singletonSha256:digest});
const monitorSchema=z.object({version:z.literal(1),source:sha,controller:sha,run:decimal,attempt:z.literal('1'),unit:z.string(),file:z.string(),fingerprint:digest,mode:z.literal('full-ci-singleton'),releaseAuthorized:z.literal(false),stage:z.string(),sequence:z.number().int().positive(),preparationSha256:digest,testContextSha256:digest,supervisor:z.object({pid:z.number().int().positive(),start:decimal}).strict(),monitor:z.object({pid:z.number().int().positive(),start:decimal}).strict()}).strict();
function ancestry(){const values:ReturnType<typeof employeeLifecycleProcess>[]=[];let pid=process.pid;for(let depth=0;depth<32&&pid>1;depth++){const value=employeeLifecycleProcess(pid);values.push(value);pid=value.parent;}return values;}
function controllerHead(path:string){return execFileSync('git',['-c','safe.directory='+path,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',path,'rev-parse','HEAD'],{encoding:'utf8',timeout:10000,maxBuffer:65536}).trim();}
export function admitEmployeeChoiceLifecycle(file:string){
 const admission=admitSingletonTest(file); // FIRST, before hooks/constructors/queries.
 const profile=employeeLifecycleFile(file),env=process.env,ancestors=ancestry(),directory=admission.evidenceDirectory;assert(profile,'Unknown closed employee lifecycle file');
 assert.equal(env.RUNNER_OS,'Linux');assert.equal(env.CI,'true');assert.equal(env.GITHUB_RUN_ATTEMPT,'1');assert.equal(realpathSync(directory),directory);
 if(admission.mode==='full-ci-singleton'){
  const path=join(directory,`${admission.databaseUnit}-employee-test-context.json`);assert.equal(env.AIHR_EMPLOYEE_LIFECYCLE_CONTEXT,path);const bytes=employeeLifecycleRead(path,65536),context=contextSchema.parse(JSON.parse(bytes));
  assert.equal(context.registrySha256,EMPLOYEE_LIFECYCLE_PROFILE_SHA256);assert.equal(context.file,file);assert.equal(context.stage,profile.stage);assert.equal(context.unit,admission.databaseUnit);assert.equal(context.source,env.AIHR_CI_HEAD);assert.equal(context.controller,env.AIHR_CI_CONTROL_HEAD);assert.equal(context.run,env.GITHUB_RUN_ID);assert.equal(context.attempt,env.GITHUB_RUN_ATTEMPT);assert.equal(context.evidenceDirectory,directory);assert.equal(context.sourceRoot,realpathSync(process.cwd()));
  const prepPath=join(directory,`${context.unit}-employee-preparation.json`),prepBytes=employeeLifecycleRead(prepPath,65536),prep=preparation.parse(JSON.parse(prepBytes));assert.equal(employeeLifecycleHash(prepBytes),context.preparationSha256);
  const {preparationSha256:_p,singletonPath,singletonSha256,...original}=context;assert.deepEqual(original,prep);assert.equal(singletonPath,join(directory,`${context.unit}-singleton.json`));assert.equal(employeeLifecycleHash(employeeLifecycleRead(singletonPath,1048576)),singletonSha256);
  const witness=monitorSchema.parse(JSON.parse(employeeLifecycleRead(join(directory,`${context.unit}-employee-monitor.json`),16384)));
  for(const key of ['source','controller','run','attempt','unit','file','fingerprint','stage'] as const)assert.equal(witness[key],context[key]);assert.equal(witness.preparationSha256,context.preparationSha256);assert.equal(witness.testContextSha256,employeeLifecycleHash(bytes));
  const monitor=ancestors.find(value=>value.pid===witness.monitor.pid);assert(monitor);assert.equal(monitor.start,witness.monitor.start);assert.equal(monitor.group,monitor.pid);assert.equal(monitor.session,monitor.pid);
  const supervisor=ancestors.find(value=>value.pid===witness.supervisor.pid);assert(supervisor);assert.equal(supervisor.start,witness.supervisor.start);assert.equal(supervisor.exe,realpathSync('/usr/bin/python3'));assert.equal(monitor.parent,supervisor.pid);assert.equal(supervisor.parent,context.parent.pid);assert.deepEqual(employeeLifecycleProcess(context.parent.pid),context.parent);
  assert.equal(supervisor.argv.length,5);assert.deepEqual(supervisor.argv.slice(1,4),['-I','-B',join(context.automation,'.github/ci/employee-lifecycle-supervisor.py')]);assert.equal(controllerHead(context.automation),context.controller);
  assert.deepEqual(Object.keys(context.controllerSources).sort(),[...EMPLOYEE_LIFECYCLE_CONTROLLER_SOURCES].sort());
  for(const [path,digest]of Object.entries(context.controllerSources))assert.equal(employeeLifecycleHash(employeeLifecycleRead(join(context.automation,path),1048576,false)),digest);
 }else{
  assert(!Object.keys(env).some(key=>key.startsWith('AIHR_EMPLOYEE_LIFECYCLE_')),'Mixed normal/focused lifecycle intent');
  const automation=realpathSync(join(env.GITHUB_WORKSPACE!,'automation')),script=join(automation,'.github/ci/employee-benchmark-supervisor.py');assert.equal(controllerHead(automation),env.AIHR_CI_CONTROL_HEAD);
  const supervisor=ancestors.find(value=>value.argv.length===5&&value.argv[1]==='-I'&&value.argv[2]==='-B'&&value.argv[3]===script);assert(supervisor,'Real focused supervisor ancestor required');
  const request=z.object({stage:z.string(),node:z.string(),controller:z.string(),destination:z.string()}).strict().parse(JSON.parse(supervisor.argv[4]));assert.equal(request.stage,profile.stage);assert.equal(request.controller,automation);assert.equal(request.destination,directory);assert.equal(request.node,realpathSync(process.execPath));
  const monitor=ancestors.find(value=>value.parent===supervisor.pid);assert(monitor);assert.equal(monitor.pid,monitor.group);assert.equal(monitor.pid,monitor.session);
  const text=employeeLifecycleRead(join(directory,'benchmark-supervisor.jsonl'),1048576).toString('utf8');assert(text.endsWith('\n'));const events:unknown[]=text.trimEnd().split('\n').map(line=>JSON.parse(line));
  const ready=z.object({kind:z.literal('session-admitted'),stage:z.literal(profile.stage),pid:z.literal(monitor.pid),start:z.number().int().positive(),source:z.literal(env.AIHR_CI_HEAD!),controller:z.literal(env.AIHR_CI_CONTROL_HEAD!),run:z.literal(env.GITHUB_RUN_ID!),attempt:z.literal('1'),releaseAuthorized:z.literal(false)}).strict();
  assert(events.some(value=>{const parsed=ready.safeParse(value);return parsed.success&&String(parsed.data.start)===monitor.start;}),'Actual focused session ACK witness required');
 }
 return Object.freeze({...admission,file,stage:profile.stage,expectedCases:profile.cases,planPhases:profile.planPhases,callPairs:profile.callPairs,releaseAuthorized:false as const});
}
