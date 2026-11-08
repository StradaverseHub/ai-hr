import {describe,it,expect} from 'vitest';
import {rewardDashboardPreference,rewardSalaryDisplay} from '../packs/rewards/dashboard-model';
const units=[{id:'permitted',roles:['bu']}];
describe('Rewards dashboard presentation',()=>{
 it('intersects saved scope with live seats and never gives ordinary reviewers All',()=>{
  for(const scope of ['removed','all'])expect(rewardDashboardPreference({scope,period:'annual'},units)).toEqual({scope:'permitted',period:'annual'});
  expect(rewardDashboardPreference({scope:'all'},[{id:'a',roles:['gr']},{id:'b',roles:['ec']}]).scope).toBe('all');
  expect(rewardDashboardPreference({scope:'all'},[]).scope).toBe('');
 });
 it('annualizes recurring salary with checked arithmetic',()=>{
  expect(rewardSalaryDisplay(12345,'monthly')).toBe(12345);expect(rewardSalaryDisplay(12345,'annual')).toBe(148140);
  expect(()=>rewardSalaryDisplay(Number.MAX_SAFE_INTEGER,'annual')).toThrow();
 });
});
