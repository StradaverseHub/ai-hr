/** Typed configuration values; integer cents and basis points remain deterministic domain facts. */
import {z} from 'zod';
import {ARCHITECTURE_GRADES,architectureGrade,type ArchitectureGrade} from '../job-architecture/model';
import {performances,type RewardPolicy} from './model';
export const setupUuid=z.uuid();
export const setupYear=z.number().int().min(2000).max(2200);
export const setupReason=z.string().trim().min(10).max(4000);
const cents=z.number().int().min(0).max(100_000_000_000);
const signedCents=z.number().int().min(-100_000_000_000).max(100_000_000_000);
const months=z.number().int().min(0).max(100_000).refine(n=>n%100===0,'Use no more than two decimal places.');
export const salaryRowSchema=z.object({gradeId:setupUuid,grade:z.enum(ARCHITECTURE_GRADES),minimumCents:cents.nullable(),midpointCents:cents.nullable(),maximumCents:cents.nullable()}).strict();
export type SalaryLibraryRow=z.infer<typeof salaryRowSchema>;
export const bonusRowSchema=z.object({gradeId:setupUuid,grade:z.enum(ARCHITECTURE_GRADES),months:z.tuple([months,months,months,months,months])}).strict();
export const bonusSegmentSchema=z.object({name:z.string().trim().min(1).max(80),factors:z.tuple([months,months,months,months,months])}).strict();
export type BonusLibraryRow=z.infer<typeof bonusRowSchema>;
export type BonusLibrarySegment=z.infer<typeof bonusSegmentSchema>;
export const salaryLibrarySchema=z.object({kind:z.literal('salary'),rows:z.array(salaryRowSchema).length(13)}).strict();
export const bonusLibrarySchema=z.object({kind:z.literal('bonus'),type:z.enum(['standard','branch']),rows:z.array(bonusRowSchema).length(13),segments:z.array(bonusSegmentSchema).max(100)}).strict();
export type SalaryLibrary=z.infer<typeof salaryLibrarySchema>;
export type BonusLibrary=z.infer<typeof bonusLibrarySchema>;
export type RewardLibrary=SalaryLibrary|BonusLibrary;
export class RewardSetupError extends Error{constructor(public code:'invalid'|'forbidden'|'changed'|'independent'|'locked'|'missing',message:string){super(message);this.name='RewardSetupError';}}
export function validateRewardLibrary(raw:unknown):RewardLibrary{
 const p=z.discriminatedUnion('kind',[salaryLibrarySchema,bonusLibrarySchema]).parse(raw);
 if(new Set(p.rows.map(r=>r.grade)).size!==13||new Set(p.rows.map(r=>r.gradeId)).size!==13)throw new RewardSetupError('invalid','Include each active grade exactly once.');
 for(const g of ARCHITECTURE_GRADES)if(!p.rows.some(r=>r.grade===g))throw new RewardSetupError('invalid','An active grade is missing.');
 if(p.kind==='salary')for(const r of p.rows){if(r.grade==='23'){if(r.minimumCents!==null||r.midpointCents!==null||r.maximumCents!==null)throw new RewardSetupError('invalid','JG 23 has no salary range.');}
  else if(r.minimumCents===null||r.midpointCents===null||r.maximumCents===null||r.minimumCents<=0||r.minimumCents>=r.midpointCents||r.midpointCents>=r.maximumCents)throw new RewardSetupError('invalid',`Grade ${r.grade}: Minimum must be lower than Midpoint, and Midpoint lower than Maximum.`);}
 else{
  for(const r of p.rows){if(r.months[0]!==0||r.months.some((m,i)=>i>0&&m<r.months[i-1]))throw new RewardSetupError('invalid',`Grade ${r.grade}: UA must be zero and months must rise from UA to OU.`);}
  if(p.type==='standard'&&p.segments.length||p.type==='branch'&&!p.segments.length)throw new RewardSetupError('invalid','Branch matrices need segment factors; standard matrices do not.');
  if(new Set(p.segments.map(r=>r.name)).size!==p.segments.length)throw new RewardSetupError('invalid','Each segment must be listed once.');
  for(const r of p.segments)if(r.factors[0]!==0)throw new RewardSetupError('invalid',`${r.name}: UA factor must be zero.`);
 }
 return p;
}
export function libraryPolicyProjection(salary:SalaryLibrary,bonus:BonusLibrary):Pick<RewardPolicy,'ranges'|'bonusMatrix'|'bonusStructure'|'branchFactors'>{
 return{ranges:Object.fromEntries(salary.rows.flatMap(r=>r.grade==='23'?[]:[[r.grade,[r.minimumCents!,r.midpointCents!,r.maximumCents!] as [number,number,number]]])),bonusMatrix:Object.fromEntries(bonus.rows.map(r=>[r.grade,r.months])),bonusStructure:bonus.type,branchFactors:Object.fromEntries(bonus.segments.map(s=>[s.name,s.factors]))};
}
export const patInputSchema=z.object({targetCents:signedCents.nullable(),forecastCents:signedCents.nullable(),actualCents:signedCents.nullable(),targetMonthsBp:months}).strict().superRefine((p,ctx)=>{
 if(p.targetCents!==null&&p.targetCents<=0)ctx.addIssue({code:'custom',path:['targetCents'],message:'Target PAT must be positive.'});
 if((p.actualCents!==null||p.forecastCents!==null)&&p.targetCents===null)ctx.addIssue({code:'custom',path:['targetCents'],message:'Enter a Target PAT before a forecast or Actual PAT.'});
});
export type PatInput=z.infer<typeof patInputSchema>;
export type PatStatus='not-set'|'provisional'|'final';
export function patProjection(p:PatInput){
 const numerator=p.actualCents??p.forecastCents,status:PatStatus=p.targetCents===null||numerator===null?'not-set':p.actualCents!==null?'final':'provisional';
 const achievementBp=status==='not-set'?null:Number(BigInt(numerator!)*BigInt(10000)/BigInt(p.targetCents!));
 return{status,achievementBp,targetMonthsBp:p.targetMonthsBp};
}
export function patPoolCents(p:PatInput,eligibleMonthlyPayrollCents:number):number{
 const value=patInputSchema.parse(p);cents.parse(eligibleMonthlyPayrollCents);const basis=value.actualCents??value.forecastCents;
 if(value.targetCents===null||basis===null)return 0;
 const result=Number((BigInt(eligibleMonthlyPayrollCents)*BigInt(Math.max(0,basis))/BigInt(value.targetCents))*BigInt(value.targetMonthsBp)/BigInt(10000));if(!Number.isSafeInteger(result))throw new RewardSetupError('invalid','The calculated pool exceeds the supported amount.');return result;
}
export function patSubtotal(rows:readonly PatInput[]){const sum=(key:'targetCents'|'actualCents'|'forecastCents')=>!rows.length||rows.some(r=>r[key]===null)?null:rows.reduce((n,r)=>n+(r[key]??0),0);const targetCents=sum('targetCents'),actualCents=sum('actualCents'),forecastCents=sum('forecastCents');return{targetCents,actualCents,forecastCents,achievementBp:targetCents&&targetCents>0&&(actualCents!==null||forecastCents!==null)?Number(BigInt(actualCents??forecastCents!)*BigInt(10000)/BigInt(targetCents)):null};}
export function decimalToCents(raw:string,allowNegative=false):number|null{
 const s=raw.trim();if(!s)return null;const pattern=allowNegative?/^-?\d{1,10}(?:\.\d{1,2})?$/:/^\d{1,10}(?:\.\d{1,2})?$/;
 if(!pattern.test(s))throw new RewardSetupError('invalid','Enter a valid amount with no more than two decimal places.');
 const sign=s.startsWith('-')?-1:1,[whole,fraction='']=s.replace(/^-/,'').split('.');const n=sign*(Number(whole)*100+Number(fraction.padEnd(2,'0')));signedCents.parse(n);return n;
}
export function decimalToMonths(raw:string):number{const cents=decimalToCents(raw);if(cents===null)throw new RewardSetupError('invalid','Enter target bonus months.');return months.parse(cents*100);}
export type LibraryCandidate={id:string;libraryId:string;name:string;year:number;version:number;kind:'salary'|'bonus';tags:string[];groupDefault:boolean;type?:'standard'|'branch';previousLibraryId?:string|null};
export type LibrarySuggestion={candidate:LibraryCandidate|null;reason:'previous-year'|'business-unit'|'group-default'|'multiple-matches'|'none'};
export function suggestRewardLibrary(candidates:readonly LibraryCandidate[],p:{kind:'salary'|'bonus';year:number;businessUnit:string;previousLibraryId:string|null;branchAllowed:boolean}):LibrarySuggestion{
 const current=candidates.filter(c=>c.kind===p.kind&&c.year===p.year&&(c.type!=='branch'||p.branchAllowed));
 const groups=[{reason:'previous-year' as const,rows:current.filter(c=>p.previousLibraryId&&(c.libraryId===p.previousLibraryId||c.previousLibraryId===p.previousLibraryId))},{reason:'business-unit' as const,rows:current.filter(c=>p.businessUnit&&c.tags.some(t=>t.toLocaleLowerCase()===p.businessUnit.toLocaleLowerCase()))},{reason:'group-default' as const,rows:current.filter(c=>c.groupDefault)}];
 for(const g of groups){const map=new Map<string,LibraryCandidate>();for(const c of g.rows.sort((a,b)=>b.version-a.version))if(!map.has(c.libraryId))map.set(c.libraryId,c);const latest=[...map.values()];if(latest.length===1)return{candidate:latest[0],reason:g.reason};if(latest.length>1)return{candidate:null,reason:'multiple-matches'};}
 return{candidate:null,reason:'none'};
}
export function gradeCodeForLibrary(raw:string):ArchitectureGrade{const g=architectureGrade(raw);if(!g)throw new RewardSetupError('invalid','Choose an active Grade Ladder grade.');return g;}
export const BONUS_COLUMNS=performances;
/** An explicit editable reconciliation preview; incomplete historical grids are never auto-filled. */
export function legacyLibraryDraft(kind:'salary'|'bonus',policy:RewardPolicy,grades:readonly {gradeId:string;grade:string}[]):RewardLibrary{
 if(kind==='salary')return{kind,rows:grades.map(g=>{const grade=gradeCodeForLibrary(g.grade),values=grade==='23'?null:policy.ranges[grade];return{gradeId:g.gradeId,grade,minimumCents:values?.[0]??null,midpointCents:values?.[1]??null,maximumCents:values?.[2]??null};})};
 return{kind,type:policy.bonusStructure,rows:grades.flatMap(g=>{const grade=gradeCodeForLibrary(g.grade),months=policy.bonusMatrix[grade];return months?[{gradeId:g.gradeId,grade,months}]:[];}),segments:policy.bonusStructure==='branch'?Object.entries(policy.branchFactors).map(([name,factors])=>({name,factors})):[]};
}
