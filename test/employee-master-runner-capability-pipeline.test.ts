/** Portable missing-flag regression: only pre-existing shipping APIs, no root or app execution.
 * Parent may copy this file alone onto b39 to reproduce the original unavailable runner policy.
 */
import {describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installedInternalConfiguration,internalReportRunnerEnvironment} from '../deploy/identity-email/internal-report-install-model';
import {validateInstalledInternalReportEnvironment} from '../scripts/provision-runner';
import {employeeMasterScheduledEmailEnabled} from '../lib/employee-master-scheduled-email';
const launcherPath=fileURLToPath(new URL('../deploy/identity-email/internal-report-tick',import.meta.url));
// Reuse the existing dispatch suite's isolated pure-parser import. __main__ is never entered,
// bytecode writes are disabled, and only the generated fictional file bytes go through stdin.
function parseLauncherEnvironment(raw:string):Record<string,string>{
 const parsed:unknown=JSON.parse(execFileSync('python3',['-I','-c',`import importlib.machinery,json,sys
sys.dont_write_bytecode=True
m=importlib.machinery.SourceFileLoader('fixture_tick',sys.argv[1]).load_module()
print(json.dumps(m.parse_environment(sys.stdin.buffer.read())))`,launcherPath],{input:raw,encoding:'utf8',timeout:5000,maxBuffer:16384,stdio:['pipe','pipe','pipe']}));
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Launcher did not return an environment object.');
 const values:Record<string,string>={};
 for(const [key,value] of Object.entries(parsed)){if(typeof value!=='string')throw new Error('Launcher returned a nonstring environment value.');values[key]=value;}
 return values;
}
describe('verified web to installed runner scheduling capability',()=>{
 it.each(['true','false'] as const)('preserves actual-web %s through writer, Python and Node admission to canonical policy',flag=>{
  const actualWebEnv={AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:'https://fictional-report.invalid',AUTH_SESSION_KEY:'a'.repeat(64),DATABASE_URL:'postgres://ai_hr_app:fictional-app@127.0.0.1:5433/fictional_report',EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:flag};
  const web=installedInternalConfiguration(actualWebEnv);
  // The in-guard keeps this test type-compatible with the pre-fix shipping return shape.
  // Shipping lacks this derived value AND omits the flag in its writer; it must still reach
  // the genuine parsed-missing-flag/policy-false assertion rather than fail collection.
  const runnerInput={origin:web.origin,appDatabase:web.database,ownerDatabase:'postgres://fictional_owner:fictional-owner@127.0.0.1:5433/fictional_report',scheduledEmailEnabled:'scheduledEmailEnabled' in web&&web.scheduledEmailEnabled===true};
  const parsed=parseLauncherEnvironment(internalReportRunnerEnvironment(runnerInput));
  validateInstalledInternalReportEnvironment(parsed);
  expect(employeeMasterScheduledEmailEnabled(parsed)).toBe(flag==='true');
  expect(parsed.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED).toBe(flag);
 });
});
