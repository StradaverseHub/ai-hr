/** Pure admission for one isolated development renderer. No connection, provisioning or filesystem side effects. */
import {createHash} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
export const RESIGNATION_BROWSER_ROLE_MODE='resignation_browser_disposable' as const;
export const RESIGNATION_BROWSER_ROLE_HELPER='test/helpers/personnel-draft-discard-ci-role-fixture.ts';
export const RESIGNATION_BROWSER_ROLE_SOURCE={helper:RESIGNATION_BROWSER_ROLE_HELPER,admission:'scripts/lib/resignation-browser-role-admission.ts',entry:'scripts/resignation-browser-premigration.ts'} as const;
export type BrowserRoleEnvironment=Readonly<Record<string,string|undefined>>;
export type ResignationBrowserRoleHost={platform:string;cwd:string;realpath:(path:string)=>string;read:(path:string)=>string;git:(cwd:string,args:readonly string[])=>string};
export type ResignationBrowserRoleBinding={mode:typeof RESIGNATION_BROWSER_ROLE_MODE;candidate:string;controller:string;runId:string;attempt:string;source:string;evidenceDirectory:string;sourceDigests:Record<keyof typeof RESIGNATION_BROWSER_ROLE_SOURCE,string>};
export type ResignationBrowserRoleAdmission={admin:string;binding:ResignationBrowserRoleBinding};
const fail=():never=>{throw Error('Isolated resignation browser role admission refused.');};
const need=(value:unknown)=>{if(!value)fail();};
const sha=(value:unknown,length=40)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+length+'}$').test(value);
export function hasResignationBrowserRoleIntent(env:BrowserRoleEnvironment):boolean{return env.AIHR_RESIGNATION_ROLE_MODE!==undefined||env.AIHR_RESIGNATION_ROLE_EVIDENCE_DIR!==undefined;}
export function inspectResignationBrowserRoleAdmission(env:BrowserRoleEnvironment,host:ResignationBrowserRoleHost):ResignationBrowserRoleAdmission{
 need(env.AIHR_RESIGNATION_ROLE_MODE===RESIGNATION_BROWSER_ROLE_MODE);need(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.RUNNER_OS==='Linux'&&host.platform==='linux');
 need(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856');need(env.GITHUB_WORKFLOW==='resignation-walkthrough'&&env.GITHUB_JOB==='production-renderer');need(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'')&&/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT??''));
 need(env.NODE_ENV==='development'&&env.TEST_DB_NAMESPACE==='resignationbrowser');need(!Object.keys(env).some(key=>(key.startsWith('AIHR_FOCUSED_')||key==='AIHR_CI_DISPOSABLE_ROLE_MODE'||key.startsWith('AIHR_CI_ROLE_'))&&env[key]!==undefined));
 need(env.AIHR_CI_PG_PROFILE==='2'&&env.AIHR_CI_PG_CONFIGURED_CAP_BYTES==='2113929216'&&env.AIHR_CI_PG_PEAK_BUDGET_BYTES==='2147483648'&&env.AIHR_CI_PG_JIT==='on');
 const branch='codex/resignation-journey-20261116',ref='refs/heads/'+branch,workflowRef='StradaverseHub/ai-hr/.github/workflows/resignation-walkthrough.yml@'+ref;
 need(env.GITHUB_REF===ref&&env.GITHUB_WORKFLOW_REF===workflowRef&&sha(env.AIHR_CI_HEAD)&&env.AIHR_CI_HEAD===env.AIHR_CI_CONTROL_HEAD&&env.GITHUB_SHA===env.AIHR_CI_HEAD);
 const workspace=env.GITHUB_WORKSPACE,temp=env.RUNNER_TEMP,evidence=env.AIHR_RESIGNATION_ROLE_EVIDENCE_DIR;need(workspace&&temp&&evidence&&isAbsolute(workspace)&&isAbsolute(temp)&&isAbsolute(evidence));
 const canonical=(path:string)=>{need(resolve(path)===path&&host.realpath(path)===path);return path;};
 const source=canonical(join(canonical(workspace!), 'source')),controller=canonical(join(workspace!,'automation')),rootTemp=canonical(temp!),evidenceDirectory=canonical(evidence!);
 need(host.cwd===source&&evidenceDirectory===join(rootTemp,'resignation-production-renderer'));need(host.git(source,['rev-parse','HEAD']).trim()===env.AIHR_CI_HEAD&&host.git(controller,['rev-parse','HEAD']).trim()===env.AIHR_CI_CONTROL_HEAD);need(host.git(source,['status','--porcelain']).trim()===''&&host.git(controller,['status','--porcelain']).trim()==='');
 need(env.GITHUB_EVENT_PATH===join(rootTemp,'_github_workflow','event.json'));const event=JSON.parse(host.read(env.GITHUB_EVENT_PATH!)) as Record<string,unknown>,repository=event.repository as {full_name?:unknown;id?:unknown}|undefined;
 need(repository?.full_name==='StradaverseHub/ai-hr'&&repository.id===1333414856&&!event.pull_request&&event.ref===ref);
 if(env.GITHUB_EVENT_NAME==='push')need(event.after===env.AIHR_CI_HEAD&&event.deleted!==true);else if(env.GITHUB_EVENT_NAME==='workflow_dispatch'){const input=event.inputs as Record<string,unknown>|undefined;need(input?.candidate_ref===branch&&input.expected_sha===env.AIHR_CI_HEAD);}else fail();
 const app='postgres://ai_hr_app@127.0.0.1:5433/ai_hr_resignation_browser',migration='postgres://postgres@127.0.0.1:5433/ai_hr_resignation_browser';need(env.DATABASE_URL===app&&env.TEST_DATABASE_URL===app&&env.MIGRATION_DATABASE_URL===migration&&env.TEST_MIGRATION_DATABASE_URL===migration);
 const sourceDigests={} as ResignationBrowserRoleBinding['sourceDigests'];for(const [key,path]of Object.entries(RESIGNATION_BROWSER_ROLE_SOURCE)){const candidate=host.read(canonical(join(source,path))),control=host.read(canonical(join(controller,path)));need(candidate===control&&candidate.length>0);sourceDigests[key as keyof typeof sourceDigests]=createHash('sha256').update(candidate).digest('hex');}
 return{admin:'postgres://postgres@127.0.0.1:5433/postgres',binding:{mode:RESIGNATION_BROWSER_ROLE_MODE,candidate:env.AIHR_CI_HEAD!,controller:env.AIHR_CI_CONTROL_HEAD!,runId:env.GITHUB_RUN_ID!,attempt:env.GITHUB_RUN_ATTEMPT!,source,evidenceDirectory,sourceDigests}};
}
export function sameResignationBrowserRoleBinding(a:ResignationBrowserRoleBinding,b:ResignationBrowserRoleBinding):boolean{return JSON.stringify(a)===JSON.stringify(b);}
