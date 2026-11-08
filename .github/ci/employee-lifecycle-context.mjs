/** Private disk/process identity primitives; no command, signal or admission API. */
import assert from 'node:assert/strict';
import {openSync,readSync,fstatSync,closeSync,constants,realpathSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
export const employeeLifecycleHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function employeeLifecycleRead(path,maximum,privateFile=true){
 assert.equal(resolve(path),path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=maximum);assert.equal(before.uid,process.getuid());if(privateFile)assert((before.mode&0o077)===0);assert.equal(realpathSync(`/proc/self/fd/${fd}`),path);
  const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);assert(n>0);offset+=n;}assert.equal(readSync(fd,Buffer.alloc(1),0,1,null),0);const after=fstatSync(fd);assert.equal(after.size,before.size);assert.equal(after.mtimeNs??after.mtimeMs,before.mtimeNs??before.mtimeMs);assert.equal(after.ctimeNs??after.ctimeMs,before.ctimeNs??before.ctimeMs);return bytes;
 }finally{closeSync(fd);}
}
export function employeeLifecycleProcess(pid){
 assert(Number.isSafeInteger(pid)&&pid>0);const root=`/proc/${pid}`,stat=readFileSync(root+'/stat','utf8'),end=stat.lastIndexOf(')');assert(end>0);const fields=stat.slice(end+2).trim().split(/\s+/);assert(fields.length>=20);assert(!['Z','X'].includes(fields[0]));
 return {pid,parent:Number(fields[1]),group:Number(fields[2]),session:Number(fields[3]),start:fields[19],exe:realpathSync(root+'/exe'),argv:readFileSync(root+'/cmdline').toString('utf8').split('\0').slice(0,-1)};
}
export function assertEmployeeLifecycleAnchor(anchor,expected,nowNs,boot){
 assert.deepEqual(Object.keys(anchor).sort(),['version','run','attempt','job','unit','source','controller','bootId','startNs','wallTimeNs'].sort());assert.equal(anchor.version,1);
 for(const key of ['run','attempt','unit','source','controller'])assert.equal(anchor[key],expected[key]);assert.equal(anchor.job,'test');assert.equal(anchor.bootId,boot);
 for(const key of ['startNs','wallTimeNs'])assert(typeof anchor[key]==='string'&&/^[1-9][0-9]{0,19}(?![\s\S])/.test(anchor[key]));const elapsed=Number(nowNs-BigInt(anchor.startNs))/1e9;assert(elapsed>=0&&elapsed<1770);return elapsed;
}
export function assertEmployeeLifecycleParent(actual,expected){assert.deepEqual(actual,expected);assert(Number.isSafeInteger(actual.pid)&&actual.pid>0);assert(Array.isArray(actual.argv)&&actual.argv.length===4);}

export const EMPLOYEE_LIFECYCLE_CONTROLLER_SOURCES=Object.freeze(['.github/ci/employee-lifecycle.mjs','.github/ci/employee-lifecycle-profile.mjs','.github/ci/employee-lifecycle-profile.json','.github/ci/employee-lifecycle-context.mjs','.github/ci/employee-lifecycle-supervisor.py','.github/ci/employee-lifecycle-always-stop.mjs','.github/ci/owned-process.py','.github/ci/employee-postgres-resource.py','.github/ci/employee-postgres-policy.py','.github/ci/run-unit.mjs']);
