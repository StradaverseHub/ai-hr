/** Independent, pure SOURCE replay. Never imports or calls a classifier as its oracle. */
const refuse=()=>{throw Error('Independent classifier source witness refused');};
const need=value=>{if(!value)refuse();};
const canonical=value=>{
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){need(Number.isFinite(value)&&!Object.is(value,-0));return value;}
 if(Array.isArray(value))return value.map(canonical);
 need(value&&Object.getPrototypeOf(value)===Object.prototype);const out=Object.create(null);for(const key of Object.keys(value).sort())out[key]=canonical(value[key]);return out;
};
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const clean='no database import, call or URL in it or its test/ helpers';
const modules=['test/harness','test/global-setup','db/client','db/schema'];
const packages=['pg','postgres','drizzle-orm/postgres-js','drizzle-orm/node-postgres','drizzle-orm/pg-core'];
const extensions=['','.ts','.tsx','.js','.mjs','.cjs','.mts','/index.ts','/index.tsx','/index.js'];
const textRules=[
 [/\bmigrateTestDb\s*\(/,'calls migrateTestDb('],[/\bresetDb\s*\(/,'calls resetDb('],[/\bwithTenant\s*\(/,'calls withTenant('],
 [/DATABASE_URL/,'mentions a DATABASE_URL'],[/\binject\s*\(\s*['"`]workerDbPrefix/,"inject('workerDbPrefix')"],[/\bpsql\b/,'mentions psql'],
];
function normalise(value){const parts=[];for(const part of value.split('/')){if(!part||part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}return parts.join('/');}
function specifiers(text){
 const specs=[];
 for(const match of text.matchAll(/(?:^|[;\s}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g))specs.push(match[1]);
 for(const match of text.matchAll(/\b(?:import|require|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]\s*[,)]/g))specs.push(match[1]);
 const opaque=/(?<![\w.])(?:import|require)\s*\(\s*(?![\s)'"])/.test(text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,''));
 return{specs,opaque};
}
function inputs(suite,entries){
 need(Array.isArray(suite)&&suite.length>0&&suite.every(file=>typeof file==='string'&&/^test\/.+(?:\.test\.ts|\.dom\.test\.tsx)$/.test(file)&&!/[\s\0]/.test(file)&&!file.split('/').some(p=>!p||p==='.'||p==='..')));
 need(new Set(suite).size===suite.length&&JSON.stringify([...suite].sort())===JSON.stringify(suite));
 need(Array.isArray(entries));const values=new Map(),sourceIds=new Map();
 for(const [id,row]of entries.entries()){
  need(row&&Object.keys(row).sort().join('|')==='path|text'&&typeof row.path==='string'&&(row.text===null||typeof row.text==='string')&&!values.has(row.path));
  if(id)need(entries[id-1].path<row.path);values.set(row.path,row.text);sourceIds.set(row.path,id);
 }
 for(const root of suite)need(values.has(root));
 return{values,sourceIds};
}
/** Complete graph and resolver trace against FULL sealed strings/null. Unknown probes throw. */
export function replayClassifierGraph(suite,entries){
 const{values,sourceIds}=inputs(suite,entries),nodes=[],resolvers=[],ids=new Map();
 const source=path=>{need(values.has(path));return values.get(path);};
 const discover=file=>{if(!ids.has(file)){ids.set(file,nodes.length);nodes.push({id:nodes.length,sourceId:sourceIds.get(file),steps:[],file});}return ids.get(file);};
 for(const root of suite)discover(root);
 function resolve(spec,file,nodeId,importIndex){
  const trace={id:resolvers.length,nodeId,importIndex,specifier:spec,candidates:[],selectedSourceId:null,outcome:'bare'};
  if(!spec.startsWith('.')&&!spec.startsWith('@/')){resolvers.push(trace);return undefined;}
  const slash=file.lastIndexOf('/'),base=normalise(spec.startsWith('@/')?spec.slice(2):`${slash<0?'':file.slice(0,slash)}/${spec}`);
  for(const stem of[base,base.replace(/\.(js|mjs|cjs)$/,'')])for(const extension of extensions){
   const candidate=stem+extension,value=source(candidate);trace.candidates.push(sourceIds.get(candidate));
   if(value!==null){trace.selectedSourceId=sourceIds.get(candidate);trace.outcome='resolved';resolvers.push(trace);return candidate;}
  }
  trace.outcome='missing';resolvers.push(trace);return null;
 }
 for(let index=0;index<nodes.length;index++){
  const node=nodes[index],text=source(node.file),direct=reason=>node.steps.push({kind:'direct',reason:node.file+': '+reason});
  if(text===null){direct('cannot be read');continue;}
  const textRule=textRules.find(([pattern])=>pattern.test(text));if(textRule){direct(textRule[1]);continue;}
  const{specs,opaque}=specifiers(text);if(opaque){direct('a dynamic import()/require() that is not a string literal');continue;}
  for(const[importIndex,spec]of specs.entries()){
   if(packages.some(prefix=>spec===prefix||spec.startsWith(prefix+'/'))){direct('imports '+spec);break;}
   const target=resolve(spec,node.file,node.id,importIndex);if(target===undefined)continue;
   if(target===null){direct(`import '${spec}' does not resolve`);break;}
   const stem=target.replace(/(\/index)?\.(ts|tsx|js|mjs|cjs|mts|json)$/,''),named=modules.find(prefix=>stem===prefix||stem.startsWith(prefix+'/'));
   if(named){direct('imports '+named);break;}
   if(target.startsWith('test/'))node.steps.push({kind:'helper',targetId:discover(target)});
  }
 }
 // Independent monotone fixed point. A cycle never supplies a provisional clean result.
 const hazardous=new Set(nodes.filter(node=>node.steps.some(step=>step.kind==='direct')).map(node=>node.id));
 const parents=nodes.map(()=>new Set());for(const node of nodes)for(const step of node.steps)if(step.kind==='helper')parents[step.targetId].add(node.id);
 const frontier=[...hazardous];for(let index=0;index<frontier.length;index++)for(const parent of parents[frontier[index]])if(!hazardous.has(parent)){hazardous.add(parent);frontier.push(parent);}
 const verdicts=[],witnesses=[];
 for(const[rootId,root]of suite.entries()){
  const id=ids.get(root);if(!hazardous.has(id)){verdicts.push({rootId,kind:'NODB',reason:clean});witnesses.push({rootId,nodeIds:[],directNodeId:null,directStepIndex:null});continue;}
  const visited=new Set([id]),stack=[{id,next:0}];let witness=null;
  while(stack.length&&!witness){
   const frame=stack.at(-1),steps=nodes[frame.id].steps;
   if(frame.next===steps.length){stack.pop();continue;}
   const directStepIndex=frame.next++,step=steps[directStepIndex];
   if(step.kind==='direct'){witness={rootId,nodeIds:stack.map(x=>x.id),directNodeId:frame.id,directStepIndex};verdicts.push({rootId,kind:'DB',reason:step.reason});break;}
   if(hazardous.has(step.targetId)&&!visited.has(step.targetId)){visited.add(step.targetId);stack.push({id:step.targetId,next:0});}
  }
  need(witness);witnesses.push(witness);
 }
 return{graph:{version:1,nodes:nodes.map(({file,...node})=>node),resolvers,hazardous:[...hazardous].sort((a,b)=>a-b)},verdicts,witnesses};
}
/** Complete actual API result, ordered partition and first reasons, not caller counts. */
export function classifierResultRows(suite,result){
 need(result&&Array.isArray(result.db)&&Array.isArray(result.nodb)&&result.why instanceof Map);
 const db=new Set(result.db),nodb=new Set(result.nodb);need(db.size===result.db.length&&nodb.size===result.nodb.length&&result.why.size===suite.length);
 need(result.db.length+result.nodb.length===suite.length&&suite.every(file=>db.has(file)!==nodb.has(file)));
 need(JSON.stringify(suite.filter(file=>db.has(file)))===JSON.stringify(result.db)&&JSON.stringify(suite.filter(file=>nodb.has(file)))===JSON.stringify(result.nodb));
 return suite.map((file,rootId)=>{const reason=result.why.get(file);need(typeof reason==='string');return{rootId,kind:db.has(file)?'DB':'NODB',reason};});
}
/** Mutation detection replays independently from source bytes; JSON graph fields cannot authorize it. */
export function verifyClassifierGraph(suite,entries,claimed){
 const actual=replayClassifierGraph(suite,entries);
 need(equal(claimed,actual));return actual;
}
export function requireGraphMatchesClassifier(suite,entries,result){
 const witness=replayClassifierGraph(suite,entries);need(equal(witness.verdicts,classifierResultRows(suite,result)));return witness;
}
