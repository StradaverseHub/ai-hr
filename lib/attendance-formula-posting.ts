/** Explicit conflict adjudication only. This pure plan creates no approval or payable authority. */
export type AttendanceFormulaPostingCandidate={id:string;formulaId:string;employmentId:string;payComponentId:string;periodFrom:string;periodTo:string;posting:{kind:'exclusive'}|{kind:'sum'}|{kind:'priority';priority:number}};
export function planAttendanceFormulaPosting(rows:readonly AttendanceFormulaPostingCandidate[]){
 if(!rows.length||rows.length>128||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('Choose between1and128 distinct approved results.');
 const groups=new Map<string,AttendanceFormulaPostingCandidate[]>();
 for(const row of rows){const key=row.employmentId+':'+row.payComponentId;const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 const selected:string[]=[],excluded:string[]=[];
 for(const rows of groups.values()){
  const ordered=[...rows].sort((a,b)=>a.periodFrom.localeCompare(b.periodFrom)||a.periodTo.localeCompare(b.periodTo)||a.id.localeCompare(b.id));
  const sets:AttendanceFormulaPostingCandidate[][]=[];
  for(const row of ordered){const overlaps=sets.filter(set=>set.some(other=>other.periodFrom<=row.periodTo&&other.periodTo>=row.periodFrom));if(overlaps.length>1)throw Error('Overlapping formula periods have incompatible boundaries.');if(overlaps.length)overlaps[0].push(row);else sets.push([row]);}
  for(const set of sets){
   if(set.some(row=>row.periodFrom!==set[0].periodFrom||row.periodTo!==set[0].periodTo))throw Error('Overlapping formula results must use the same period boundaries.');
   if(new Set(set.map(row=>row.formulaId)).size!==set.length)throw Error('Only one current result per formula and period may post.');
   if(set.length===1||set.every(row=>row.posting.kind==='sum')){selected.push(...set.map(row=>row.id));continue;}
   if(set.every(row=>row.posting.kind==='priority')){const ordered=[...set].sort((a,b)=>(a.posting.kind==='priority'?a.posting.priority:0)-(b.posting.kind==='priority'?b.posting.priority:0));if(ordered[0].posting.kind==='priority'&&ordered[1].posting.kind==='priority'&&ordered[0].posting.priority===ordered[1].posting.priority)throw Error('Formula priority is tied; choose a distinct priority.');selected.push(ordered[0].id);excluded.push(...ordered.slice(1).map(row=>row.id));continue;}
   throw Error('Multiple formulas use this Pay Item and period. Configure all as Sum or distinct Priority before transfer.');
  }
 }
 return {selected:selected.sort(),excluded:excluded.sort()};
}
