import {describe,it,expect} from 'vitest';
import {rewardArchitectureParity,rewardArchitectureFlags,type RewardArchitectureSource} from '../packs/rewards/architecture-parity';
const mapping:RewardArchitectureSource={positionId:'position',mappingRevision:3,catalogueRevision:5,jobUnitId:'job-unit',jobUnitTitle:'Financial Analyst',classification:['Finance','Accounting','Analysis'],gradeId:'approved-grade',gradeCode:'12'};
describe('Rewards approved position parity',()=>{
 it('preserves historical sources without treating missing mapping as alignment',()=>{expect(rewardArchitectureParity({gradeId:'historical'})).toBe('unknown');expect(rewardArchitectureFlags('entry',{gradeId:'historical'})).toEqual([]);});
 it('compares the preserved employee identity to the approved mapping identity',()=>{expect(rewardArchitectureParity({gradeId:mapping.gradeId,architecture:mapping})).toBe('aligned');expect(rewardArchitectureFlags('entry',{gradeId:mapping.gradeId,architecture:mapping})).toEqual([]);});
 it('warns without mutating either grade or approved mapping, even when display codes could match',()=>{const source={gradeId:'different-grade-identity',architecture:structuredClone(mapping)},before=structuredClone(source);expect(rewardArchitectureFlags('entry',source)).toEqual([{severity:'warning',code:'ARCH-01',entryId:'entry',message:expect.any(String)}]);expect(source).toEqual(before);expect(rewardArchitectureParity({gradeId:null,architecture:mapping})).toBe('mismatch');});
});
