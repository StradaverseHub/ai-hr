import {it,expect} from 'vitest';
import {mobileRewardPersonBlock} from '../packs/rewards/mobile-review-projection';
import type {CalculatedEntry} from '../packs/rewards/engine';
it('senior confidentiality removes source pay, derived awards and money-bearing free text before serialization',()=>{
 const r={id:'synthetic',facts:{performance:'ME',talent:'SCORE',reviewed:true},source:{name:'Synthetic senior',employeeCode:'S1',grade:'21',basicCents:88776655},recommendation:{currentRoleSummary:'Private salary 887766',proposedRoleSummary:'Private bonus 998877',promotionGrade:'22',reason:'Private recommendation 776655'},meritCents:111122,promotionCents:222233,specialCents:333344,newBasicCents:99887766,bonusCents:77665544,lumpCents:66554433,incrementReason:'Eligible',bonusReason:'Eligible'} as CalculatedEntry;
 const hidden=JSON.stringify(mobileRewardPersonBlock(r,true));expect(hidden).toContain('Synthetic senior');expect(hidden).toContain('Handled separately');expect(hidden).not.toMatch(/887766|998877|776655|665544|111122|222233|333344|Private/);
 const visible=JSON.stringify(mobileRewardPersonBlock(r,false));expect(visible).toContain('Current basic');expect(visible).toContain('Private recommendation 776655');
});
