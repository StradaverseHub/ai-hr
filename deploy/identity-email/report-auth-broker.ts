/** One root-supervised Linux child per closed request; no server, session, singleton pool or SMTP. */
import postgres from 'postgres';
import {reportRenderDatabase} from './render-config';
import {authorizeReportArtifact} from './render-process';
import {internalConfig,internalSelected} from '../../lib/internal-auth/config';
import {prepareReportSmtpRelay} from '../../lib/internal-auth/report-smtp-token';
import {executeReportBrokerRequest,type ReportBrokerDependencies} from '../../lib/internal-auth/report-broker';
import {reportBrokerRequest,reportBrokerResponse,REPORT_BROKER_REQUEST_MAX_BYTES,REPORT_BROKER_REPLY_MAX_BYTES,type ReportBrokerResponse} from '../../lib/internal-auth/report-broker-model';
function trustedUid(value:string|undefined):number {
 if(!value||!/^\d{1,10}$/.test(value))throw new Error('Broker identity unavailable.');
 const uid=Number(value);if(!Number.isSafeInteger(uid)||uid<=0)throw new Error('Broker identity unavailable.');return uid;
}
async function main():Promise<ReportBrokerResponse>{
 if(process.platform!=='linux'||!internalSelected())throw new Error('Broker installation unavailable.');
 const uid=trustedUid(process.env.REPORT_AUTH_BROKER_UID),peer=trustedUid(process.env.REPORT_AUTH_BROKER_PEER_UID),mail=trustedUid(process.env.REPORT_AUTH_BROKER_MAIL_UID);
 if(process.getuid?.()!==uid||peer!==mail||peer===uid)throw new Error('Broker peer unavailable.');
 // The trusted peer adapter supplies a closed installed environment, never request fields.
 if(['MIGRATION_DATABASE_URL','IDENTITY_EMAIL_DATABASE_URL','IDENTITY_EMAIL_CLIENT_SECRET','WORKFLOW_EMAIL_LOOKUP_CLIENT_SECRET','WORKOS_API_KEY'].some(key=>Boolean(process.env[key])))throw new Error('Broker environment is not isolated.');
 internalConfig();reportRenderDatabase(process.env.DATABASE_URL??'');
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of process.stdin){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>REPORT_BROKER_REQUEST_MAX_BYTES)throw new Error('Broker request exceeded its bound.');chunks.push(bytes);}
 const input=reportBrokerRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
 const pool=postgres(process.env.DATABASE_URL!,{max:1,connect_timeout:5,idle_timeout:1,max_lifetime:60,prepare:false});
 try{
  const transaction:ReportBrokerDependencies['transaction']=async work=>{
   // postgres.begin returns the callback result after COMMIT, and rolls back every thrown refusal.
   const deadline=setTimeout(()=>process.exit(1),5_000);deadline.unref();
   try{const result=await pool.begin(async tx=>({value:await work(tx)}));return result.value;}
   finally{clearTimeout(deadline);}
  };
  return reportBrokerResponse.parse(await executeReportBrokerRequest(input,{transaction,authorizeArtifact:authorizeReportArtifact,prepareRelay:prepareReportSmtpRelay}));
 }finally{
  // No relay-bearing JSON is written until every private app connection has closed.
  await pool.end({timeout:2});
 }
}
// The supervisor also owns a35s child and45s unit deadline. This in-process guard is independent;
// a hung query/stream must not retain a connection or disclose a partial success response.
const watchdog=setTimeout(()=>process.exit(1),34_000);watchdog.unref();
main().then(async result=>{
 const body=JSON.stringify(result);
 if(Buffer.byteLength(body)>REPORT_BROKER_REPLY_MAX_BYTES)throw new Error('Broker reply exceeded its bound.');
 await new Promise<void>((resolve,reject)=>process.stdout.write(body+'\n',error=>error?reject(error):resolve()));
 clearTimeout(watchdog);process.exit(0);
}).catch(async()=>{
 // No Error.message/SQL/proof/target/key/relay value enters logs or public failures.
 await new Promise<void>(resolve=>process.stdout.write(JSON.stringify({ok:false,reason:'unavailable'})+'\n',()=>resolve()));
 clearTimeout(watchdog);process.exit(1);
});
