import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';

const build=readFileSync('.next/BUILD_ID','utf8').trim();
if(!/^synthetic-[a-z0-9-]+$/.test(build)) throw Error('Expected synthetic build identity');
createServer((request,response)=>{
 if(request.method!=='GET'||request.url!=='/health'){
  response.writeHead(404).end();
  return;
 }
 response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({build}));
}).listen(Number(process.env.PORT??'3107'),'127.0.0.1');
