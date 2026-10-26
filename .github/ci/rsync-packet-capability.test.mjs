import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,chmodSync,symlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {assertRsyncPacketCapability} from './rsync-packet-capability.mjs';
const fixture=(args,{mode=0o600,bytes='AIHR packet permission capability\n',symlink=false}={})=>{
 assert.deepEqual(args.slice(0,3),['-a','--chmod=D700,F600','--']);
 const target=args.at(-1);mkdirSync(target,{mode:0o700});mkdirSync(join(target,'nested'),{mode:0o700});
 const path=join(target,'nested','packet');if(symlink)symlinkSync('/dev/null',path);else{writeFileSync(path,bytes);chmodSync(path,mode);}
 return target;
};
test('valid actual-mode transport fixture is accepted and private files always removed',()=>{
 let path;const proof=assertRsyncPacketCapability({run:(_file,args)=>{path=fixture(args);}});
 assert.equal(proof.payloadBytesVerified,true);assert.equal(proof.releaseAuthorized,false);assert.equal(existsSync(path),false);
});
test('original unsupported flag refuses before any remote command',()=>{
 let calls=0;assert.throws(()=>assertRsyncPacketCapability({run:()=>{calls++;throw Error('rsync: --chmod=D700,F600: invalid argument');}}),/compatible rsync/);assert.equal(calls,1);
});
for(const [label,options]of [['public file',{mode:0o644}],['changed bytes',{bytes:'corrupted'}],['symlink',{symlink:true}]])test('a zero exit cannot hide '+label,()=>{
 let path;assert.throws(()=>assertRsyncPacketCapability({run:(_file,args)=>{path=fixture(args,options);}}));assert.equal(existsSync(path),false);
});
test('actual available rsync satisfies the complete local flags and permission contract',()=>{
 const proof=assertRsyncPacketCapability();assert.equal(proof.fileMode,'0600');assert.equal(proof.directoryMode,'0700');
});
