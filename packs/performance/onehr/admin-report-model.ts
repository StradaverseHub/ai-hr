import {z} from 'zod';
import {sourceRound} from './source-numeric';
import type {ProgressCell} from './progress-model';
export const adminReportParams=z.object({kind:z.enum(['progress','pbt','scoring','participants']),module:z.enum(['pm','f360','competency','calibration']).optional(),groupBy:z.enum(['business_group','company','department','person']).default('business_group'),status:z.enum(['all','outstanding','done']).default('all'),businessGroup:z.string().trim().max(300).optional()}).strict().refine(p=>p.kind!=='progress'||!!p.module,'Choose a progress module.');
export type AdminReportParams=z.infer<typeof adminReportParams>;
export type ReportPerson={name:string;code:string|null;group:string;company:string;department:string};
export type AdminReportData={progress?:Array<ReportPerson&{cell:ProgressCell}>;assessors?:Array<ReportPerson&{assigned:number;done:number}>;participants?:Array<ReportPerson&{takingPart:boolean;reason:string}>;profit?:Array<{group:string;company:string;achievementPct:number|null;inherited:boolean}>;scoring?:Array<{group:string;mechanism:string;people:number}>};
export type AdminReport={title:string;columns:string[];rows:(string|number)[][];total:number;params:AdminReportParams};
const groups={business_group:'Business group',company:'Company',department:'Department',person:'Person'},modules={pm:'Performance',f360:'360 feedback',competency:'Competency',calibration:'Calibration'};
const statusFits=(status:AdminReportParams['status'],done:boolean)=>status==='all'||(status==='done'?done:!done);
const percent=(done:number,total:number)=>total?`${sourceRound(100*done/total)}%`:'—';
const identity=(p:ReportPerson)=>[p.name,p.code??'',p.group,p.company,p.department];
const keyOf=(p:ReportPerson,group:AdminReportParams['groupBy'])=>group==='business_group'?p.group:group==='company'?p.company:p.department;
/** Aggregation follows source report semantics. Status filters apply after grouping, not to input people. */
export function buildAdminReport(raw:unknown,cycleName:string,data:AdminReportData):AdminReport{
 const p=adminReportParams.parse(raw);let title='',columns:string[]=[],rows:(string|number)[][]=[];
 const scoped=<T extends {group:string}>(items:T[])=>items.filter(i=>!p.businessGroup||i.group===p.businessGroup);
 if(p.kind==='progress'&&p.module!=='f360'){
  const people=scoped(data.progress??[]);title=`${modules[p.module!]} progress`;
  if(p.groupBy==='person'){columns=['Name','Employee ID','Business group','Company','Department','Status','Detail'];rows=people.filter(r=>statusFits(p.status,r.cell.state==='done')).map(r=>[...identity(r),r.cell.state==='done'?'Complete':r.cell.state==='active'?'In progress':'Not started',r.cell.label.replaceAll('_',' ')]);}
  else {const grouped=new Map<string,{done:number;active:number;pending:number}>();for(const row of people){const key=keyOf(row,p.groupBy),counts=grouped.get(key)??{done:0,active:0,pending:0};counts[row.cell.state]++;grouped.set(key,counts);}
   columns=[groups[p.groupBy],'Complete','In progress','Not started','Total','% complete'];rows=[...grouped].sort(([,a],[,b])=>b.active+b.pending-a.active-a.pending).filter(([,r])=>statusFits(p.status,r.active+r.pending===0)).map(([key,r])=>[key||'(none)',r.done,r.active,r.pending,r.done+r.active+r.pending,percent(r.done,r.done+r.active+r.pending)]);
  }
 }else if(p.kind==='progress'){
  const people=scoped(data.assessors??[]);title=`360 feedback: rating tasks by assessor’s ${groups[p.groupBy].toLowerCase()}`;
  if(p.groupBy==='person'){columns=['Assessor','Employee ID','Business group','Company','Department','Submitted','Tasks'];rows=people.filter(r=>statusFits(p.status,r.done>=r.assigned)).map(r=>[...identity(r),r.done,r.assigned]);}
  else {const grouped=new Map<string,{done:number;total:number}>();for(const row of people){const key=keyOf(row,p.groupBy),counts=grouped.get(key)??{done:0,total:0};counts.done+=row.done;counts.total+=row.assigned;grouped.set(key,counts);}
   columns=[groups[p.groupBy],'Submitted','Tasks','% submitted'];rows=[...grouped].sort(([,a],[,b])=>(a.total?a.done/a.total:1)-(b.total?b.done/b.total:1)).filter(([,r])=>statusFits(p.status,r.done>=r.total)).map(([key,r])=>[key||'(none)',r.done,r.total,percent(r.done,r.total)]);
  }
 }else if(p.kind==='participants'){
  const people=scoped(data.participants??[]);title='Who takes part';
  if(p.groupBy==='person'){columns=['Name','Employee ID','Business group','Company','Department','Takes part','Why'];rows=people.filter(r=>statusFits(p.status,r.takingPart)).map(r=>[...identity(r),r.takingPart?'Yes':'No',r.reason.replaceAll('_',' ')]);}
  else {const grouped=new Map<string,{yes:number;no:number}>();for(const row of people){const key=keyOf(row,p.groupBy),counts=grouped.get(key)??{yes:0,no:0};counts[row.takingPart?'yes':'no']++;grouped.set(key,counts);}
   columns=[groups[p.groupBy],'Take part','Do not take part','People'];rows=[...grouped].sort(([,a],[,b])=>b.no-a.no).filter(([,r])=>statusFits(p.status,r.no===0)).map(([key,r])=>[key||'(none)',r.yes,r.no,r.yes+r.no]);
  }
 }else if(p.kind==='pbt'){
  title='PBT achievement by company';columns=['Business group','Company','PBT achievement %','Curve','Figure source'];rows=scoped(data.profit??[]).filter(r=>statusFits(p.status,r.achievementPct!==null)).map(r=>[r.group,r.company,r.achievementPct??'',r.achievementPct===null?'Normal (not entered)':r.achievementPct<70?'Below 70%':r.achievementPct>130?'Above 130%':'70–130%',r.achievementPct===null?'Not entered':r.inherited?'Business group':'Company']);
 }else{title='Scoring mechanism by business group';columns=['Business group','Mechanism','People'];rows=scoped(data.scoring??[]).filter(r=>statusFits(p.status,r.mechanism!=='Not set')).map(r=>[r.group,r.mechanism,r.people]);}
 if(p.kind==='participants'||p.kind==='progress'&&p.module!=='f360')title+=p.groupBy==='person'?', person by person':` by ${groups[p.groupBy].toLowerCase()}`;
 return {title:[title,cycleName,p.businessGroup,p.status!=='all'?`${p.status} only`:null].filter(Boolean).join(' · '),columns,rows:rows.slice(0,5000),total:rows.length,params:p};
}
export type PerformanceAdminIndexItem={kind:'page'|'setting'|'report';label:string;path:string;href:string;value?:string;scope?:string;canEdit?:boolean;description?:string};
const stop=new Set('the a an to of for in on is are do i where what how can my me and or which change set see show find open it this that with by be page setting settings please pls we our go get'.split(' '));
export function findPerformanceAdminItems(items:PerformanceAdminIndexItem[],query:string,kinds:PerformanceAdminIndexItem['kind'][],limit=5){
 const words=(query.toLowerCase().match(/[a-z0-9&+]+/g)??[]).filter(w=>w.length>1&&!stop.has(w));
 return items.filter(item=>kinds.includes(item.kind)).map((item,index)=>{const label=item.label.toLowerCase(),rest=[item.path,item.value,item.scope,item.description].filter(Boolean).join(' ').toLowerCase();return {item,index,score:words.reduce((n,w)=>{const stem=w.length>3&&w.endsWith('s')?w.slice(0,-1):w;return n+(label.includes(w)||label.includes(stem)?3:rest.includes(w)||rest.includes(stem)?1:0);},0)};}).filter(r=>r.score).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,limit).map(r=>r.item);
}
const query=z.object({query:z.string().trim().min(1).max(1000)}).strict();
export const performanceAdminAction=z.discriminatedUnion('tool',[
 z.object({tool:z.literal('find_setting'),args:query}).strict(),z.object({tool:z.literal('find_page'),args:query}).strict(),z.object({tool:z.literal('find_download'),args:query}).strict(),
 z.object({tool:z.literal('open_page'),args:z.object({href:z.string().max(1000)}).strict()}).strict(),z.object({tool:z.literal('cycle_status'),args:z.object({}).strict()}).strict(),z.object({tool:z.literal('build_report'),args:adminReportParams}).strict(),
]);
