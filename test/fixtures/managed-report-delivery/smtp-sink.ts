/** Controlled implicit-TLS sink. Reserved fictional envelopes only; no upstream relay exists. */
import {createServer,type TLSSocket} from 'node:tls';
import {createHash} from 'node:crypto';
export type SinkMode='accept'|'temporary'|'lost'|'hold';
export type CapturedReportMail={recipients:string[];raw:Buffer;sha256:string};
export async function startReportSmtpSink(input:{key:Buffer;cert:Buffer;port?:number;recipients:readonly string[];recipientCount?:number}) {
 if(!input.recipients.length||input.recipients.some(value=>!/^[-a-z0-9]+@report-acceptance\.invalid$/.test(value)))throw new Error('Fictional sink recipients required.');
 let recipientCount=input.recipientCount??1;if(!Number.isInteger(recipientCount)||recipientCount<1||recipientCount>input.recipients.length)throw Error('Invalid fixture envelope count');
 let mode:SinkMode='accept',capturedBytes=0;const messages:CapturedReportMail[]=[],sockets=new Set<TLSSocket>();
 const server=createServer({key:input.key,cert:input.cert,minVersion:'TLSv1.2'},socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.write('220 localhost disposable report fixture\r\n');
  let pending=Buffer.alloc(0),data=false,size=0,recipients:string[]=[],chunks:Buffer[]=[];
  socket.on('data',(chunk:Buffer)=>{
   pending=Buffer.concat([pending,chunk]);if(pending.length>32_000_000){socket.destroy();return;}
   let end:number;
   while((end=pending.indexOf('\r\n'))>=0){const bytes=pending.subarray(0,end);pending=pending.subarray(end+2);const line=bytes.toString('ascii');
    if(data){
     if(line==='.'){
      data=false;const raw=Buffer.concat(chunks);if(messages.length>=128||capturedBytes+raw.length>64_000_000){socket.destroy();return;}capturedBytes+=raw.length;messages.push({recipients:[...recipients],raw,sha256:createHash('sha256').update(raw).digest('hex')});
      if(mode==='lost')socket.destroy();else if(mode==='temporary')socket.write('451 4.3.0 Fixture temporary rejection\r\n');else if(mode==='accept')socket.write('250 2.0.0 Fixture accepted\r\n');
      chunks=[];size=0;continue;
     }
     const unstuffed=bytes[0]===46?bytes.subarray(1):bytes;size+=unstuffed.length+2;
     if(size>30_000_000){socket.destroy();return;}chunks.push(Buffer.concat([unstuffed,Buffer.from('\r\n')]));continue;
    }
    if(/^EHLO |^HELO /.test(line))socket.write('250 localhost\r\n');
    else if(/^MAIL FROM:/.test(line)){recipients=[];socket.write('250 OK\r\n');}
    else if(/^RCPT TO:/.test(line)){
     const address=line.match(/^RCPT TO:<([^>]+)>$/)?.[1];
     if(!address||!input.recipients.includes(address)){socket.write('550 5.1.1 Fixture recipient refused\r\n');continue;}
     recipients.push(address);socket.write('250 OK\r\n');
    }else if(line==='DATA'){if(recipients.length!==recipientCount||new Set(recipients).size!==recipientCount){socket.write('554 Fixture envelope count differs\r\n');continue;}data=true;socket.write('354 End with dot\r\n');}
    else if(line==='QUIT')socket.end('221 Bye\r\n');else if(line==='RSET'){recipients=[];socket.write('250 OK\r\n');}else socket.write('502 Unsupported fixture command\r\n');
   }
  });
 });
 server.on('tlsClientError',()=>{});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(input.port??0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture sink did not bind.');
 return {port:address.port,messages,setRecipientCount:(count:number)=>{if(!Number.isInteger(count)||count<1||count>input.recipients.length)throw Error('Invalid fixture envelope count');recipientCount=count;},setMode:(next:SinkMode)=>{mode=next;},disconnect:()=>{for(const socket of sockets)socket.destroy();},close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
/** Unfold continuation lines only in the MIME header section, never in encoded body data. */
function mimePart(part:string):{headers:Map<string,string[]>;body:string} {
 const split=part.indexOf('\r\n\r\n');if(split<0||split>16384)throw new Error('Missing or oversized MIME headers.');
 const header=part.slice(0,split).replace(/\r\n[ \t]+/g,' '),headers=new Map<string,string[]>();
 for(const line of header.split('\r\n')){
  const match=line.match(/^([a-zA-Z0-9-]+):[ \t]*(.*)$/);if(!match)throw new Error('Invalid MIME header.');
  const key=match[1].toLowerCase(),values=headers.get(key)??[];values.push(match[2].trim());headers.set(key,values);
 }
 return {headers,body:part.slice(split+4)};
}
function oneHeader(headers:Map<string,string[]>,name:string):string {
 const values=headers.get(name);if(values?.length!==1)throw new Error('Missing or repeated MIME header.');return values[0];
}
/** Reads the attachment emitted by the real Nodemailer transport, never a caller-supplied workbook. */
export function reportAttachment(raw:Buffer,expectedType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'|'application/pdf'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'):Buffer {
 const outer=mimePart(raw.toString('ascii')),type=oneHeader(outer.headers,'content-type');
 if(type.split(';')[0].trim().toLowerCase()!=='multipart/mixed')throw new Error('Missing multipart workbook.');
 const boundary=type.match(/(?:^|;)\s*boundary="([^"\r\n]{1,200})"(?:;|$)/i)?.[1];if(!boundary)throw new Error('Missing multipart boundary.');
 const parts:{headers:Map<string,string[]>;body:string}[]=[];
 for(const segment of outer.body.split('--'+boundary).slice(1)){
  if(segment.startsWith('--'))break;
  if(!segment.startsWith('\r\n'))throw new Error('Invalid multipart delimiter.');
  const part=mimePart(segment.slice(2)),dispositions=part.headers.get('content-disposition')??[];
  if(dispositions.some(value=>value.split(';')[0].trim().toLowerCase()==='attachment')){
   if(dispositions.length!==1)throw new Error('Repeated attachment disposition.');parts.push(part);
  }
 }
 if(parts.length!==1)throw new Error(expectedType==='application/pdf'?'Expected one PDF attachment.':'Expected one workbook attachment.');
 const part=parts[0],mediaType=oneHeader(part.headers,'content-type').split(';')[0].trim().toLowerCase(),encoding=oneHeader(part.headers,'content-transfer-encoding').toLowerCase();
 if(mediaType!==expectedType||encoding!=='base64')throw new Error('Unexpected attachment encoding.');
 const encoded=part.body.trim();if(!/^[a-zA-Z0-9+/=\r\n]+$/.test(encoded))throw new Error('Invalid attachment encoding.');
 const result=Buffer.from(encoded.replace(/\s/g,''),'base64');if(expectedType==='application/pdf'?result.subarray(0,5).toString()!=='%PDF-':result.length<4||result.subarray(0,2).toString()!=='PK')throw new Error('Attachment signature differs.');return result;
}
