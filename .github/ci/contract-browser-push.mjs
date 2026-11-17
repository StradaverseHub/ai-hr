/** Development-only bootstrap for this one fictional browser workflow. Never resolves release candidates. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const CONTRACT_BROWSER_BRANCH='codex/contract-handoff-current-base-20261117';
export const CONTRACT_BROWSER_WORKFLOW='.github/workflows/contract-walkthrough.yml';
export function contractBrowserPushSource(event,env,checkoutSha,dirty,changedFiles){
 const repo='StradaverseHub/ai-hr',ref='refs/heads/'+CONTRACT_BROWSER_BRANCH,sha=event.after;
 assert.equal(env.GITHUB_EVENT_NAME,'push','Only the explicit development push trigger is accepted');assert.equal(env.GITHUB_REPOSITORY,repo);assert.equal(event.repository?.full_name,repo);assert.equal(event.ref,ref);assert.equal(env.GITHUB_REF,ref);assert.notEqual(event.deleted,true);
 assert(/^[a-f0-9]{40}$/.test(sha??''),'An exact pushed commit is required');assert.equal(env.GITHUB_SHA,sha);assert.equal(env.AIHR_WORKFLOW_SHA,sha);assert.equal(env.AIHR_WORKFLOW_REF,repo+'/'+CONTRACT_BROWSER_WORKFLOW+'@'+ref);assert.equal(checkoutSha,sha);assert.equal(dirty,'');
 assert(Array.isArray(changedFiles)&&changedFiles.length<=300&&changedFiles.includes(CONTRACT_BROWSER_WORKFLOW),'The exact GitHub comparison must include this development workflow');
 assert(!event.pull_request,'PR events cannot enter the development push bootstrap');return{sha,branch:CONTRACT_BROWSER_BRANCH};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
 // Actions deliberately omits commit changed-file lists. Read the immutable, exact SHA comparison instead.
 assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(event.repository?.full_name,'StradaverseHub/ai-hr');assert.equal(event.ref,'refs/heads/'+CONTRACT_BROWSER_BRANCH);assert.equal(event.after,process.env.GITHUB_SHA);assert(/^[a-f0-9]{40}$/.test(event.before??'')&&!/^0+$/.test(event.before));assert(/^[a-f0-9]{40}$/.test(event.after??''));
 const compared=JSON.parse(execFileSync('gh',['api',`repos/StradaverseHub/ai-hr/compare/${event.before}...${event.after}`],{encoding:'utf8'}));
 assert.equal(compared.merge_base_commit?.sha,event.before,'Only a forward push from the exact prior head is admitted');assert.equal(compared.status,'ahead');
 const changedFiles=(compared.files??[]).filter(file=>['added','modified','renamed'].includes(file.status)).map(file=>file.filename);
 const source=contractBrowserPushSource(event,process.env,git('rev-parse','HEAD'),git('status','--porcelain'),changedFiles);
 appendFileSync(process.env.GITHUB_OUTPUT,`sha=${source.sha}\nbranch=${source.branch}\n`);
 appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Synthetic browser development bootstrap\n- Exact push: ${source.sha}\n- Branch: ${source.branch}\n- Workflow source: ${CONTRACT_BROWSER_WORKFLOW}\n- Isolated fictional database only. Release remains paused; no staging or operator action.\n`);
}
