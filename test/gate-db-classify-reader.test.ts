/** Actual public API Reader controls; no filesystem/driver/application behavior. */
import {expect,it} from 'vitest';
import {classifyTestFile,classifyTestFiles,type DbVerdict,type Reader} from '../scripts/gate-db-classify';
const spell=(source:string)=>source.replace(/\bIMP\b/g,'imp'+'ort');
function counted(files:Record<string,string>){
 const calls=new Map<string,number>(),order:string[]=[];
 const read:Reader=name=>{calls.set(name,(calls.get(name)??0)+1);order.push(name);return Object.hasOwn(files,name)?spell(files[name]):null;};
 return{read,calls,order};
}
const onlyOnce=(calls:Map<string,number>)=>{expect(calls.size).toBeGreaterThan(0);expect([...calls.values()].every(count=>count===1)).toBe(true);};
it('reads each shared diamond candidate once while preserving duplicate requested roots and their output order',()=>{
 const roots=['test/a.test.ts','test/b.test.ts','test/a.test.ts'],view=counted({
  'test/a.test.ts':"IMP './left'; IMP './right'; IMP './left';",'test/b.test.ts':"IMP './right';",
  'test/left.ts':"IMP './shared';",'test/right.ts':"IMP './shared';",'test/shared.ts':"IMP 'pg';",
 });
 const actual=classifyTestFiles(roots,view.read);expect(actual.db).toEqual(roots);expect(actual.nodb).toEqual([]);
 expect([...actual.why]).toEqual([['test/a.test.ts','test/shared.ts: imports pg'],['test/b.test.ts','test/shared.ts: imports pg']]);
 expect(view.calls.get('test/shared.ts')).toBe(1);expect(view.calls.get('test/shared')).toBe(1);expect(view.calls.get('test/a.test.ts')).toBe(1);onlyOnce(view.calls);
});
it('memoizes complete null misses and present empty strings without changing resolver existence semantics',()=>{
 const view=counted({'test/empty.test.ts':"IMP './empty'; IMP './empty';",'test/empty.ts':'','test/missing.test.ts':"IMP './absent';"});
 const actual=classifyTestFiles(['test/empty.test.ts','test/missing.test.ts'],view.read);
 expect(actual.nodb).toEqual(['test/empty.test.ts']);expect(actual.db).toEqual(['test/missing.test.ts']);
 expect(actual.why.get('test/missing.test.ts')).toBe("test/missing.test.ts: import './absent' does not resolve");
 expect(view.calls.get('test/empty.ts')).toBe(1);expect(view.calls.get('test/empty')).toBe(1);expect(view.calls.get('test/absent')).toBe(1);onlyOnce(view.calls);
});
it('refreshes the same batch Reader after content changes, deletion and creation between requests',()=>{
 const root='test/root.test.ts',files:Record<string,string>={[root]:"IMP './helper';",'test/helper.ts':'export {};'},view=counted(files);
 expect(classifyTestFiles([root],view.read).nodb).toEqual([root]);
 files['test/helper.ts']="IMP 'postgres';";let actual=classifyTestFiles([root],view.read);expect(actual.db).toEqual([root]);expect(actual.why.get(root)).toBe('test/helper.ts: imports postgres');
 delete files['test/helper.ts'];actual=classifyTestFiles([root],view.read);expect(actual.db).toEqual([root]);expect(actual.why.get(root)).toBe("test/root.test.ts: import './helper' does not resolve");
 files['test/helper']='';expect(classifyTestFiles([root],view.read).nodb).toEqual([root]);
 expect(view.calls.get(root)).toBe(4);expect(view.calls.get('test/helper.ts')).toBe(3);expect(view.calls.get('test/helper')).toBe(4);
});
it('keeps single-file requests fresh with the same Reader and a stale external result sink, and never shares another Reader state',()=>{
 const root='test/root.test.ts',files:Record<string,string>={[root]:"IMP './helper';"},view=counted(files),sink=new Map<string,DbVerdict>();
 expect(classifyTestFile(root,view.read,sink).reason).toBe("test/root.test.ts: import './helper' does not resolve");
 files['test/helper.ts']="IMP 'pg';";expect(classifyTestFile(root,view.read,sink)).toEqual({db:true,reason:'test/helper.ts: imports pg'});
 files['test/helper.ts']='';expect(classifyTestFile(root,view.read,sink).db).toBe(false);
 const foreign=counted({[root]:"IMP 'postgres';"}),fresh=classifyTestFile(root,foreign.read,sink);expect(fresh).toEqual({db:true,reason:root+': imports postgres'});expect(sink.get(root)).toBe(fresh);
 expect(view.calls.get(root)).toBe(3);expect(view.calls.get('test/helper.ts')).toBe(3);expect(foreign.calls.get(root)).toBe(1);
});
it('retains the exact first-observed ESM stem and suffix probe order while avoiding a later helper reread',()=>{
 const view=counted({'test/root.test.ts':"IMP './helper.js';",'test/helper.ts':"IMP 'pg';"});
 expect(classifyTestFile('test/root.test.ts',view.read)).toEqual({db:true,reason:'test/helper.ts: imports pg'});
 expect(view.order).toEqual(['test/root.test.ts','test/helper.js','test/helper.js.ts','test/helper.js.tsx','test/helper.js.js','test/helper.js.mjs','test/helper.js.cjs','test/helper.js.mts','test/helper.js/index.ts','test/helper.js/index.tsx','test/helper.js/index.js','test/helper','test/helper.ts']);onlyOnce(view.calls);
});
it('retains complete large helper content and finds a hazard beyond a four-MiB prefix without repeated reads',()=>{
 const root='test/root.test.ts',view=counted({[root]:"IMP './large'; IMP './large';",'test/large.ts':' '.repeat(5*1024*1024)+"IMP 'pg';"});
 expect(classifyTestFile(root,view.read)).toEqual({db:true,reason:'test/large.ts: imports pg'});expect(view.calls.get('test/large.ts')).toBe(1);onlyOnce(view.calls);
});
it('propagates the exact thrown Reader error without publishing a clean sink and retries fresh on the next request',()=>{
 const root='test/root.test.ts',failure=Error('fictional unavailable Reader'),old={db:false,reason:'stale'},sink=new Map<string,DbVerdict>([[root,old]]);let broken=true,calls=0;
 const read:Reader=name=>{if(name===root){calls++;return spell("IMP './helper';");}if(name==='test/helper'&&broken)throw failure;return name==='test/helper.ts'?'':null;};
 let singleError:unknown;try{classifyTestFile(root,read,sink);}catch(error){singleError=error;}expect(singleError).toBe(failure);expect(sink.get(root)).toBe(old);
 let thrown:unknown;try{classifyTestFiles([root],read);}catch(error){thrown=error;}expect(thrown).toBe(failure);expect(calls).toBe(2);
 broken=false;expect(classifyTestFile(root,read,sink).db).toBe(false);expect(calls).toBe(3);
});
it('caches only sources, preserving root-specific first acyclic reasons through a hazardous cycle in either request order',()=>{
 const files={'test/a.test.ts':"IMP './b.test'; IMP 'pg';",'test/b.test.ts':"IMP './a.test'; IMP 'postgres';"};
 for(const roots of [['test/a.test.ts','test/b.test.ts'],['test/b.test.ts','test/a.test.ts']]){
  const view=counted(files),actual=classifyTestFiles(roots,view.read);expect(actual.db).toEqual(roots);expect(actual.nodb).toEqual([]);
  expect(actual.why.get('test/a.test.ts')).toBe('test/b.test.ts: imports postgres');expect(actual.why.get('test/b.test.ts')).toBe('test/a.test.ts: imports pg');onlyOnce(view.calls);
 }
});
