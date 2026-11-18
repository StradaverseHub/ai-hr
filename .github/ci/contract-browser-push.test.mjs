import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contractBrowserPushSource,CONTRACT_BROWSER_BRANCH,CONTRACT_BROWSER_WORKFLOW} from './contract-browser-push.mjs';
const changed=[CONTRACT_BROWSER_WORKFLOW],sha='a'.repeat(40),ref='refs/heads/'+CONTRACT_BROWSER_BRANCH,repo='StradaverseHub/ai-hr';
const event=()=>({repository:{full_name:repo},ref,after:sha,deleted:false,commits:[{id:sha,modified:[CONTRACT_BROWSER_WORKFLOW]}]});
const env=()=>({GITHUB_EVENT_NAME:'push',GITHUB_REPOSITORY:repo,GITHUB_REF:ref,GITHUB_SHA:sha,AIHR_WORKFLOW_SHA:sha,AIHR_WORKFLOW_REF:repo+'/'+CONTRACT_BROWSER_WORKFLOW+'@'+ref});
test('binds this exact candidate push to the actual clean workflow-source checkout',()=>{assert.deepEqual(contractBrowserPushSource(event(),env(),sha,'',changed),{sha,branch:CONTRACT_BROWSER_BRANCH});});
for(const [label,change]of Object.entries({repository:e=>e.repository.full_name='Other/repo',branch:e=>e.ref='refs/heads/main',tag:e=>e.ref='refs/tags/example',deleted:e=>e.deleted=true,malformed:e=>e.after='main',pullRequest:e=>e.pull_request={number:1}}))test('refuses altered event '+label,()=>{const value=event();change(value);assert.throws(()=>contractBrowserPushSource(value,env(),sha,'',changed));});
for(const key of ['GITHUB_EVENT_NAME','GITHUB_REPOSITORY','GITHUB_REF','GITHUB_SHA','AIHR_WORKFLOW_SHA','AIHR_WORKFLOW_REF'])test('refuses mismatched runtime '+key,()=>{assert.throws(()=>contractBrowserPushSource(event(),{...env(),[key]:'unexpected'},sha,'',changed));});
test('refuses a moved or dirty checkout independently of event metadata',()=>{assert.throws(()=>contractBrowserPushSource(event(),env(),'b'.repeat(40),'',changed));assert.throws(()=>contractBrowserPushSource(event(),env(),sha,' M app/me/page.tsx',changed));});

test('refuses the former candidate branch after the exact review-branch binding changes',()=>{const value=event();value.ref='refs/heads/codex/contract-handoff-completion-20261117';assert.throws(()=>contractBrowserPushSource(value,env(),sha,'',changed));});

test('refuses missing or unrelated API file evidence even when the push identity is otherwise correct',()=>{for(const files of [undefined,[],['app/me/page.tsx']])assert.throws(()=>contractBrowserPushSource(event(),env(),sha,'',files));});

test('refuses the preserved prior candidate branch after the hotfix-base binding',()=>{const value=event();value.ref='refs/heads/codex/contract-handoff-current-base-20261117';assert.throws(()=>contractBrowserPushSource(value,env(),sha,'',changed));});
