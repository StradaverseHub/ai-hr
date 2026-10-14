import { tiers,type PMBand,type PotentialBand,type Tier } from './model';
export type TalentTrailState='none'|'set'|'kept'|'moved'|'wait'|'na';
export type TalentTrailStep={tier:'self'|'manager'|'you'|Tier;band:string|null;state:TalentTrailState};
type Bands={performance:PMBand|null;potential:PotentialBand|null};
type Decision=Bands&{tier:Tier;performanceLocked:boolean;potentialLocked:boolean};
type Source={self:Bands;manager:Bands;decisions:Decision[];current:Bands;adjusted:{performance:boolean;potential:boolean};sources:{performance:string|null;potential:string|null}};
const step=(tier:TalentTrailStep['tier'],band:string|null,before:string|null):TalentTrailStep=>({tier,band,state:!band?'none':!before?'set':band===before?'kept':'moved'});
/** Source _pot_review_final: assigned competency must be reviewed before this is the manager's call. */
export function potentialReviewReady(valid:boolean,assigned:boolean,status:string){return valid&&(!assigned||status==='reviewed');}
/** Source _tb_band_trails: pending tiers never publish their working band into another tier's trail. */
export function talentBandTrail(source:Source,axis:'performance'|'potential'):TalentTrailStep[]{
 const self=source.self[axis],manager=source.manager[axis],out=[step('self',self,null),step('manager',manager,self)];let current:string|null=manager;
 for(const tier of ['hod','bu'] as const){
  const decision=source.decisions.find(d=>d.tier===tier);
  if(!decision){out.push({tier,band:null,state:'na'});continue;}
  if(!decision[axis==='performance'?'performanceLocked':'potentialLocked']){out.push({tier,band:null,state:'wait'});continue;}
  const band=decision[axis]??current;out.push(step(tier,band,current));current=band??current;
 }
 const origin=source.sources[axis];
 if(source.adjusted[axis])out.push(step('you',source.current[axis],current));
 else if(origin&&['bg','group','final'].includes(origin)&&tiers.includes(origin as Tier))out.push(step(origin as Tier,source.current[axis],current));
 return out;
}
