/** Admission for one job-owned fictional DB fixture, never installation provisioning. */
import assert from 'node:assert/strict';
import {join,resolve,isAbsolute} from 'node:path';
const image='postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const contexts={
 'ai-orchestrator-walkthrough':{job:'production-renderer',file:'ai-orchestrator-walkthrough.yml',evidence:'orchestrator-production-renderer'},
};
const pgArgs=['-c','listen_addresses=127.0.0.1','-c','port=5433','-c','fsync=off','-c','synchronous_commit=off','-c','full_page_writes=off','-c','wal_level=minimal','-c','max_wal_senders=0','-c','jit=on','-c','shared_buffers=128MB','-c','max_connections=100','-c','max_locks_per_transaction=256'];
const need=(value,label)=>assert(value,'Fictional bootstrap refused: '+label);
export function inspectOrchestratorBootstrap({env,platform,cwd,realpath,read,git,inspect,evidenceDirectory,adminUrl}) {
 need(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.RUNNER_OS==='Linux'&&platform==='linux','hosted Linux');
 need(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856'&&env.GITHUB_EVENT_NAME==='workflow_dispatch','repository/event');
 const context=contexts[env.GITHUB_WORKFLOW];need(context&&env.GITHUB_JOB===context.job,'workflow/job');
 need(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'')&&/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT??''),'run/attempt');
 need(/^[a-f0-9]{40}$/.test(env.AIHR_CI_HEAD??'')&&/^[a-f0-9]{40}$/.test(env.AIHR_CI_CONTROL_HEAD??'')&&env.GITHUB_SHA===env.AIHR_CI_CONTROL_HEAD,'source/controller');
 need(!env.GIT_DIR&&!env.GIT_WORK_TREE&&!env.GIT_INDEX_FILE,'alternate Git');
 need(!Object.keys(env).some(k=>(k.startsWith('AIHR_FOCUSED_')||k.startsWith('AIHR_CI_ROLE_')||k.startsWith('AIHR_CI_DISPOSABLE_ROLE_'))&&env[k]!==undefined),'mixed fixture mode');
 need(env.TEST_DB_NAMESPACE==='orchbrowser23'&&env.AIHR_CI_UNIT==='db-1'&&env.NODE_ENV==='development','fictional namespace');
 need(env.AIHR_CI_PG_PROFILE==='2'&&env.AIHR_CI_PG_CONFIGURED_CAP_BYTES==='2113929216'&&env.AIHR_CI_PG_PEAK_BUDGET_BYTES==='2147483648'&&env.AIHR_CI_PG_JIT==='on'&&env.AIHR_CI_PG_MEMORY_GIB===undefined,'unchanged PostgreSQL profile');
 for(const [key,user]of [['DATABASE_URL','ai_hr_app'],['TEST_DATABASE_URL','ai_hr_app'],['MIGRATION_DATABASE_URL','postgres'],['TEST_MIGRATION_DATABASE_URL','postgres']])
  need(env[key]===`postgres://${user}@127.0.0.1:5433/ai_hr_orchestrator_browser`,'fixed database target');
 need(adminUrl==='postgres://postgres@127.0.0.1:5433/postgres','fixed admin target');
 const workspace=env.GITHUB_WORKSPACE,temp=env.RUNNER_TEMP;
 need(workspace&&temp&&isAbsolute(workspace)&&isAbsolute(temp)&&realpath(workspace)===resolve(workspace)&&realpath(temp)===resolve(temp),'direct workspace/temp');
 const source=join(workspace,'source'),controller=join(workspace,'automation');
 need(realpath(cwd)===source&&resolve(cwd)===source,'source cwd');
 for(const [path,sha]of [[source,env.AIHR_CI_HEAD],[controller,env.AIHR_CI_CONTROL_HEAD]]){
  need(realpath(path)===path&&git(path,['rev-parse','--show-toplevel']).trim()===path&&git(path,['rev-parse','HEAD']).trim()===sha,'actual checkout');
  need(git(path,['status','--porcelain','--untracked-files=no']).trim()==='','dirty checkout');
  need(git(path,['remote','get-url','origin']).trim().toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','origin');
 }
 need(evidenceDirectory===join(temp,context.evidence)&&realpath(evidenceDirectory)===evidenceDirectory,'direct evidence directory');
 const eventPath=env.GITHUB_EVENT_PATH;
 need(eventPath&&isAbsolute(eventPath)&&realpath(eventPath)===resolve(eventPath)&&resolve(eventPath).startsWith(temp+'/')&&eventPath.endsWith('/event.json'),'event path');
 const text=read(eventPath);need(text.length<=4*1024*1024,'event bound');const event=JSON.parse(text);
 need(event.repository?.full_name==='StradaverseHub/ai-hr'&&event.repository?.id===1333414856&&event.inputs?.expected_sha===env.AIHR_CI_HEAD,'event identity');
 need(typeof event.inputs?.candidate_ref==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(event.inputs.candidate_ref)&&!event.inputs.candidate_ref.includes('..'),'candidate ref');
 need(env.GITHUB_WORKFLOW_REF===`StradaverseHub/ai-hr/.github/workflows/${context.file}@${env.GITHUB_REF}`&&env.GITHUB_REF?.startsWith('refs/heads/')&&event.ref===env.GITHUB_REF,'workflow path/ref');
 const container=`aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-db-1`,d=inspect(container);
 need(d.Name==='/'+container&&d.Config?.Labels?.['aihr-owner']===container&&d.State?.Running===true&&!d.State?.Dead&&!d.State?.OOMKilled,'owned running container');
 need(d.Config?.Image===image&&d.HostConfig?.NetworkMode==='host'&&d.HostConfig?.Memory===2113929216&&d.HostConfig?.MemorySwap===2113929216,'container profile');
 const command=d.Config?.Cmd;need(JSON.stringify(command)===JSON.stringify(pgArgs)||JSON.stringify(command)===JSON.stringify(['postgres',...pgArgs]),'fixed PostgreSQL command');
 return {kind:'ORCHESTRATOR_DISPOSABLE_ROLE_ADMISSION',candidate:env.AIHR_CI_HEAD,controller:env.AIHR_CI_CONTROL_HEAD,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,container,workflow:env.GITHUB_WORKFLOW,releaseAuthorized:false};
}
