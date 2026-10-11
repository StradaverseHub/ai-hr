import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createServer,type TLSSocket } from 'node:tls';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
let directory:string;
beforeAll(()=>{
 directory=mkdtempSync(path.join(tmpdir(),'aihr-workflow-smtp-'));
 writeFileSync(path.join(directory,'extensions.cnf'),'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
 const run=(args:string[])=>execFileSync('openssl',args,{cwd:directory,stdio:'ignore'});
 run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-subj','/CN=Disposable AIHR SMTP CA','-days','1']);
 run(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=localhost']);
 run(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','1','-extfile','extensions.cnf']);
});
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
async function relay(mode:'accept'|'temporary'|'lost',trusted=true){
 let captured='',acceptedRecipients:string[]=[];const sockets=new Set<TLSSocket>();
 const server=createServer({key:readFileSync(path.join(directory,'server.key')),cert:readFileSync(path.join(directory,'server.pem'))},socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.write('220 localhost fixture\r\n');let pending='',data=false;
  socket.on('data',chunk=>{pending+=chunk.toString();let end:number;while((end=pending.indexOf('\r\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+2);
   if(data){if(line==='.') {data=false;if(mode==='lost')socket.destroy();else socket.write(mode==='temporary'?'451 4.3.0 Retry later\r\n':'250 2.0.0 Accepted\r\n');}else captured+=line+'\n';continue;}
   if(/^EHLO|^HELO/.test(line))socket.write('250 localhost\r\n');else if(/^MAIL FROM/.test(line))socket.write('250 OK\r\n');else if(/^RCPT TO/.test(line)){acceptedRecipients.push(line);socket.write('250 OK\r\n');}
   else if(line==='DATA'){data=true;socket.write('354 End with dot\r\n');}else if(line==='QUIT'){socket.end('221 Bye\r\n');}else socket.write('250 OK\r\n');
  }});
 });
 server.on('tlsClientError',()=>{});await new Promise<void>(resolve=>server.listen(0,'::',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing fixture port');
 try{
  const result=await new Promise<string>((resolve,reject)=>{
   const env={...process.env};delete env.NODE_EXTRA_CA_CERTS;if(trusted)env.NODE_EXTRA_CA_CERTS=path.join(directory,'ca.pem');
   const child=spawn(process.execPath,['--import','tsx','test/fixtures/notification-email/smtp-client.ts',String(address.port)],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});let output='',errors='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('SMTP fixture timed out'));},25_000);
   child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(new Error('SMTP fixture failed: '+errors.slice(0,300)));});
  });
  return {result:JSON.parse(result.trim()),captured,acceptedRecipients};
 }finally{for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
describe('actual implicit-TLS SMTP adapter against a disposable local relay',()=>{
 it('accepts only the selected recipient and sends the brief app link without HR details',async()=>{
  const r=await relay('accept');expect(r.result).toEqual({outcome:'sent'});expect(r.acceptedRecipients).toEqual(['RCPT TO:<employee@example.test>']);expect(r.captured).toContain('Subject: Payroll update');expect(r.captured).toContain('https://hr.example.test/me');expect(r.captured).not.toMatch(/salary|medical|approved|rejected/i);
 });
 it('does not transmit a message to an untrusted TLS certificate',async()=>{
  const r=await relay('accept',false);expect(r.result.outcome).not.toBe('sent');expect(r.acceptedRecipients).toEqual([]);expect(r.captured).toBe('');
 });
 it('distinguishes temporary rejection from losing the final SMTP acknowledgement',async()=>{
  expect((await relay('temporary')).result).toEqual({outcome:'retry',error:'smtpTemporary'});
  expect((await relay('lost')).result).toEqual({outcome:'uncertain',error:'uncertain'});
 });
});
