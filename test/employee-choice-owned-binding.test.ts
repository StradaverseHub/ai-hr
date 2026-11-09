/** Pure endpoint/admission predicates. No database/host action executes. */
import {afterEach,expect,it,vi} from 'vitest';
import {employeeChoiceOwnedUrl} from './performance/employee-choice-owned-binding';
import {admitEmployeeChoiceNativeControl,employeeChoiceNativeControlFile} from './performance/employee-choice-native-control-admission';
afterEach(()=>vi.unstubAllEnvs());
const env=()=>({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_JOB:'selected-tests',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123',AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'b'.repeat(40),AIHR_FOCUSED_TESTS:JSON.stringify([employeeChoiceNativeControlFile]),VITEST_POOL_ID:'1',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test_w1',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test_w1'});
it('requires the exact Postgres scheme/5433/loopback/canonical worker/login before constructing any carrier',()=>{
 vi.stubEnv('TEST_DB_NAMESPACE','');const context=env();
 for(const protocol of ['postgres','postgresql'])expect(new URL(employeeChoiceOwnedUrl(protocol+'://postgres@127.0.0.1:5433/ai_hr_test_w1','postgres','fixed','work',context)).port).toBe('5433');
 for(const input of ['http://postgres@127.0.0.1:5433/ai_hr_test_w1','https://postgres@127.0.0.1:5433/ai_hr_test_w1','postgres://postgres@127.0.0.1:5432/ai_hr_test_w1','postgres://postgres@127.0.0.1/ai_hr_test_w1','postgres://postgres@localhost:5433/ai_hr_test_w1','postgres://postgres@127.0.0.2:5433/ai_hr_test_w1','postgres://postgres:secret@127.0.0.1:5433/ai_hr_test_w1','postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test_w1','postgres://postgres@127.0.0.1:5433/ai_hr_test_w2','postgres://postgres@127.0.0.1:5433/ai_hr_dev','postgres://postgres@127.0.0.1:5433/ai_hr_test_w1?host=foreign','postgres://postgres@127.0.0.1:5433/ai_hr_test_w1#fragment'])expect(()=>employeeChoiceOwnedUrl(input,'postgres','fixed','work',context)).toThrow();
 expect(new URL(employeeChoiceOwnedUrl(context.TEST_DATABASE_URL,'ai_hr_app','fixed','work',context)).searchParams.get('statement_timeout')).toBe('20000');
 expect(new URL(employeeChoiceOwnedUrl(context.TEST_DATABASE_URL,'ai_hr_app','fixed','native-control',context)).searchParams.get('statement_timeout')).toBe('1000');
});
it('refuses mixed/unregistered/native or foreign host input without manufacturing a normal-CI admission',()=>{
 vi.stubEnv('TEST_DB_NAMESPACE','');const context=env();expect(admitEmployeeChoiceNativeControl(context)).toEqual({developmentOnly:true,releaseAuthorized:false,normalCiAdmitted:false});
 for(const change of [{GITHUB_ACTIONS:'false'},{CI:'false'},{GITHUB_JOB:'test'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_RUN_ATTEMPT:'2'},{AIHR_FOCUSED_TESTS:JSON.stringify([employeeChoiceNativeControlFile,'test/foreign.test.ts'])},{AIHR_FOCUSED_TESTS:'[]'},{AIHR_CI_HEAD:'unknown'},{VITEST_POOL_ID:'0'},{TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5432/ai_hr_test_w1'}])expect(()=>admitEmployeeChoiceNativeControl({...context,...change})).toThrow();
});

it('never retains malformed configured URI contents in the parser failure or cause',()=>{
 vi.stubEnv('TEST_DB_NAMESPACE','');const secret='PRIVATE_FIXTURE_SECRET',raw='postgres://postgres:'+secret+'@[';let failure:unknown;
 try{employeeChoiceOwnedUrl(raw,'postgres','fixed','work',env());}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(Error);if(!(failure instanceof Error))throw Error('Closed endpoint refusal required');
 expect(failure.message).toBe('Invalid owned employee benchmark endpoint');expect(String(failure)).not.toContain(secret);expect(failure.stack).not.toContain(secret);expect(JSON.stringify(failure)).not.toContain(secret);
 expect(Reflect.ownKeys(failure)).not.toContain('cause');expect(Reflect.ownKeys(failure)).not.toContain('input');
});
