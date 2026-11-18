import { parseCsvRecords } from '../../../lib/csv';
import { policySchema, statementSchema, type Policy, type Statement } from './model';

export const architectureSheets=['Job_Profile','Job_Skills'] as const;
export const architectureHeaders={
 Job_Profile:['Department','Job Title','Job Grade','SSG Sector','SSG Track','SSG Job Role','Mapping Confidence','Standardized Proficiency Level'],
 Job_Skills:['Department','Job Title','Job Grade','SSG Sector','SSG Track','SSG Job Role','Mapping Confidence','Skill Code','Skill Title','Skill Type','Skill Category','Required Level','Proficiency Description','Knowledge Items','Ability Items'],
};
type Row=Record<string,string>;
const get=(row:Row,key:string)=>row[key.toLowerCase().replaceAll(' ','_')]?.trim()??'';
const roleKey=(department:string,title:string,grade:string)=>JSON.stringify([department.trim().toUpperCase(),title.trim().toUpperCase(),grade.trim().toUpperCase()]);
const key=(p:Policy['profiles'][number])=>`${p.companyId??''}:${roleKey(p.department??'',p.jobTitle??p.name,p.grade)}`;
function rows(csv:string,required:string[]){
 if(new TextEncoder().encode(csv).length>2_000_000)throw Error('Choose a catalogue sheet smaller than 2 MB of text.');
 const parsed=parseCsvRecords(csv.replace(/^\uFEFF/,''));
 if(new Set(parsed.headers).size!==parsed.headers.length)throw Error('Duplicate catalogue headings.');
 for(const name of required)if(!parsed.headers.includes(name.toLowerCase().replaceAll(' ','_')))throw Error(`Missing ${name} heading.`);
 if(parsed.records.length>20000)throw Error('A catalogue sheet may contain at most 20,000 rows.');
 return parsed.records.filter(r=>Object.values(r).some(Boolean));
}
/** Upsert the source's two-sheet architecture. Assignment snapshots are a separate explicit operation. */
export function importArchitecture(policy:Policy,sheets:Record<typeof architectureSheets[number],string>,companyId:string|null,newId:(key:string)=>string){
 const skillRows=rows(sheets.Job_Skills,['Skill Code','Skill Title','Required Level','Department','Job Title','Job Grade']);
 if(!skillRows.length)throw Error('Job_Skills is empty.');
 const profileRows=sheets.Job_Profile.trim()?rows(sheets.Job_Profile,['Department','Job Title','Job Grade']):[];
 const skills=new Map((policy.skills??[]).map(s=>[s.skillCode??s.id,s]));
 const profiles=new Map(policy.profiles.map(p=>[key(p),p]));
 const seenSkills=new Set<string>(),seenProfiles=new Set<string>();let skipped=0;
 for(const row of skillRows){
  const code=get(row,'Skill Code'),title=get(row,'Skill Title');
  if(!code||!title){skipped++;continue;}
  // The original importer keeps the first occurrence of a skill code in this workbook.
  if(seenSkills.has(code))continue;seenSkills.add(code);
  const level=get(row,'Required Level');if(!/^\d+$/.test(level)||Number(level)<1||Number(level)>100)throw Error(`Skill ${code} needs a positive proficiency level.`);
  const old=skills.get(code),category=get(row,'Skill Category'),description=get(row,'Proficiency Description');
  skills.set(code,statementSchema.parse({id:old?.id??code,skillCode:code,skillTitle:title,skillLevel:Number(level),principle:category||get(row,'Skill Type')||title,text:description||title,future:false,skillType:get(row,'Skill Type'),knowledge:get(row,'Knowledge Items'),ability:get(row,'Ability Items')}));
 }
 const upsert=(row:Row)=>{
  const title=get(row,'Job Title');if(!title)return null;
  const department=get(row,'Department'),grade=get(row,'Job Grade'),k=`${companyId??''}:${roleKey(department,title,grade)}`,old=profiles.get(k);
  profiles.set(k,{...old,id:old?.id??newId(k),name:title,jobTitle:title,department,grade,companyId:old?.companyId??companyId,active:old?.active??true,ssgJobRole:get(row,'SSG Job Role'),mappingConfidence:get(row,'Mapping Confidence'),proficiencyLevel:/^\d+$/.test(get(row,'Standardized Proficiency Level'))?Number(get(row,'Standardized Proficiency Level')):null,sector:get(row,'SSG Sector'),track:get(row,'SSG Track'),competencies:[]});seenProfiles.add(k);return k;
 };
 for(const row of profileRows)upsert(row);
 const links=new Map<string,Statement[]>();
 for(const row of skillRows){
  const code=get(row,'Skill Code');if(!code)continue;
  const k=`${companyId??''}:${roleKey(get(row,'Department'),get(row,'Job Title'),get(row,'Job Grade'))}`;
  if(!get(row,'Job Title'))continue;
  if(!seenProfiles.has(k))upsert(row);
  const skill=skills.get(code);if(!skill)throw Error(`Skill ${code} has no usable catalogue definition.`);
  const list=links.get(k)??[];if(!list.some(s=>s.id===skill.id))list.push({...skill,skillLevel:Number(get(row,'Required Level'))||skill.skillLevel,future:false});links.set(k,list);
 }
 for(const k of seenProfiles)profiles.get(k)!.competencies=links.get(k)??[];
 const byId=new Map([...skills.values()].map(s=>[s.id,s]));
 const resolved=[...profiles.values()].map(p=>({...p,competencies:p.competencies.map(s=>({...(byId.get(s.id)??s),skillLevel:s.skillLevel??byId.get(s.id)?.skillLevel,future:s.future}))}));
 const next=policySchema.parse({...policy,skills:[...skills.values()],profiles:resolved});
 return {policy:next,skills:seenSkills.size,profiles:seenProfiles.size,links:[...links.values()].reduce((n,s)=>n+s.length,0),skipped};
}
