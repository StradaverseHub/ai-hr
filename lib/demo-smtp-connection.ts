import 'server-only';
import SMTPConnection,{type SMTPConnectionOptions} from 'nodemailer/lib/smtp-connection';

export const DEMO_SMTP_MAX_REPLY_BYTES=8192;
const MAX_EXCHANGE_BYTES=65536;

/** Nodemailer 10.1 bounds unfinished replies, but not an oversized final/complete line.
 * This narrow adapter counts plaintext SMTP bytes before its parser, across TLS upgrades.
 * The pinned library calls _onData dynamically; real TLS/STARTTLS fixtures guard this seam.
 * If a future library removes it, refuse the probe instead of opening an unbounded connection. */
export function createDemoSmtpConnection(options:SMTPConnectionOptions):SMTPConnection {
 const client=new SMTPConnection(options);
 const parser=client as SMTPConnection & {_onData:(chunk:Buffer)=>void};
 if(typeof parser._onData!=='function')throw Error('SMTP response guard unavailable');
 const receive=parser._onData.bind(client);
 let replyBytes=0,totalBytes=0,prefix='',closed=false;
 parser._onData=chunk=>{
  if(closed)return;
  totalBytes+=chunk.length;
  let allowed=totalBytes<=MAX_EXCHANGE_BYTES;
  for(const byte of chunk){
   if(!allowed)break;
   if(++replyBytes>DEMO_SMTP_MAX_REPLY_BYTES){allowed=false;break;}
   if(prefix.length<4)prefix+=String.fromCharCode(byte);
   if(byte===10){if(!/^\d{3}-/.test(prefix))replyBytes=0;prefix='';}
  }
  if(!allowed){
   closed=true;
   try{client.emit('error',Object.assign(Error('SMTP response limit exceeded'),{code:'EPROTOCOL'}));}
   finally{client.close();}
   return;
  }
  receive(chunk);
 };
 return client;
}
