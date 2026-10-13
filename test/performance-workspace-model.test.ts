import { describe,expect,it } from 'vitest';
import { defaultPolicy } from '../packs/performance/onehr/model';
import { leaderWorkspaceParts } from '../packs/performance/onehr/workspace-model';
import framework from '../packs/performance/onehr/framework.json';
const policy=defaultPolicy(framework),open={lockedAt:null,performanceLockedAt:null,potentialLockedAt:null};
describe('source leader workspace views',()=>{
 it('separates Dept and BU Performance/Potential parts and tracks independent locks',()=>{
  expect(leaderWorkspaceParts(policy,'hod',{...open,performanceLockedAt:'confirmed'})).toEqual([{stage:'department_review',axis:'performance',module:'cal',state:'done'},{stage:'department_potential_review',axis:'potential',module:'cal',state:'open'}]);
  expect(leaderWorkspaceParts(policy,'bu',open).map(p=>p.stage)).toEqual(['calibration','potential_calibration']);
 });
 it('keeps BG combined and Group performance-only without misclassifying them as employee PM',()=>{
  expect(leaderWorkspaceParts(policy,'bg',open)).toMatchObject([{module:'cal',stage:'talent_box',axis:'both'}]);
  expect(leaderWorkspaceParts(policy,'group',open)).toMatchObject([{module:'cal',axis:'performance'}]);
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,pm:false}},'group',open)).toEqual([]);
 });
 it('omits disabled axes and every leader part outside year end',()=>{
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,pm:false}},'bu',open)).toMatchObject([{axis:'potential'}]);
  expect(leaderWorkspaceParts({...policy,kind:'mid_year'},'hod',open)).toEqual([]);
  expect(leaderWorkspaceParts({...policy,modules:{...policy.modules,calibration:false}},'bg',open)).toEqual([]);
 });
});
