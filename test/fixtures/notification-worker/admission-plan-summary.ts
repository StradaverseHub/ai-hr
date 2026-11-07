/** Pure plan models only. Actual CI/source/PID provenance belongs to the native collector. */
import {createHash} from 'node:crypto';
import type {AutoExplainMessage} from './auto-explain';
// PostgreSQL retains the reviewed expression text. Trim only its outer edge;
// SQL literal whitespace and every interior byte remain part of the identity.
const expressionText=(text:string)=>text.trim();
export function reviewedAdmissionExpression(source:string){
 const declaration='CREATE OR REPLACE FUNCTION notification_worker_private.admit_login() RETURNS oid';
 const start=source.indexOf(declaration);if(start<0||source.indexOf(declaration,start+1)!==-1)throw Error('One reviewed native admission owner required');
 const begin=source.indexOf('AS $body$',start),end=source.indexOf('END $body$;',begin);
 if(begin<start||end<begin)throw Error('Exact reviewed native admission body required');
 const body=source.slice(begin+'AS $body$'.length,end)+'END ',bodyMd5=createHash('md5').update(body).digest('hex');
 if(!['8517a1befa95a7daa5ff621e92f8ceef','49533d66467b0468d6cb4c1fb0697fe5'].includes(bodyMd5))throw Error('Unreviewed native admission source');
 const first=body.indexOf(' IF NOT FOUND'),last=body.indexOf(" THEN RAISE EXCEPTION 'Notification worker authority unavailable'");
 if(first<0||last<=first||body.slice(0,first).split('\n').length!==6)throw Error('Exact reviewed admission rejection boundary required');
 return{bodyMd5,expression:expressionText(body.slice(first+4,last)),frame:'PL/pgSQL function notification_worker_private.admit_login() line 6 at IF'};
}
export function notificationAdmissionSummary(entries:readonly AutoExplainMessage[],expected:ReturnType<typeof reviewedAdmissionExpression>){
 const expressions:AutoExplainMessage[]=[];
 for(const entry of entries){
  const query=expressionText(entry.query),frame=entry.context.split(/\r?\n/).map(line=>line.trim()).find(line=>line.startsWith('PL/pgSQL function '));
  const exact=query===expected.expression;
  if(!exact&&frame!==expected.frame&&!query.startsWith('NOT FOUND OR a.enabled'))continue;
  if(!exact||frame!==expected.frame)throw Error('Exact reviewed rejection expression and innermost native admission frame required');
  expressions.push(entry);
 }
 const first=expressions[0],last=expressions[expressions.length-1];
 if(!first||!last)throw Error('Nonempty exact native admission rejection plans required');
 const blocks=(entry:AutoExplainMessage)=>{const plan=entry.document.Plan;if(!plan||typeof plan!=='object'||Array.isArray(plan))throw Error('Actual native plan required');const value=(key:string)=>{const n=Reflect.get(plan,key)??0;if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw Error('Actual nonnegative buffer count required');return n;};return value('Shared Hit Blocks')+value('Shared Read Blocks');};
 return{calls:expressions.length,inclusiveMs:expressions.reduce((n,entry)=>n+entry.durationMs,0),rootSharedBlocks:expressions.reduce((n,entry)=>n+blocks(entry),0),
  firstDurationMs:first.durationMs,lastDurationMs:last.durationMs,jitDocuments:expressions.filter(entry=>entry.document.JIT!==undefined).length,
  bodyMd5:expected.bodyMd5,note:'Nonempty exact expression + innermost native frame; nested-inclusive time is not additive with callers. Every full helper source check remains.'};
}
