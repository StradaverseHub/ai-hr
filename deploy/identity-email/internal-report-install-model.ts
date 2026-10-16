/** Pure installation contract; private source is the actual running, already-key-authorized web unit. */
import {internalConfig} from '../../lib/internal-auth/config';
import {reportRenderDatabase} from './render-config';
export function installedWebPrincipal(input:{unit:string;user:string;group:string;uid:number;gid:number;pid:number;dynamicUser:string}){
 if(!/^[a-zA-Z0-9_.@-]+\.service$/.test(input.unit)||!input.user||!input.group||input.dynamicUser!=='no'||![input.uid,input.gid,input.pid].every(n=>Number.isSafeInteger(n)&&n>0)||!/^[-a-zA-Z0-9_]+$/.test(input.user)||!/^[-a-zA-Z0-9_]+$/.test(input.group))throw new Error('Existing web identity is not a fixed non-root principal.');
 return input;
}
export function installedInternalConfiguration(env:Record<string,string|undefined>){
 if(env.AUTH_PROVIDER!=='internal')throw new Error('Running web provider is not internal.');
 const config=internalConfig(env),database=reportRenderDatabase(env.DATABASE_URL??'');
 if(env.MIGRATION_DATABASE_URL)throw new Error('Running web holds migration authority.');
 if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname))throw new Error('Local managed report installation requires local PostgreSQL.');
 return {origin:config.origin,key:config.key,database:database.toString()};
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
export function internalReportRunnerEnvironment(input:{origin:string;appDatabase:string;ownerDatabase:string}){
 const values={AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:input.origin,DATABASE_URL:input.appDatabase,MIGRATION_DATABASE_URL:input.ownerDatabase,NODE_ENV:'production',TZ:'UTC',HOME:'/nonexistent',PATH:'/usr/local/lib/aihr-identity-email:/usr/bin:/bin',LANG:'C.UTF-8'};
 // This file is sourced by an env-i shell, unlike systemd EnvironmentFile: quote for shell,
 // including apostrophes/$/backticks, without evaluating an operator-supplied password.
 return Object.entries(values).map(([key,value])=>{if(/[\r\n\0]/.test(value))throw new Error('Invalid runner environment.');return key+"='"+value.replaceAll("'","'\\''")+"'\n";}).join('');
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
