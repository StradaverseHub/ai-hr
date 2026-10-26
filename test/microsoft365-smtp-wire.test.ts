/** Real Nodemailer STARTTLS/XOAUTH2 on loopback. Only the test factory remaps pinned production SMTP. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net,{type Socket} from 'node:net';
import tls from 'node:tls';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
const boundary=vi.hoisted(()=>({host:'127.0.0.1',port:0,ca:undefined as Buffer|undefined}));
vi.mock('nodemailer',async original=>{
 const real=await original<typeof import('nodemailer')>();return {default:{...real.default,createTransport:(options:any)=>real.default.createTransport({...options,host:boundary.host,port:boundary.port,tls:{...options.tls,servername:'smtp.fixture.test',...(boundary.ca?{ca:boundary.ca}:{})}})}};
});
import {sendSmtp} from '../lib/internal-auth/smtp';
import type {DeliveryEmailRelay} from '../lib/identity/email-relay';
let directory:string,key:Buffer,cert:Buffer;
beforeAll(()=>{
 directory=mkdtempSync(join(tmpdir(),'aihr-oauth-smtp-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-subj','/CN=smtp.fixture.test','-addext','subjectAltName=DNS:smtp.fixture.test','-days','2'],{stdio:'ignore'});
 key=readFileSync(join(directory,'key.pem'));cert=readFileSync(join(directory,'cert.pem'));
});
afterAll(()=>{if(directory)rmSync(directory,{recursive:true,force:true});});
const relay=():DeliveryEmailRelay=>({config:{host:'smtp.office365.com',port:587,security:'starttls',from:'sender@example.test',fromName:'AI HR',replyTo:'',auth:true,user:'sender@example.test',authentication:'microsoft365',oauth2:{tenantId:crypto.randomUUID(),clientId:crypto.randomUUID()}},accessToken:'fictional-wire-token',accessTokenExpiresAt:Date.now()+3600000});
async function fixture(offerTLS=true,reject=false){
 const sockets=new Set<Socket>(),commands:{line:string;secure:boolean}[]=[];let message='';
 const attach=(socket:Socket,secure:boolean,greeting=true)=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});if(greeting)socket.write('220 Fictional SMTP\r\n');let pending='',data=false;
  const onData=(chunk:Buffer)=>{
   pending+=chunk.toString();let end:number;
   while((end=pending.indexOf('\r\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+2);
    if(data){if(line==='.'){data=false;socket.write('250 Accepted\r\n');}else message+=line+'\n';continue;}
    commands.push({line,secure});
    if(line.startsWith('EHLO '))socket.write('250-smtp.fixture.test\r\n'+(!secure&&offerTLS?'250-STARTTLS\r\n':'')+'250 AUTH XOAUTH2 PLAIN\r\n');
    else if(line==='STARTTLS'){
     if(!offerTLS){socket.write('454 TLS unavailable\r\n');continue;}
     socket.removeListener('data',onData);socket.write('220 Start TLS\r\n',()=>attach(new tls.TLSSocket(socket,{isServer:true,secureContext:tls.createSecureContext({key,cert})}),true,false));return;
    }else if(line.startsWith('AUTH XOAUTH2 '))socket.write(secure&&!reject?'235 Authenticated\r\n':'535 Rejected\r\n');
    else if(line.startsWith('MAIL FROM:')||line.startsWith('RCPT TO:'))socket.write('250 OK\r\n');
    else if(line==='DATA'){data=true;socket.write('354 Send data\r\n');}
    else if(line==='QUIT')socket.end('221 Bye\r\n');else socket.write('500 Unsupported\r\n');
   }
  };socket.on('data',onData);
 };
 const server=net.createServer(s=>attach(s,false));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));boundary.port=(server.address() as net.AddressInfo).port;boundary.ca=cert;
 return {commands,get message(){return message;},stop:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
const mail={to:'recipient@example.test',subject:'Fictional OAuth test',text:'A bounded delivery.'};
describe('actual SMTP STARTTLS/XOAUTH2 exchange',()=>{
 it('negotiates TLS before AUTH, sends the mailbox and access token only, and accepts one message',async()=>{
  const f=await fixture();try{await sendSmtp(relay(),mail);const auth=f.commands.filter(c=>c.line.startsWith('AUTH '));expect(auth).toHaveLength(1);expect(auth[0].secure).toBe(true);expect(auth[0].line).toMatch(/^AUTH XOAUTH2 /);
   expect(Buffer.from(auth[0].line.slice('AUTH XOAUTH2 '.length),'base64').toString()).toBe('user=sender@example.test\x01auth=Bearer fictional-wire-token\x01\x01');expect(f.commands.filter(c=>c.line.startsWith('RCPT TO:')).map(c=>c.line)).toEqual(['RCPT TO:<recipient@example.test>']);expect(f.message).toContain(mail.text);
  }finally{await f.stop();}
 });
 it.each(['noTLS','untrusted','rejected'] as const)('refuses %s without delivering a message or falling back to password auth',async mode=>{
  const f=await fixture(mode!=='noTLS',mode==='rejected');if(mode==='untrusted')boundary.ca=undefined;
  try{await expect(sendSmtp(relay(),mail)).rejects.toBeDefined();expect(f.message).toBe('');expect(f.commands.some(c=>c.line.startsWith('MAIL FROM:'))).toBe(false);expect(f.commands.some(c=>c.line.startsWith('AUTH PLAIN'))).toBe(false);if(mode!=='rejected')expect(f.commands.some(c=>c.line.startsWith('AUTH '))).toBe(false);
  }finally{await f.stop();}
 });
});
