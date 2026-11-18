/** Real MIME serialization to an in-memory stream; no server, relay, recipient or network. */
import {expect,it,vi} from 'vitest';
import sharp from 'sharp';
import type {SendMailOptions} from 'nodemailer';
const capture=vi.hoisted(()=>({messages:[] as Buffer[]}));
vi.mock('nodemailer',async original=>{
 const actual=await original<typeof import('nodemailer')>();
 return {default:{createTransport:()=>{
  const stream=actual.default.createTransport({streamTransport:true,buffer:true,newline:'unix'});
  return {sendMail:async(mail:SendMailOptions)=>{const result=await stream.sendMail(mail);capture.messages.push(result.message as Buffer);return {...result,accepted:['recipient@fictional.invalid']};},close:()=>stream.close()};
 }}};
});
import {sendSmtp} from '../lib/internal-auth/smtp';
import {renderEmailBody} from '../lib/email-body/render';
import {v9EmailContent,v9ImageCid} from '../lib/lifecycle-v9-email-content';
import type {EmailAsset} from '../lib/lifecycle-v9-model';
it('serializes exact owned bytes and Content-ID for all four raster MIME types with escaped alt and filename fallback',async()=>{
 const png=await sharp({create:{width:2,height:2,channels:4,background:'#bb4c10'}}).png().toBuffer();
 const formats=[['png','image/png',png],['jpg','image/jpeg',await sharp(png).jpeg().toBuffer()],['gif','image/gif',await sharp(png).gif().toBuffer()],['webp','image/webp',await sharp(png).webp().toBuffer()]] as const;
 for(const [extension,mime,bytes] of formats){
  const image:EmailAsset={id:'9ea43e78-c325-4f88-8313-1b6fc3a1a78e',kind:'image',name:'Fictional welcome.'+extension,mimeType:mime,size:bytes.length,contentHash:'a'.repeat(64),at:'2026-11-18T00:00:00Z',by:'Fictional HR',alt:'Grow "safely" & <together>'};
  const content=renderEmailBody({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Before'},{type:'image',attrs:{assetId:image.id,alt:image.alt??image.name}},{type:'text',text:'After'}]}]},{values:{},images:[{id:image.id,alt:image.alt??image.name,cid:v9ImageCid(image.id)}]});
  expect(content.html).toContain('alt="Grow &quot;safely&quot; &amp; &lt;together&gt;"');
  expect(v9EmailContent('{image:'+image.id+'}',[{...image,alt:''}]).html).toContain('alt="'+image.name+'"');
  await sendSmtp({config:{host:'unused.fixture.invalid',port:465,security:'tls',from:'owner@fictional.invalid',fromName:'Fictional HR',replyTo:'',auth:false,user:''}},{to:'recipient@fictional.invalid',subject:'Fictional image',text:content.text,html:content.html,messageId:'<image-fixture@fictional.invalid>',attachments:[{filename:image.name,contentType:mime,bytes,cid:v9ImageCid(image.id)}]});
  const raw=capture.messages.at(-1)!.toString();expect(raw).toContain('Content-ID: <'+v9ImageCid(image.id)+'>');expect(raw).toContain('Content-Disposition: inline;');
  const part=raw.split('Content-Type: '+mime)[1];expect(part).toBeTruthy();const encoded=part.split(/\r?\n\r?\n/)[1].split(/\r?\n--/)[0];expect(Buffer.from(encoded.replace(/\s/g,''),'base64')).toEqual(bytes);
  const decoded=raw.replace(/=\r?\n/g,'').replace(/=([0-9A-F]{2})/g,(_,hex:string)=>String.fromCharCode(parseInt(hex,16)));expect(decoded).toContain('src="cid:'+v9ImageCid(image.id)+'"');
 }
 expect(capture.messages).toHaveLength(4);
});
