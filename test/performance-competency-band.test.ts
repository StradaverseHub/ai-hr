import {expect,it} from 'vitest';
import {competencyBand} from '../packs/performance/onehr/competency-band';
import type {Statement} from '../packs/performance/onehr/model';
const rows:Statement[]=[{id:'current',principle:'Service',text:'Deliver',future:false},{id:'next',principle:'Service',text:'Lead',future:true}],policy={lowMaxPct:40,midMaxPct:26/35*100};
it('matches source current/next weighting and inclusive cycle cutoffs without any 360 input',()=>{
 expect(competencyBand(rows,{current:'yes',next:'no'},policy,true)).toBe('Low');
 expect(competencyBand(rows,{current:'no',next:'yes'},policy,true)).toBe('Mid');
 expect(competencyBand(rows,{current:'yes',next:'yes'},policy,true)).toBe('High');
 expect(competencyBand(rows,{current:'no',next:'no'},policy,true)).toBe('Low');
 expect(competencyBand(rows,{current:'no',next:'yes'},{lowMaxPct:30,midMaxPct:60},true)).toBe('Mid');
 expect(competencyBand(rows,{current:'no',next:'yes'},{lowMaxPct:30,midMaxPct:59},true)).toBe('High');
});
it('uses the source fallback boundaries only when no leadership framework is assigned',()=>{
 expect(competencyBand(rows,{current:'yes',next:'no'},policy,false)).toBe('Mid');
 const four=Array.from({length:4},(_,i)=>({...rows[0],id:String(i)}));
 expect(competencyBand(four,{'0':'yes','1':'yes','2':'yes','3':'no'},policy,false)).toBe('High');
 expect(competencyBand(rows,{current:'',next:'yes'},policy,true)).toBeNull();expect(competencyBand([],{},policy,true)).toBeNull();
});
