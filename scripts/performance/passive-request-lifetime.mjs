// Isolated hosted observer. Tracks no URL, actor, socket, headers or request data.
import http from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';

const emptyWindow=()=>({attached:0,unattached:0,pendingAtAbort:0,runningAtAbort:0,
 requestedAfterAbort:0,enteredAfterAbort:0,exitedBeforeEntryAfterAbort:0,finishedAfterAbort:0});

export function observePassiveRequestLifetime(){
 const storage=new AsyncLocalStorage();
 const emit=http.Server.prototype.emit;
 let window=emptyWindow();
 http.Server.prototype.emit=function(event,...args){
  if(event!=='request')return emit.call(this,event,...args);
  const [,response]=args;
  const span={aborted:false,pending:0,running:0};
  response.once('close',()=>{
   if(response.writableFinished)return;
   span.aborted=true;
   window.pendingAtAbort+=span.pending;
   window.runningAtAbort+=span.running;
  });
  return storage.run(span,()=>emit.call(this,event,...args));
 };
 return {
  begin(){
   const span=storage.getStore();
   if(!span){window.unattached++;return;}
   window.attached++;
   if(span.aborted)window.requestedAfterAbort++;
   span.pending++;
   let entered=false;
   return {
    acquired(){
     entered=true;
     span.pending--;
     span.running++;
     if(span.aborted)window.enteredAfterAbort++;
    },
    finished(){
     if(entered){
      span.running--;
      if(span.aborted)window.finishedAfterAbort++;
     }else{
      span.pending--;
      if(span.aborted)window.exitedBeforeEntryAfterAbort++;
     }
    },
   };
  },
  drain(){
   const recent=window;
   window=emptyWindow();
   return recent;
  },
 };
}
