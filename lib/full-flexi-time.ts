/** Full Flexi measures closed intervals, never the elapsed envelope between first and last clocks. */
export type ClosedClockInterval={inAbs:number;outAbs:number};
const minutes=(clock:string)=>{const [h,m]=clock.split(':').map(Number);return h*60+m;};
export function fullFlexiIntervals(punches:readonly {punchAt:string;direction:'in'|'out'}[],firstIn:string|null,cutoff:number|null) {
 const ins=punches.filter(p=>p.direction==='in');
 if(!ins.length)return {complete:false as const,intervals:[] as ClosedClockInterval[],checkInAt:null,checkOutAt:null};
 const anchor=firstIn&&ins.some(p=>p.punchAt===firstIn)?minutes(firstIn):cutoff??Math.min(...ins.map(p=>minutes(p.punchAt)));
 const unique=[...new Map(punches.map(p=>[`${p.punchAt}:${p.direction}`,p])).values()];
 const ordered=unique.map(p=>({...p,at:minutes(p.punchAt)+(minutes(p.punchAt)<anchor?1440:0)})).sort((a,b)=>a.at-b.at||a.punchAt.localeCompare(b.punchAt)||a.direction.localeCompare(b.direction));
 const intervals:ClosedClockInterval[]=[];let pending:typeof ordered[number]|null=null;let invalid=false;
 for(const p of ordered){if(p.direction==='in'){if(pending)invalid=true;pending=p;}else if(!pending||p.at<=pending.at){invalid=true;}else{intervals.push({inAbs:pending.at,outAbs:p.at});pending=null;}}
 const first=ordered.find(p=>p.direction==='in');
 const last=ordered.filter(p=>p.direction==='out').reduce<typeof ordered[number]|null>((a,b)=>!a||b.at>a.at?b:a,null);
 const complete=!invalid&&!pending&&intervals.length>0;
 return {complete,intervals:complete?intervals:[],checkInAt:first?.punchAt??null,checkOutAt:complete?last?.punchAt??null:null};
}
export function fullFlexiBreakMinutes(intervals:readonly ClosedClockInterval[],breaks:readonly {start:string;end:string;paid?:boolean;flexible?:boolean;flexibleMinutes?:number}[]|null,scalar:number,wholeAllowance:number|null) {
 const span=intervals.reduce((n,p)=>n+p.outAbs-p.inAbs,0);
 if(wholeAllowance!=null)return Math.min(span,wholeAllowance);
 if(!breaks?.length)return span>=360?Math.min(span,scalar):0;
 const anchor=intervals.reduce((n,p)=>Math.min(n,p.inAbs),Infinity);
 let deduction=0;
 for(const bp of breaks){if(bp.paid)continue;if(bp.flexible&&bp.flexibleMinutes!=null){deduction+=bp.flexibleMinutes;continue;}
  let start=minutes(bp.start);if(start<anchor-720)start+=1440;
  const length=(minutes(bp.end)-minutes(bp.start)+1440)%1440,end=start+length;
  deduction+=intervals.reduce((n,p)=>n+Math.max(0,Math.min(p.outAbs,end)-Math.max(p.inAbs,start)),0);
 }
 return Math.min(span,scalar,deduction);
}
