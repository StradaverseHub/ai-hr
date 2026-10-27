import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import{withBuildOnlyMode}from'./build-only-mode.mjs';
const original=readFileSync(new URL('./fixtures/build-only-original.yml',import.meta.url),'utf8'),changed=withBuildOnlyMode(original);
const job=(source,name)=>source.split('  '+name+':\n')[1]?.split(/\n  [A-Za-z][A-Za-z-]*:\n/)[0];
test('actual canonical build job stays byte identical',()=>assert.equal(job(changed,'build'),job(original,'build')));
test('full mode retains all required jobs and adds only opt-in exclusions',()=>{for(const name of ['typecheck','migrations','controller-tests','plan','test','browser','verify']){assert(job(original,name));assert(job(changed,name)?.includes('!inputs.build_only'));}assert(changed.includes('default: false\n        type: boolean\n      diagnostics_only:'));});
test('build-only cannot create a full gate receipt or silently dispatch on push',()=>{assert(job(changed,'verify').includes('!inputs.build_only'));assert(changed.includes('test "$EVENT" = workflow_dispatch'));assert(changed.includes('test "$DIAGNOSTICS_ONLY" = false'));assert(changed.includes('test "$CONTROLLER_ONLY" = false'));});
test('unexpected or already transformed workflow refuses',()=>{assert.throws(()=>withBuildOnlyMode(changed));assert.throws(()=>withBuildOnlyMode(original.replace('      diagnostics_only:','      renamed:')));});

test('original workflow fixture retains exact reviewed9541 bytes',()=>assert.equal(createHash('sha256').update(original).digest('hex'),'cf78afc94c77af1034784b7e6e45447649def2e0e5702495cd25f90a987cf944'));
