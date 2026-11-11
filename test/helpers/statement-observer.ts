/** Test-only statement observer for the application pool: counts the statements a piece of work sends (BEGIN, COMMIT,
 * ROLLBACK and savepoint bookkeeping excluded; each transaction's one identity statement included), captures their text
 * and serialised parameters, and can replay a captured sequence under EXPLAIN (ANALYZE) to say where the server's time
 * went. Replays run in one transaction that is rolled back; each statement in its own savepoint, so one failure does
 * not hide the rest. Never a product path: it reads `client.options.debug`, which only tests set. */
import {client} from '../../db/client';

export type Captured=Readonly<{sql:string;params:readonly unknown[]}>;
type Debuggable={options:{debug?:unknown}};
const BOOKKEEPING=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
export const isIdentityStatement=(text:string)=>/^select set_config\('app\.tenant_id'/i.test(text.trim());

export async function observeStatements<T>(work:()=>Promise<T>):Promise<{result:T;ms:number;statements:Captured[];transactions:number}>{
 const options=(client as unknown as Debuggable).options,previous=options.debug,statements:Captured[]=[];
 options.debug=(_connection:number,text:string,params:unknown[])=>{if(!BOOKKEEPING.test(text.trim()))statements.push({sql:text,params:[...(params??[])]});};
 const started=performance.now();
 try{const result=await work();return{result,ms:performance.now()-started,statements,transactions:statements.filter(s=>isIdentityStatement(s.sql)).length};}
 finally{options.debug=previous;}
}

type PlanNode={'Node Type':string;'Relation Name'?:string;'Function Name'?:string;'Index Name'?:string;'Actual Rows'?:number;'Actual Loops'?:number;
 'Actual Total Time'?:number;'Subplan Name'?:string;'Parent Relationship'?:string;Filter?:string;'Rows Removed by Filter'?:number;Plans?:PlanNode[]};
export type PlanHotspot=Readonly<{node:string;relation:string|null;subplan:string|null;rows:number;loops:number;totalMs:number;filter:string|null;removed:number}>;
/** The plan's nodes by total time spent (actual total time × loops), largest first. */
function hotspots(plan:PlanNode,limit=8):PlanHotspot[]{
 const out:PlanHotspot[]=[];
 const walk=(node:PlanNode)=>{
  out.push({node:node['Node Type'],relation:node['Relation Name']??node['Function Name']??node['Index Name']??null,subplan:node['Subplan Name']??null,
   rows:node['Actual Rows']??0,loops:node['Actual Loops']??0,totalMs:Math.round((node['Actual Total Time']??0)*(node['Actual Loops']??1)*100)/100,
   filter:node.Filter?node.Filter.slice(0,240):null,removed:node['Rows Removed by Filter']??0});
  for(const child of node.Plans??[])walk(child);
 };
 walk(plan);
 return out.sort((a,b)=>b.totalMs-a.totalMs).slice(0,limit);
}

export type ExplainedStatement=Readonly<{ordinal:number;sql:string;executionMs:number|null;planningMs:number|null;jitMs?:number|null;hotspots:readonly PlanHotspot[];error?:string}>;
/** Replays `statements` (as captured, identity statements re-establishing each transaction's settings) under EXPLAIN. */
export async function explainStatements(statements:readonly Captured[]):Promise<ExplainedStatement[]>{
 const out:ExplainedStatement[]=[];
 await client.begin(async tx=>{
  let ordinal=0;
  for(const statement of statements){
   ordinal++;
   const text=statement.sql.trim();
   if(isIdentityStatement(text)){await tx.unsafe(text,statement.params as never[]);continue;}
   if(!/^(select|with|\()/i.test(text)){out.push({ordinal,sql:text.slice(0,300),executionMs:null,planningMs:null,hotspots:[],error:'not a read'});continue;}
   try{
    const rows=await tx.savepoint(sp=>sp.unsafe(`explain (analyze, buffers, format json) ${text}`,statement.params as never[]));
    const plan=(rows[0] as Record<string,unknown>)['QUERY PLAN'] as [{Plan:PlanNode;'Execution Time':number;'Planning Time':number;JIT?:{Timing?:{Total?:number}}}];
    // JIT compilation is part of execution time; reported apart because it is the cost an OLTP read most often need not pay.
    out.push({ordinal,sql:text.slice(0,300),executionMs:Math.round(plan[0]['Execution Time']*100)/100,planningMs:Math.round(plan[0]['Planning Time']*100)/100,
     jitMs:plan[0].JIT?.Timing?.Total==null?null:Math.round(plan[0].JIT.Timing.Total*100)/100,hotspots:hotspots(plan[0].Plan)});
   }catch(error){out.push({ordinal,sql:text.slice(0,300),executionMs:null,planningMs:null,hotspots:[],error:String(error).slice(0,300)});}
  }
  await tx.unsafe('select 1');
 }).catch(error=>{throw error;});
 return out;
}
