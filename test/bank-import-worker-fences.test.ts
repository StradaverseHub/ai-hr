/** Complete descriptor-relative metadata observations; hosted Linux only, no staging/live mutation. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('refuses real filesystem races and observes complete stable bounded metadata with actual descriptors',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-fences-tests.py'],{encoding:'utf8',maxBuffer:1024**2,timeout:90000});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 26 tests');
},100000);
it('refuses actual UID drift between complete enumerations using only owned hosted tempfiles',()=>{
 if(process.getuid===undefined)throw Error('Standard Linux hosted runner UID required');
 const result=spawnSync('sudo',['-n','python3','-I','-B','test/fixtures/bank-import-worker-fences-tests.py','--uid-race',String(process.getuid())],{encoding:'utf8',maxBuffer:1024**2,timeout:30000});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(JSON.parse(result.stdout.trim())).toEqual({kind:'ACTUAL_UID_METADATA_DRIFT_REFUSED',uid:process.getuid(),ownedTemporaryFilesOnly:true,releaseAuthorized:false});
});
