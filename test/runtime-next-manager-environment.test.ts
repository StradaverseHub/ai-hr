/** Pure source controls only. Actual typed manager custody requires native component evidence. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('checks generic manager projection, reserved control input, private transport and finite source history',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_manager_environment.py'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);expect(result.stdout).toBe('');
 expect(output).toMatch(/Ran 25 tests in /);expect(output).toMatch(/\nOK\s*$/);expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);process.stdout.write(output);
});
it('checks the actual singleton protocol with its complete shared preparation source closure',()=>{
 const result=spawnSync(process.execPath,['--test','.github/ci/singleton-profiles.test.mjs'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(output).toMatch(/# tests 11\n/);expect(output).toMatch(/# pass 11\n/);
 expect(output).toMatch(/# fail 0\n/);expect(output).toMatch(/# cancelled 0\n/);expect(output).toMatch(/# skipped 0\n/);expect(output).toMatch(/# todo 0\n/);process.stdout.write(output);
},35000);
