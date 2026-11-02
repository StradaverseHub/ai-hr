import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
it('independent bounded readback rejects lying, same-size corrupt, missing and stalled readers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'backup-readback-')),bytes=Buffer.from('independently expected bytes');
 const hash=createHash('sha256').update(bytes).digest('hex');
 const read=(name:string,code:string)=>spawnSync('python3',[resolve('scripts/backup-readback.py'),String(bytes.length),hash,join(dir,name),'1','--',process.execPath,'-e',code],{encoding:'utf8',timeout:5000});
 try {
  expect(read('valid',`process.stdout.write(${JSON.stringify(bytes.toString())})`).status).toBe(0);
  expect(readFileSync(join(dir,'valid'))).toEqual(bytes);
  expect(read('lie','process.exit(0)').status).toBe(1);
  expect(read('corrupt',`process.stdout.write(${JSON.stringify('X'+bytes.toString().slice(1))})`).status).toBe(1);
  expect(read('large',`process.stdout.write('x'.repeat(100000))`).status).toBe(1);
  const slow=read('slow','setTimeout(()=>process.stdout.write("late"),10000)');expect(slow.error).toBeUndefined();expect(slow.status).toBe(1);
  expect(existsSync(join(dir,'valid'))).toBe(true);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
