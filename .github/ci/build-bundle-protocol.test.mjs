/** Disposable Git/byte fixtures only. No application build, provider or deployment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync,realpathSync,chmodSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {BUILD_BUNDLE_FORMAT,BUILD_BUNDLE_KIND,BUILD_BUNDLE_HELPER_PATHS,trustedBundleHelpers,validateBundleHelpers,verifyBundleHelperFiles,assertSourceBundleCapability} from './build-bundle-protocol.mjs';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-bundle-protocol-')));
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git(['init','--quiet']);
 for(const [key,path]of Object.entries(BUILD_BUNDLE_HELPER_PATHS)){
  mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),'fixture helper '+key+'\n');
 }
 git(['add','.']);git(['-c','user.name=Protocol fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Independent original helper bytes']);
 return {root,git,ref:git(['rev-parse','HEAD']),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('protocol is closed3 and seven trusted hashes come from immutable Git blobs, not current files',()=>{
 const f=fixture();try{
  assert.equal(BUILD_BUNDLE_FORMAT,3);assert.equal(BUILD_BUNDLE_KIND,'next-map-byte-bundle');
  assert.deepEqual(Object.keys(BUILD_BUNDLE_HELPER_PATHS),['regular','maps','installer','grant','artifact','policy','protocol']);
  const expected=trustedBundleHelpers(f.root,f.ref);
  for(const [key,path]of Object.entries(BUILD_BUNDLE_HELPER_PATHS))assert.equal(expected[key],createHash('sha256').update(readFileSync(join(f.root,path))).digest('hex'));
  assert.equal(assertSourceBundleCapability(f.root,expected,f.ref),true);
  writeFileSync(join(f.root,BUILD_BUNDLE_HELPER_PATHS.maps),'different current helper\n');
  assert.deepEqual(trustedBundleHelpers(f.root,f.ref),expected);
  assert.throws(()=>assertSourceBundleCapability(f.root,expected,f.ref),/Current source helper/);
  const rebound={...expected,maps:createHash('sha256').update('different current helper\n').digest('hex')};
  assert.throws(()=>assertSourceBundleCapability(f.root,rebound,f.ref),/Source Git bundle capability/);
 }finally{f.close();}
});
test('new committed helper cannot claim the old controller identity even after metadata hashes refresh',()=>{
 const f=fixture();try{
  const original=trustedBundleHelpers(f.root,f.ref);
  writeFileSync(join(f.root,BUILD_BUNDLE_HELPER_PATHS.regular),'new regular helper\n');f.git(['add','.']);
  f.git(['-c','user.name=Protocol fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Changed helper']);
  const refreshed=trustedBundleHelpers(f.root);
  assert.notEqual(original.regular,refreshed.regular);
  assert.throws(()=>assertSourceBundleCapability(f.root,refreshed,f.ref),/Source Git bundle capability/);
  assert.throws(()=>assertSourceBundleCapability(f.root,original),/Source Git bundle capability/);
  assert.equal(assertSourceBundleCapability(f.root,refreshed),true);
 }finally{f.close();}
});
test('raw remote helper verification works without Git and refuses every missing, symlink or shared inode companion',()=>{
 const f=fixture();try{
  const expected=trustedBundleHelpers(f.root,f.ref);rmSync(join(f.root,'.git'),{recursive:true});
  assert.equal(verifyBundleHelperFiles(f.root,expected),true);
  for(const path of Object.values(BUILD_BUNDLE_HELPER_PATHS)){
   const selected=join(f.root,path),bytes=readFileSync(selected),foreign=join(f.root,'foreign-helper');
   rmSync(selected);assert.throws(()=>verifyBundleHelperFiles(f.root,expected));
   writeFileSync(foreign,bytes);symlinkSync(foreign,selected);assert.throws(()=>verifyBundleHelperFiles(f.root,expected));
   rmSync(selected);linkSync(foreign,selected);assert.throws(()=>verifyBundleHelperFiles(f.root,expected));
   rmSync(selected);rmSync(foreign);writeFileSync(selected,bytes);
   assert.equal(verifyBundleHelperFiles(f.root,expected),true);
  }
 }finally{f.close();}
});
test('same-byte group or world writable helper refuses until original mode is restored',()=>{
 const f=fixture();try{
  const expected=trustedBundleHelpers(f.root,f.ref),path=join(f.root,BUILD_BUNDLE_HELPER_PATHS.maps);
  const bytes=readFileSync(path),mode=statSync(path).mode&0o777;
  try{
   for(const writable of [0o666,0o664]){
    chmodSync(path,writable);assert.deepEqual(readFileSync(path),bytes);
    assert.throws(()=>verifyBundleHelperFiles(f.root,expected),/Bounded regular source helper/);
   }
  }finally{chmodSync(path,mode);}
  assert.equal(verifyBundleHelperFiles(f.root,expected),true);
 }finally{f.close();}
});
test('missing/extra/legacy helper metadata and nonregular Git helper blobs refuse',()=>{
 const f=fixture();try{
  const expected=trustedBundleHelpers(f.root,f.ref);
  for(const value of [undefined,null,[],{}, {...expected,unknown:'a'.repeat(64)}, {...expected,maps:'a'.repeat(40)}, {...expected,maps:true}])assert.throws(()=>validateBundleHelpers(value));
  const missing={...expected};delete missing.maps;assert.throws(()=>validateBundleHelpers(missing));
  const path=join(f.root,BUILD_BUNDLE_HELPER_PATHS.maps);rmSync(path);symlinkSync('build-bundle.py',path);
  f.git(['add','.']);f.git(['-c','user.name=Protocol fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Unsupported helper symlink']);
  assert.throws(()=>trustedBundleHelpers(f.root),/regular Git blob/);
  assert.throws(()=>trustedBundleHelpers(f.root,'HEAD:path'),/Exact controller/);
 }finally{f.close();}
});

test('install authority is exact v18/format3 including nested build and closed helper closure',async()=>{
 const {validateInstallGrant}=await import('./ci-install-grant.mjs');
 const {STAGING_BUILD_RUNTIME,BUILD_CAPACITY_PROFILE}=await import('./build-production.mjs');
 const {CI_POLICY}=await import('./policy-version.mjs');
 const f=fixture();try{
  assert.equal(CI_POLICY,'aihr-staging-ci/v18');
  const now=Date.parse('2026-11-02T00:05:00.000Z'),digest='d'.repeat(64);
  const grant={format:3,kind:'OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL',policyVersion:CI_POLICY,target:'alpha-staging',
   installId:'00000000-0000-4000-8000-000000000001',source:'a'.repeat(40),controller:f.ref,controllerBranch:'main',baseline:'b'.repeat(40),baselineBuildId:'historical-format2-baseline',environmentSha256:digest,
   runId:123,runAttempt:1,runCreatedAt:'2026-11-02T00:00:00.000Z',producerStartedAt:'2026-11-02T00:01:00.000Z',producerCompletedAt:'2026-11-02T00:02:00.000Z',issuedAt:'2026-11-02T00:04:00.000Z',expiresAt:'2026-11-02T00:20:00.000Z',witnessFingerprint:digest,
   artifact:{id:1,digest:'sha256:'+digest},build:{format:3,bundleHelpers:trustedBundleHelpers(f.root),capacityProfile:{...BUILD_CAPACITY_PROFILE},nextBuildId:'new-format3-build',buildRecordId:'00000000-0000-4000-8000-000000000002',buildSourcePath:'/runner/source',runtime:{...STAGING_BUILD_RUNTIME},
    archiveBytes:123,...Object.fromEntries(['provenanceSha256','archiveSha256','manifestSha256','preparedSha256','successfulObservationSha256','lockSha256','packageSha256'].map(key=>[key,digest]))}};
  assert.equal(validateInstallGrant(grant,{now}),grant);
  for(const mutate of [g=>g.format=2,g=>g.format=4,g=>g.build.format=2,g=>g.policyVersion='aihr-staging-ci/v17',g=>delete g.build.bundleHelpers,g=>delete g.build.bundleHelpers.maps,g=>g.build.bundleHelpers.extra=digest,g=>g.build.capacityProfile.archiveMaxBytes++]){
   const wrong=structuredClone(grant);mutate(wrong);assert.throws(()=>validateInstallGrant(wrong,{now}));
  }
 }finally{f.close();}
});
