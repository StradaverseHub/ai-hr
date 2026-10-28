import { parseCsvRecords } from '../../../lib/csv';
/** unitOut: the cycle exclusion rule covers the person (D-P1-22); such a person never rates (canAssess false). */
export type PanelPerson={id:string;personId:string;code:string;name:string;companyId:string;groupId:string;department:string;grade:number|null;service:number;joinedOn:string|null;managerId:string|null;participates:boolean;canAssess?:boolean;unitOut?:boolean};
export const panelImportHeaders=['Subject Employee ID','Assessor Employee ID','Relationship'];
export type PanelRelationship='line_manager'|'matrix_manager'|'peer'|'direct_report';
export function panelImportRows(csv:string){
 if(new TextEncoder().encode(csv).length>2_000_000)throw Error('Choose a panel import smaller than 2 MB.');
 const {headers,records}=parseCsvRecords(csv.replace(/^\uFEFF/,''));
 if(new Set(headers).size!==headers.length)throw Error('The panel import has duplicate headings.');
 if(!records.length||records.length>20000)throw Error('Choose a panel file with between 1 and 20,000 rows.');
 const synonyms:Record<string,PanelRelationship>={line_manager:'line_manager','line manager':'line_manager',manager:'line_manager',lm:'line_manager',supervisor:'line_manager',matrix_manager:'matrix_manager','matrix manager':'matrix_manager',matrix:'matrix_manager',dotted_line_manager:'matrix_manager','dotted line manager':'matrix_manager','dotted line':'matrix_manager','dotted manager':'matrix_manager',dlm:'matrix_manager',peer:'peer',peers:'peer',colleague:'peer','peer/stakeholder':'peer','peer/stakeholders':'peer',stakeholder:'peer',stakeholders:'peer',direct_report:'direct_report','direct report':'direct_report',report:'direct_report',reports:'direct_report',subordinate:'direct_report',dr:'direct_report'};
 const pick=(r:Record<string,string>,names:string[])=>names.map(n=>r[n]?.trim()).find(s=>s&&s.toLowerCase()!=='nan')??'';
 return records.map((r,i)=>{
  const subject=pick(r,['subject_employee_id','subject_id','subject','subject_eid']),assessor=pick(r,['assessor_employee_id','assessor_id','assessor','assessor_eid']);
  const raw=pick(r,['relationship','rel','type']).toLowerCase().replace(/\s+/g,' ').replace(/\s*\/\s*/g,'/'),relationship=synonyms[raw];
  if(!subject&&!assessor&&!raw)return null;
  if(!subject||!assessor||!relationship)throw Error(`Row ${i+2}: enter a subject, assessor and valid relationship.`);
  return {row:i+2,subject,assessor,relationship};
 }).filter((r):r is NonNullable<typeof r>=>!!r);
}
export type PanelMember={employmentId:string;relationship:'line_manager'|'direct_report'|'peer';personId?:string};
export type PanelCandidates={subjectId:string;members:PanelMember[];directAvailable:number;peerAvailable:number;managerStatus:'ok'|'no_manager'|'ineligible_lm_grade'};
const stable=(a:PanelPerson,b:PanelPerson)=>a.code.localeCompare(b.code)||a.id.localeCompare(b.id);
const uniquePeople=(rows:PanelPerson[])=>{const seen=new Set<string>();return rows.filter(p=>{if(seen.has(p.personId))return false;seen.add(p.personId);return true;});};
const longest=(a:PanelPerson,b:PanelPerson)=>b.service-a.service||(a.joinedOn??'9999-99-99').localeCompare(b.joinedOn??'9999-99-99')||stable(a,b);
/** Source build_assignments.build_panels: one manager, two reports and two peers, with a flexible surplus. */
export function buildPanelCandidates(people:PanelPerson[],target=5,initialPeerLoad:Record<string,number>={},peerCap=10):PanelCandidates[]{
 if(!Number.isInteger(target)||target<1||target>20||!Number.isInteger(peerCap)||peerCap<1)throw Error('Invalid panel size or peer cap.');
 const byId=new Map(people.map(p=>[p.id,p])),peerLoad={...initialPeerLoad};
 return people.filter(p=>p.participates).map(subject=>{
  const manager=byId.get(subject.managerId??''),eligibleManager=manager&&manager.canAssess!==false&&manager.grade!=null&&manager.personId!==subject.personId?manager:null;
  const used=new Set([subject.personId,...(eligibleManager?[eligibleManager.personId]:[])]);
  const base={subjectId:subject.id,managerStatus:eligibleManager?'ok' as const:manager?'ineligible_lm_grade' as const:'no_manager' as const};
  if(subject.grade==null)return {...base,members:eligibleManager?[{employmentId:eligibleManager.id,personId:eligibleManager.personId,relationship:'line_manager' as const}]:[],directAvailable:0,peerAvailable:0};
  const reports=uniquePeople(people.filter(p=>p.managerId===subject.id&&p.canAssess!==false&&p.grade!=null&&!used.has(p.personId)).sort(longest));
  const sameDepartment=(p:PanelPerson)=>!!subject.department&&p.department===subject.department;
  const tier1=manager?uniquePeople(people.filter(p=>p.managerId===manager.id&&p.canAssess!==false&&p.grade!=null&&!used.has(p.personId)&&sameDepartment(p))):[];
  const seen=new Set([...used,...tier1.map(p=>p.personId)]);
  const tier2=uniquePeople(people.filter(p=>!seen.has(p.personId)&&p.canAssess!==false&&p.grade!=null&&p.companyId===subject.companyId&&p.groupId===subject.groupId&&sameDepartment(p)&&Math.abs(p.grade-subject.grade!)<=2));
  const peerRank=(a:PanelPerson,b:PanelPerson)=>b.service-a.service||stable(a,b);
  const reportPeople=new Set(reports.map(p=>p.personId));
  const peers=[...tier1.sort(peerRank),...tier2.sort(peerRank)].filter(p=>!reportPeople.has(p.personId)&&(peerLoad[p.id]??0)<peerCap);
  let takeReports=Math.min(2,reports.length),takePeers=Math.min(2,peers.length),remaining=target-1-takeReports-takePeers;
  if(remaining>0){const extra=Math.min(remaining,peers.length-takePeers);takePeers+=extra;remaining-=extra;}
  if(remaining>0)takeReports+=Math.min(remaining,reports.length-takeReports);
  const members:PanelMember[]=[...(eligibleManager?[{employmentId:eligibleManager.id,personId:eligibleManager.personId,relationship:'line_manager' as const}]:[]),...reports.slice(0,takeReports).map(p=>({employmentId:p.id,personId:p.personId,relationship:'direct_report' as const})),...peers.slice(0,takePeers).map(p=>({employmentId:p.id,personId:p.personId,relationship:'peer' as const}))];
  // The source candidate engine reserves the manager slot even if no manager is available.
  // The additive planner below applies the configured cap, including targets below five.
  for(const member of members)if(member.relationship==='peer')peerLoad[member.employmentId]=(peerLoad[member.employmentId]??0)+1;
  return {...base,members,directAvailable:reports.length,peerAvailable:peers.length};
 });
}
export type ExistingPanel={employmentId:string;relationship:string;archived:boolean;submitted:boolean;personId?:string};
/** Bulk operations never restore archived pairs, replace a manager, or change a scored/released panel. */
export function additivePanelPlan(candidates:PanelCandidates,existing:ExistingPanel[],mode:'missing'|'topup',target:number,released=false,finalized=false){
 const active=existing.filter(p=>!p.archived),taken=new Set(existing.map(p=>p.employmentId)),takenPeople=new Set(existing.flatMap(p=>p.personId?[p.personId]:[]));
 const status=finalized?'finalized':mode==='missing'&&active.length||mode==='topup'&&!active.length?'has_panel':active.length>=target?'full':mode==='topup'&&active.some(p=>p.submitted)?'started':mode==='topup'&&released?'released':null;
 if(status)return {status,add:[] as PanelMember[],before:active.length,after:active.length};
 const hasManager=active.some(p=>p.relationship==='line_manager'),add:PanelMember[]=[];
 for(const member of candidates.members){
  if(taken.has(member.employmentId)||member.personId&&takenPeople.has(member.personId)||member.relationship==='line_manager'&&hasManager)continue;
  if(active.length+add.length>=target)break;
  add.push(member);taken.add(member.employmentId);if(member.personId)takenPeople.add(member.personId);
 }
 return {status:add.length?'add':'short',add,before:active.length,after:active.length+add.length};
}
