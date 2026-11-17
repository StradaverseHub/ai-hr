/** Real Linux descriptor/flock lifetime tests run on standard hosted Actions, without root operations. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('holds native SH and worker EX through direct mutating children and fences exact fixed authority',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-operation-guard-tests.py'],{encoding:'utf8',maxBuffer:1024**2,timeout:90000});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 12 tests');
},100000);

it('drops actual root to the installation owner with controlled env/groups and both kernel lock descriptions',()=>{
 if(process.getuid===undefined||process.getgid===undefined)throw Error('Standard Linux hosted runner UID/GID required');
 const result=spawnSync('sudo',['-n','python3','-I','-B','test/fixtures/bank-import-worker-operation-guard-tests.py','--privilege-boundary',String(process.getuid()),String(process.getgid())],{encoding:'utf8',maxBuffer:1024**2,timeout:45000});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 const proof=JSON.parse(result.stdout.trim());
 expect(proof).toMatchObject({kind:'ACTUAL_ROOT_TO_OWNER_KERNEL_BOUNDARY',uid:process.getuid(),gid:process.getgid(),supplementaryGroups:[],rootLauncherRefused:true,parentDescriptionsClosed:true,childHeldBothUntilExit:true,mutationsOutsideOwnedTempfiles:false,servicesTouched:false,releaseAuthorized:false});
});
