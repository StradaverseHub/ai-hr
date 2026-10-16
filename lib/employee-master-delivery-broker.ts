/** Sender-side keyless client. A complete EOF is required; a broken start reply proves no outcome. */
import {Socket} from 'node:net';
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
  const socket=new Socket({allowHalfOpen:true}),chunks:Buffer[]=[];let size=0,settled=false,ended=false;
  const fail=()=>{if(settled)return;settled=true;socket.destroy();reject(new ReportBrokerUnavailable());};
  socket.setTimeout(45_000,fail);socket.on('error',fail);
  socket.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>REPORT_BROKER_RESPONSE_MAX_BYTES)fail();else chunks.push(chunk);});
  socket.on('end',()=>{ended=true;if(settled)return;try{const value=parseReportBrokerReply(Buffer.concat(chunks).toString('utf8'),body.phase);settled=true;socket.destroy();resolve(value);}catch{fail();}});
  socket.on('close',()=>{if(!ended)fail();});
  socket.connect(REPORT_BROKER_SOCKET,()=>socket.end(encoded));
 });
}
