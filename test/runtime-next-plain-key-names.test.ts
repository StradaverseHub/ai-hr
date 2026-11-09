/** Source models only; real owned native names require separately authenticated hosted evidence. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('checks bounded plain OTHER names, digest pairing and genuine full-helper receiver transitions',()=>{
 const result=spawnSync('/usr/bin/python3',['-I','-B','deploy/admission/test_next_plain_key_names.py'],
  {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 const output=(result.stdout??'')+(result.stderr??'');
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,output).toBe(0);
 expect(result.stdout).toBe('');expect(output).toMatch(/Ran 25 tests in /);expect(output).toMatch(/\nOK\s*$/);
 expect(output).not.toMatch(/skipped|FAILED|ERROR|FAIL:/);process.stdout.write(output);
});
