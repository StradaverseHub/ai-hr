/** Exact guard from failed source402bcd1bd; pure regression fixture, no query or mutation. */
import assert from 'node:assert/strict';
export function assertInstallEnvironment(e){
 assert(e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'
  &&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_RUN_ATTEMPT==='1','Owned first-attempt hosted experiment only');
 assert(['baseline','prototype'].includes(e.AIHR_PLAN_REUSE_MODE)&&e.AIHR_CI_HEAD===e.AIHR_CI_CONTROL_HEAD&&/^[a-f0-9]{40}$/.test(e.AIHR_CI_HEAD??''),'Frozen identical candidate/controller required');
 assert(e.TEST_DB_NAMESPACE===(e.AIHR_PLAN_REUSE_MODE==='baseline'?'plan_base':'plan_proto'),'Explicit private namespace required');
 const url=new URL(e.TEST_MIGRATION_DATABASE_URL);assert(url.hostname==='127.0.0.1'&&url.port==='5433'&&url.username==='postgres'
  &&/^\/ai_hr_test_w[12]_plan_(base|proto)$/.test(url.pathname),'Owned local runner worker only');
}
