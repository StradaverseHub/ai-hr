/** Org Chart is a permitted, effective-dated projection, never a second reporting-line owner. */
export type OrgChartEmployee = {
 employmentId:string;personId:string;name:string;employeeCode:string|null;role:string|null;
 department:string|null;departmentId:string|null;businessUnit:string|null;businessUnitId:string|null;
 companyId:string;company:string;employmentType:string|null;status:'active'|'probation'|'notice'|'inactive';
 topLevel:boolean;canOpenProfile:boolean;directReportCount?:number;photoUrl?:string|null;
 managerState?:'outside'|'restricted'|'inactive'|'missing'|'invalid';managerName?:string|null;crossCompany?:boolean;
};
export type OrgChartEdge={manager:string;subordinate:string;type:'administrative'|'functional'|'project'|'dotted'};
export type OrgChartFilter={companyId?:string;businessUnitId?:string;departmentId?:string;employmentType?:string;status?:string;query?:string;asOf:string};
export type OrgChartIssue={employmentId:string;name:string;code:'missing'|'inactive'|'invalid'|'unassigned'};
export function projectOrgChart(input:{employees:OrgChartEmployee[];edges:OrgChartEdge[];filter:OrgChartFilter}){
 const all=new Map(input.employees.map(e=>[e.employmentId,e]));
 const f=input.filter;
 const employees=input.employees.filter(e=>e.status!=='inactive'&&(!f.companyId||e.companyId===f.companyId)&&(!f.businessUnitId||e.businessUnitId===f.businessUnitId)&&(!f.departmentId||e.departmentId===f.departmentId)&&(!f.employmentType||e.employmentType===f.employmentType)&&(!f.status||f.status==='all'||e.status===f.status)).map(e=>({...e}));
 const selected=new Map(employees.map(e=>[e.employmentId,e]));
 const parents=new Map<string,OrgChartEdge[]>();
 for(const edge of input.edges)if(edge.type==='administrative')parents.set(edge.subordinate,[...(parents.get(edge.subordinate)??[]),edge]);
 const invalid=new Set<string>();
 // Dirty historical cycles or duplicate parents are reported, never silently made top-level or recursed.
 for(const e of employees){let next=e.employmentId;const seen=new Set<string>();
  while(parents.has(next)){if(seen.has(next)){for(const id of seen)invalid.add(id);break;}seen.add(next);const links=parents.get(next)!;if(links.length!==1){invalid.add(next);break;}next=links[0].manager;}
 }
 const issues:OrgChartIssue[]=[];
 for(const e of employees){const links=parents.get(e.employmentId)??[];const manager=links.length===1?all.get(links[0].manager):undefined;
  if(invalid.has(e.employmentId)||links.length>1||(e.topLevel&&links.length)){e.managerState='invalid';issues.push({employmentId:e.employmentId,name:e.name,code:'invalid'});}
  else if(links.length&&!manager){e.managerState='restricted';}
  else if(manager?.status==='inactive'){e.managerState='inactive';e.managerName=manager.name;issues.push({employmentId:e.employmentId,name:e.name,code:'inactive'});}
  else if(manager&&!selected.has(manager.employmentId)){e.managerState='outside';e.managerName=manager.name;}
  else if(!links.length&&!e.topLevel){e.managerState='missing';issues.push({employmentId:e.employmentId,name:e.name,code:'unassigned'});}
  if(manager)e.crossCompany=manager.companyId!==e.companyId;
 }
 const edges=input.edges.filter(edge=>selected.has(edge.manager)&&selected.has(edge.subordinate)&&!['invalid','inactive'].includes(selected.get(edge.subordinate)?.managerState??'')&&!invalid.has(edge.manager));
 return {employees,edges,issues};
}
export function orgChartVisibleIds(employees:{employmentId:string}[],edges:OrgChartEdge[],collapsed:readonly string[],root?:string){
 const allowed=new Set(employees.map(e=>e.employmentId));const children=new Map<string,string[]>();const child=new Set<string>();
 for(const edge of edges){
  if(edge.type!=='administrative'||!allowed.has(edge.manager)||!allowed.has(edge.subordinate))continue;
  const reports=children.get(edge.manager);
  if(reports)reports.push(edge.subordinate);
  else children.set(edge.manager,[edge.subordinate]);
  child.add(edge.subordinate);
 }
 const hidden=new Set(collapsed),visible=new Set<string>();
 const roots=root?[root]:employees.map(employee=>employee.employmentId).filter(id=>!child.has(id));
 const stack=roots.reverse();
 while(stack.length){
  const id=stack.pop()!;
  if(!allowed.has(id)||visible.has(id))continue;
  visible.add(id);
  if(hidden.has(id))continue;
  const reports=children.get(id)??[];
  for(let index=reports.length-1;index>=0;index--)stack.push(reports[index]);
 }
 return visible;
}

/** Deterministic forest layout reused by PDF tiling; invalid cycles have already been removed. */
export function layoutOrgChart(employees:{employmentId:string}[],edges:OrgChartEdge[],horizontal=false,cardHeight=100){
 const ids=new Set(employees.map(e=>e.employmentId));const children=new Map<string,string[]>(),parent=new Set<string>();
 for(const edge of edges){
  if(edge.type!=='administrative'||!ids.has(edge.manager)||!ids.has(edge.subordinate))continue;
  const reports=children.get(edge.manager);
  if(reports)reports.push(edge.subordinate);
  else children.set(edge.manager,[edge.subordinate]);
  parent.add(edge.subordinate);
 }
 const positions=new Map<string,{x:number;y:number;width:number;height:number}>();let leaf=0;const seen=new Set<string>();
 for(const root of employees.filter(e=>!parent.has(e.employmentId))){const stack=[{id:root.employmentId,depth:0,exit:false}];while(stack.length){const node=stack.pop()!;
  if(!node.exit){if(seen.has(node.id))continue;seen.add(node.id);stack.push({...node,exit:true});for(const id of [...(children.get(node.id)??[])].reverse())stack.push({id,depth:node.depth+1,exit:false});}
  else{const kids=(children.get(node.id)??[]).map(id=>positions.get(id)).filter((p):p is {x:number;y:number;width:number;height:number}=>!!p);const axis=kids.length?(horizontal?(kids[0].y+kids[kids.length-1].y)/2:(kids[0].x+kids[kids.length-1].x)/2):leaf++*(horizontal?cardHeight+32:232);positions.set(node.id,{x:horizontal?node.depth*250:axis,y:horizontal?axis:node.depth*(cardHeight+48),width:200,height:cardHeight});}
 }}
 let width=1,height=1;
 for(const position of positions.values()){
  width=Math.max(width,position.x+position.width);
  height=Math.max(height,position.y+position.height);
 }
 return {positions,width,height};
}

/** Search focuses the permitted superior path and immediate reports, without mounting unrelated branches. */
export function orgChartSearchIds(employees:{employmentId:string;name:string;employeeCode:string|null;role:string|null;department:string|null}[],edges:OrgChartEdge[],query:string){
 const q=query.trim().toLowerCase();const matches=new Set(employees.filter(e=>`${e.employeeCode??''} ${e.name} ${e.role??''} ${e.department??''}`.toLowerCase().includes(q)).map(e=>e.employmentId));
 const firstManager=new Map<string,string>();
 const directReports=new Map<string,string[]>();
 for(const edge of edges){
  if(edge.type!=='administrative')continue;
  if(!firstManager.has(edge.subordinate))firstManager.set(edge.subordinate,edge.manager);
  const reports=directReports.get(edge.manager);
  if(reports)reports.push(edge.subordinate);
  else directReports.set(edge.manager,[edge.subordinate]);
 }
 const visible=new Set(matches),visited=new Set<string>();
 for(const hit of matches){
  let current:string|undefined=hit;
  while(current!==undefined&&!visited.has(current)){
   visited.add(current);visible.add(current);
   current=firstManager.get(current);
  }
  for(const subordinate of directReports.get(hit)??[])visible.add(subordinate);
 }
 return visible;
}

export type OrgChartNodePosition={cx:number;cy:number;t:number;b:number;l:number;r:number};
/** One connector owner for the live measured chart and inert real-component browser evidence. */
export function orgChartConnectorPath(m:OrgChartNodePosition,s:OrgChartNodePosition,type:OrgChartEdge['type'],horizontal:boolean):string {
    let d: string;
    if (type === 'administrative' && horizontal) {
      const mid=(m.r+s.l)/2;d=`M ${m.r} ${m.cy} L ${mid} ${m.cy} L ${mid} ${s.cy} L ${s.l} ${s.cy}`;
    } else if (type === 'administrative') {
      const px = m.cx;
      const py = m.b;
      const cx = s.cx;
      const cy = s.t;
      const midY = (py + cy) / 2;
      const r = Math.min(8, Math.abs(cx - px) / 2, Math.max((cy - py) / 2, 0));
      if (Math.abs(cx - px) < 1 || r < 1) {
        d = `M ${px} ${py} L ${cx} ${cy}`;
      } else {
        const dir = cx > px ? 1 : -1;
        d = `M ${px} ${py} L ${px} ${midY - r} Q ${px} ${midY} ${px + dir * r} ${midY} L ${cx - dir * r} ${midY} Q ${cx} ${midY} ${cx} ${midY + r} L ${cx} ${cy}`;
      }
    } else if (Math.abs(s.cy - m.cy) < 24) {
      // same level → connect nearest sides
      const fromR = s.cx >= m.cx;
      const x1 = fromR ? m.r : m.l;
      const x2 = fromR ? s.l : s.r;
      const mx = (x1 + x2) / 2;
      d = `M ${x1} ${m.cy} C ${mx} ${m.cy}, ${mx} ${s.cy}, ${x2} ${s.cy}`;
    } else {
      // different level → connect top/bottom with a smooth curve
      const down = s.cy > m.cy;
      const y1 = down ? m.b : m.t;
      const y2 = down ? s.t : s.b;
      const my = (y1 + y2) / 2;
      d = `M ${m.cx} ${y1} C ${m.cx} ${my}, ${s.cx} ${my}, ${s.cx} ${y2}`;
    }
    return d;
}
