import type { Competency, Policy, Statement } from './model';
import { sourceRound } from './journey-model';

type Profile=Policy['profiles'][number];
export type ProfileMatch='roster'|'self'|'title_grade'|'title'|'assigned'|'grade';
const grade=(value:string)=>value.replace(/^JG\s*/i,'').trim();
const gradeRank=(value:string)=>/^\d+$/.test(grade(value))?Number(grade(value)):0;

/** Exact native role, personal choice, then deterministic title fallbacks from the source architecture. */
export function resolveTechnicalProfile(profiles:Profile[],identity:{companyId:string;employmentId:string;department:string;title:string;grade:string},pickedId?:string|null):{profile:Profile;source:ProfileMatch}|null {
 const available=profiles.filter(p=>p.active!==false&&(p.companyId==null||p.companyId===identity.companyId)).sort((a,b)=>a.id.localeCompare(b.id));
 const assigned=available.filter(p=>p.employmentIds?.includes(identity.employmentId));
 if(assigned.length>1)throw Error('Assign exactly one technical profile to this employment.');
 if(assigned[0])return {profile:assigned[0],source:'assigned'};
 const candidates=available.filter(p=>!p.employmentIds?.length);
 const exact=candidates.find(p=>p.jobTitle&&p.jobTitle.trim()===identity.title.trim()&&(p.department??'').trim()===identity.department.trim()&&grade(p.grade)===grade(identity.grade));
 if(exact)return {profile:exact,source:'roster'};
 const picked=candidates.find(p=>p.id===pickedId);if(picked)return {profile:picked,source:'self'};
 if(identity.title.trim()){
  const titleGrade=candidates.find(p=>p.jobTitle?.trim()===identity.title.trim()&&grade(p.grade)===grade(identity.grade));
  if(titleGrade)return {profile:titleGrade,source:'title_grade'};
  const title=candidates.find(p=>p.jobTitle?.trim()===identity.title.trim());if(title)return {profile:title,source:'title'};
 }
 // Backward compatibility for native catalogues that explicitly scope profiles only by grade.
 const legacy=candidates.filter(p=>!p.jobTitle&&grade(p.grade)===grade(identity.grade));
 if(legacy.length>1)throw Error('Assign exactly one competency profile per company and grade.');
 return legacy[0]?{profile:legacy[0],source:'grade'}:null;
}

/** Explicit current levels win before deriving the same titled skill at level N+1. */
export function technicalProfilePlan(profile:Profile,catalogue:Statement[]):Statement[] {
 const explicit=profile.competencies.map(s=>({...s}));
 const claimed=new Set(explicit.map(s=>s.id));
 const future:Statement[]=[];
 for(const skill of explicit){
  if(skill.future||!skill.skillTitle||skill.skillLevel==null)continue;
  const next=catalogue.find(s=>s.skillTitle?.trim()===skill.skillTitle!.trim()&&s.skillLevel===skill.skillLevel!+1);
  if(next&&!claimed.has(next.id)){future.push({...next,future:true});claimed.add(next.id);}
 }
 return [...explicit,...future];
}

export function demonstratedSkills(records:{status:string;competencies:Competency[]}[],self=false):Record<string,number> {
 const result:Record<string,number>={};
 for(const record of records){
  if(!self&&record.status!=='reviewed')continue;
  for(const skill of record.competencies){
   if(!skill.skillTitle||skill.skillLevel==null||(skill.manager??skill.self)!=='yes')continue;
   const title=skill.skillTitle.trim();result[title]=Math.max(result[title]??-1,skill.skillLevel);
  }
 }
 return result;
}
export function requiredSkills(profile:Profile):Record<string,number> {
 const result:Record<string,number>={};
 for(const skill of profile.competencies){
  if(skill.future||!skill.skillTitle||skill.skillLevel==null)continue;
  const title=skill.skillTitle.trim();result[title]=Math.max(result[title]??-1,skill.skillLevel);
 }
 return result;
}
export function careerGap(have:Record<string,number>,target:Profile){
 const need=requiredSkills(target);
 const rows=Object.keys(need).sort().map(title=>({title,required:need[title],have:have[title]??null,state:have[title]==null?'missing' as const:have[title]>=need[title]?'met' as const:'stretch' as const}));
 const met=rows.filter(r=>r.state==='met').length;
 return {rows,total:rows.length,met,stretch:rows.filter(r=>r.state==='stretch').length,missing:rows.filter(r=>r.state==='missing').length,pct:rows.length?sourceRound(100*met/rows.length):0};
}

/** Similarity answers overlap with the CURRENT role; readiness answers demonstrated TARGET requirements. */
export function careerRoutes(profile:Profile,profiles:Profile[],have:Record<string,number>,overrides:NonNullable<Policy['careerRoutes']>=[],limit=9){
 const mine=Object.keys(requiredSkills(profile));if(!mine.length)return [];
 const ranked=Object.keys(have).length>0;
 return profiles.filter(p=>p.id!==profile.id&&p.active!==false&&gradeRank(p.grade)>=gradeRank(profile.grade)).flatMap(candidate=>{
  const kind=overrides.find(r=>r.fromProfileId===profile.id&&r.toProfileId===candidate.id)?.kind;
  if(kind==='hidden')return [];
  const theirs=Object.keys(requiredSkills(candidate));if(!theirs.length)return [];
  const shared=mine.filter(title=>theirs.includes(title)).length,overlap=shared/mine.length;
  const sameTrack=!!profile.track&&candidate.track===profile.track;
  if(kind!=='pinned'&&overlap<0.30&&!sameTrack)return [];
  const score=overlap+(sameTrack?0.25:0)+(profile.sector&&candidate.sector===profile.sector?0.10:0)+((candidate.department??'')===(profile.department??'')?0.05:0);
  const gap=careerGap(have,candidate),readiness=ranked?gap.pct:null;
  return [{profile:candidate,overlap:sourceRound(overlap*100),shared,newSkills:theirs.length-shared,gap,readiness,pinned:kind==='pinned',score,lane:sameTrack?'deepen' as const:'cross' as const,step:gradeRank(candidate.grade)>gradeRank(profile.grade)?'up' as const:'same' as const,group:readiness==null?'related' as const:readiness>=60?'closest' as const:readiness>=25?'stretch' as const:'longer' as const}];
 }).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||(b.readiness??-1)-(a.readiness??-1)||b.score-a.score||(a.profile.jobTitle??a.profile.name).localeCompare(b.profile.jobTitle??b.profile.name)||a.profile.id.localeCompare(b.profile.id)).slice(0,limit);
}

/** The career map can show the ladder; the next-move picker is bounded by the person's actual grade. */
export function careerGradeChoices<T extends {grade:string|number|null}>(roles:T[],current:string|number|null,span=2):T[]{
 if(current==null)return roles;
 const rank=gradeRank(String(current));
 return roles.filter(role=>{const distance=gradeRank(String(role.grade??''))-rank;return distance>=0&&distance<=span;});
}
/** Source candidate order: rank the reviewed-evidence map, take nine, THEN cap the grade span. */
export function careerDirections(profile:Profile|null,profiles:Profile[],reviewed:Record<string,number>,currentGrade:string|null,overrides:NonNullable<Policy['careerRoutes']>=[]){
 if(!profile)return [];
 return careerGradeChoices(careerRoutes(profile,profiles,reviewed,overrides).map(route=>route.profile),currentGrade);
}

/** Pending self answers are planning context only. A private edit replaces this review's prior claim. */
export function careerSkillEvidence(records:{reviewId?:string;status:string;competencies:Competency[]}[],current?:{reviewId:string;status:string;competencies:Competency[]}){
 const reviewed=demonstratedSkills(records);
 const planning=demonstratedSkills(current?[...records.filter(r=>r.reviewId!==current.reviewId),current]:records,true);
 return {reviewed,planning};
}
