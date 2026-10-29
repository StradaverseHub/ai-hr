/** One form codec for both review policy and immutable shared versions. */
import {talents,policySchema,type RewardPolicy} from '@/packs/rewards/model';
import {policyGridIssues,parsePolicyGridText} from '@/packs/rewards/policy-grid-validation';
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
function inputMatrixRows(f:FormData,kind:'ranges'|'bonusMatrix'|'branchFactors'):string[][]{
 const raw=f.get(`policyGridData.${kind}`);
 if(raw===null){try{return parsePolicyGridText(kind,str(f,kind));}catch{throw new RewardPolicyInputError('Invalid policy grid columns.');}}
 if(typeof raw!=='string'||raw.length>200000)throw new RewardPolicyInputError('Invalid policy grid size.');
 let rows:unknown;try{rows=JSON.parse(raw);}catch{throw new RewardPolicyInputError('Invalid policy grid data.');}
 const width=kind==='ranges'?4:6;
 if(!Array.isArray(rows)||rows.length>200||rows.some(row=>!Array.isArray(row)||row.length!==width||row.some(cell=>typeof cell!=='string'||cell.length>1000)))throw new RewardPolicyInputError('Invalid policy grid columns.');
 return rows as string[][];
}
function matrix(rows:string[][],kind:'ranges'|'bonusMatrix'|'branchFactors'){
 const result:Record<string,number[]>={},scale=kind==='ranges'?100:10000;
 for(const [key,...values] of rows){
  if(kind==='ranges'&&key==='23')continue;
  if(Object.hasOwn(result,key)||['__proto__','constructor','prototype'].includes(key))throw new RewardPolicyInputError('Grade or segment names must be unique.');
  result[key]=values.map(value=>{const n=Number(value);if(!value||!Number.isFinite(n))throw new RewardPolicyInputError('Enter a number in every matrix cell.');return Math.round(n*scale);});
 }
 return result;
}
export function rewardPolicyFromForm(f:FormData,p:RewardPolicy,options:{context?:'shared'|'unit'}={}):RewardPolicy{
    const gridRows=Object.fromEntries((['ranges','bonusMatrix','branchFactors'] as const).map(kind=>[kind,inputMatrixRows(f,kind)])) as Record<'ranges'|'bonusMatrix'|'branchFactors',string[][]>;
    for(const kind of ['ranges','bonusMatrix','branchFactors'] as const){
      if(kind==='branchFactors'&&str(f,'bonusStructure')!=='branch')continue;
      if(policyGridIssues(kind,gridRows[kind]).length)throw new RewardPolicyInputError('Correct the highlighted policy grid cells.');
    }
    const meritMatrix = Object.fromEntries(talents.map(t => [t, [0, 1, 2].map(pos => Math.round(number(f, `merit.${t}.${pos}`) * 100))]));
    const shared=options.context==='shared';
    const eligibility=f.get('policyEligibilityVersion')==='1'?{activeAsOf:str(f,'activeAsOf'),minimumBonusRating:str(f,'minimumBonusRating'),excludeNotice:f.get('excludeNotice')==='on',excludeErCase:f.get('excludeErCase')==='on'}:{};
    const branchRatings = shared?{}:f.has('branchRatings')?Object.fromEntries(lines(str(f, 'branchRatings'), 2)):p.branchRatings;
    return policySchema.parse({ ...p,...eligibility, effectiveFrom: str(f, 'effectiveFrom'), joinedBefore: str(f, 'joinedBefore'), confirmedBy: str(f, 'confirmedBy'), blockedFrom: str(f, 'blockedFrom'), blockedTo: str(f, 'blockedTo'),
      patActual: shared?0:f.has('patActual')?scaled(f,'patActual'):p.patActual, patTarget:shared?100:f.has('patTarget')?scaled(f,'patTarget'):p.patTarget, targetMonthsBp:shared?0:f.has('targetMonths')?scaled(f,'targetMonths',10000):p.targetMonthsBp, multiplierBp:shared?null:f.has('multiplier')?scaled(f,'multiplier',10000):p.multiplierBp,
      standardPools: [0, 1, 2].map(i => Math.round(number(f, `standard.${i}`) * 100)), hPools: [0, 1, 2].map(i => Math.round(number(f, `h.${i}`) * 100)),
      meritMatrix, ranges:matrix(gridRows.ranges,'ranges'),bonusMatrix:matrix(gridRows.bonusMatrix,'bonusMatrix'), bonusStructure: str(f, 'bonusStructure'),
      branchFactors:matrix(gridRows.branchFactors,'branchFactors'), branchRatings,
      seniorGrades: p.seniorGrades,
      lumpStepCents: scaled(f, 'lumpStep'), lumpShareBp: scaled(f, 'lumpShare'), lumpCapCents: scaled(f, 'lumpCap'), exemptReason: shared?'':f.has('exemptReason')?str(f,'exemptReason'):p.exemptReason,
    });
 }
