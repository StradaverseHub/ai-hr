/** Intended reachability rules, exercised against the actual exported owner. */
import {expect,it} from 'vitest';
import {classifyTestFiles,type Reader} from '../scripts/gate-db-classify';

const spell=(source:string)=>source.replace(/\bIMP\b/g,'imp'+'ort');
const tree=(files:Record<string,string>):Reader=>name=>Object.hasOwn(files,name)?spell(files[name]):null;
const two=['test/a.test.ts','test/b.test.ts'];
const three=[...two,'test/c.test.ts'];
const rotations=(files:string[])=>files.map((_,index)=>files.slice(index).concat(files.slice(0,index)));

it('classifies every cycle member that reaches a driver in either root order',()=>{
 const read=tree({
  [two[0]]:"IMP './b.test'; IMP 'postgres';",
  [two[1]]:"IMP './a.test';",
 });
 for(const order of rotations(two)){
  const actual=classifyTestFiles(order,read);
  expect(actual.db).toEqual(order);expect(actual.nodb).toEqual([]);
 }
});

it('does not cache a provisional clean result before a later missing, opaque or text hazard in a longer cycle',()=>{
 for(const hazard of ["IMP './missing';",'const moduleName="known"; IMP(moduleName);','process.env.DATA'+'BASE_URL']){
  const read=tree({[three[0]]:"IMP './b.test'; "+hazard,[three[1]]:"IMP './c.test';",[three[2]]:"IMP './a.test';"});
  for(const order of rotations(three)){
   const actual=classifyTestFiles(order,read);
   expect(actual.db).toEqual(order);expect(actual.nodb).toEqual([]);
  }
 }
});

it('keeps a complete hazard-free cycle clean in every root order',()=>{
 const read=tree({[three[0]]:"IMP './b.test';",[three[1]]:"IMP './c.test';",[three[2]]:"IMP './a.test';"});
 for(const order of rotations(three)){
  const actual=classifyTestFiles(order,read);
  expect(actual.db).toEqual([]);expect(actual.nodb).toEqual(order);
 }
});

it('does not reuse an earlier request verdict when the same reader has a new source image',()=>{
 const files={[two[0]]:"IMP './b.test';",[two[1]]:'export const value=1;'},read=tree(files);
 expect(classifyTestFiles(two,read).nodb).toEqual(two);
 files[two[1]]="IMP 'postgres';";
 const actual=classifyTestFiles(two,read);expect(actual.db).toEqual(two);expect(actual.nodb).toEqual([]);
});
