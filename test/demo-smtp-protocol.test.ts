import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net,{type Socket} from 'node:net';
import tls from 'node:tls';
import {createDemoSmtpConnection} from '../lib/demo-smtp-connection';
import {probeDemoSmtp} from '../lib/demo-smtp-probe';
let dir:string,key:Buffer,cert:Buffer;
beforeAll(()=>{
 dir=mkdtempSync(join(tmpdir(),'aihr-demo-smtp-cert-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-subj','/CN=smtp.fixture.test','-addext','subjectAltName=DNS:smtp.fixture.test','-days','2'],{stdio:'ignore'});
 key=readFileSync(join(dir,'key.pem'));cert=readFileSync(join(dir,'cert.pem'));
});
afterAll(()=>{if(dir)rmSync(dir,{recursive:true,force:true});});
async function server(mode:'tls'|'starttls'|'no-tls'|'no-auth'|'oversized'|'oversized-final'){
 const sockets=new Set<Socket>(),commands:string[]=[];
 const attach=(socket:Socket,secure:boolean,greeting=true)=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  if(greeting)socket.write(mode==='oversized'?'220 '+ 'x'.repeat(9000)+'\r\n':'220 Synthetic SMTP fixture\r\n');
  let input='';
  const data=(chunk:Buffer)=>{
   input+=chunk.toString();let end:number;
   while((end=input.indexOf('\n'))>=0){const line=input.slice(0,end).trim();input=input.slice(end+1);commands.push(line);
    if(/^EHLO /.test(line)&&mode==='oversized-final')socket.write('250-short continuation\r\n250 '+ 'x'.repeat(9000)+'\r\n');
    else if(/^EHLO /.test(line))socket.write('250-smtp.fixture.test\r\n'+(!secure&&mode==='starttls'?'250-STARTTLS\r\n':'')+(mode==='no-auth'?'250 OK\r\n':'250 AUTH PLAIN\r\n'));
    else if(line==='STARTTLS'){
     if(mode!=='starttls'){socket.write('454 TLS unavailable\r\n');continue;}
     socket.removeListener('data',data);socket.write('220 Start TLS\r\n',()=>{
      const upgraded=new tls.TLSSocket(socket,{isServer:true,secureContext:tls.createSecureContext({key,cert})});
      attach(upgraded,true,false);
     });return;
    }else if(line.startsWith('AUTH PLAIN ')){
     const decoded=Buffer.from(line.slice(11),'base64').toString();
     socket.write(secure&&decoded==='\0synthetic-user\0synthetic-secret'?'235 Authenticated\r\n':'535 synthetic-secret was rejected\r\n');
    }else if(line==='QUIT'){socket.end('221 Bye\r\n');}
    else socket.write('500 Unsupported command\r\n');
   }
  };
  socket.on('data',data);
 };
 const instance=mode==='starttls'||mode==='no-tls'?net.createServer(s=>attach(s,false)):tls.createServer({key,cert},s=>attach(s,true));
 instance.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});instance.on('tlsClientError',()=>{});
 await new Promise<void>(resolve=>instance.listen(0,'127.0.0.1',resolve));
 const port=(instance.address() as net.AddressInfo).port;
 return {port,commands,stop:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>instance.close(()=>resolve()));}};
}
async function probe(f:Awaited<ReturnType<typeof server>>,security:'tls'|'starttls'='tls',trusted=true,password='synthetic-secret',auth=true){
 return probeDemoSmtp({host:'smtp.fixture.test',port:f.port,security,auth,user:auth?'synthetic-user':'',password:auth?password:''},{
  resolve:async()=>['8.8.8.8'],
  // Only the test factory maps the already-checked public address to our disposable local fixture.
  connection:options=>createDemoSmtpConnection({...options,host:'127.0.0.1',tls:{...options.tls,...(trusted?{ca:cert}:{} )}}),
 });
}
describe('real Nodemailer TLS and SMTP protocol',()=>{
 it.each(['tls','starttls'] as const)('authenticates over %s without MAIL, RCPT or DATA',async mode=>{
  const f=await server(mode);try{expect(await probe(f,mode)).toEqual({status:'success',authenticated:true});expect(f.commands.some(c=>c.startsWith('AUTH PLAIN '))).toBe(true);expect(f.commands.some(c=>/^(MAIL|RCPT|DATA)\b/.test(c))).toBe(false);if(mode==='starttls')expect(f.commands.indexOf('STARTTLS')).toBeLessThan(f.commands.findIndex(c=>c.startsWith('AUTH ')));}finally{await f.stop();}
 });
 it('returns a sanitized authentication failure',async()=>{const f=await server('tls');try{expect(await probe(f,'tls',true,'incorrect')).toEqual({status:'error',code:'authenticationFailed'});}finally{await f.stop();}});
 it('rejects an untrusted TLS certificate before sending credentials',async()=>{const f=await server('tls');try{expect(await probe(f,'tls',false)).toEqual({status:'error',code:'tlsFailed'});expect(f.commands).toEqual([]);}finally{await f.stop();}});
 it('refuses a relay without STARTTLS even when it offers AUTH',async()=>{const f=await server('no-tls');try{expect(await probe(f,'starttls')).toEqual({status:'error',code:'tlsFailed'});expect(f.commands.some(c=>c.startsWith('AUTH '))).toBe(false);}finally{await f.stop();}});
 it('does not claim login success when AUTH is unavailable',async()=>{const f=await server('no-auth');try{expect(await probe(f)).toEqual({status:'error',code:'authenticationFailed'});expect(await probe(f,'tls',true,'',false)).toEqual({status:'success',authenticated:false});}finally{await f.stop();}});
 it('bounds an oversized final line in a multiline response before AUTH',async()=>{const f=await server('oversized-final');try{expect(await probe(f)).toEqual({status:'error',code:'connectionFailed'});expect(f.commands.some(c=>c.startsWith('AUTH '))).toBe(false);}finally{await f.stop();}});
 it('bounds the size of a hostile SMTP greeting',async()=>{const f=await server('oversized');try{expect(await probe(f)).toEqual({status:'error',code:'connectionFailed'});expect(f.commands).toEqual([]);}finally{await f.stop();}});
});
