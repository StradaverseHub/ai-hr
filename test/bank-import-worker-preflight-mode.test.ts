/** Pure supervisor budget parsing only; actual401 lifecycle is a separate GHA proof. */
import {describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';

const githubLinux=process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.platform==='linux';

describe.skipIf(!githubLinux)('Bank fixed preflight supervisor budget on GitHub Linux',()=>{
 it('caps fixed preflight at900seconds while retaining full-mode ceilings and fail-closed malformed budgets',()=>{
  expect(githubLinux).toBe(true);
  const source=String.raw`
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('preflight_budget_subject',Path('scripts/ci-bank-import-large-throughput.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
cases=[([],10800),(['--mode','full-100001','--max-seconds','900'],900),(['--mode','preflight-401'],900),(['--mode','preflight-401','--max-seconds','60'],60),(['--mode','preflight-401','--max-seconds','900'],900),(['--mode','preflight-401','--max-seconds','901'],900),(['--mode','preflight-401','--max-seconds','bad'],900),(['--mode','preflight-401','--max-seconds'],900),(['--mode=preflight-401','--max-seconds=601'],601),(['--mode','full-100001','--max-seconds','10801'],10800)]
for argv,wanted in cases:
 actual=module.supervisor_budget(argv)
 assert actual==wanted,(argv,actual,wanted)
print(json.dumps({'checkedBudgetCases':len(cases),'nativeProcessesStarted':0,'databaseUsed':False},sort_keys=True))
`;
  const stdout=execFileSync('python3',['-I','-B','-Werror', '-c',source],{cwd:process.cwd(),encoding:'utf8',timeout:10_000,maxBuffer:64*1024,stdio:['ignore','pipe','pipe']});
  expect(JSON.parse(stdout)).toEqual({checkedBudgetCases:10,nativeProcessesStarted:0,databaseUsed:false});
 },15_000);
});
