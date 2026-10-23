/** One form codec for both review policy and immutable shared versions. */
import {talents,policySchema,type RewardPolicy} from '@/packs/rewards/model';
export class RewardPolicyInputError extends Error {
 constructor(message:string){super(message);this.name='RewardPolicyInputError';}
}
const str=(f:FormData,key:string)=>String(f.get(key)??'').trim();
const number=(f:FormData,key:string)=>Number(str(f,key));
const scaled=(f:FormData,key:string,scale=100)=>str(f,key)===''?null:Math.round(number(f,key)*scale);
function lines(text: string, columns: number): string[][] {
  if (!text.trim()) return [];
  return text.split(/\r?\n/).filter(x => x.trim()).map(line => {
    const cells = line.split(',').map(x => x.trim());
    if (cells.length !== columns || !cells[0]) throw new RewardPolicyInputError(`Each row needs ${columns} comma-separated values.`);
    return cells;
  });
}
function matrix(text: string, columns: number, scale: number) {
  const result: Record<string, number[]> = {};
  for (const [key, ...values] of lines(text, columns)) {
    if (Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new RewardPolicyInputError('Grade or segment names must be unique.');
    result[key] = values.map(x => { const n = Number(x); if (!x || !Number.isFinite(n)) throw new RewardPolicyInputError('Enter a number in every matrix cell.'); return Math.round(n * scale); });
  }
  return result;
}
export function rewardPolicyFromForm(f:FormData,p:RewardPolicy):RewardPolicy{
    const meritMatrix = Object.fromEntries(talents.map(t => [t, [0, 1, 2].map(pos => Math.round(number(f, `merit.${t}.${pos}`) * 100))]));
    const branchRatings = Object.fromEntries(lines(str(f, 'branchRatings'), 2));
    return policySchema.parse({ ...p, effectiveFrom: str(f, 'effectiveFrom'), joinedBefore: str(f, 'joinedBefore'), confirmedBy: str(f, 'confirmedBy'), blockedFrom: str(f, 'blockedFrom'), blockedTo: str(f, 'blockedTo'),
      patActual: scaled(f, 'patActual'), patTarget: scaled(f, 'patTarget'), targetMonthsBp: scaled(f, 'targetMonths', 10000), multiplierBp: scaled(f, 'multiplier', 10000),
      standardPools: [0, 1, 2].map(i => Math.round(number(f, `standard.${i}`) * 100)), hPools: [0, 1, 2].map(i => Math.round(number(f, `h.${i}`) * 100)),
      meritMatrix, ranges: matrix(str(f, 'ranges'), 4, 100), bonusMatrix: matrix(str(f, 'bonusMatrix'), 6, 10000), bonusStructure: str(f, 'bonusStructure'),
      branchFactors: matrix(str(f, 'branchFactors'), 6, 10000), branchRatings,
      seniorGrades: p.seniorGrades,
      lumpStepCents: scaled(f, 'lumpStep'), lumpShareBp: scaled(f, 'lumpShare'), lumpCapCents: scaled(f, 'lumpCap'), exemptReason: str(f, 'exemptReason'),
    });
 }
