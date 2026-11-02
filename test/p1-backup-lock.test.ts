import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const helper=resolve('scripts/backup-lock.py');
it('only its exact token, directory and complete known members permit backup lock removal',()=>{
 const dir=mkdtempSync(join(tmpdir(),'backup-lock-')),lock=join(dir,'.lock');
 const run=(...args:string[])=>spawnSync('python3',[helper,...args],{encoding:'utf8',timeout:5000});
 try {
  const acquired=run('acquire',lock,'123');expect(acquired.status).toBe(0);const token=acquired.stdout.trim();
  expect(run('acquire',lock,'456').status).toBe(1);expect(readFileSync(join(lock,'pid'),'utf8')).toBe('123\n');
  writeFileSync(join(lock,'foreign'),'retain');expect(run('release',lock,token,'123').status).toBe(1);expect(readFileSync(join(lock,'foreign'),'utf8')).toBe('retain');
  rmSync(join(lock,'foreign'));writeFileSync(join(lock,'owner'),'replaced\n');expect(run('release',lock,token,'123').status).toBe(1);
  writeFileSync(join(lock,'owner'),token+'\n');renameSync(lock,join(dir,'old'));mkdirSync(lock);writeFileSync(join(lock,'pid'),'foreign');
  expect(run('release',lock,token,'123').status).toBe(1);expect(readFileSync(join(lock,'pid'),'utf8')).toBe('foreign');
  rmSync(lock,{recursive:true});renameSync(join(dir,'old'),lock);expect(run('release',lock,token,'123').status).toBe(0);expect(existsSync(lock)).toBe(false);
  expect(run('acquire',lock,'123').status).toBe(0);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
