/** Pure bounded PG16 log parsing; native provenance is checked separately. */
import {createHash} from 'node:crypto';
export type AutoExplainMessage={pid:number;durationMs:number;query:string;document:Record<string,unknown>;context:string};
/** Parse real PG16 auto_explain JSON objects, retaining native error context.
 * Synthetic parser tests establish parsing only; a source hash never replaces a plan. */
export function employeeChoiceAutoExplainMessages(log:string,pid:number):AutoExplainMessage[]{
 if(Buffer.byteLength(log)>64*1024*1024||!Number.isSafeInteger(pid)||pid<1)throw Error('Unbounded native plan log');
 const headers=[...log.matchAll(/^.*?\[([0-9]+)\]\s+(?:LOG|NOTICE|WARNING|ERROR|FATAL|PANIC):/gm)];
 if(headers.length>100000)throw Error('Excessive native log messages');
 const result:AutoExplainMessage[]=[];
 for(let index=0;index<headers.length;index++){
  const header=headers[index];if(Number(header[1])!==pid)continue;
  const text=log.slice(header.index!+header[0].length,headers[index+1]?.index??log.length);
  const timing=/^\s*duration:\s*([0-9]+(?:\.[0-9]+)?)\s+ms\s+plan:\s*/.exec(text);if(!timing)continue;
  const source=text.slice(timing[0].length);if(source[0]!=='{')throw Error('Native plan JSON object required');
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let position=0;position<source.length;position++){
   const char=source[position];
   if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
   if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){end=position+1;break;}
  }
  if(end<0)throw Error('Truncated native plan JSON');
  const document:unknown=JSON.parse(source.slice(0,end));
  if(!document||typeof document!=='object'||Array.isArray(document)||!('Query Text'in document)||typeof document['Query Text']!=='string'
   ||!('Plan'in document)||!document.Plan||typeof document.Plan!=='object'||Array.isArray(document.Plan))throw Error('Native executable plan fields required');
  const durationMs=Number(timing[1]);if(!Number.isFinite(durationMs)||durationMs<0)throw Error('Finite native plan duration required');
  result.push({pid,durationMs,query:document['Query Text'],document:document as Record<string,unknown>,context:source.slice(end)});
 }
 return result;
}
export const employeeChoiceSqlFingerprint=(sql:string)=>createHash('sha256').update(sql.trim().replace(/;$/,'').replace(/\s+/g,' ').toLowerCase()).digest('hex');
export function employeeChoiceNativeBody(source:string){
 const begin=source.indexOf(' RETURN QUERY WITH'),end=source.indexOf('\nEND;\n$employee_choice$;');
 if(begin<0||end<=begin)throw Error('Fixed native purpose body missing');
 return source.slice(begin+' RETURN QUERY '.length,end).trim();
}
export type NativePageExpectation={total:number;offset:number;limit:number};
export type NativeCallExpectation={port:'page'|'ids'|'project';rows:number;matchedIds?:number;serverScopeIds?:number;pagination?:NativePageExpectation};
export type PlanMarker={label:string;begin:string;end:string;native:boolean;expectedNativeRows?:number;expectedNativeCalls?:readonly NativeCallExpectation[]};
/** Require both the real nested statement and its actual function invocation.
 * An outer Function Scan alone cannot establish the work performed inside it. */
export function employeeChoiceNativeInvocation(entries:readonly AutoExplainMessage[],body:string,expectedRows:number){
 if(!Number.isSafeInteger(expectedRows)||expectedRows<0)throw Error('Independent native stream count required');
 const bodyHash=employeeChoiceSqlFingerprint(body),bodies=entries.filter(entry=>employeeChoiceSqlFingerprint(entry.query)===bodyHash);
 const invocations=entries.filter(entry=>/\bapp\.employee_choice_native_prototype\s*\(/i.test(entry.query)&&employeeChoiceSqlFingerprint(entry.query)!==bodyHash);
 if(bodies.length!==1||invocations.length!==1)throw Error('One actual body and outer function invocation required');
 const actual=(node:Record<string,unknown>)=>{
  if(node['Actual Loops']!==1||node['Actual Rows']!==expectedRows)throw Error('Actual native returned stream count differs from independent fixture');
 };
 const bodyPlan=bodies[0].document.Plan;if(!bodyPlan||typeof bodyPlan!=='object'||Array.isArray(bodyPlan))throw Error('Actual native body plan required');
 const nativeBodyPlan=bodyPlan as Record<string,unknown>;actual(nativeBodyPlan);
 const scans:Record<string,unknown>[]=[];
 const visit=(node:unknown)=>{
  if(!node||typeof node!=='object'||Array.isArray(node))throw Error('Actual native invocation plan required');
  const value=node as Record<string,unknown>;if(value['Node Type']==='Function Scan')scans.push(value);
  if(value.Plans!==undefined&&!Array.isArray(value.Plans))throw Error('Actual native invocation children required');
  for(const child of value.Plans??[])visit(child);
 };
 visit(invocations[0].document.Plan);if(scans.length!==1||scans[0]['Function Name']!=='employee_choice_native_prototype')throw Error('One actual outer native Function Scan required');actual(scans[0]);
 return {expectedRows,nestedRows:nativeBodyPlan['Actual Rows'],functionRows:scans[0]['Actual Rows'],nestedDurationMs:bodies[0].durationMs};
}
/** Every real body and outer invocation is paired in native log order. A second
 * projection scan is measured separately, never folded into the old single-call proof. */
export function employeeChoiceNativeInvocations(entries:readonly AutoExplainMessage[],body:string,expected:readonly NativeCallExpectation[]){
 const hash=employeeChoiceSqlFingerprint(body),bodyIndices:number[]=[],outerIndices:number[]=[];
 for(const [index,entry]of entries.entries()){
  if(employeeChoiceSqlFingerprint(entry.query)===hash)bodyIndices.push(index);
  else if(/\bapp\.employee_choice_native_prototype\s*\(/i.test(entry.query))outerIndices.push(index);
 }
 if(bodyIndices.length!==expected.length||outerIndices.length!==expected.length)throw Error('Every actual native call/body must be accounted separately');
 const result=[];let previous=-1;
 for(const [index,call]of expected.entries()){
  const inner=bodyIndices[index],outer=outerIndices[index];
  if(inner<=previous||inner>=outer)throw Error('Native body/outer invocation sequence is unbound');
  const entry=entries[outer],ports=[...entry.query.matchAll(/\/\* employee-choice-native:(page|ids|project) \*\//g)].map(match=>match[1]);
  if(ports.length!==1||ports[0]!==call.port)throw Error('Actual native purpose differs from independently expected call sequence');
  if(!entries[inner].context.includes('employee_choice_native_prototype(')||!/at RETURN QUERY/i.test(entries[inner].context))throw Error('Actual native call body context required');
  const invocation=employeeChoiceNativeInvocation([entries[inner],entry],body,call.rows);
  const membership=call.port==='project'?employeeChoiceNativeProjectMembership(entries[inner].document.Plan,call.matchedIds):undefined;
  const serverScope=call.serverScopeIds===undefined?undefined:employeeChoiceNativeServerMembership(entries[inner].document.Plan,call.serverScopeIds);
  const pagination=call.pagination===undefined?undefined:employeeChoiceNativePagination(entries[inner].document.Plan,call.pagination);
  result.push({port:call.port,...invocation,...(membership?{membership}:{}),...(serverScope?{serverScope}:{}),...(pagination?{pagination}:{})});previous=outer;
 }
 return result;
}
/** A row/loop envelope cannot bound per-row ScalarArrayOp comparisons. For each
 * real projection, bind the independently expected COMPLETE match set to the
 * materialized unnest and its one-time hashed membership subplan. This oracle
 * alone is synthetic; its caller must first bind actual PID/source/body/port. */
export function employeeChoiceNativeProjectMembership(plan:unknown,matchedIds:unknown){
 return completeNativeMembership(plan,matchedIds,'employee_choice_project_ids',/\bANY\s*\(\s*\(*\s*(?:\$20\b|p_matched_ids\b)/i);
}
export function employeeChoiceNativeServerMembership(plan:unknown,scopeIds:unknown){
 return{...completeNativeMembership(plan,scopeIds,'employee_choice_scope_ids',/\bANY\s*\(\s*\(*\s*(?:\$8\b|p_employee_scope\b)/i),scopeIds};
}
function completeNativeMembership(plan:unknown,matchedIds:unknown,cte:string,linear:RegExp){
 if(typeof matchedIds!=='number'||!Number.isSafeInteger(matchedIds)||matchedIds<1)throw Error('Independent complete projection match count required');
 type Node=Record<string,unknown>;
 const nodes:Node[]=[],children=new Map<Node,Node[]>();
 function visit(value:unknown):Node{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Actual projection plan node required');
  const node=value as Node;nodes.push(node);if(nodes.length>100000)throw Error('Projection plan node bound exceeded');
  if(node.Plans!==undefined&&!Array.isArray(node.Plans))throw Error('Projection plan children required');
  children.set(node,(node.Plans??[]).map(visit));return node;
 }
 visit(plan);
 const predicates=['Filter','Index Cond','Recheck Cond','Hash Cond','Merge Cond','Join Filter','TID Cond','One-Time Filter'];
 for(const node of nodes)for(const key of predicates){const expression=node[key];
  if(typeof expression==='string'&&linear.test(expression))throw Error('Linear matched-ID ScalarArray membership refused');
 }
 const materialized=nodes.filter(node=>node['Subplan Name']==='CTE '+cte);
 if(materialized.length!==1)throw Error('One actual materialized projection set required');
 const descendants=(node:Node):Node[]=>[node,...(children.get(node)??[]).flatMap(descendants)];
 const unnest=descendants(materialized[0]).filter(node=>node['Node Type']==='Function Scan'&&node['Function Name']==='unnest');
 if(unnest.length!==1||unnest[0]['Actual Loops']!==1||unnest[0]['Actual Rows']!==matchedIds)throw Error('Complete projection set must be unnested exactly once');
 const scans=nodes.filter(node=>node['Node Type']==='CTE Scan'&&node['CTE Name']===cte);
 if(scans.length!==1||scans[0]['Actual Loops']!==1||scans[0]['Actual Rows']!==matchedIds
  ||scans[0]['Parent Relationship']!=='SubPlan'||typeof scans[0]['Subplan Name']!=='string'
  ||!/^SubPlan [1-9][0-9]*$/.test(scans[0]['Subplan Name']))throw Error('Complete one-time projection membership scan required');
 const hashed=new RegExp('\\bhashed '+scans[0]['Subplan Name']+'\\b');
 const employment=nodes.filter(node=>node['Relation Name']==='employment'&&typeof node.Filter==='string'&&hashed.test(node.Filter));
 if(employment.length!==1||employment[0]['Actual Loops']!==1)throw Error('Actual employment filter must use its complete hashed projection set');
 return{kind:'ACTUAL_COMPLETE_MATERIALIZED_HASHED_MEMBERSHIP',matchedIds,unnestRows:unnest[0]['Actual Rows'],unnestLoops:1,
  membershipRows:scans[0]['Actual Rows'],membershipLoops:1,hashedSubplan:scans[0]['Subplan Name'],linearMatchedArrayRefused:true};
}
/** Native branch/sort proof, bound to independently known N/O/L rather than
 * trusting a claimed direction or output count. Both branches must exist; the
 * unused branch's actual source/sort/limit work must remain unexecuted. */
export function employeeChoiceNativePagination(plan:unknown,expected:NativePageExpectation){
 const {total,offset,limit}=expected;
 if(!Number.isSafeInteger(total)||total<1||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>2000)throw Error('Independent native pagination facts required');
 const k=Math.max(0,Math.min(limit,total-offset)),r=Math.max(0,total-offset-k),direction=offset<=r?'ascending':'descending';
 if(k===0)throw Error('Nonempty actual pagination proof required');
 type Node=Record<string,unknown>;const nodes:Node[]=[];
 const visit=(value:unknown):Node=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Actual pagination plan node required');
  const node=value as Node;nodes.push(node);if(nodes.length>100000||node.Plans!==undefined&&!Array.isArray(node.Plans))throw Error('Bounded pagination children required');
  for(const child of node.Plans??[])visit(child);return node;
 };
 visit(plan);
 const descendants=(node:Node):Node[]=>[node,...((node.Plans??[])as Node[]).flatMap(descendants)];
 const branches=['ascending','descending'].map(name=>{
  const roots=nodes.filter(node=>node['Subplan Name']==='CTE employee_choice_page_'+name);
  if(roots.length!==1)throw Error('Both actual native pagination branches required');
  return{name,nodes:descendants(roots[0])};
 });
 const active=branches.find(branch=>branch.name===direction)!,inactive=branches.find(branch=>branch.name!==direction)!;
 // The gate may run once to decide not to enter its lateral child. Every
 // actual matching-source, Sort and Limit beneath it must have zero loops.
 const inactiveSorts=inactive.nodes.filter(node=>node['Node Type']==='Sort'),inactiveLimits=inactive.nodes.filter(node=>node['Node Type']==='Limit'),
  inactiveSources=inactive.nodes.filter(node=>node['CTE Name']==='employee_choice_matching');
 const work=[...inactiveSorts,...inactiveLimits,...inactiveSources];
 if(inactiveSorts.length!==1||inactiveLimits.length!==1||inactiveSources.length!==1||work.some(node=>node['Actual Loops']!==0||node['Actual Rows']!==0))throw Error('Unused native pagination branch executed or missing');
 const sorts=active.nodes.filter(node=>node['Node Type']==='Sort'),scans=active.nodes.filter(node=>node['CTE Name']==='employee_choice_matching'),limits=active.nodes.filter(node=>node['Node Type']==='Limit');
 const rowGoal=(direction==='ascending'?offset:r)+k;
 if(sorts.length!==1||scans.length!==1||limits.length!==1||sorts[0]['Actual Loops']!==1||scans[0]['Actual Loops']!==1||scans[0]['Actual Rows']!==total
  ||limits[0]['Actual Loops']!==1||limits[0]['Actual Rows']!==k||sorts[0]['Actual Rows']!==rowGoal||sorts[0]['Sort Method']!=='top-N heapsort'||sorts[0]['Sort Space Type']!=='Memory')throw Error('Actual bounded top-N native pagination required');
 const keys=sorts[0]['Sort Key'];
 if(!Array.isArray(keys)||keys.length!==2||typeof keys[0]!=='string'||typeof keys[1]!=='string'
  ||!(direction==='ascending'?/\.name$/:/\.name DESC$/).test(keys[0])
  ||!(direction==='ascending'?/\."employmentId"$/:/\."employmentId" DESC$/).test(keys[1]))throw Error('Native name/employment tuple direction differs');
 return{kind:'ACTUAL_NEARER_END_NATIVE_PAGINATION',...expected,k,r,direction,rowGoal,unusedSourceSortLimitLoops:0,sortMethod:sorts[0]['Sort Method']};
}
export function bindEmployeeChoiceNativePlans(messages:readonly AutoExplainMessage[],markers:readonly PlanMarker[],body:string){
 const known=new Map<string,{marker:PlanMarker;edge:'begin'|'end'}>();
 for(const marker of markers)for(const edge of ['begin','end']as const){const key=employeeChoiceSqlFingerprint(marker[edge]);if(known.has(key))throw Error('Duplicate native plan marker');known.set(key,{marker,edge});}
 const results=new Map<string,AutoExplainMessage[]>(),completed=new Set<string>();let active:PlanMarker|undefined;
 const bodyHash=employeeChoiceSqlFingerprint(body);
 for(const message of messages){
  const key=employeeChoiceSqlFingerprint(message.query),boundary=known.get(key);
  if(boundary){
   if(boundary.edge==='begin'){if(active||results.has(boundary.marker.label))throw Error('Duplicate or nested native plan phase');active=boundary.marker;results.set(active.label,[]);}
   else{if(!active||active.label!==boundary.marker.label)throw Error('Unmatched native plan phase');completed.add(active.label);active=undefined;}
   continue;
  }
  const native=key===bodyHash;
  if(native&&(!active||!active.native))throw Error('Native body plan outside its admitted phase');
  if(active)results.get(active.label)!.push(message);
 }
 if(active||completed.size!==markers.length)throw Error('Incomplete actual native plan phases');
 for(const marker of markers){
  const entries=results.get(marker.label)!;if(!entries.length)throw Error('Missing actual phase plans');
  const bodies=entries.filter(entry=>employeeChoiceSqlFingerprint(entry.query)===bodyHash);
  if(marker.native){
   const expected=marker.expectedNativeCalls?.length??1;
   if(bodies.length!==expected||bodies.some(entry=>!entry.context.includes('employee_choice_native_prototype(')||!/at RETURN QUERY/i.test(entry.context)))throw Error('Actual nested native body/context proof required for every call');
   if(marker.expectedNativeCalls)employeeChoiceNativeInvocations(entries,body,marker.expectedNativeCalls);
  }else if(bodies.length)throw Error('Current-root control unexpectedly used the prototype');
 }
 return results;
}
