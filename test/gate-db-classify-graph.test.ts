/** Additional reachability rules; no real driver or application is loaded. */
import {expect,it} from 'vitest';
import {classifyTestFile,classifyTestFiles,type DbVerdict,type Reader} from '../scripts/gate-db-classify';
const spell=(source:string)=>source.replace(/\bIMP\b/g,'imp'+'ort');
const tree=(files:Record<string,string>):Reader=>name=>Object.hasOwn(files,name)?spell(files[name]):null;

it('cannot inherit a clean verdict from a different Reader through the legacy result map',()=>{
 const results=new Map<string,DbVerdict>(),file='test/root.test.ts';
 expect(classifyTestFile(file,tree({[file]:'export const value=1;'}),results).db).toBe(false);
 const actual=classifyTestFile(file,tree({[file]:"IMP 'postgres';"}),results);
 expect(actual).toEqual({db:true,reason:file+': imports postgres'});expect(results.get(file)).toBe(actual);
});
it('resolves a hazardous self cycle and keeps a complete clean self cycle clean',()=>{
 const file='test/root.test.ts';
 expect(classifyTestFile(file,tree({[file]:"IMP './root.test'; IMP 'pg';"}))).toEqual({db:true,reason:file+': imports pg'});
 expect(classifyTestFile(file,tree({[file]:"IMP './root.test';"})).db).toBe(false);
});
it('closes a diamond and retains the first reachable acyclic reason instead of a later direct hazard',()=>{
 const read=tree({'test/root.test.ts':"IMP './left'; IMP './right'; IMP 'pg';",'test/left.ts':"IMP './shared';",'test/right.ts':"IMP './shared';",'test/shared.ts':"IMP 'postgres';"});
 const files=['test/root.test.ts','test/left.ts','test/right.ts','test/shared.ts'],actual=classifyTestFiles(files,read);
 expect(actual.db).toEqual(files);expect(actual.nodb).toEqual([]);
 for(const file of files)expect(actual.why.get(file)).toBe('test/shared.ts: imports postgres');
});
it('retains text and opaque precedence before ordered import traversal',()=>{
 const file='test/root.test.ts',direct='process.env.DATA'+'BASE_URL';
 expect(classifyTestFile(file,tree({[file]:"IMP 'postgres'; "+direct})).reason).toBe(file+': mentions a DATABASE'+'_URL');
 expect(classifyTestFile(file,tree({[file]:"IMP 'postgres'; const name='module'; IMP(name);"})).reason).toBe(file+': a dynamic import()/require() that is not a string literal');
});
it('retains resolver suffix order, ESM source fallback and product-only traversal boundaries',()=>{
 const file='test/root.test.ts';
 expect(classifyTestFile(file,tree({[file]:"IMP './helper.js';",'test/helper.ts':"IMP 'pg';"})).reason).toBe('test/helper.ts: imports pg');
 expect(classifyTestFile(file,tree({[file]:"IMP './helper';",'test/helper':'export {};','test/helper.ts':"IMP 'pg';"})).db).toBe(false);
 expect(classifyTestFile(file,tree({[file]:"IMP '../core/product';",'core/product.ts':"IMP 'pg';"})).db).toBe(false);
});
it('handles a long finite dependency chain without using the JavaScript call stack',()=>{
 const files:Record<string,string>={};for(let index=0;index<2500;index++)files['test/link'+index+'.ts']=index===2499?"IMP 'pg';":"IMP './link"+(index+1)+"';";
 const actual=classifyTestFiles(['test/link0.ts','test/link2499.ts'],tree(files));
 expect(actual.db).toEqual(['test/link0.ts','test/link2499.ts']);expect(actual.nodb).toEqual([]);expect([...actual.why.values()]).toEqual(['test/link2499.ts: imports pg','test/link2499.ts: imports pg']);
});
