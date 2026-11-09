/** Checklist evidence belongs to the existing unit governance history, not a parallel review. */
export const REWARD_PREPARATION_STEPS = ['snapshot','data','excluded','senior','budget','applied'] as const;
export type RewardPreparationStep = typeof REWARD_PREPARATION_STEPS[number];
export type RewardPreparation = {
  version: 1;
  state: 'preparing' | 'released';
  expectedRelease: string | null;
  steps: Partial<Record<RewardPreparationStep, { basis: string; actorId: string; actorPersonId: string; at: string }>>;
  releasedBy: string | null;
  releasedByPersonId: string | null;
  releasedAt: string | null;
  releaseBasis: string | null;
  changeReason: string | null;
};
export const emptyRewardPreparation = (): RewardPreparation => ({version:1,state:'preparing',expectedRelease:null,steps:{},releasedBy:null,releasedByPersonId:null,releasedAt:null,releaseBasis:null,changeReason:null});

/** Changing any preparation input invalidates every confirmation, without deleting its audit history. */
export function rewardPreparationStatus(preparation: RewardPreparation, basis: string) {
  const missing = REWARD_PREPARATION_STEPS.filter(step => preparation.steps[step]?.basis !== basis);
  return { missing, ready: missing.length === 0, doers: [...new Set(Object.values(preparation.steps).map(proof => proof.actorId))] };
}
