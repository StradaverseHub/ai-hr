import { z } from 'zod';

/** Native translation of OneHR a644fd6. These are assessment rules, never pay rules. */
export const pmBands = ['UA', 'BE', 'ME', 'AE', 'OU'] as const;
export const potentialBands = ['Low', 'Mid', 'High'] as const;
export type PMBand = typeof pmBands[number];
export type PotentialBand = typeof potentialBands[number];
export type Talent = 'PIP/Improvement' | 'Solid Core' | 'Star' | 'Super Star';
export const windowCells = ['pm_setting','pm_setting_approve','pm_results','pm_approve','tc_self','tc_approve','f360','idp_self','idp_review','pm_hod','pot_hod','pm_buceo','pot_buceo','tb_bgceo'] as const;
export type WindowCell = typeof windowCells[number];
const finite = z.number().finite();
const text = z.string().trim().max(4000);
const answer = z.enum(['yes','no']);
export const statementSchema = z.object({ id: z.string().min(1).max(100), principle: z.string().min(1).max(200), text: z.string().min(1).max(2000), future: z.boolean() });
export type Statement = z.infer<typeof statementSchema>;
const scoringSchema = z.discriminatedUnion('mechanism', [
  z.object({ mechanism: z.literal('A'), method: z.enum(['more','less']), rates: z.tuple([finite,finite,finite,finite,finite]) }).superRefine((v,c)=>{if(v.rates.some((n,i)=>i>0&&(v.method==='more'?n<v.rates[i-1]:n>v.rates[i-1])))c.addIssue({code:'custom',message:'Rate thresholds must follow the direction of the KPI.'});}),
  z.object({ mechanism: z.literal('B'), method: z.enum(['more','less']), variant: z.enum(['base','excellence']), threshold: finite, target: finite.refine(n=>n!==0,'Target cannot be zero.'), multiple: finite.min(0).max(10000), excellence: finite.nullable() }).superRefine((v,c)=>{if(v.variant==='excellence'&&v.excellence==null)c.addIssue({code:'custom',message:'An excellence value is required.'});}),
]);
export type Scoring = z.infer<typeof scoringSchema>;
export const kpiSchema = z.object({ id:z.uuid(), title:z.string().trim().min(1).max(300), description:text, weightBp:z.number().int().min(1).max(10000), unit:z.string().max(80), scoring:scoringSchema, moderatorEmploymentId:z.uuid().nullable(), approvalChain:z.array(z.object({employmentId:z.uuid(),actual:finite.nullable(),remark:text,at:z.iso.datetime().nullable()})).max(10).optional(), setting:z.enum(['draft','proposed','approved','returned']), settingRemark:text, actual:finite.nullable(), note:text, approvedActual:finite.nullable(), moderationRemark:text, locked:z.boolean() });
export type KPI = z.infer<typeof kpiSchema>;
export function pendingKpiApprover(k:KPI):string|null {return k.locked?null:k.approvalChain?.length?k.approvalChain.find(s=>!s.at)?.employmentId??null:k.moderatorEmploymentId;}
export function kpiApprovers(k:KPI):string[]{return k.approvalChain?.length?k.approvalChain.map(s=>s.employmentId):k.moderatorEmploymentId?[k.moderatorEmploymentId]:[];}
export const competencySchema = z.object({ ...statementSchema.shape, self:answer.nullable(), manager:answer.nullable(), managerRemark:text });
export type Competency = z.infer<typeof competencySchema>;
export const policySchema = z.object({
  extremes:z.object({enabled:z.boolean(),bonus:z.number().finite().min(0).max(1000),penalty:z.number().finite().min(0).max(1000)}).default({enabled:false,bonus:5,penalty:5}),
  version:z.literal(1), kind:z.enum(['mid_year','year_end','quarterly']),
  modules:z.object({pm:z.boolean(),tm:z.boolean(),idp:z.boolean(),evidence:z.boolean()}),
  windows:z.partialRecord(z.enum(windowCells),z.object({opensAt:z.iso.datetime({offset:true}).nullable(),closesAt:z.iso.datetime({offset:true}).nullable()}).refine(w=>!w.opensAt||!w.closesAt||Date.parse(w.opensAt)<Date.parse(w.closesAt),'The window must close after it opens.')),
  aBands:z.tuple([finite,finite,finite,finite,finite]),
  bBands:z.array(z.object({companyId:z.uuid(),minima:z.tuple([finite,finite,finite,finite,finite])})).max(200),
  lowMaxPct:finite.min(0).max(100),midMaxPct:finite.min(0).max(100),minValid:z.number().int().min(1).max(30),
  weights:z.record(z.string().min(1).max(30),z.number().int().min(0).max(10000)), // 360 basis points; rest is competency
  framework:z.array(z.object({gradeMin:z.number().int(),gradeMax:z.number().int(),letters:z.array(z.string().min(1).max(30)),statements:z.array(statementSchema).min(1).max(200)})).min(1).max(30),
  profiles:z.array(z.object({id:z.uuid(),name:z.string().min(1).max(300),companyId:z.uuid().nullable(),grade:z.string().max(30),employmentIds:z.array(z.uuid()).max(10000).optional(),competencies:z.array(statementSchema).min(1).max(200)})).max(1000),
  idpMinGoals:z.number().int().min(1).max(30), idpRequireAllActions:z.boolean(),
  curveTolerancePct:finite.min(0).max(100),curveTolerancePeople:z.number().int().min(0).max(100),curveStrict:z.boolean(),
}).superRefine((v,c)=>{
  if(v.lowMaxPct>=v.midMaxPct)c.addIssue({code:'custom',message:'Potential cutoffs must increase.'});
  for(const minima of [v.aBands,...v.bBands.map(b=>b.minima)])if(minima.some((n,i)=>i>0&&n<=minima[i-1]))c.addIssue({code:'custom',message:'Performance band cutoffs must increase.'});
  if(new Set(v.bBands.map(b=>b.companyId)).size!==v.bBands.length)c.addIssue({code:'custom',message:'Configure one achievement scale per company.'});
  if(new Set(v.profiles.map(p=>p.id)).size!==v.profiles.length)c.addIssue({code:'custom',message:'Profile IDs must be unique.'});
  for(const p of v.profiles)if(new Set(p.competencies.map(s=>s.id)).size!==p.competencies.length)c.addIssue({code:'custom',message:'A profile contains duplicate competency IDs.'});
  for(const tier of v.framework)if(new Set(tier.statements.map(s=>s.id)).size!==tier.statements.length)c.addIssue({code:'custom',message:'A framework contains duplicate statement IDs.'});
});
export type Policy = z.infer<typeof policySchema>;
export function defaultPolicy(framework: Policy['framework']):Policy {
  return {extremes:{enabled:false,bonus:5,penalty:5},version:1,kind:'year_end',modules:{pm:true,tm:true,idp:true,evidence:false},windows:{},aBands:[1,1.51,2.51,3.51,4.51],bBands:[],lowMaxPct:40,midMaxPct:26/35*100,minValid:4,weights:Object.fromEntries([...Array.from({length:12},(_,i)=>String(i+12)),'H'].map(g=>[g,4000])),framework,profiles:[],idpMinGoals:1,idpRequireAllActions:false,curveTolerancePct:10,curveTolerancePeople:1,curveStrict:false};
}
export function assertWindow(policy:Policy,cell:WindowCell,now=new Date()):void {
  const w=policy.windows[cell]; if(w?.opensAt&&now.getTime()<Date.parse(w.opensAt))throw Error('This step has not opened yet.');
  if(w?.closesAt&&now.getTime()>=Date.parse(w.closesAt))throw Error('This step is closed.');
}
export function frameworkFor(policy:Policy,grade:string):Statement[] {
  const g=grade.replace(/^JG\s*/i,'').trim();const n=/^\d+$/.test(g)?Number(g):null;
  let matches=policy.framework.filter(t=>n==null?t.letters.includes(g):n>=t.gradeMin&&n<=t.gradeMax);
  if(n==null&&!matches.length&&g)matches=policy.framework.filter(t=>t.letters.includes('*'));
  if(matches.length!==1)throw Error('Assign exactly one leadership framework for this grade.');return matches[0].statements;
}
export function scoreKPI(actual:number,s:Scoring):number {
  if(!Number.isFinite(actual))throw Error('A result must be a finite number.');
  if(s.mechanism==='A'){let rating=1;s.rates.forEach((t,i)=>{if(s.method==='more'?actual>=t:actual<=t)rating=i+1;});return rating;}
  if(s.method==='more'?actual<=s.threshold:actual>=s.threshold)return 0;
  const raw=s.method==='more'?actual/s.target*100:(2-actual/s.target)*100;
  if(s.variant==='excellence'){if(s.excellence==null)throw Error('An excellence value is required.');return Math.min(raw,s.method==='more'?s.excellence/s.target*100:(2-s.excellence/s.target)*100);}
  return raw<=100?raw:100+(raw-100)*s.multiple/100;
}
export function bandFor(value:number|null,minima:readonly number[]):PMBand|null {if(value==null)return null;let result:PMBand|null=null;minima.forEach((n,i)=>{if(value>=n)result=pmBands[i];});return result;}
export function scorecard(kpis:KPI[],policy:Policy,companyId:string,manager:boolean):{score:number|null;band:PMBand|null} {
  if(!kpis.length||kpis.some(k=>manager?!k.locked:k.actual==null))return {score:null,band:null};
  if(new Set(kpis.map(k=>k.scoring.mechanism)).size!==1)throw Error('A scorecard must use one scoring mechanism.');
  const total=kpis.reduce((n,k)=>n+k.weightBp,0);const score=kpis.reduce((n,k)=>n+scoreKPI((manager?k.approvedActual:k.actual)!,k.scoring)*k.weightBp,0)/total;
  const minima=kpis[0].scoring.mechanism==='A'?policy.aBands:policy.bBands.find(b=>b.companyId===companyId)?.minima;
  if(!minima)throw Error('Configure achievement bands for this company.');return {score,band:bandFor(score,minima)};
}
export function validateScorecard(kpis:KPI[]):void {if(!kpis.length||kpis.reduce((n,k)=>n+k.weightBp,0)!==10000)throw Error('KPI weights must total exactly 100%.');if(new Set(kpis.map(k=>k.scoring.mechanism)).size!==1)throw Error('A scorecard must use one mechanism.');}
export function scoreAnswers(statements:Statement[],answers:Record<string,'yes'|'no'>):{score:number;max:number} {
  if(Object.keys(answers).length!==statements.length||statements.some(s=>!['yes','no'].includes(answers[s.id])))throw Error('Answer every assigned statement exactly once.');
  return statements.reduce((a,s)=>({score:a.score+(answers[s.id]==='yes'?(s.future?1.5:1):0),max:a.max+(s.future?1.5:1)}),{score:0,max:0});
}
export function potential(leadership:{score:number;max:number}[],tech:{score:number;max:number}|null,policy:Policy,grade:string):{pct:number|null;band:PotentialBand|null;valid:boolean} {
  const normalizedGrade=grade.replace(/^JG\s*/i,'').trim();const min=/^\d+$/.test(normalizedGrade)?policy.minValid:1;
  if(leadership.length<min)return {pct:null,band:null,valid:false};
  const pct360=leadership.reduce((n,s)=>n+s.score/s.max*100,0)/leadership.length;
  const w=policy.weights[normalizedGrade]??10000;
  const pct=tech&&tech.max>0&&w<10000?(pct360*w+(tech.score/tech.max*100)*(10000-w))/10000:pct360;
  return {pct,band:pct<=policy.lowMaxPct?'Low':pct<=policy.midMaxPct?'Mid':'High',valid:true};
}
const talent15:Record<PotentialBand,readonly Talent[]>={High:['PIP/Improvement','Solid Core','Star','Super Star','Super Star'],Mid:['PIP/Improvement','PIP/Improvement','Solid Core','Star','Star'],Low:['PIP/Improvement','PIP/Improvement','Solid Core','Solid Core','Solid Core']};
export function talentCategory(pm:PMBand|null,pot:PotentialBand|null):Talent|null{return pm&&pot?talent15[pot][pmBands.indexOf(pm)]:null;}
export function talentCell9(performance:'low'|'mid'|'high',pot:PotentialBand):Talent {const map:Record<PotentialBand,Talent[]>={High:['Solid Core','Star','Super Star'],Mid:['PIP/Improvement','Solid Core','Star'],Low:['PIP/Improvement','Solid Core','Solid Core']};return map[pot][['low','mid','high'].indexOf(performance)];}
export const tiers=['hod','bu','bg','group','final'] as const;
export type Tier=typeof tiers[number];
export function resolveBand<T>(raw:T|null,decisions:{tier:Tier;band:T|null;locked:boolean}[]):{band:T|null;source:Tier|'manager'} {
  for(const tier of [...tiers].reverse()){const d=decisions.find(d=>d.tier===tier&&d.band!=null&&(d.locked||tier==='final'));if(d)return {band:d.band,source:tier};}return {band:raw,source:'manager'};
}
export function referenceCurve(pbt:number):Record<PMBand,number>{return pbt<70?{UA:10,BE:25,ME:60,AE:5,OU:0}:pbt>130?{UA:0,BE:5,ME:60,AE:25,OU:10}:{UA:5,BE:10,ME:70,AE:10,OU:5};}
export const goalSchema=z.object({id:z.uuid(),area:z.string().trim().min(1).max(300),dueOn:z.iso.date(),onJob:text,fromOthers:text,formalLearning:text,status:z.enum(['not_started','in_progress','done','dropped']),managerComment:text});
export type DevelopmentGoal=z.infer<typeof goalSchema>;
export const careerSchema=z.object({aspiration:text,mobility:z.enum(['stay','role_in_unit','company_in_group','other_group','relocate']),mobilityNote:text,targetProfileId:z.uuid().nullable()});
export type Career=z.infer<typeof careerSchema>;
export const evidenceResponseSchema=z.object({userId:z.uuid(),stance:z.enum(['endorse','dispute']),note:z.string().trim().min(1).max(1200),at:z.iso.datetime()});
export type FrozenResult={version:1;provenance?:{evidence:unknown[];attachments:{id:string;fileName:string;sizeBytes:number}[];kpis:KPI[];competencies:Competency[];leadership:{score:number;max:number}[];decisions:{tier:Tier;mode:string;performance:PMBand|null;potential:PotentialBand|null;locked:boolean;performanceLocked:boolean;potentialLocked:boolean;pip:boolean;promotion:boolean;specialReward:boolean}[]};performance:PMBand|null;potential:PotentialBand|null;performanceSource:Tier|'manager';potentialSource:Tier|'manager';talent:Talent|null;selfScore:number|null;managerScore:number|null;potentialPct:number|null;grade:string;policyDigest:string;feedback:{principle:string;band:PotentialBand}[];pip:boolean;promotion:boolean;specialReward:boolean};
