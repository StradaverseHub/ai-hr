/** Pure metadata/file models, never native ownership or acceptance evidence. */
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {accessEditorCatalogueDiagnostic,writeAccessEditorCatalogueDiagnostic} from './fixtures/access-editor-catalogue-diagnostic';
const directories:string[]=[];
const folder=()=>{const value=mkdtempSync(join(realpathSync(tmpdir()),'aihr-access-metadata-model-'));directories.push(value);return value;};
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
it('describes complete equal sections without treating object property order as a different native value',()=>{
 const value=accessEditorCatalogueDiagnostic({functions:[{oid:1,details:{owner:10,source:'real exact body'}}]},{functions:[{details:{source:'real exact body',owner:10},oid:1}]});
 expect(value).toMatchObject({sections:{functions:{expected:{rows:1},actual:{rows:1},deepStrictEqual:true}},differing:{}});
});
it('retains every differing dependency and unknown field without normalizing away an owner edge',()=>{
 const before={sharedDependencies:[{classid:1255,objid:123,refobjid:10,deptype:'a',unknown:'retained'}]},after={sharedDependencies:[...before.sharedDependencies,{classid:1255,objid:123,refobjid:16400,deptype:'o',unknown:'also retained'}]};
 const value=accessEditorCatalogueDiagnostic(before,after);
 expect(value).toMatchObject({sections:{sharedDependencies:{expected:{rows:1},actual:{rows:2},deepStrictEqual:false}},differing:{sharedDependencies:{expected:before.sharedDependencies,actual:after.sharedDependencies}}});
 const path=folder(),saved=writeAccessEditorCatalogueDiagnostic(path,{kind:'MODEL_NOT_NATIVE',releaseAuthorized:false,complete:true,...value});expect(saved.complete).toBe(true);
 expect(JSON.parse(readFileSync(join(path,saved.file),'utf8'))).toMatchObject({kind:'MODEL_NOT_NATIVE',differing:{sharedDependencies:{expected:before.sharedDependencies,actual:after.sharedDependencies}}});
});
it('exposes missing/nonJSON structural fields when serialized values otherwise look identical',()=>{
 const value=accessEditorCatalogueDiagnostic({relations:[{oid:1,unknown:undefined}]},{relations:[{oid:1}]});
 expect(value).toMatchObject({sections:{relations:{deepStrictEqual:false}},differing:{relations:{structuralDifferences:[{path:'relations.0.unknown',expectedOwnKey:true,actualOwnKey:false,expectedType:'undefined',actualType:'undefined'}]}}});
});
it('refuses oversized complete metadata while retaining only an explicitly incomplete bounded summary',()=>{
 const path=folder();expect(()=>writeAccessEditorCatalogueDiagnostic(path,{kind:'MODEL_NOT_NATIVE',complete:true,sections:{functions:{deepStrictEqual:false}},differing:{functions:{actual:'x'.repeat(16*1024*1024)}}})).toThrow('summary only');
 const retained=JSON.parse(readFileSync(join(path,'access-native-owner-catalogue.json'),'utf8'));expect(retained).toMatchObject({kind:'MODEL_NOT_NATIVE',complete:false,reason:'metadata-byte-bound'});expect(retained).not.toHaveProperty('differing');
});
