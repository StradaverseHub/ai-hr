/** Closed real focused-host admission, never a self-issued normal-CI marker. */
import {employeeChoiceOwnedUrl} from './employee-choice-owned-binding';
export const employeeChoiceNativeControlFile='test/employee-choice-benchmark-owner-native.test.ts';
export function admitEmployeeChoiceNativeControl(env:NodeJS.ProcessEnv=process.env){
 const selection:unknown=JSON.parse(env.AIHR_FOCUSED_TESTS??'null');
 if(env.GITHUB_ACTIONS!=='true'||env.CI!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'
  ||env.GITHUB_JOB!=='selected-tests'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_RUN_ATTEMPT!=='1'||!(/^[1-9][0-9]{0,19}$/).test(env.GITHUB_RUN_ID??'')
  ||!(/^[0-9a-f]{40}$/).test(env.AIHR_CI_HEAD??'')||!(/^[0-9a-f]{40}$/).test(env.AIHR_CI_CONTROL_HEAD??'')
  ||env.WORKER_DB==='0'||!Array.isArray(selection)||selection.length!==1||selection[0]!==employeeChoiceNativeControlFile)throw Error('Sole owned hosted native control required; normal singleton admission pending');
 // These are the actual worker URLs, checked before the control creates pools.
 employeeChoiceOwnedUrl(env.TEST_MIGRATION_DATABASE_URL!,'postgres','admission-owner','native-control',env);
 employeeChoiceOwnedUrl(env.TEST_DATABASE_URL!,'ai_hr_app','admission-app','native-control',env);
 return Object.freeze({developmentOnly:true,releaseAuthorized:false,normalCiAdmitted:false});
}
