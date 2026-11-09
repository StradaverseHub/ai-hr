/** One read-only native log codec. No DB, app, Vitest, execution or authority API.
 * Mechanically extracted typed bodies; inverse source record retains all originals. */
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {gunzipSync,inflateRawSync} from 'node:zlib';
const MiB=1024*1024;
export const employeeChoiceNativeLogBounds=Object.freeze({partRawBytes:8*MiB,rawAggregateBytes:128*MiB,gzipAggregateBytes:32*MiB,indexBytes:2*MiB,parts:128,recordBytes:64*MiB,phaseBytes:64*MiB,memberBytes:64*MiB,checkpointMs:20000});
const sha=(value)=>createHash('sha256').update(value).digest('hex');
export function employeeChoiceNativeLogPartBytes(gzip,part){
 if(!Number.isSafeInteger(part.rawBytes)||part.rawBytes<1||part.rawBytes>employeeChoiceNativeLogBounds.partRawBytes||gzip.length>employeeChoiceNativeLogBounds.memberBytes
  ||gzip.length!==part.gzipBytes||sha(gzip)!==part.gzipSha256||gzip.length<18||gzip[0]!==31||gzip[1]!==139||gzip[2]!==8||gzip[3]!==0||gzip.readUInt32LE(gzip.length-4)!==part.rawBytes)throw Error('Exact single native gzip member required');
 // A native raw-deflate decoder reports the exact consumed stream length. This
 // rejects trailing/concatenated members even if a final empty member or equal
 // ISIZE could otherwise mask their presence. gunzip separately validates CRC.
 const stream=inflateRawSync(gzip.subarray(10,gzip.length-8),{info:true,maxOutputLength:employeeChoiceNativeLogBounds.partRawBytes});
 if(!stream||typeof stream!=='object'||!('engine'in stream)||!stream.engine||typeof stream.engine!=='object'||!('bytesWritten'in stream.engine)
  ||stream.engine.bytesWritten!==gzip.length-18||!('buffer'in stream)||!Buffer.isBuffer(stream.buffer))throw Error('Trailing or concatenated native gzip member');
 const raw=gunzipSync(gzip,{maxOutputLength:employeeChoiceNativeLogBounds.partRawBytes});
 if(raw.length!==part.rawBytes||sha(raw)!==part.rawSha256||!raw.equals(stream.buffer))throw Error('Native raw part bytes differ');return raw;
}
/** Pure bounded PG16 log parsing; native provenance is checked separately. */
/** Parse real PG16 auto_explain JSON objects, retaining native error context.
 * Synthetic parser tests establish parsing only; a source hash never replaces a plan. */
export function employeeChoiceAutoExplainMessages(log,pid){
 if(Buffer.byteLength(log)>64*1024*1024||!Number.isSafeInteger(pid)||pid<1)throw Error('Unbounded native plan log');
 const headers=[...log.matchAll(/^.*?\[([0-9]+)\]\s+(?:LOG|NOTICE|WARNING|ERROR|FATAL|PANIC):/gm)];
 if(headers.length>100000)throw Error('Excessive native log messages');
 const result=[];
 for(let index=0;index<headers.length;index++){
  const header=headers[index];if(Number(header[1])!==pid)continue;
  const text=log.slice(header.index+header[0].length,headers[index+1]?.index??log.length);
  const timing=/^\s*duration:\s*([0-9]+(?:\.[0-9]+)?)\s+ms\s+plan:\s*/.exec(text);if(!timing)continue;
  const source=text.slice(timing[0].length);if(source[0]!=='{')throw Error('Native plan JSON object required');
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let position=0;position<source.length;position++){
   const char=source[position];
   if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
   if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){end=position+1;break;}
  }
  if(end<0)throw Error('Truncated native plan JSON');
  const document=JSON.parse(source.slice(0,end));
  if(!document||typeof document!=='object'||Array.isArray(document)||!('Query Text'in document)||typeof document['Query Text']!=='string'
   ||!('Plan'in document)||!document.Plan||typeof document.Plan!=='object'||Array.isArray(document.Plan))throw Error('Native executable plan fields required');
  const durationMs=Number(timing[1]);if(!Number.isFinite(durationMs)||durationMs<0)throw Error('Finite native plan duration required');
  result.push({pid,durationMs,query:document['Query Text'],document:document,context:source.slice(end)});
 }
 return result;
}
export const employeeChoiceSqlFingerprint=(sql)=>createHash('sha256').update(sql.trim().replace(/;$/,'').replace(/\s+/g,' ').toLowerCase()).digest('hex');
export function employeeChoiceNativeBody(source){
 const begin=source.indexOf(' RETURN QUERY WITH'),end=source.indexOf('\nEND;\n$employee_choice$;');
 if(begin<0||end<=begin)throw Error('Fixed native purpose body missing');
 return source.slice(begin+' RETURN QUERY '.length,end).trim();
}
/** Require both the real nested statement and its actual function invocation.
 * An outer Function Scan alone cannot establish the work performed inside it. */
export function employeeChoiceNativeInvocation(entries,body,expectedRows){
 if(!Number.isSafeInteger(expectedRows)||expectedRows<0)throw Error('Independent native stream count required');
 const bodyHash=employeeChoiceSqlFingerprint(body),bodies=entries.filter(entry=>employeeChoiceSqlFingerprint(entry.query)===bodyHash);
 const invocations=entries.filter(entry=>/\bapp\.employee_choice_native_prototype\s*\(/i.test(entry.query)&&employeeChoiceSqlFingerprint(entry.query)!==bodyHash);
 if(bodies.length!==1||invocations.length!==1)throw Error('One actual body and outer function invocation required');
 const actual=(node)=>{
  if(node['Actual Loops']!==1||node['Actual Rows']!==expectedRows)throw Error('Actual native returned stream count differs from independent fixture');
 };
 const bodyPlan=bodies[0].document.Plan;if(!bodyPlan||typeof bodyPlan!=='object'||Array.isArray(bodyPlan))throw Error('Actual native body plan required');
 const nativeBodyPlan=bodyPlan;actual(nativeBodyPlan);
 const scans=[];
 const visit=(node)=>{
  if(!node||typeof node!=='object'||Array.isArray(node))throw Error('Actual native invocation plan required');
  const value=node;if(value['Node Type']==='Function Scan')scans.push(value);
  if(value.Plans!==undefined&&!Array.isArray(value.Plans))throw Error('Actual native invocation children required');
  for(const child of value.Plans??[])visit(child);
 };
 visit(invocations[0].document.Plan);if(scans.length!==1||scans[0]['Function Name']!=='employee_choice_native_prototype')throw Error('One actual outer native Function Scan required');actual(scans[0]);
 return {expectedRows,nestedRows:nativeBodyPlan['Actual Rows'],functionRows:scans[0]['Actual Rows'],nestedDurationMs:bodies[0].durationMs};
}
/** Every real body and outer invocation is paired in native log order. A second
 * projection scan is measured separately, never folded into the old single-call proof. */
export function employeeChoiceNativeInvocations(entries,body,expected){
 const hash=employeeChoiceSqlFingerprint(body),bodyIndices=[],outerIndices=[];
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
  const assignmentHydration=call.assignmentPageRows===undefined?undefined:employeeChoiceNativeProjectionAssignments(entries[inner].document.Plan,call.assignmentPageRows);
  result.push({port:call.port,...invocation,...(membership?{membership}:{}),...(serverScope?{serverScope}:{}),...(pagination?{pagination}:{}),...(assignmentHydration?{assignmentHydration}:{})});previous=outer;
 }
 return result;
}
/** A row/loop envelope cannot bound per-row ScalarArrayOp comparisons. For each
 * real projection, bind the independently expected COMPLETE match set to the
 * materialized unnest and its one-time hashed membership subplan. This oracle
 * alone is synthetic; its caller must first bind actual PID/source/body/port. */
export function employeeChoiceNativeProjectMembership(plan,matchedIds){
 return completeNativeMembership(plan,matchedIds,'employee_choice_project_ids',/\bANY\s*\(\s*\(*\s*(?:\$20\b|p_matched_ids\b)/i);
}
export function employeeChoiceNativeServerMembership(plan,scopeIds){
 return{...completeNativeMembership(plan,scopeIds,'employee_choice_scope_ids',/\bANY\s*\(\s*\(*\s*(?:\$8\b|p_employee_scope\b)/i),scopeIds};
}
function completeNativeMembership(plan,matchedIds,cte,linear){
 if(typeof matchedIds!=='number'||!Number.isSafeInteger(matchedIds)||matchedIds<1)throw Error('Independent complete projection match count required');
 
 const nodes=[],children=new Map();
 function visit(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Actual projection plan node required');
  const node=value;nodes.push(node);if(nodes.length>100000)throw Error('Projection plan node bound exceeded');
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
 const descendants=(node)=>[node,...(children.get(node)??[]).flatMap(descendants)];
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
export function employeeChoiceNativePagination(plan,expected){
 const {total,offset,limit}=expected;
 if(!Number.isSafeInteger(total)||total<1||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>2000)throw Error('Independent native pagination facts required');
 const k=Math.max(0,Math.min(limit,total-offset)),r=Math.max(0,total-offset-k),direction=offset<=r?'ascending':'descending';
 if(k===0)throw Error('Nonempty actual pagination proof required');
 const nodes=[];
 const visit=(value)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Actual pagination plan node required');
  const node=value;nodes.push(node);if(nodes.length>100000||node.Plans!==undefined&&!Array.isArray(node.Plans))throw Error('Bounded pagination children required');
  for(const child of node.Plans??[])visit(child);return node;
 };
 visit(plan);
 const descendants=(node)=>[node,...((node.Plans??[])).flatMap(descendants)];
 const branches=['ascending','descending'].map(name=>{
  const roots=nodes.filter(node=>node['Subplan Name']==='CTE employee_choice_page_'+name);
  if(roots.length!==1)throw Error('Both actual native pagination branches required');
  return{name,nodes:descendants(roots[0])};
 });
 const active=branches.find(branch=>branch.name===direction),inactive=branches.find(branch=>branch.name!==direction);
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
export function bindEmployeeChoiceNativePlans(messages,markers,body){
 const known=new Map();
 for(const marker of markers)for(const edge of ['begin','end']){const key=employeeChoiceSqlFingerprint(marker[edge]);if(known.has(key))throw Error('Duplicate native plan marker');known.set(key,{marker,edge});}
 const results=new Map(),completed=new Set();let active;
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
  if(active)results.get(active.label).push(message);
 }
 if(active||completed.size!==markers.length)throw Error('Incomplete actual native plan phases');
 for(const marker of markers){
  const entries=results.get(marker.label);if(!entries.length)throw Error('Missing actual phase plans');
  const bodies=entries.filter(entry=>employeeChoiceSqlFingerprint(entry.query)===bodyHash);
  if(marker.native){
   const expected=marker.expectedNativeCalls?.length??1;
   if(bodies.length!==expected||bodies.some(entry=>!entry.context.includes('employee_choice_native_prototype(')||!/at RETURN QUERY/i.test(entry.context)))throw Error('Actual nested native body/context proof required for every call');
   if(marker.expectedNativeCalls)employeeChoiceNativeInvocations(entries,body,marker.expectedNativeCalls);
  }else if(bodies.length)throw Error('Current-root control unexpectedly used the prototype');
 }
 return results;
}

/** Actual source-work proof for identity-only projection. The fixture independently
 * supplies its page size; no current plan cardinality chooses this work budget. */
export function employeeChoiceNativeProjectionAssignments(plan,pageRows){
 if(!Number.isSafeInteger(pageRows)||pageRows<1||pageRows>2000)throw Error('Independent bounded native page required');
 let nodes=0,boundedRoots=0,boundedSources=0,probes=0,tupleWork=0;
 const counter=(node,key,optional=false)=>{const value=node[key]??(optional?0:NaN);if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('Invalid native assignment counter');return value;};
 const visit=(value,within=false)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||++nodes>100000)throw Error('Bounded actual native assignment plan required');
  const node=value,root=node['Subplan Name']==='CTE employee_choice_page_assignments',inside=within||root;
  if(root)boundedRoots++;
  if(node['Relation Name']==='assignment'){
   const loops=counter(node,'Actual Loops'),rows=counter(node,'Actual Rows'),removed=['Rows Removed by Filter','Rows Removed by Join Filter','Rows Removed by Index Recheck','Rows Removed by Conflict Filter'].reduce((sum,key)=>sum+counter(node,key,true),0);
   if(!inside&&(loops!==0||rows!==0||removed!==0))throw Error('Full Assignment source executed during bounded projection');
   if(inside){boundedSources++;probes+=loops;tupleWork+=loops*(rows+removed);}
  }
  if(node.Plans!==undefined&&!Array.isArray(node.Plans))throw Error('Native assignment children required');
  for(const child of node.Plans??[])visit(child,inside);
 };
 visit(plan);
 if(boundedRoots!==1||boundedSources<1||probes!==pageRows||tupleWork!==pageRows)throw Error('Native Assignment hydration exceeded independent page bound');
 return{kind:'ACTUAL_PAGE_ONLY_ASSIGNMENT_HYDRATION',pageRows,boundedSources,probes,tupleWork,fullAssignmentSourceWork:0};
}

/** Continuous native framing. Raw retention and semantic qualification stay separate. */
const header=/^.*?\[([0-9]+)\]\s+(?:LOG|NOTICE|WARNING|ERROR|FATAL|PANIC):/gm;
export function* employeeChoiceNativeLogRecords(parts){
 const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',records=0;
 function* take(final){
  const matches=[...pending.matchAll(new RegExp(header.source,'gm'))];
  if(matches.length>100000)throw Error('Excessive native log messages');
  const count=final?matches.length:Math.max(0,matches.length-1);
  for(let i=0;i<count;i++){
   const begin=matches[i].index,end=matches[i+1]?.index??pending.length,text=pending.slice(begin,end),bytes=Buffer.byteLength(text);
   if(++records>100000||bytes>employeeChoiceNativeLogBounds.recordBytes)throw Error('Native log record bound exceeded');
   yield{pid:Number(matches[i][1]),bytes,text};
  }
  if(final)pending='';else if(matches.length)pending=pending.slice(matches.at(-1).index);
  if(Buffer.byteLength(pending)>employeeChoiceNativeLogBounds.recordBytes)throw Error('Incomplete native record exceeds bound');
 }
 for(const part of parts){pending+=decoder.decode(part.bytes,{stream:true});yield* take(false);}
 pending+=decoder.decode();yield* take(true);
}
/** One real phase in memory at a time, with the original binder/oracles. Every
 * record is still visited: a native body outside its actual phase refuses. */
export function* employeeChoiceNativePlanPhases(parts,pid,markers,body){
 const known=new Map(),completed=new Set(),bodyKey=employeeChoiceSqlFingerprint(body);
 for(const marker of markers)for(const edge of ['begin','end']){const key=employeeChoiceSqlFingerprint(marker[edge]);if(known.has(key))throw Error('Duplicate native plan marker');known.set(key,{marker,edge});}
 let active,entries=[],bytes=0;
 for(const record of employeeChoiceNativeLogRecords(parts)){
  if(active){bytes+=record.bytes;if(bytes>employeeChoiceNativeLogBounds.phaseBytes)throw Error('Native phase exceeds64MiB');}
  if(record.pid!==pid)continue;
  for(const message of employeeChoiceAutoExplainMessages(record.text,pid)){
   const key=employeeChoiceSqlFingerprint(message.query),boundary=known.get(key);
   if(boundary?.edge==='begin'){
    if(active||completed.has(boundary.marker.label))throw Error('Duplicate or nested native plan phase');
    if(markers[completed.size]!==boundary.marker)throw Error('Actual native phase order differs from canonical marker order');
    active=boundary.marker;entries=[message];bytes=record.bytes;continue;
   }
   if(key===bodyKey&&(!active||!active.native))throw Error('Native body plan outside its admitted phase');
   if(active)entries.push(message);
   if(boundary?.edge==='end'){
    if(!active||active.label!==boundary.marker.label)throw Error('Unmatched native plan phase');
    const bound=bindEmployeeChoiceNativePlans(entries,[active],body),label=active.label;completed.add(label);active=undefined;entries=[];bytes=0;
    yield{label,entries:bound.get(label)};
   }
  }
 }
 if(active||completed.size!==markers.length)throw Error('Incomplete actual native plan phases');
}
/** End-marker readiness does not await the NEXT record header. Its trailing
 * native context remains in raw parts and is checked by the final full framer. */
export function employeeChoiceNativeMarkerObserver(pid,onMarker){
 const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',markerRecord=false,notified=false,bytes=0,candidate='',querySeen=false;
 return{append(value){
  pending+=decoder.decode(value,{stream:true});
  let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end+1);pending=pending.slice(end+1);
   header.lastIndex=0;const start=header.exec(line);
   if(start){markerRecord=Number(start[1])===pid&&/duration:.*ms\s+plan:/.test(line);notified=false;bytes=0;candidate='';querySeen=false;}
   bytes+=Buffer.byteLength(line);if(bytes>employeeChoiceNativeLogBounds.recordBytes)throw Error('Live native record exceeds bound');
   // The canonical marker query is a single JSON string property. Parse that
   // property natively, never reconstruct or execute any logged statement.
   if(markerRecord&&!notified){if(!querySeen)candidate+=line;const query=/^\s*"Query Text":\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/.exec(line);
    if(query){const text=JSON.parse(query[1]);if(typeof text!=='string')throw Error('Native marker query string required');querySeen=true;if(!/^select 1 as "aihr_ecp_[a-f0-9]{24}_(?:begin|end)"$/i.test(text.trim())){markerRecord=false;candidate='';}}
    else if(querySeen)candidate+=line;
    if(querySeen&&markerRecord){let depth=0,quoted=false,escaped=false,complete=false;const begin=candidate.indexOf('{');
     for(const char of candidate.slice(begin)){if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}else if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){complete=true;break;}}
     if(complete){const messages=employeeChoiceAutoExplainMessages(candidate,pid);if(messages.length!==1)throw Error('One complete native marker required');notified=true;onMarker(messages[0].query);}
    }
   }
  }
  if(Buffer.byteLength(pending)>employeeChoiceNativeLogBounds.recordBytes)throw Error('Live native partial line exceeds bound');
 },finish(){decoder.decode();if(pending)throw Error('Native follower ended with a partial line');}};
}

const removedFields=['Rows Removed by Filter','Rows Removed by Join Filter','Rows Removed by Index Recheck','Rows Removed by Conflict Filter'];
const keys=['employment','person','assignment','company','department','businessUnit'];
export function employeeChoicePlanLimits(counts){
 if(keys.some(key=>!Number.isSafeInteger(counts[key])||counts[key]<0))throw Error('Invalid exact native cardinalities');
 const scaleRows=Math.max(1,...keys.map(key=>counts[key]));
 // Linear below the retained50k benchmark scale, capped at its original work/buffer
 // ceilings. A larger future fixture requires review, never an automatic larger budget.
 return{scaleScope:'largest exact whole-owned-fixture base relation, all fixture tenants; not reltuples or authorized output count',scaleRows,
  maxNodeWork:Math.min(1_600_000,32*scaleRows),maxRootSharedBlocks:Math.min(150_000,Math.max(4096,3*scaleRows)),
  metric:'Actual Loops * (Actual Rows + four Rows Removed counters); PostgreSQL per-loop averages may be rounded'};
}
export function employeeChoicePlanWork(plan,counts){
 const limits=employeeChoicePlanLimits(counts),nodes=[],rejectionReasons=[];let maximumNodeWork=0;
 const counter=(node,key,required=false)=>{
  const value=node[key]??(required?NaN:0);if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('Invalid actual plan counter: '+key);return value;
 };
 const visit=(node,path)=>{
  const loops=counter(node,'Actual Loops',true),rows=counter(node,'Actual Rows',true),removed=Object.fromEntries(removedFields.map(key=>[key,counter(node,key)]));
  const work=loops*(rows+Object.values(removed).reduce((sum,value)=>sum+value,0));
  maximumNodeWork=Math.max(maximumNodeWork,work);
  if(!Number.isFinite(work)||work>limits.maxNodeWork)rejectionReasons.push(path+':node-work');
  nodes.push({path,nodeType:node['Node Type'],relation:node['Relation Name']??null,index:node['Index Name']??null,cte:node['CTE Name']??null,loops,rows,removed,work});
  if(node.Plans!==undefined&&!Array.isArray(node.Plans))throw Error('Invalid actual plan children');
  for(const [index,child]of ((node.Plans??[])).entries())visit(child,path+'.'+index);
 };
 visit(plan,'root');
 const rootSharedBlocks=counter(plan,'Shared Hit Blocks',true)+counter(plan,'Shared Read Blocks',true);
 if(rootSharedBlocks>limits.maxRootSharedBlocks)rejectionReasons.push('root:shared-blocks');
 return{kind:'DEVELOPMENT_COMPLEXITY_REJECTION_ONLY',limits,rootSharedBlocks,maximumNodeWork,nodes,rejectionReasons};
}
