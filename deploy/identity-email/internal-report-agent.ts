/** Dedicated keyless internal-mode report sender. Existing external settings/workflow agent is unchanged. */
import {createServer} from 'node:http';
import postgres from 'postgres';
import {createSingleReportHandler} from './report-handler';
import {createInternalMasterReportDeliveryService,sendInternalEmployeeMasterSmtp} from './internal-reports';
import {employeeMasterBrokerRequest} from '../../lib/employee-master-delivery-broker';
import {prepareMasterReportFile,removeMasterReportFile,reportRendererReady} from './render-process';
const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error('Missing private report sender configuration.');return value;};
if(process.env.AUTH_SESSION_KEY||process.env.DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.IDENTITY_EMAIL_CLIENT_SECRET||process.env.WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET)throw new Error('Report sender environment is not isolated.');
const database=postgres(required('IDENTITY_EMAIL_DATABASE_URL'),{max:1,connect_timeout:5,idle_timeout:5,connection:{statement_timeout:5000,lock_timeout:250,application_name:'aihr-internal-report-sender'}});
const deliver=createInternalMasterReportDeliveryService({origin:required('AUTH_PUBLIC_ORIGIN'),broker:employeeMasterBrokerRequest,
 rendererReady:reportRendererReady,prepare:prepareMasterReportFile,send:sendInternalEmployeeMasterSmtp,
 finish:async(id,token,outcome,reason,metadata)=>(await database`select identity_email.finish_report(${id}::uuid,${token}::uuid,${outcome},${reason},${metadata?.rowCount??null}::integer,${metadata?.scopeIds??null}::uuid[]) as finished`)[0]?.finished===true});
const handle=createSingleReportHandler(deliver,removeMasterReportFile);
const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
 if(req.method!=='POST'||req.url!=='/v1/reports'){res.writeHead(404).end('{}');return;}
 try{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)throw new Error();chunks.push(chunk);}const result=await handle(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200).end(JSON.stringify(result));}
 catch{res.writeHead(400).end('{"outcome":"unavailable"}');}
});
server.requestTimeout=210_000;server.headersTimeout=5_000;
server.maxConnections=8;
if(process.env.LISTEN_FDS!=='1'||process.env.LISTEN_PID!==String(process.pid))throw new Error('Socket activation required.');
server.listen({fd:3});
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>server.close(()=>{database.end().then(()=>process.exit(0));}));
