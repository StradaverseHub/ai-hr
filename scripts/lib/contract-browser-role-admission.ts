/** Pure admission for the exact Contract development renderer. No connection or provisioning. */
import {createHash} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
export const CONTRACT_BROWSER_ROLE_MODE='contract_browser_disposable' as const;
export const CONTRACT_BROWSER_BRANCH='codex/contract-handoff-hotfix-base-20261117';
export const CONTRACT_BROWSER_ROLE_SOURCE={helper:'test/helpers/personnel-draft-discard-ci-role-fixture.ts',admission:'scripts/lib/contract-browser-role-admission.ts',entry:'scripts/contract-browser-premigration.ts'} as const;
export type ContractBrowserRoleEnvironment=Readonly<Record<string,string|undefined>>;
export type ContractBrowserRoleHost={platform:string;cwd:string;realpath:(path:string)=>string;read:(path:string)=>string;git:(cwd:string,args:readonly string[])=>string};
export type ContractBrowserRoleBinding={mode:typeof CONTRACT_BROWSER_ROLE_MODE;candidate:string;controller:string;runId:string;attempt:string;source:string;evidenceDirectory:string;sourceDigests:Record<keyof typeof CONTRACT_BROWSER_ROLE_SOURCE,string>};
const need=(value:unknown)=>{if(!value)throw Error('Isolated Contract browser role admission refused.');};
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export function hasContractBrowserRoleIntent(env:ContractBrowserRoleEnvironment){return env.AIHR_CONTRACT_ROLE_MODE!==undefined||env.AIHR_CONTRACT_ROLE_EVIDENCE_DIR!==undefined;}
export function inspectContractBrowserRoleAdmission(env:ContractBrowserRoleEnvironment,host:ContractBrowserRoleHost):{admin:string;binding:ContractBrowserRoleBinding}{
 need(env.AIHR_CONTRACT_ROLE_MODE===CONTRACT_BROWSER_ROLE_MODE);
 need(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.RUNNER_OS==='Linux'&&host.platform==='linux');
 need(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856'&&env.GITHUB_WORKFLOW==='contract-walkthrough'&&env.GITHUB_JOB==='production-renderer');
 need(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'')&&/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT??''));
 need(env.NODE_ENV==='development'&&env.TEST_DB_NAMESPACE==='contractbrowser');
 need(!Object.keys(env).some(key=>(key.startsWith('AIHR_FOCUSED_')||key==='AIHR_CI_DISPOSABLE_ROLE_MODE'||key.startsWith('AIHR_CI_ROLE_')||key.startsWith('AIHR_RESIGNATION_ROLE_'))&&env[key]!==undefined));
 need(env.AIHR_CI_PG_PROFILE==='2'&&env.AIHR_CI_PG_CONFIGURED_CAP_BYTES==='2113929216'&&env.AIHR_CI_PG_PEAK_BUDGET_BYTES==='2147483648'&&env.AIHR_CI_PG_JIT==='on');
 const ref='refs/heads/'+CONTRACT_BROWSER_BRANCH;
 need(env.GITHUB_REF===ref&&env.GITHUB_WORKFLOW_REF==='StradaverseHub/ai-hr/.github/workflows/contract-walkthrough.yml@'+ref);
 need(sha(env.AIHR_CI_HEAD)&&env.AIHR_CI_HEAD===env.AIHR_CI_CONTROL_HEAD&&env.GITHUB_SHA===env.AIHR_CI_HEAD);
 const workspace=env.GITHUB_WORKSPACE,temp=env.RUNNER_TEMP,evidence=env.AIHR_CONTRACT_ROLE_EVIDENCE_DIR;
 need(workspace&&temp&&evidence&&isAbsolute(workspace)&&isAbsolute(temp)&&isAbsolute(evidence));
 const canonical=(path:string)=>{need(resolve(path)===path&&host.realpath(path)===path);return path;};
 const source=canonical(join(canonical(workspace!),'source')),controller=canonical(join(workspace!,'automation')),rootTemp=canonical(temp!),evidenceDirectory=canonical(evidence!);
 need(host.cwd===source&&evidenceDirectory===join(rootTemp,'contract-production-renderer'));
 need(host.git(source,['rev-parse','HEAD']).trim()===env.AIHR_CI_HEAD&&host.git(controller,['rev-parse','HEAD']).trim()===env.AIHR_CI_CONTROL_HEAD);
 need(host.git(source,['status','--porcelain']).trim()===''&&host.git(controller,['status','--porcelain']).trim()==='');
 need(env.GITHUB_EVENT_PATH===join(rootTemp,'_github_workflow','event.json'));
 const event=JSON.parse(host.read(env.GITHUB_EVENT_PATH!)) as Record<string,unknown>,repository=event.repository as {full_name?:unknown;id?:unknown}|undefined;
 need(repository?.full_name==='StradaverseHub/ai-hr'&&repository.id===1333414856&&!event.pull_request&&event.ref===ref);
 if(env.GITHUB_EVENT_NAME==='push')need(event.after===env.AIHR_CI_HEAD&&event.deleted!==true);
 else if(env.GITHUB_EVENT_NAME==='workflow_dispatch'){const input=event.inputs as Record<string,unknown>|undefined;need(input?.candidate_ref===CONTRACT_BROWSER_BRANCH&&input.expected_sha===env.AIHR_CI_HEAD);}else need(false);
 const app='postgres://ai_hr_app@127.0.0.1:5433/ai_hr_contract_browser',migration='postgres://postgres@127.0.0.1:5433/ai_hr_contract_browser';
 need(env.DATABASE_URL===app&&env.TEST_DATABASE_URL===app&&env.MIGRATION_DATABASE_URL===migration&&env.TEST_MIGRATION_DATABASE_URL===migration);
 const sourceDigests={} as ContractBrowserRoleBinding['sourceDigests'];
 for(const [key,path] of Object.entries(CONTRACT_BROWSER_ROLE_SOURCE)){const candidate=host.read(canonical(join(source,path))),control=host.read(canonical(join(controller,path)));need(candidate===control&&candidate.length>0);sourceDigests[key as keyof typeof sourceDigests]=createHash('sha256').update(candidate).digest('hex');}
 return{admin:'postgres://postgres@127.0.0.1:5433/postgres',binding:{mode:CONTRACT_BROWSER_ROLE_MODE,candidate:env.AIHR_CI_HEAD!,controller:env.AIHR_CI_CONTROL_HEAD!,runId:env.GITHUB_RUN_ID!,attempt:env.GITHUB_RUN_ATTEMPT!,source,evidenceDirectory,sourceDigests}};
}
export function sameContractBrowserRoleBinding(a:ContractBrowserRoleBinding,b:ContractBrowserRoleBinding){return JSON.stringify(a)===JSON.stringify(b);}
