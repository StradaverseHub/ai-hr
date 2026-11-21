import 'server-only';
import {request} from 'node:http';
import {isGroupAdmin,isOperator} from './authz-model';
import type {SessionContext} from '../db/client';
import {runnerChangeSchema,runnerSnapshotSchema,type RunnerChange,type RunnerSnapshot} from './runner-control-model';
import {isDemoDeployment} from './demo-mode';

class RunnerPortRefused extends Error {
 constructor(readonly status:number|undefined){super('Runner request refused. Refresh and check the installation policy.');}
}

async function port(body:unknown):Promise<unknown> {
 return new Promise((resolve,reject)=>{
  const req=request({socketPath:'/run/aihr-runner-control.sock',path:'/v1/runners',method:'POST',headers:{'content-type':'application/json'},timeout:30000},res=>{
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>131072)res.destroy(new Error('Runner controller response exceeded its limit.'));else chunks.push(chunk);});
   res.on('error',reject);
   res.on('end',()=>{try{if(res.statusCode!==200)throw new RunnerPortRefused(res.statusCode);resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});
  });
  req.on('timeout',()=>req.destroy(new Error('Runner controller timed out. Refresh to check whether the change was applied.')));
  req.on('error',reject);req.end(JSON.stringify(body));
 });
}
export async function runnerControlSnapshot(session:SessionContext):Promise<RunnerSnapshot|null> {
 if(!isOperator(session)&&!isGroupAdmin(session))throw new Error('Runner status is restricted to administrators.');
 try{
  for(const op of ['status_with_worker_cron','status_with_cron','status']){
   try{return runnerSnapshotSchema.parse(await port({op}));}
   catch(error){if(!(error instanceof RunnerPortRefused&&error.status===409))throw error;}
  }
  return null;
 }catch{return null;}
}
export async function configureRunner(session:SessionContext,input:RunnerChange):Promise<void> {
 // Rechecked on every server call; roles-only and customer-admin sessions cannot control the host.
 if(!isOperator(session)||!session.userId||isDemoDeployment())throw new Error('Only an installation operator can change runners.');
 const change=runnerChangeSchema.parse(input);
 await port({op:'configure',...change,actor:session.userId});
}
