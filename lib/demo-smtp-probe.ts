import 'server-only';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type SMTPConnection from 'nodemailer/lib/smtp-connection';
import type {SMTPConnectionOptions} from 'nodemailer/lib/smtp-connection';
import { isPublicIp } from './public-network';
import {createDemoSmtpConnection} from './demo-smtp-connection';
import { demoSmtpSchema,type DemoSmtpConfig,type DemoSmtpFailure,type DemoSmtpResult } from './demo-smtp-model';

export class DemoSmtpError extends Error {
  constructor(readonly code:DemoSmtpFailure){super('SMTP connection test: '+code);}
}
export async function resolveDemoSmtpHost(host:string):Promise<string[]> {
  if(isIP(host))return [host];
  const resolver=new Resolver({timeout:2000,tries:1});
  const timer=setTimeout(()=>resolver.cancel(),4000);
  try{
    const answers=await Promise.allSettled([resolver.resolve4(host),resolver.resolve6(host)]);
    const addresses:string[]=[];
    for(const answer of answers){
      if(answer.status==='fulfilled')addresses.push(...answer.value);
      else if(!['ENODATA','ENOTFOUND'].includes(answer.reason?.code))throw new DemoSmtpError('connectionFailed');
    }
    return addresses;
  }catch{throw new DemoSmtpError('connectionFailed');}
  finally{clearTimeout(timer);resolver.cancel();}
}
export function smtpProbeFailure(error:unknown):DemoSmtpFailure {
  if(error instanceof DemoSmtpError)return error.code;
  const e=error as {code?:string;originalCode?:string;command?:string};
  if(e?.code==='EAUTH')return 'authenticationFailed';
  if(e?.code==='ETLS'||e?.command==='STARTTLS'||
     /CERT|TLS|SSL|SELF_SIGNED|ISSUER|LEAF_SIGNATURE/.test(e?.originalCode??e?.code??''))return 'tlsFailed';
  return 'connectionFailed';
}
type Dependencies={resolve:(host:string)=>Promise<string[]>;connection:(options:SMTPConnectionOptions)=>SMTPConnection};
const defaults:Dependencies={resolve:resolveDemoSmtpHost,connection:createDemoSmtpConnection};

/** Connection + optional AUTH only. No sender, recipients, message, relay state or secret storage. */
export async function probeDemoSmtp(input:DemoSmtpConfig,deps:Dependencies=defaults):Promise<DemoSmtpResult> {
  let connection:SMTPConnection|undefined;
  try{
    const parsed=demoSmtpSchema.safeParse(input);
    if(!parsed.success)return {status:'error',code:'invalid'};
    const config=parsed.data;
    const addresses=await deps.resolve(config.host);
    if(!addresses.length)throw new DemoSmtpError('connectionFailed');
    if(addresses.some(address=>!isPublicIp(address)))throw new DemoSmtpError('blockedHost');
    // Pin the checked IP: the SMTP library must not perform a second, potentially rebound lookup.
    const address=addresses.find(a=>isIP(a)===4)??addresses[0];
    connection=deps.connection({host:address,port:config.port,servername:config.host,
      secure:config.security==='tls',requireTLS:config.security==='starttls',opportunisticTLS:false,
      tls:{servername:config.host,rejectUnauthorized:true,minVersion:'TLSv1.2'},
      name:'demo.ai-hr.invalid',connectionTimeout:10000,greetingTimeout:5000,socketTimeout:5000,
      dnsTimeout:2000,maxResponseSize:8192,logger:false,debug:false,transactionLog:false});
    const client=connection;
    return await new Promise<DemoSmtpResult>(resolve=>{
      let settled=false;
      const finish=(result:DemoSmtpResult)=>{if(settled)return;settled=true;clearTimeout(timer);client.close();resolve(result);};
      const fail=(e:unknown)=>finish({status:'error',code:smtpProbeFailure(e)});
      const timer=setTimeout(()=>fail(new DemoSmtpError('connectionFailed')),15000);
      client.on('error',fail);
      client.on('end',()=>fail(new DemoSmtpError('connectionFailed')));
      try{client.connect(error=>{
        try{
        if(settled)return;
        if(error)return fail(error);
        if(!client.secure)return fail(new DemoSmtpError('tlsFailed'));
        if(!config.auth)return finish({status:'success',authenticated:false});
        if(!client.allowsAuth)return fail(new DemoSmtpError('authenticationFailed'));
        client.login({user:config.user,pass:config.password},error=>{
          if(error)return fail(error);
          finish(client.authenticated?{status:'success',authenticated:true}:{status:'error',code:'authenticationFailed'});
        });
        }catch(e){fail(e);}
      });}catch(e){fail(e);}
    });
  }catch(e){return {status:'error',code:e instanceof DemoSmtpError?e.code:'connectionFailed'};}
  finally{connection?.close();}
}
