/** Python format/refusal cases execute in GHA; no database, root operation or worker credentials. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('closed worker package format rejects altered bytes, links, inventory and provenance',()=>{
 const result=spawnSync('python3',['-I','test/fixtures/bank-import-worker-package-tests.py'],{encoding:'utf8',maxBuffer:1024**2});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stderr,/Ran 9 tests/);
});
