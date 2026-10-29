/** Python format/refusal cases execute in GHA; no database, root operation or worker credentials. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
function pythonCases(path){
 const before=execFileSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8'});
 const result=spawnSync('python3',['-I','-B',path],{encoding:'utf8',maxBuffer:1024**2});
 assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8'}),before,'Python security checks changed the source checkout');
 assert.equal(existsSync('deploy/systemd/__pycache__'),false,'Python created bytecode beside trusted source');
 return result;
}
test('closed worker package format rejects altered bytes, links, inventory and provenance',()=>{
 const result=pythonCases('test/fixtures/bank-import-worker-package-tests.py');
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stderr,/Ran 11 tests/);
});
test('worker installer refuses mutable trust inputs and fixes the privileged service definition',()=>{
 const result=pythonCases('test/fixtures/bank-import-worker-installer-tests.py');
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stderr,/Ran 12 tests/);
});
test('exact-install continuation refuses changed bytes, inventory, modes and prior activation',()=>{
 const result=pythonCases('test/fixtures/bank-import-worker-recovery-tests.py');
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stderr,/Ran 6 tests/);
});
test('corrected never-started variants require a native runtime witness and safely restore unit bytes',()=>{
 const result=pythonCases('test/fixtures/bank-import-worker-variant-tests.py');
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stderr,/Ran 7 tests/);
});
