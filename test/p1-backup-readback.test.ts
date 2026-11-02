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

it('keeps failed reader status and terminates its owned pipe descendants without touching a foreign process',()=>{
 const dir=mkdtempSync(join(tmpdir(),'backup-readback-groups-')),bytes=Buffer.from('owned bytes');
 const foreign=spawnSync(process.execPath,['-e',`const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(join(dir,'foreign.pid'))},String(p.pid));p.unref();`],{encoding:'utf8',timeout:5000});
 expect(foreign.status).toBe(0);const foreignPid=Number(readFileSync(join(dir,'foreign.pid'),'utf8'));
 const hash=createHash('sha256').update(bytes).digest('hex');
 const run=(name:string,code:string)=>spawnSync('python3',[resolve('scripts/backup-readback.py'),String(bytes.length),hash,join(dir,name),'1','--',process.execPath,'-e',code],{encoding:'utf8',timeout:5000});
 try {
  const failed=run('failed',`process.stdout.write(${JSON.stringify(bytes.toString())});process.exitCode=7;`);expect(failed.status).toBe(1);
  const descendant=run('descendant',`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});process.stdout.write(${JSON.stringify(bytes.toString())});process.exit(0);`);
  expect(descendant.error).toBeUndefined();expect(descendant.status).toBe(1);expect(()=>process.kill(foreignPid,0)).not.toThrow();
 } finally {process.kill(foreignPid,'SIGKILL');rmSync(dir,{recursive:true,force:true});}
});

it('a bounded final-wait failure has a distinct cleanup-uncertain status',()=>{
 const dir=mkdtempSync(join(tmpdir(),'readback-uncertain-'));
 const code=`import subprocess,runpy,sys,hashlib
real=subprocess.Popen
children=[]
class Deferred:
 def __init__(self,*a,**k):
  self.raw=real(*a,**k);children.append(self.raw);self.pid=self.raw.pid;self.stdout=self.raw.stdout
 def wait(self,timeout=None):
  raise subprocess.TimeoutExpired('owned reader',timeout)
subprocess.Popen=Deferred
sys.argv=[${JSON.stringify(resolve('scripts/backup-readback.py'))},'2',hashlib.sha256(b'ok').hexdigest(),${JSON.stringify(join(dir,'out'))},'1','--',${JSON.stringify(process.execPath)},'-e','process.stdout.write("ok")']
try:
 runpy.run_path(sys.argv[0],run_name='__main__')
finally:
 for child in children: child.wait(timeout=5)
`;
 try {
  const result=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:10000});
  expect(result.error).toBeUndefined();expect(result.status).toBe(78);expect(result.stderr).toContain('cleanup is uncertain');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

it('an OS refusal while terminating the owned reader is cleanup uncertainty, not an ordinary verified stop',()=>{
 const dir=mkdtempSync(join(tmpdir(),'readback-stop-refused-'));
 const code=`import subprocess,runpy,sys,hashlib,os,signal
real=subprocess.Popen
kill=os.killpg
children=[]
def started(*a,**k):
 child=real(*a,**k);children.append(child);return child
def refuse(*a):
 raise PermissionError('synthetic owned-group signal refusal')
subprocess.Popen=started
os.killpg=refuse
sys.argv=[${JSON.stringify(resolve('scripts/backup-readback.py'))},'2',hashlib.sha256(b'ok').hexdigest(),${JSON.stringify(join(dir,'out'))},'1','--',${JSON.stringify(process.execPath)},'-e','process.stdout.write("ok")']
try:
 runpy.run_path(sys.argv[0],run_name='__main__')
finally:
 for child in children:
  try: kill(child.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  child.wait(timeout=5)
`;
 try {
  const result=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:10000});
  expect(result.error).toBeUndefined();expect(result.status).toBe(78);expect(result.stderr).toContain('cleanup is uncertain');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
