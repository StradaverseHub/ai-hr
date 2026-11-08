import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,linkSync,renameSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {createClassifierSourceView} from '../.github/ci/diagnostics/classifier-witness-snapshot.mjs';
const gitBlob=(bytes:Buffer)=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
// Genuine temporary-filesystem observations, SYNTHETIC index fixture only, no admission/native/GitHub authority.
function fixture<T>(files:Record<string,string|Buffer>,work:(f:{source:string;tracked:Buffer;write:(path:string,bytes:string|Buffer)=>void})=>T){
 const source=mkdtempSync(join(tmpdir(),'classifier-source-view-'));
 const write=(path:string,bytes:string|Buffer)=>{mkdirSync(join(source,path,'..'),{recursive:true});writeFileSync(join(source,path),bytes);};
 try{for(const[path,bytes]of Object.entries(files))write(path,bytes);const tracked=Buffer.from(Object.entries(files).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(([path,bytes])=>`100644 ${gitBlob(Buffer.from(bytes))} 0\t${path}\0`).join(''));return work({source,tracked,write});}
 finally{rmSync(source,{recursive:true,force:true});}
}
function finish(view:ReturnType<typeof createClassifierSourceView>,paths:string[]){for(const engine of ['c','b','a']){const read=view.begin(engine);for(const path of paths)read(path);view.end(engine);}return view.seal();}
it('distinguishes a complete empty positive string from absent and nonfile null with full source metadata',()=>fixture({'test/empty.ts':''},({source,tracked})=>{
 const sealed=finish(createClassifierSourceView({source,tracked}),['test/empty.ts','test/missing','']);
 expect(sealed.entries).toEqual([{path:'',text:null},{path:'test/empty.ts',text:''},{path:'test/missing',text:null}]);
 const index=sealed.index();expect(index.rows[0].value).toBeNull();expect(index.rows[1].value.rawBytes).toBe(0);expect(index.rows[1].value.blob).toBe(gitBlob(Buffer.alloc(0)));expect(index.rows[2].value).toBeNull();sealed.assertStable();
}));
it('records every actual repeated engine call and first observer independently of sorted source IDs',()=>fixture({'test/z.ts':'z','test/a.ts':'a'},({source,tracked})=>{
 const view=createClassifierSourceView({source,tracked});const c=view.begin('c');expect(c('test/z.ts')).toBe('z');view.end('c');const b=view.begin('b');b('test/a.ts');b('test/z.ts');b('test/z.ts');view.end('b');view.begin('a')('test/a.ts');view.end('a');const sealed=view.seal();
 expect(sealed.index().rows.map((row:any)=>[row.path,row.firstSeen,row.firstEngine])).toEqual([['test/a.ts',1,'b'],['test/z.ts',0,'c']]);expect(sealed.calls('b').rows).toEqual([{id:0,sourceId:0},{id:1,sourceId:1},{id:2,sourceId:1}]);
}));
it('preserves BOM native UTF8 replacement complete bytes and decoded code-unit hashes',()=>fixture({'test/a.ts':Buffer.from([239,187,191,65,255,240,159,152,128])},({source,tracked})=>{
 const sealed=finish(createClassifierSourceView({source,tracked}),['test/a.ts']),row=sealed.index().rows[0],expected='\ufeffA\ufffd😀';
 expect(sealed.read('test/a.ts')).toBe(expected);expect(row.value.rawBytes).toBe(9);expect(row.value.textCodeUnits).toBe(expected.length);expect(row.value.textSha256).toBe(createHash('sha256').update(Buffer.from(expected)).digest('hex'));
}));
it('rejects unknown sealed probes rather than silently manufacturing null or touching the filesystem again',()=>fixture({'test/a.ts':'a'},({source,tracked})=>{
 const sealed=finish(createClassifierSourceView({source,tracked}),['test/a.ts']);expect(()=>sealed.read('test/unobserved.ts')).toThrow();
}));
it('refuses an untracked positive before its private contents can become a returned observation',()=>fixture({'test/a.ts':'a'},({source,tracked,write})=>{
 write('private.env','secret-fixture');const view=createClassifierSourceView({source,tracked}),read=view.begin('c');expect(()=>read('private.env')).toThrow('Classifier source custody unavailable');expect(()=>view.end('c')).toThrow();
}));
it('refuses wrong actual positive Git blob bytes and never substitutes null or a clean snapshot',()=>fixture({'test/a.ts':'original'},({source,tracked,write})=>{
 write('test/a.ts','changed');const view=createClassifierSourceView({source,tracked});expect(()=>view.begin('c')('test/a.ts')).toThrow();expect(()=>view.seal()).toThrow();
}));
it('detects a previously missing probe becoming a positive file before sealing',()=>fixture({'test/a.ts':'a'},({source,tracked,write})=>{
 const view=createClassifierSourceView({source,tracked});view.begin('c')('test/missing.ts');view.end('c');view.begin('b')('test/missing.ts');view.end('b');view.begin('a')('test/missing.ts');view.end('a');write('test/missing.ts','new');expect(()=>view.seal()).toThrow();
}));
it('detects replacement of a positive inode with identical complete bytes',()=>fixture({'test/a.ts':'same'},({source,tracked,write})=>{
 const sealed=finish(createClassifierSourceView({source,tracked}),['test/a.ts']);write('replacement','same');renameSync(join(source,'replacement'),join(source,'test/a.ts'));expect(()=>sealed.assertStable()).toThrow();
}));
it('rejects symlink and hardlink positive aliases without opening an unauthenticated source',()=>fixture({'test/a.ts':'a','test/link.ts':'a'},({source,tracked})=>{
 rmSync(join(source,'test/link.ts'));symlinkSync(join(source,'test/a.ts'),join(source,'test/link.ts'));expect(()=>createClassifierSourceView({source,tracked}).begin('c')('test/link.ts')).toThrow();rmSync(join(source,'test/link.ts'));linkSync(join(source,'test/a.ts'),join(source,'test/link.ts'));expect(()=>createClassifierSourceView({source,tracked}).begin('c')('test/a.ts')).toThrow();
}));
it('requires actual Git executable mode agreement and independently rejects a changed source mode',()=>fixture({'test/a.ts':'a'},({source,tracked})=>{
 chmodSync(join(source,'test/a.ts'),0o755);expect(()=>createClassifierSourceView({source,tracked}).begin('c')('test/a.ts')).toThrow();
}));
it('retains full positive text beyond four MiB and fails unavailable above the reviewed whole-blob envelope',()=>{
 fixture({'test/a.ts':'x'.repeat(4*1024*1024+1)},({source,tracked})=>{const sealed=finish(createClassifierSourceView({source,tracked}),['test/a.ts']);expect(sealed.read('test/a.ts').length).toBe(4*1024*1024+1);});
 fixture({'test/a.ts':Buffer.alloc(8*1024*1024+1)},({source,tracked})=>expect(()=>createClassifierSourceView({source,tracked}).begin('c')('test/a.ts')).toThrow());
});
it('rejects engine reordering and preserves the original null abort identity without resetting poison',()=>fixture({'test/a.ts':'a'},({source,tracked})=>{
 expect(()=>createClassifierSourceView({source,tracked}).begin('b')).toThrow();const controller=new AbortController(),view=createClassifierSourceView({source,tracked,signal:controller.signal});controller.abort(null);let first:unknown='uncaught',second:unknown='uncaught';try{view.begin('c');}catch(error){first=error;}try{view.seal();}catch(error){second=error;}expect(first).toBeNull();expect(second).toBe(first);
}));

it('preserves a real native NUL path-validation refusal as a logical null without relaxing any positive path rule',()=>fixture({'test/a.ts':'a'},({source,tracked})=>{
 const logical='test/missing'+String.fromCharCode(0)+'key',sealed=finish(createClassifierSourceView({source,tracked}),[logical]);
 expect(sealed.entries).toEqual([{path:logical,text:null}]);expect(sealed.index().rows[0].value).toBeNull();sealed.assertStable();
}));

it('retains a stable native too-long logical miss rather than replacing the original null with a custody error',()=>fixture({'test/a.ts':'a'},({source,tracked})=>{
 const logical='test/'+'x'.repeat(300),sealed=finish(createClassifierSourceView({source,tracked}),[logical]);expect(sealed.entries).toEqual([{path:logical,text:null}]);sealed.assertStable();
}));

it('refuses unreadable tracked positive source custody instead of silently converting a read failure into a clean null',()=>fixture({'test/a.ts':'private fixture'},({source,tracked})=>{
 expect(process.getuid?.()).toBeGreaterThan(0);chmodSync(join(source,'test/a.ts'),0o000);const view=createClassifierSourceView({source,tracked});expect(()=>view.begin('c')('test/a.ts')).toThrow();expect(()=>view.seal()).toThrow();
}));

it('preserves distinct logical aliases and native missing-parent traversal instead of normalising a null into a positive',()=>fixture({'test/a.ts':'a'},({source,tracked})=>{
 const sealed=finish(createClassifierSourceView({source,tracked}),['test/a.ts','test/./a.ts','test/missing/../a.ts']);
 expect(sealed.read('test/a.ts')).toBe('a');expect(sealed.read('test/./a.ts')).toBe('a');expect(sealed.read('test/missing/../a.ts')).toBeNull();expect(sealed.index().rows.filter((row:any)=>row.value!==null).map((row:any)=>row.value.blob)).toEqual([gitBlob(Buffer.from('a')),gitBlob(Buffer.from('a'))]);
}));
it('does not let returned metadata copies or frozen full entries alter the private sealed view',()=>fixture({'test/a.ts':'a'},({source,tracked})=>{
 const sealed=finish(createClassifierSourceView({source,tracked}),['test/a.ts']),index=sealed.index(),calls=sealed.calls('c');index.rows[0].value.rawSha256='forged';calls.rows[0].sourceId=99;
 expect(sealed.index().rows[0].value.rawSha256).not.toBe('forged');expect(sealed.calls('c').rows[0].sourceId).toBe(0);expect(Object.isFrozen(sealed.entries)&&Object.isFrozen(sealed.entries[0])).toBe(true);expect(sealed.read('test/a.ts')).toBe('a');sealed.assertStable();
}));
