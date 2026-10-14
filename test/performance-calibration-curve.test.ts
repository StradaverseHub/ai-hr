import { expect,it } from 'vitest';
import golden from './fixtures/onehr/calibration-curve-golden.json';
import framework from '../packs/performance/onehr/framework.json';
import { defaultPolicy,type PMBand,type PotentialBand } from '../packs/performance/onehr/model';
import { calibrationDistribution,profitAchievementText,profitCurveFor } from '../packs/performance/onehr/calibration-curve-model';
it('uses the unit figure before the consolidated BG figure and treats a missing figure as unentered',()=>{
 expect(profitCurveFor('unit','group',[{companyId:'unit',achievementPct:0,revision:2},{companyId:'group',achievementPct:150,revision:3}])).toMatchObject({key:'negative',source:'company',achievementPct:0,entered:true,revision:2});
 expect(profitCurveFor('unit','group',[{companyId:'unit',achievementPct:null,revision:4},{companyId:'group',achievementPct:150,revision:3}])).toMatchObject({key:'positive',source:'bg',achievementPct:150,entered:true,revision:3});
 expect(profitCurveFor('unit','group',[])).toMatchObject({key:'normal',source:null,achievementPct:null,entered:false,revision:null});
});
it('matches isolated source profit boundaries and display rounding without selecting a curve from the rounded label',()=>{
 for(const sample of golden.figures){const figures=sample.pct==null?[]:[{companyId:'unit',achievementPct:sample.pct,revision:1}];expect(profitCurveFor('unit',null,figures).key).toBe(sample.key);expect(profitAchievementText(sample.pct)).toBe(sample.text);}
 expect(profitAchievementText(69.999999999)).toBe('70%');expect(profitCurveFor('unit',null,[{companyId:'unit',achievementPct:69.999999999,revision:1}]).key).toBe('negative');
});
it('matches source expected headcounts and gaps for small, empty and larger populations on both axes',()=>{
 const policy=defaultPolicy(framework);
 for(const sample of golden.distributions){
  const axis=sample.axis as 'performance'|'potential',rows:{performance:PMBand|null;potential:PotentialBand|null}[]=[];
  for(const [band,count] of Object.entries(sample.counts))for(let i=0;i<count!;i++)rows.push(axis==='performance'?{performance:band as PMBand,potential:null}:{performance:null,potential:band as PotentialBand});
  const result=calibrationDistribution(rows,axis,policy,axis==='performance'?sample.target as Record<PMBand,number>:null);
  expect(Object.fromEntries(result.rows.map(row=>[row.band,row.gap]))).toEqual(sample.gaps);
  expect(result.rows.every(row=>row.targetCount===row.count+row.gap!)).toBe(true);
 }
});
it('uses the source browser percentage rounding independently of the server headcount rounding',()=>{
 const policy=defaultPolicy(framework),rows=Array.from({length:40},(_,index)=>({performance:index===0?'UA' as const:'ME' as const,potential:null}));
 expect(calibrationDistribution(rows,'performance',policy,{UA:5,BE:10,ME:70,AE:10,OU:5}).rows.find(row=>row.band==='UA')?.actualPct).toBe(3);
});
