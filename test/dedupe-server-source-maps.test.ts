/** Post-build server source-map sharing (scripts/dedupe-server-source-maps.mjs). Real files only. */
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {dedupeServerSourceMaps} from '../scripts/dedupe-server-source-maps.mjs';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function build(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'aihr-server-maps-'));roots.push(root);
 mkdirSync(join(root,'server/chunks/ssr'),{recursive:true});mkdirSync(join(root,'static/chunks'),{recursive:true});
 return root;
}
const map=(source:string)=>JSON.stringify({version:3,sources:['../../../core/'+source+'.ts'],sourcesContent:['export const '+source+'=1'],names:[],mappings:'AAAA'});
/** A chunk as Turbopack writes it: code, a blank line, then the URL-encoded name of its own map. */
function chunk(root:string,path:string,code:string,mapBytes:string,url=encodeURIComponent(path.split('/').at(-1)!+'.map')){
 writeFileSync(join(root,path),code+'\n\n//# sourceMappingURL='+url);
 writeFileSync(join(root,path+'.map'),mapBytes);
}
const read=(root:string,path:string)=>readFileSync(join(root,path),'utf8');

describe('dedupeServerSourceMaps',()=>{
 it('points every copy of an identical map at the first one and keeps each chunk\'s code byte-for-byte',()=>{
  const root=build(),core=map('payroll');
  chunk(root,'server/chunks/_b._.js','module.exports=[1,"b"];',core);
  chunk(root,'server/chunks/_a._.js','module.exports=[1,"a"];',core);
  chunk(root,'server/chunks/17x1_@noble_c._.js','module.exports=[1,"c"];',core);
  const result=dedupeServerSourceMaps(root);
  // `17x1_@noble_c` sorts first, so its map is the one kept; its own chunk is untouched.
  expect(result.removed.map(path=>path.slice(root.length+1)).sort()).toEqual(['server/chunks/_a._.js.map','server/chunks/_b._.js.map']);
  expect(result.bytes).toBe(2*Buffer.byteLength(core));expect(result.skipped).toBe(0);
  expect(read(root,'server/chunks/17x1_@noble_c._.js')).toBe('module.exports=[1,"c"];\n\n//# sourceMappingURL=17x1_%40noble_c._.js.map');
  expect(read(root,'server/chunks/_a._.js')).toBe('module.exports=[1,"a"];\n\n//# sourceMappingURL=17x1_%40noble_c._.js.map');
  expect(read(root,'server/chunks/_b._.js')).toBe('module.exports=[1,"b"];\n\n//# sourceMappingURL=17x1_%40noble_c._.js.map');
  expect(read(root,'server/chunks/17x1_@noble_c._.js.map')).toBe(core);
  expect(existsSync(join(root,'server/chunks/_a._.js.map'))).toBe(false);
 });

 it('keeps maps that differ, maps in other directories and maps whose chunks do not name them',()=>{
  const root=build(),core=map('leave');
  chunk(root,'server/chunks/_a._.js','a();',core);
  chunk(root,'server/chunks/ssr/_a._.js','a();',core);
  chunk(root,'server/chunks/_other._.js','o();',map('attendance'));
  // An identical pair where one chunk names no map: the pair is left exactly as written.
  writeFileSync(join(root,'server/chunks/route.js'),'module.exports=R.m(1).exports\n');writeFileSync(join(root,'server/chunks/route.js.map'),map('read'));
  chunk(root,'server/chunks/page.js','p();',map('read'));
  const before=['server/chunks/_a._.js','server/chunks/ssr/_a._.js','server/chunks/route.js','server/chunks/page.js'].map(path=>read(root,path));
  const result=dedupeServerSourceMaps(root);
  expect(result.removed).toEqual([]);expect(result.skipped).toBe(2);
  expect(['server/chunks/_a._.js','server/chunks/ssr/_a._.js','server/chunks/route.js','server/chunks/page.js'].map(path=>read(root,path))).toEqual(before);
  for(const path of ['server/chunks/_a._.js.map','server/chunks/ssr/_a._.js.map','server/chunks/_other._.js.map','server/chunks/route.js.map','server/chunks/page.js.map'])
   expect(existsSync(join(root,path)),path).toBe(true);
 });

 it('touches nothing outside the server build and refuses symbolic links',()=>{
  const root=build(),core=map('claims');
  writeFileSync(join(root,'static/chunks/x.js'),'x();\n\n//# sourceMappingURL=x.js.map');writeFileSync(join(root,'static/chunks/x.js.map'),core);
  writeFileSync(join(root,'static/chunks/y.js'),'y();\n\n//# sourceMappingURL=y.js.map');writeFileSync(join(root,'static/chunks/y.js.map'),core);
  expect(dedupeServerSourceMaps(root).removed).toEqual([]);
  expect(existsSync(join(root,'static/chunks/y.js.map'))).toBe(true);
  symlinkSync(join(root,'static/chunks/x.js.map'),join(root,'server/chunks/link.js.map'));
  expect(()=>dedupeServerSourceMaps(root)).toThrow(/symbolic link/);
 });
});
