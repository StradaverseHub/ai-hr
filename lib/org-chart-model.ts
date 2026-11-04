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
 for(const e of edges)if(e.type==='administrative'&&allowed.has(e.manager)&&allowed.has(e.subordinate)){children.set(e.manager,[...(children.get(e.manager)??[]),e.subordinate]);child.add(e.subordinate);}
 const hidden=new Set(collapsed),visible=new Set<string>();const visit=(id:string)=>{if(!allowed.has(id)||visible.has(id))return;visible.add(id);if(!hidden.has(id))for(const sub of children.get(id)??[])visit(sub);};
 if(root)visit(root);else for(const e of employees)if(!child.has(e.employmentId))visit(e.employmentId);
 return visible;
}

/** Deterministic forest layout reused by PDF tiling; invalid cycles have already been removed. */
export function layoutOrgChart(employees:{employmentId:string}[],edges:OrgChartEdge[],horizontal=false,cardHeight=100){
 const ids=new Set(employees.map(e=>e.employmentId));const children=new Map<string,string[]>(),parent=new Set<string>();
 for(const edge of edges)if(edge.type==='administrative'&&ids.has(edge.manager)&&ids.has(edge.subordinate)){children.set(edge.manager,[...(children.get(edge.manager)??[]),edge.subordinate]);parent.add(edge.subordinate);}
 const positions=new Map<string,{x:number;y:number;width:number;height:number}>();let leaf=0;const seen=new Set<string>();
 for(const root of employees.filter(e=>!parent.has(e.employmentId))){const stack=[{id:root.employmentId,depth:0,exit:false}];while(stack.length){const node=stack.pop()!;
  if(!node.exit){if(seen.has(node.id))continue;seen.add(node.id);stack.push({...node,exit:true});for(const id of [...(children.get(node.id)??[])].reverse())stack.push({id,depth:node.depth+1,exit:false});}
  else{const kids=(children.get(node.id)??[]).map(id=>positions.get(id)).filter((p):p is {x:number;y:number;width:number;height:number}=>!!p);const axis=kids.length?(horizontal?(kids[0].y+kids[kids.length-1].y)/2:(kids[0].x+kids[kids.length-1].x)/2):leaf++*(horizontal?cardHeight+32:232);positions.set(node.id,{x:horizontal?node.depth*250:axis,y:horizontal?axis:node.depth*(cardHeight+48),width:200,height:cardHeight});}
 }}
 return {positions,width:Math.max(1,...[...positions.values()].map(p=>p.x+p.width)),height:Math.max(1,...[...positions.values()].map(p=>p.y+p.height))};
}

/** Search focuses the permitted superior path and immediate reports, without mounting unrelated branches. */
export function orgChartSearchIds(employees:{employmentId:string;name:string;employeeCode:string|null;role:string|null;department:string|null}[],edges:OrgChartEdge[],query:string){
 const q=query.trim().toLowerCase();const matches=new Set(employees.filter(e=>`${e.employeeCode??''} ${e.name} ${e.role??''} ${e.department??''}`.toLowerCase().includes(q)).map(e=>e.employmentId));
 const visible=new Set(matches);for(const hit of matches){let next=hit;const seen=new Set<string>();while(!seen.has(next)){seen.add(next);const edge=edges.find(edge=>edge.type==='administrative'&&edge.subordinate===next);if(!edge)break;visible.add(edge.manager);next=edge.manager;}for(const edge of edges)if(edge.type==='administrative'&&edge.manager===hit)visible.add(edge.subordinate);}
 return visible;
}
