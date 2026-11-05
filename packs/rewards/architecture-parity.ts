import type {RewardArchitectureSource,RewardFlag,RewardSource} from './model';
/** Historical snapshots without a mapping stay readable; UUIDs own grade identity. */
export function rewardArchitectureParity(source:Pick<RewardSource,'gradeId'|'architecture'>):'unknown'|'aligned'|'mismatch'{
 const mapping=source.architecture;
 if(!mapping)return 'unknown';
 return source.gradeId===mapping.gradeId?'aligned':'mismatch';
}
/** Advisory issue only: approved pay and grade movements remain separate decisions. */
export function rewardArchitectureFlags(entryId:string,source:Pick<RewardSource,'gradeId'|'architecture'>):RewardFlag[]{
 return rewardArchitectureParity(source)==='mismatch'?[{severity:'warning',code:'ARCH-01',message:'The employee grade differs from the approved position grade. Review the position mapping or propose a dated grade movement; this review keeps the recorded employee grade.',entryId}]:[];
}
export type {RewardArchitectureSource};
