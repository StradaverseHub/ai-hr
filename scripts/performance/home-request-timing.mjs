// Isolated HTTP observation only. No cookies, identities, headers, query strings or response data.
import http from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

export function observeHomeRequests(){
 const context=new AsyncLocalStorage(),completed=[];
 const cards=new Set(['team','celebrations','notices','timeOff','greeting','summary','tasks','today','calendar']);
 const stages=new Set(['handler','session','read-start','read-finish','read-failure']);
 const emit=http.Server.prototype.emit;
 let sequence=0,active=0,dropped=0;
 const mark=(stage,card)=>{
  const span=context.getStore();
  if(!span||!stages.has(stage)||card!==undefined&&!cards.has(card)||span.stages.length>=32)return;
  span.stages.push({stage,...(card===undefined?{}:{card}),afterMs:performance.now()-span.start});
 };
 globalThis.__aihrPerfHomeStage=mark;
 http.Server.prototype.emit=function(event,...args){
  if(event!=='request')return emit.call(this,event,...args);
  const [request,response]=args,path=request.url?.split('?')[0];
  if(request.method!=='GET'||!['/','/api/home/sharing-initial'].includes(path))return emit.call(this,event,...args);
  if(active>=32){dropped++;return emit.call(this,event,...args);}
  active++;
  const span={sequence:++sequence,path,at:Date.now(),start:performance.now(),stages:[]};
  let ended=false;
  const finish=()=>{
   if(ended)return;ended=true;active--;
   completed.push({sequence:span.sequence,path:span.path,at:span.at,elapsedMs:performance.now()-span.start,
    status:response.statusCode,finished:response.writableFinished,stages:span.stages});
   if(completed.length>128)completed.shift();
  };
  response.once('finish',finish);response.once('close',finish);
  return context.run(span,()=>emit.call(this,event,...args));
 };
 return ()=>({scope:'Bounded Home GET lifetimes and closed reader stages; handler delay includes module load and scheduling. No identities or query values.',active,dropped,completed:[...completed]});
}
