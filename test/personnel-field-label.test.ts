import {describe,it,expect} from 'vitest';
import {personnelFieldLabel} from '../lib/personnel-field-label';
import {PERSONNEL_FIELDS,type PersonnelFieldDescriptor} from '../lib/personnel-field-registry';
describe('shared Personnel business field labels',()=>{
 it('composes category/share labels and uses the full canonical fallback once if a part is unavailable',()=>{
  const field={...PERSONNEL_FIELDS[0],label:'Under 18 — 100%',labelParts:['category','share']} as PersonnelFieldDescriptor;
  expect(personnelFieldLabel(field,(key,fallback)=>(({category:'未满18岁',share:'100%'} as Record<string,string>)[key]??fallback))).toBe('未满18岁 — 100%');
  expect(personnelFieldLabel(field,(key,fallback)=>key==='category'?'Under 18':fallback)).toBe('Under 18 — 100%');expect(personnelFieldLabel(field)).toBe('Under 18 — 100%');
 });
 it('distinguishes compound value/unit once, including untranslated fallback headers',()=>{
  const field={...PERSONNEL_FIELDS[0],labelKey:'probation',label:'Probation — Unit',import:{...PERSONNEL_FIELDS[0].import,qualifier:'unit'}} as PersonnelFieldDescriptor;
  expect(personnelFieldLabel(field)).toBe('Probation — Unit');expect(personnelFieldLabel(field,(_key,fallback)=>fallback)).toBe('Probation — Unit');expect(personnelFieldLabel(field,(key,fallback)=>(({probation:'Percubaan','people.import.fieldUnit':'Unit'} as Record<string,string>)[key]??fallback))).toBe('Percubaan — Unit');
 });
});
