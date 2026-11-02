/** Actual Nginx sockets on an isolated standard Actions runner; no staging or employee traffic. */
import {createServer,request} from 'node:http';
import {createConnection} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {CLOUDFLARE_CIDRS,hardenProxyConfig,renderIngressHttp} from '../deploy/security/ingress-policy.mjs';
const run=promisify(execFile),image='nginx@sha256:3b03dfd827515a07ccf4946000f0bbdd2a4fb6aca7499249fcb6b1f9726823d6';
const container='aihr-ingress-'+process.pid;let directory='',port=0,backendPort=0,started=false;
let held:Array<()=>void>=[],backendRequests=0;
const backend=createServer((req,res)=>{backendRequests++;req.resume();const finish=()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({source:req.headers['x-aihr-request-source'],host:req.headers.host,proto:req.headers['x-forwarded-proto']}));};if(req.url==='/api/mobile/hold')held.push(finish);else finish();});
function send(path='/api/mobile/profile',ip='203.0.113.9',extra:Record<string,string>={},localAddress='127.0.0.1',body?:string):Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>{
 return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method:body===undefined?'GET':'POST',localAddress,headers:{host:'staging.example.invalid',...(ip?{'cf-connecting-ip':ip}:{}),...extra,...body===undefined?{}:{'content-length':Buffer.byteLength(body)}},timeout:15000},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:text}));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Fixture response timeout')));req.end(body);});
}
beforeAll(async()=>{
 expect(process.platform).toBe('linux');await new Promise<void>(done=>backend.listen(0,'127.0.0.1',done));backendPort=(backend.address() as import('node:net').AddressInfo).port;
 const reservation=createServer();await new Promise<void>(done=>reservation.listen(0,'127.0.0.1',done));port=(reservation.address() as import('node:net').AddressInfo).port;await new Promise<void>((done,fail)=>reservation.close(e=>e?fail(e):done()));
 const original=`server {\n    listen 127.0.0.1:${port};\n    server_name staging.example.invalid;\n${['127.0.0.1',...CLOUDFLARE_CIDRS].map((n:string)=>'    allow '+n+';').join('\n')}\n    deny all;\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-Proto https;\n        proxy_read_timeout 300s;\n    }\n}\n`;
 const hardened=hardenProxyConfig(original).replaceAll('http://127.0.0.1:3000;','http://127.0.0.1:'+backendPort+';');
 const policy=renderIngressHttp({edgeNetworks:['127.0.0.1/32'],localPeer:'127.0.0.3/32'});
 directory=await mkdtemp(join(tmpdir(),'aihr-ingress-'));await writeFile(join(directory,'nginx.conf'),'pid /tmp/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 256; }\nhttp { access_log off; client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;\n'+policy+hardened+'}\n');
 await run('docker',['pull',image],{timeout:120000,maxBuffer:1024*1024});
 await run('docker',['run','--detach','--name',container,'--network','host','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--user','101:101','--volume',join(directory,'nginx.conf')+':/etc/nginx/nginx.conf:ro',image,'nginx','-g','daemon off;'],{timeout:30000});started=true;
 let last:unknown;for(let i=0;i<50;i++){try{const r=await send();if(r.status===200)return;last=r;}catch(e){last=e;}await new Promise(done=>setTimeout(done,100));}const logs=await run('docker',['logs',container],{timeout:5000,maxBuffer:65536});throw Error('Fixture nginx not ready: '+String(last)+' '+logs.stdout+' '+logs.stderr);
},180000);
afterAll(async()=>{for(const finish of held)finish();held=[];if(started)await run('docker',['rm','--force',container],{timeout:15000});await new Promise<void>(done=>backend.close(()=>done()));if(directory)await rm(directory,{recursive:true,force:true});});
it('restores only the verified edge address and overwrites a forged application source',async()=>{
 const r=await send('/api/mobile/profile','203.0.113.9',{'x-aihr-request-source':'198.51.100.77','x-forwarded-for':'198.51.100.88'});expect(r.status).toBe(200);expect(JSON.parse(r.body)).toEqual({source:'203.0.113.9',host:'staging.example.invalid',proto:'https'});
});
it('denies an untrusted socket peer even when it forges all forwarding headers',async()=>{
 const before=backendRequests,r=await send('/api/mobile/profile','203.0.113.9',{'x-aihr-request-source':'203.0.113.10'},'127.0.0.2');expect(r.status).toBe(403);expect(backendRequests).toBe(before);
});
it.each(['','not-an-ip','203.0.113.1, 203.0.113.2'])('refuses missing, malformed or multiple edge identities: %s',async ip=>{expect((await send('/api/mobile/profile',ip)).status).toBe(400);});
it('does not implicitly trust Worker subrequest identity',async()=>{expect((await send('/login/api/password','203.0.113.9',{'cf-worker':'unknown.example.invalid'})).status).toBe(403);});
it('contains a noisy mobile source despite forged source rotation and preserves a quiet source',async()=>{
 const results=[];for(let i=0;i<85;i++)results.push(await send('/api/mobile/profile','203.0.113.10',{'x-aihr-request-source':'198.51.100.'+(i+1)}));
 const denied=results.filter(r=>r.status===429);expect(denied.length).toBeGreaterThan(0);expect(denied[0].headers['retry-after']).toBe('1');expect(denied[0].headers['cache-control']).toBe('no-store');expect(JSON.parse(denied[0].body)).toEqual({error:'unavailable'});expect((await send('/api/mobile/profile','203.0.113.11')).status).toBe(200);
});
it('enforces separate auth admission and body bounds',async()=>{
 const results=[];for(let i=0;i<42;i++)results.push((await send('/login/api/password','203.0.113.20')).status);expect(results).toContain(429);expect((await send('/login/api/password','203.0.113.21')).status).toBe(200);expect((await send('/api/mobile/profile','203.0.113.20')).status).toBe(200);expect((await send('/login/api/password','203.0.113.22',{},'127.0.0.1','x'.repeat(8193))).status).toBe(413);
});
it('bounds simultaneous mobile connections without consuming the quiet source capacity',async()=>{
 const pending=Array.from({length:22},()=>send('/api/mobile/hold','203.0.113.50'));await new Promise(done=>setTimeout(done,600));expect(held.length).toBeLessThanOrEqual(20);expect(held.length).toBeGreaterThan(0);expect((await send('/api/mobile/profile','203.0.113.51')).status).toBe(200);for(const finish of held)finish();held=[];const results=await Promise.all(pending);expect(results.some(r=>r.status===429)).toBe(true);expect(results.some(r=>r.status===200)).toBe(true);
});
it('closes a slow incomplete authentication body under the configured deadline',async()=>{
 const response=await new Promise<string>((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port,localAddress:'127.0.0.1'});let data='';socket.setTimeout(14000,()=>socket.destroy(Error('Body deadline not enforced')));socket.on('connect',()=>socket.write('POST /login/api/password HTTP/1.1\r\nHost: staging.example.invalid\r\nCF-Connecting-IP: 203.0.113.70\r\nContent-Length: 100\r\n\r\nx'));socket.on('data',b=>data+=b);socket.on('end',()=>resolve(data));socket.on('error',reject);});expect(response).toMatch(/^HTTP\/1\.1 408/);
},16000);
