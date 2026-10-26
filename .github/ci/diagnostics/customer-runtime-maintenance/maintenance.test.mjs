import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('bounded maintenance agent phase, custody and filesystem refusal controls',()=>{
 const path=fileURLToPath(new URL('./test_maintenance_agent.py',import.meta.url));
 const result=execFileSync('python3',['-B',path],{encoding:'utf8',timeout:30000,maxBuffer:1024**2,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',LANG:'C.UTF-8'}});
 assert.equal(result,'');
});
