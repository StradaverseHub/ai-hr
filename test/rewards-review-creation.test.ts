import {describe,it,expect} from 'vitest';
import {rewardReviewInputIssues} from '../packs/rewards/review-creation';
const valid={year:2026,snapshotDate:'2026-11-04',today:'2026-11-04',cycleId:'',name:'Annual review'};
describe('Rewards server/form creation input readiness',()=>{
 it('accepts an existing named cycle without a new name and validates real snapshot dates',()=>{
  expect(rewardReviewInputIssues(valid)).toEqual([]);expect(rewardReviewInputIssues({...valid,cycleId:'existing',name:''})).toEqual([]);
  expect(rewardReviewInputIssues({...valid,snapshotDate:'2026-02-30'})).toEqual(['snapshotMissing']);expect(rewardReviewInputIssues({...valid,snapshotDate:'2026-11-05'})).toEqual(['snapshotFuture']);
 });
 it('reports every missing prerequisite without implying that manual policy defaults are forbidden',()=>{
  expect(rewardReviewInputIssues({...valid,year:1999,name:' ',snapshotDate:''})).toEqual(['year','snapshotMissing','cycleName']);
 });
});
