import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {NATIVE_NODB_PROFILES,NATIVE_NODB_FILES,nativeNoDbFile,nativeNoDbUnitForId,nativeNoDbUnit,nativeNoDbProfile} from '../.github/ci/native-nodb-profiles.mjs';
import {CLASSIFIER_WITNESS_PROFILES} from '../.github/ci/diagnostics/classifier-witness-profile.mjs';
import {normalTestMatrices} from '../.github/ci/normal-test-matrices.mjs';
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const expectedUnits=()=>NATIVE_NODB_PROFILES.map((row:any)=>{const descriptor={version:1,profile:row.profile,workers:1,isolation:'job-host'};return{id:'nodb-'+hash({file:row.file,descriptor}).slice(0,16),kind:'nodb',files:[row.file],pdfTools:false,singleton:descriptor};});
const ordinary={id:'nodb-ordinary',kind:'nodb',files:['test/ordinary.test.ts'],pdfTools:false};
const next={id:'db-next',kind:'db',files:['test/runtime-next-admission-native.test.ts'],pdfTools:false,singleton:{version:1,profile:'linux-next-postgres-v1',workers:1,isolation:'job-host-and-postgres-cluster'}};
const browser={id:'browser-chromium',kind:'browser',engine:'chromium',files:['test/example.browser.test.tsx'],pdfTools:false};
describe('fixed normal five-selector metadata without execution or admission authority',()=>{
 it('owns exactly five immutable compiler/classifier rows and retains the actual shared classifier row identities',()=>{
  expect(NATIVE_NODB_PROFILES).toHaveLength(5);expect(new Set(NATIVE_NODB_FILES).size).toBe(5);expect(Object.isFrozen(NATIVE_NODB_PROFILES)&&NATIVE_NODB_PROFILES.every(Object.isFrozen)).toBe(true);
  expect(NATIVE_NODB_PROFILES.slice(2)).toEqual(CLASSIFIER_WITNESS_PROFILES);for(let i=0;i<3;i++)expect(NATIVE_NODB_PROFILES[i+2]).toBe(CLASSIFIER_WITNESS_PROFILES[i]);
  expect(NATIVE_NODB_PROFILES.map((row:any)=>[row.owner,row.purpose,row.job])).toEqual([['compiler','reference','test'],['compiler','application','test'],['classifier','semantic','classifier-semantic'],['classifier','cli-b','classifier-cli'],['classifier','cli-c','classifier-cli']]);
 });
 it('returns the entire exact deterministic normal unit shape rather than a profile hint',()=>{
  for(const unit of expectedUnits()){
   const actual=nativeNoDbUnitForId(unit.id);expect(actual).toEqual(unit);expect(nativeNoDbUnit(actual)).toBe(true);expect(nativeNoDbProfile(actual)).toBe(nativeNoDbFile(unit.files[0]));
   expect(Object.isFrozen(actual)&&Object.isFrozen(actual.files)&&Object.isFrozen(actual.singleton)).toBe(true);
  }
  expect(nativeNoDbUnitForId('nodb-foreign')).toBeUndefined();expect(nativeNoDbFile('test/unknown.test.ts')).toBeUndefined();expect(nativeNoDbUnit(ordinary)).toBe(false);
 });
 it('refuses every malformed owned file/profile intent including omitted files and coherent descriptor substitutions',()=>{
  for(const original of expectedUnits())for(const mutate of [(x:any)=>x.kind='db',(x:any)=>x.id='nodb-foreign',(x:any)=>x.files=[],(x:any)=>x.files.push('test/ordinary.test.ts'),(x:any)=>x.singleton.workers=2,(x:any)=>x.singleton.isolation='job-postgres-cluster',(x:any)=>x.singleton.version=2,(x:any)=>x.singleton.profile='linux-owned-unknown-v1',(x:any)=>x.pdfTools=true,(x:any)=>x.extra=true]){const bad=clone(original);mutate(bad);expect(()=>nativeNoDbUnit(bad)).toThrow();}
  expect(()=>nativeNoDbUnit({singleton:{profile:'linux-owned-unknown-v1'}})).toThrow();
  const omitted:any=clone(expectedUnits()[0]);delete omitted.files;delete omitted.singleton;expect(()=>nativeNoDbUnit(omitted)).toThrow();
 });
 it('partitions complete ordinary/nativeNext/semantic/CLI routes with their exact disjoint union and canonical names',()=>{
  const units=expectedUnits(),plan={units:[ordinary,...units,next,browser]},out=normalTestMatrices(plan);
  expect(out.test_matrix.include).toEqual([{unit:ordinary.id,employeeLifecycle:false},...units.slice(0,2).map((unit:any,i:number)=>({unit:unit.id,employeeLifecycle:false,nativeNoDb:true,purpose:i===0?'reference':'application'}))]);
  expect(out.native_matrix).toEqual({unit:[next.id]});expect(out.classifier_semantic_matrix).toEqual({unit:[units[2].id]});expect(out.classifier_cli_matrix).toEqual({unit:[units[3].id,units[4].id]});
  const all=[...out.test_matrix.include.map((row:any)=>row.unit),...out.native_matrix.unit,...out.classifier_semantic_matrix.unit,...out.classifier_cli_matrix.unit];expect(all.slice().sort()).toEqual(plan.units.filter(unit=>unit.kind!=='browser').map(unit=>unit.id).sort());expect(new Set(all).size).toBe(all.length);
  expect([out.has_tests,out.has_native,out.has_classifier_semantic,out.has_classifier_cli]).toEqual([true,true,true,true]);
 });
 it('requires the actual semantic companion for a CLI selection and never silently adds or omits selected units',()=>{
  const units=expectedUnits(),plan={units:[ordinary,...units,browser]};expect(()=>normalTestMatrices(plan,[units[3].id])).toThrow();
  const out=normalTestMatrices(plan,[units[2].id,units[4].id]);expect(out.classifier_semantic_matrix.unit).toEqual([units[2].id]);expect(out.classifier_cli_matrix.unit).toEqual([units[4].id]);expect(out.test_matrix.include).toEqual([]);expect(out.has_tests).toBe(false);expect(out.has_native).toBe(false);
 });
 it('preserves ordinary and nativeNext rows when none of the new source-only profiles is present',()=>{
  const out=normalTestMatrices({units:[ordinary,next,browser]});expect(out.test_matrix).toEqual({include:[{unit:ordinary.id,employeeLifecycle:false}]});expect(out.native_matrix).toEqual({unit:[next.id]});expect(out.has_classifier_semantic).toBe(false);expect(out.has_classifier_cli).toBe(false);
  expect(Object.isFrozen(out)&&Object.isFrozen(out.test_matrix)&&Object.isFrozen(out.test_matrix.include)&&out.test_matrix.include.every(Object.isFrozen)).toBe(true);
 });
 it('refuses duplicate, foreign, browser, excessive or unknown-kind matrix selections and plans',()=>{
  for(const selected of [[],[ordinary.id,ordinary.id],['foreign'],[browser.id]])expect(()=>normalTestMatrices({units:[ordinary,browser]},selected)).toThrow();
  for(const units of [[],[ordinary,ordinary],Array.from({length:257},(_,i)=>({...ordinary,id:'unit-'+i})),[{...ordinary,kind:'unknown'}]])expect(()=>normalTestMatrices({units})).toThrow();
 });
 it('refuses a malformed owned capability even if a selection tries to hide it among omitted source units',()=>{
  const unit=clone(expectedUnits()[0]);unit.singleton.workers=2;expect(()=>normalTestMatrices({units:[ordinary,unit,browser]},[ordinary.id])).toThrow();
 });
 it('refuses compiler and classifier reserved intent disguised as browser before an ordinary-only selection',()=>{
  for(const original of expectedUnits()){
   const bad={...clone(original),kind:'browser'};expect(()=>normalTestMatrices({units:[ordinary,bad,browser]},[ordinary.id])).toThrow();
   expect(()=>normalTestMatrices({units:[ordinary,bad,browser]})).toThrow();
  }
  const out=normalTestMatrices({units:[ordinary,browser]},[ordinary.id]);expect(out.test_matrix.include).toEqual([{unit:ordinary.id,employeeLifecycle:false}]);
 });
});
