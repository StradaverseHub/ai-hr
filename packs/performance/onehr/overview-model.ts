import type {Policy,WindowCell} from './model';
import type {ProgressModule} from './progress-model';
export const overviewModules=['pm','f360','competency','calibration','idp'] as const;
export type OverviewModule=typeof overviewModules[number];
export type OverviewCounts={id:string;name:string;businessGroup:string;company:string;people:number;counts:Record<OverviewModule,{total:number;done:number}>};
/** The window that decides each module's open / closed state (also read by the admin area's module Overview). */
export const overviewWindows:Record<OverviewModule,WindowCell>={pm:'pm_results',f360:'f360',competency:'tc_self',calibration:'tb_bgceo',idp:'idp_self'};
/** The Review progress module each overview module opens. */
export const overviewProgressModule={pm:'pm',f360:'feedback',competency:'competency',calibration:'calibration',idp:'career'} as const satisfies Record<OverviewModule,ProgressModule>;
/** Whether the cycle's policy has the module on: 360 Feedback and Competency ride the talent switch. */
export function overviewModuleOn(policy:Pick<Policy,'modules'>,k:OverviewModule):boolean{return k==='pm'?policy.modules.pm:k==='f360'||k==='competency'?policy.modules.tm:k==='calibration'?policy.modules.calibration!==false:policy.modules.idp;}
export type OverviewCell={total:number;done:number;pct:number|null;state:'not_open'|'open'|'closed';opens:string|null;href:string|null};
export function buildAssessmentOverview(policy:Policy,cycleId:string,groups:OverviewCounts[],now=new Date()){
 const modules=overviewModules.filter(k=>overviewModuleOn(policy,k));
 const cell=(k:OverviewModule,total:number,done:number,group?:OverviewCounts):OverviewCell=>{
  const w=policy.windows[policy.kind==='quarterly'&&k==='pm'?'pm_results':overviewWindows[k]],state=w?.opensAt&&now.getTime()<Date.parse(w.opensAt)?'not_open':w?.closesAt&&now.getTime()>=Date.parse(w.closesAt)?'closed':'open';
  const query=new URLSearchParams({progressModule:overviewProgressModule[k],progressKind:k==='f360'?'assessors':'assessments'});
  if(group?.businessGroup)query.set('progressGroup',group.businessGroup);else if(group?.company)query.set('progressCompany',group.company);
  return {total,done,pct:state==='not_open'&&!done||!total?null:Math.floor(done*100/total),state,opens:state==='not_open'?w?.opensAt??null:null,href:group&&total&&(state!=='not_open'||done>0)?'/performance/'+cycleId+'?'+query+'#progress':null};
 };
 const rows=[...groups].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).map(g=>({...g,cells:Object.fromEntries(modules.map(k=>[k,cell(k,g.counts[k].total,g.counts[k].done,g)])) as Record<OverviewModule,OverviewCell>}));
 const totals={people:rows.reduce((n,r)=>n+r.people,0),cells:Object.fromEntries(modules.map(k=>[k,cell(k,rows.reduce((n,r)=>n+r.counts[k].total,0),rows.reduce((n,r)=>n+r.counts[k].done,0))])) as Record<OverviewModule,OverviewCell>};
 const scored=rows.map(r=>({row:r,open:modules.filter(k=>r.cells[k].state==='open'&&r.cells[k].pct!==null)})).filter(r=>r.open.length);
 const slow=modules.filter(k=>totals.cells[k].state==='open'&&totals.cells[k].pct!==null).sort((a,b)=>totals.cells[a].pct!-totals.cells[b].pct!)[0];
 const behind=scored.length>1?[...scored].sort((a,b)=>a.open.reduce((n,k)=>n+a.row.cells[k].pct!,0)/a.open.length-b.open.reduce((n,k)=>n+b.row.cells[k].pct!,0)/b.open.length)[0]?.row.name:null;
 return {modules,rows,totals,notes:{slowest:slow&&totals.cells[slow].pct!<100?{module:slow,pct:totals.cells[slow].pct!,daysLeft:policy.windows[overviewWindows[slow]]?.closesAt?Math.floor((Date.parse(policy.windows[overviewWindows[slow]]!.closesAt!)-now.getTime())/86400000):null}:null,behind,complete:rows.length>1?scored.filter(r=>r.open.every(k=>r.row.cells[k].pct===100)).map(r=>r.row.name):[]}};
}
