/** Sender-side keyless client. A complete EOF is required; a broken start reply proves no outcome. */
import {spawn} from 'node:child_process';
import {reportBrokerRequest,reportBrokerResponse,REPORT_BROKER_REQUEST_MAX_BYTES,REPORT_BROKER_REPLY_MAX_BYTES,type ReportBrokerRequest,type ReportBrokerResponse} from './internal-auth/report-broker-model';
export const REPORT_BROKER_SOCKET='/run/aihr-report-auth.sock';
export {REPORT_BROKER_REQUEST_MAX_BYTES};
export const REPORT_BROKER_RESPONSE_MAX_BYTES=REPORT_BROKER_REPLY_MAX_BYTES;
export class ReportBrokerUnavailable extends Error {constructor(){super('Private report authorization is unavailable.');}}
export function parseReportBrokerReply(input:string,phase:ReportBrokerRequest['phase']):ReportBrokerResponse {
 const value=reportBrokerResponse.parse(JSON.parse(input));
 if('available' in value){if(phase!=='status')throw new ReportBrokerUnavailable();}
 else if(value.ok&&value.phase!==phase)throw new ReportBrokerUnavailable();
 else if(phase==='status'&&value.ok)throw new ReportBrokerUnavailable();
 return value;
}
export function employeeMasterBrokerRequest(input:ReportBrokerRequest):Promise<ReportBrokerResponse>{
 const body=reportBrokerRequest.parse(input),encoded=JSON.stringify(body);
 if(Buffer.byteLength(encoded)>REPORT_BROKER_REQUEST_MAX_BYTES)throw new ReportBrokerUnavailable();
 return new Promise((resolve,reject)=>{
  // The immutable keyless client owns UDS framing, pinned cgroup-FD validation and exact
  // systemd activation retirement. A JSON chunk or stdout EOF cannot authorize SMTP.
  // Next augments ProcessEnv with a required NODE_ENV; this isolated Python client
  // intentionally accepts only the four keyless variables below. Node permits that env.
  const clientEnv={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'} as unknown as NodeJS.ProcessEnv;
  const child=spawn('/usr/bin/python3',['-I','/usr/local/lib/aihr-identity-email/report-auth-peer.py','--client'],{
   detached:true,env:clientEnv,stdio:['pipe','pipe','pipe'],
  });
  const chunks:Buffer[]=[];let size=0,settled=false,closed=false;
  const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);if(!closed&&child.pid&&child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH'){reject(new ReportBrokerUnavailable());return;}}reject(new ReportBrokerUnavailable());};
  const timer=setTimeout(fail,45_000);child.on('error',fail);child.stdin.on('error',fail);child.stderr.resume();
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>REPORT_BROKER_RESPONSE_MAX_BYTES)fail();else chunks.push(chunk);});
  child.on('close',code=>{closed=true;if(settled)return;if(code!==0){fail();return;}try{const value=parseReportBrokerReply(Buffer.concat(chunks).toString('utf8'),body.phase);settled=true;clearTimeout(timer);resolve(value);}catch{fail();}});
  child.stdin.end(encoded);
 });
}
