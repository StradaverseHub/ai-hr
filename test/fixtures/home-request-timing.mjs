import http from 'node:http';
import {setTimeout as pause} from 'node:timers/promises';
const server=http.createServer(async(request,response)=>{
 const card=request.url.startsWith('/api/home/')?'tasks':'calendar';
 globalThis.__aihrPerfHomeStage?.('handler');
 globalThis.__aihrPerfHomeStage?.('session');
 globalThis.__aihrPerfHomeStage?.('PRIVATE_STAGE','PRIVATE_CARD');
 globalThis.__aihrPerfHomeStage?.('read-start',card);
 await pause(card==='tasks'?25:5);
 globalThis.__aihrPerfHomeStage?.('read-finish',card);
 response.end('PRIVATE_RESPONSE');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 await Promise.all(['/api/home/sharing-initial?employmentId=PRIVATE_ID','/?private=PRIVATE_QUERY','/PRIVATE_PATH'].map(async path=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+path,{headers:{Cookie:'PRIVATE_COOKIE'}});
  await response.text();
 }));
}finally{
 await new Promise(resolve=>server.close(resolve));
}
