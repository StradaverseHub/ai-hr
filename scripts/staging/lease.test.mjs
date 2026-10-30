import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readLease,guardCommand,guardedRsync,leaseEnvironment} from './lease.mjs';
const g={protocol:'aihr-staging-queue/v1',candidate:'a'.repeat(40),batch:'01234567-1234-4234-9234-0123456789ab',epoch:1,token:'b'.repeat(64),releaseAuthorized:false};
test('lease credential is private and binds the exact candidate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'queue-lease-')),p=join(dir,'lease.json');
 try{
  writeFileSync(p,JSON.stringify(g),{mode:0o600});
  assert.deepEqual(readLease(g.candidate,{AIHR_STAGING_LEASE_FILE:p}),g);
  assert.throws(()=>readLease('c'.repeat(40),{AIHR_STAGING_LEASE_FILE:p}));
  chmodSync(p,0o644);assert.throws(()=>readLease(g.candidate,{AIHR_STAGING_LEASE_FILE:p}));
  assert.throws(()=>readLease(g.candidate,{}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('both source and packet rsync use the target operation guard; shell text stays quoted',()=>{
 const command=guardCommand(g,"echo '$()'; false");
 assert(command.includes('coordinator.py guard -- bash -c '));
 assert(command.includes("'\"'\"'"));
 const args=guardedRsync(g,['--delete','source/','aihr-staging:/opt/ai-hr/']);
 assert(args[0].includes('coordinator.py guard -- rsync'));
 assert.deepEqual(args.slice(1),['--delete','source/','aihr-staging:/opt/ai-hr/']);
 assert.equal(leaseEnvironment(g).AIHR_STAGING_CANDIDATE,g.candidate);
});
