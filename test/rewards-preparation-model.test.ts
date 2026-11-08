import { describe, expect, it } from 'vitest';
import { emptyRewardPreparation, REWARD_PREPARATION_STEPS, rewardPreparationStatus } from '../packs/rewards/preparation-model';

describe('unit preparation evidence',()=>{
 it('requires every step to match the exact current preparation basis',()=>{
  const value=emptyRewardPreparation();
  expect(rewardPreparationStatus(value,'current').missing).toEqual([...REWARD_PREPARATION_STEPS]);
  for(const step of REWARD_PREPARATION_STEPS)value.steps[step]={basis:'current',actorId:'maker',actorPersonId:'person-maker',at:'2026-11-08T01:00:00Z'};
  expect(rewardPreparationStatus(value,'current')).toEqual({missing:[],ready:true,doers:['maker']});
  expect(rewardPreparationStatus(value,'changed').missing).toEqual([...REWARD_PREPARATION_STEPS]);
  expect(value.steps.snapshot?.basis).toBe('current'); // stale proof remains history, never relabelled
 });
 it('retains all contributors for the separate checker decision',()=>{
  const value=emptyRewardPreparation();value.steps.data={basis:'b',actorId:'maker-a',actorPersonId:'person-a',at:'2026-11-08T01:00:00Z'};
  value.steps.snapshot={basis:'b',actorId:'maker-b',actorPersonId:'person-b',at:'2026-11-08T01:01:00Z'};
  expect(rewardPreparationStatus(value,'b').doers.sort()).toEqual(['maker-a','maker-b']);
 });
});
