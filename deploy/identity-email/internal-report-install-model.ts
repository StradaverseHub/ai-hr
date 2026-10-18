/** Pure installation contract; private source is the actual running, already-key-authorized web unit. */
import {internalConfig} from '../../lib/internal-auth/config';
import {reportRenderDatabase} from './render-config';
import {employeeMasterScheduledEmailEnabled} from '../../lib/employee-master-scheduled-email';
export function installedWebPrincipal(input:{unit:string;user:string;group:string;uid:number;gid:number;pid:number;dynamicUser:string}){
 if(!/^[a-zA-Z0-9_.@-]+\.service$/.test(input.unit)||!input.user||!input.group||input.dynamicUser!=='no'||![input.uid,input.gid,input.pid].every(n=>Number.isSafeInteger(n)&&n>0)||!/^[-a-zA-Z0-9_]+$/.test(input.user)||!/^[-a-zA-Z0-9_]+$/.test(input.group))throw new Error('Existing web identity is not a fixed non-root principal.');
 return input;
}
export function installedInternalConfiguration(env:Record<string,string|undefined>){
 if(env.AUTH_PROVIDER!=='internal')throw new Error('Running web provider is not internal.');
 const config=internalConfig(env),database=reportRenderDatabase(env.DATABASE_URL??'');
 if(env.MIGRATION_DATABASE_URL)throw new Error('Running web holds migration authority.');
 if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname))throw new Error('Local managed report installation requires local PostgreSQL.');
 return {origin:config.origin,key:config.key,database:database.toString(),scheduledEmailEnabled:employeeMasterScheduledEmailEnabled(env)};
}
export function internalReportSenderDatabase(value:string,appValue:string){
 const app=new URL(appValue),url=new URL(value);
 if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!=='aihr_identity_email'||!url.password||url.hash||url.search||url.hostname!==app.hostname||(url.port||'5432')!==(app.port||'5432')||url.pathname!==app.pathname)throw new Error('Use the separate restricted sender role on the exact application database.');
 return url;
}
export function internalReportRunnerDatabase(value:string,appValue:string){
 const app=new URL(appValue),url=new URL(value);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!/^[-a-zA-Z0-9_]+$/.test(decodeURIComponent(url.username))||['ai_hr_app','aihr_identity_email'].includes(decodeURIComponent(url.username))||!url.password||url.hash||url.search||url.hostname!==app.hostname||(url.port||'5432')!==(app.port||'5432')||url.pathname!==app.pathname)throw new Error('Supply the separately authorized existing owner on the exact application database.');
 return url;
}
export function internalReportRunnerEnvironment(input:{origin:string;appDatabase:string;ownerDatabase:string;scheduledEmailEnabled:boolean}){
 if(typeof input.scheduledEmailEnabled!=='boolean')throw new Error('Missing typed runner scheduling capability.');
 const values={AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:input.origin,DATABASE_URL:input.appDatabase,MIGRATION_DATABASE_URL:input.ownerDatabase,EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:input.scheduledEmailEnabled?'true':'false',NODE_ENV:'production',TZ:'UTC',HOME:'/nonexistent',PATH:'/usr/local/lib/aihr-identity-email:/usr/bin:/bin',LANG:'C.UTF-8'};
 // Root launcher parses this canonical quoting as data (never shell eval/source).
 // Keep apostrophes/$/backticks literal while preserving the existing file format.
 return Object.entries(values).map(([key,value])=>{if(/[\r\n\0]/.test(value))throw new Error('Invalid runner environment.');return key+"='"+value.replaceAll("'","'\\''")+"'\n";}).join('');
}
/** Only the canonical writer format is accepted, never shell syntax or caller environment.
 * The separate owner credential is intentionally unavailable in the web process, so activation
 * cannot reconstruct this private file from web settings alone. Re-serialization pins every byte. */
export function parseInternalReportRunnerEnvironment(raw:Uint8Array|string){
 if(typeof raw!=='string'&&raw.byteLength>16384)throw new Error('Invalid installed runner environment.');
 const text=typeof raw==='string'?raw:new TextDecoder('utf-8',{fatal:true}).decode(raw);
 if(!text||Buffer.byteLength(text)>16384||/[\r\0]/.test(text)||!text.endsWith('\n'))throw new Error('Invalid installed runner environment.');
 const values:Record<string,string>={};
 const keys=['AUTH_PROVIDER','AUTH_PUBLIC_ORIGIN','DATABASE_URL','MIGRATION_DATABASE_URL','EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','NODE_ENV','TZ','HOME','PATH','LANG'];
 for(const line of text.slice(0,-1).split('\n')){
  const at=line.indexOf("='"),key=line.slice(0,at);
  if(at<1||!line.endsWith("'")||!keys.includes(key)||Object.hasOwn(values,key))throw new Error('Unknown installed runner environment authority.');
  values[key]=line.slice(at+2,-1).replaceAll("'\\''", "'");
 }
 if(Object.keys(values).length!==keys.length||!['AUTH_PUBLIC_ORIGIN','DATABASE_URL','MIGRATION_DATABASE_URL'].every(key=>values[key])||!['true','false'].includes(values.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED))throw new Error('Incomplete installed runner environment.');
 const canonical=internalReportRunnerEnvironment({origin:values.AUTH_PUBLIC_ORIGIN,appDatabase:values.DATABASE_URL,ownerDatabase:values.MIGRATION_DATABASE_URL,scheduledEmailEnabled:values.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED==='true'});
 if(text!==canonical)throw new Error('Installed runner environment differs from canonical writer.');
 return values;
}
export function assertInternalReportSchedulingEnabled(web:ReturnType<typeof installedInternalConfiguration>,raw:Uint8Array|string){
 const runner=parseInternalReportRunnerEnvironment(raw);
 if(!web.scheduledEmailEnabled||runner.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED!=='true')throw new Error('Scheduled report capability is held or differs; activation refused.');
 if(runner.AUTH_PUBLIC_ORIGIN!==web.origin||runner.DATABASE_URL!==web.database)throw new Error('Installed runner differs from active web configuration.');
 internalReportRunnerDatabase(runner.MIGRATION_DATABASE_URL,web.database);
}
/** Revoke old direct capabilities, then verify effective PUBLIC/inherited authority separately. */
export const internalReportSenderGrants=[
 'REVOKE EXECUTE ON FUNCTION identity_email.report_target(uuid,uuid,text),identity_email.start_report(uuid,uuid,text,jsonb) FROM aihr_identity_email',
 'GRANT USAGE ON SCHEMA identity_email TO aihr_identity_email',
 'GRANT EXECUTE ON FUNCTION identity_email.finish_report(uuid,uuid,text,text,integer,uuid[]) TO aihr_identity_email',
] as const;
export const forbiddenSenderFunctionsSql=`select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
 ((n.nspname='app' and (p.proname like 'internal_auth_%' or p.proname in ('employee_master_internal_render_context','employee_master_render_context')))
 or (n.nspname='identity_email' and p.proname in ('report_target','start_report','start_report_bound','internal_report_context')))
 and has_function_privilege('aihr_identity_email',p.oid,'EXECUTE')`;
