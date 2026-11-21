import assert from 'node:assert/strict';

export const shellPreviewPath='/api/notifications/shell-tasks';

export function createShellPreviewReplay(read,measure){
 const roles=new Map();
 function actor(user){
  const stats=roles.get(user.role)??{started:0,ready:0,unavailable:0,failed:0,navigationCancelled:0,durations:[]};
  roles.set(user.role,stats);
  let current;
  return {
   start(){
    assert(!current,'Only one shell preview can belong to a document');
    const controller=new AbortController();
    stats.started++;
    const settled=(async()=>{
     try{
      const response=await read(user,controller.signal);
      controller.signal.throwIfAborted();
      assert.equal(response.headers['cache-control'],'private, no-store');
      const {approvals,lifecycle}=JSON.parse(response.content);
      if(approvals?.state==='unavailable'){stats.unavailable++;return;}
      assert.equal(approvals?.state,'ready');
      for(const value of [approvals.total,approvals.approvalCount,approvals.claimTotal,lifecycle?.count]){
       assert(Number.isSafeInteger(value)&&value>=0,'Invalid task preview count');
      }
      assert(Array.isArray(approvals.items)&&Array.isArray(lifecycle.items));
      stats.ready++;
      stats.durations.push(response.durationMs);
     }catch{
      if(controller.signal.aborted)stats.navigationCancelled++;
      else stats.failed++;
     }
    })();
    current={controller,settled};
   },
   async replace(){
    if(!current)return;
    current.controller.abort();
    await current.settled;
    current=undefined;
   },
   async finish(){await current?.settled;},
  };
 }
 return {actor,snapshot:()=>Object.fromEntries([...roles].map(([role,{durations,...counts}])=>[
  role,{...counts,readyLatency:measure(durations)},
 ]))};
}
