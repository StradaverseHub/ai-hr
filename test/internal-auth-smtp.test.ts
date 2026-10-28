/** Pure transport contract: Nodemailer is mocked; no SMTP, network, database or Auth records. */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const smtp=vi.hoisted(()=>({create:vi.fn(),send:vi.fn(),close:vi.fn()}));
vi.mock('nodemailer',()=>({default:{createTransport:smtp.create}}));
import { sendSmtp, type Mail, type Relay } from '../lib/internal-auth/smtp';
import { XLSX_EMAIL_ATTACHMENT_MAX_BYTES, XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE } from '../lib/email-attachment';
import {renderEmailDesign} from '../lib/email-design/render';
import { buildXlsx } from '../lib/spreadsheet';

const relay:Relay={config:{host:'smtp.example.test',port:465,security:'tls',from:'owner@example.test',
  fromName:'AI HR',replyTo:'reply@example.test',auth:true,user:'synthetic-relay-user'},password:'synthetic-relay-secret'};
const plain={to:'recipient@example.test',subject:'AI HR email delivery test',text:'Unchanged plain message.'};
const id='<employee-master-11111111-1111-4111-8111-111111111111@hr.test>';
const attachment=()=>({bytes:Buffer.from([0x50,0x4b,0x03,0x04]),filename:'employee-master.xlsx',contentType:XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE});
const report=(value:unknown=attachment(),messageId:unknown=id)=>({...plain,messageId,attachment:value});
beforeEach(()=>{vi.resetAllMocks();smtp.create.mockReturnValue({sendMail:smtp.send,close:smtp.close});smtp.send.mockResolvedValue({accepted:[plain.to]});});

describe('Auth-owned pure SMTP transport',()=>{
  it('keeps the plain-message envelope, TLS, credentials, timeouts and default headers unchanged',async()=>{
    await sendSmtp(relay,plain);
    expect(smtp.create).toHaveBeenCalledWith({host:relay.config.host,port:465,secure:true,
      auth:{user:relay.config.user,pass:relay.password},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},
      connectionTimeout:10_000,greetingTimeout:8_000,socketTimeout:15_000,disableFileAccess:true,disableUrlAccess:true});
    expect(smtp.send).toHaveBeenCalledWith({from:{name:relay.config.fromName,address:relay.config.from},to:plain.to,
      replyTo:relay.config.replyTo,envelope:{from:relay.config.from,to:[plain.to]},subject:plain.subject,text:plain.text,
      disableFileAccess:true,disableUrlAccess:true});
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it('transmits the shared renderer HTML and plain-text alternative together',async()=>{
    const rendered=renderEmailDesign(null,'invitation','en',{subject:'Fictional invitation',text:'Essential security notice.\nhttps://example.com/activate',link:'https://example.com/activate'});
    await sendSmtp(relay,{to:plain.to,...rendered});
    expect(smtp.send).toHaveBeenCalledWith(expect.objectContaining({to:plain.to,subject:rendered.subject,text:rendered.text,html:rendered.html}));
    expect(rendered.text).toContain('Essential security notice.');expect(rendered.html).toContain('https://example.com/activate');
  });

  it('keeps authentication off and empty reply-to absent for existing callers',async()=>{
    await sendSmtp({...relay,config:{...relay.config,auth:false,replyTo:''}},plain);
    expect(smtp.create).toHaveBeenCalledWith(expect.objectContaining({auth:undefined}));
    expect(smtp.send).toHaveBeenCalledWith(expect.objectContaining({replyTo:undefined}));
    expect(JSON.stringify(smtp.send.mock.calls)).not.toContain(relay.password);
  });

  it('hands Nodemailer one actual workbook Buffer and preserves the deterministic delivery message ID',async()=>{
    const bytes=Buffer.from(await buildXlsx(['Employee ID','Name'],[['0012','Fictional employee']],{sheetName:'Employee Master',textColumns:[0],textRowFloor:1}));
    await sendSmtp(relay,{...plain,messageId:id,attachment:{...attachment(),bytes}});
    const sent=smtp.send.mock.calls[0][0] as {messageId:string;attachments:{filename:string;content:Buffer;contentType:string}[];envelope:{from:string;to:string[]}};
    expect(sent.messageId).toBe(id);expect(sent.envelope).toEqual({from:relay.config.from,to:[plain.to]});
    expect(sent.attachments).toHaveLength(1);expect(Buffer.isBuffer(sent.attachments[0].content)).toBe(true);
    expect(sent.attachments[0].content.equals(bytes)).toBe(true);
    expect(sent.attachments[0]).toMatchObject({filename:'employee-master.xlsx',contentType:XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE});
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it('accepts the existing exact20,000,000-byte boundary and refuses the next byte before creating a transport',async()=>{
    expect(XLSX_EMAIL_ATTACHMENT_MAX_BYTES).toBe(20_000_000);
    await sendSmtp(relay,{...plain,messageId:id,attachment:{...attachment(),bytes:Buffer.alloc(XLSX_EMAIL_ATTACHMENT_MAX_BYTES)}});
    expect(smtp.send).toHaveBeenCalledOnce();smtp.create.mockClear();smtp.send.mockClear();
    await expect(sendSmtp(relay,report({...attachment(),bytes:Buffer.alloc(XLSX_EMAIL_ATTACHMENT_MAX_BYTES+1)}) as Mail)).rejects.toMatchObject({code:'invalid'});
    expect(smtp.create).not.toHaveBeenCalled();expect(smtp.send).not.toHaveBeenCalled();
  });

  it.each<[string,()=>unknown]>([
    ['empty bytes',()=>({...attachment(),bytes:Buffer.alloc(0)})],
    ['base64 text',()=>({...attachment(),bytes:'UEsDBA=='})],
    ['absolute path',()=>({...attachment(),filename:'/tmp/report.xlsx'})],
    ['parent path',()=>({...attachment(),filename:'../report.xlsx'})],
    ['URL filename',()=>({...attachment(),filename:'https://evil.test/report.xlsx'})],
    ['header injection',()=>({...attachment(),filename:'report.xlsx\r\nX-Test: injected'})],
    ['trailing newline',()=>({...attachment(),filename:'report.xlsx\n'})],
    ['filename beyond renderer bound',()=>({...attachment(),filename:'r'.repeat(146)+'.xlsx'})],
    ['wrong extension',()=>({...attachment(),filename:'report.pdf'})],
    ['wrong MIME',()=>({...attachment(),contentType:'application/octet-stream'})],
    ['unknown path field',()=>({...attachment(),path:'/etc/passwd'})],
    ['unknown URL field',()=>({...attachment(),href:'https://evil.test/secret'})],
    ['unknown raw field',()=>({...attachment(),raw:'secret'})],
    ['unknown encoding field',()=>({...attachment(),encoding:'base64'})],
    ['multiple attachments',()=>[attachment(),attachment()]],
  ])('refuses %s before any SMTP transport exists',async(_name,value)=>{
    await expect(sendSmtp(relay,report(value()) as Mail)).rejects.toMatchObject({code:'invalid'});
    expect(smtp.create).not.toHaveBeenCalled();expect(smtp.send).not.toHaveBeenCalled();
  });

  it.each([undefined,'employee-master-id@hr.test','<id@hr.test>\r\nBcc: secret@example.test','<id@../secret>','<id@bad..test>'])
    ('refuses missing or unsafe attachment message ID %s',async value=>{
      const input=value===undefined?{...plain,attachment:attachment()}:report(attachment(),value);
      await expect(sendSmtp(relay,input as Mail)).rejects.toMatchObject({code:'invalid'});
      expect(smtp.create).not.toHaveBeenCalled();
    });

  it('refuses extra Nodemailer attachment/envelope options and multiple attachment recipients',async()=>{
    for(const input of [
      {...report(),attachments:[{path:'/etc/passwd'}]},
      {...report(),envelope:{to:['attacker@example.test']}},
      {...report(),password:'caller-secret'},
      {...report(),to:'first@example.test,second@example.test'},
    ])await expect(sendSmtp(relay,input as Mail)).rejects.toMatchObject({code:'invalid'});
    expect(smtp.create).not.toHaveBeenCalled();
  });

  it.each([{accepted:[]},{accepted:[plain.to,'unexpected@example.test']}])('retains uncertain acceptance and closes the transport for %j',async({accepted})=>{
    smtp.send.mockResolvedValue({accepted});await expect(sendSmtp(relay,plain)).rejects.toMatchObject({code:'uncertain'});
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it('preserves the transport error and closes after a failed send',async()=>{
    const error=new Error('synthetic connection failure');smtp.send.mockRejectedValue(error);
    await expect(sendSmtp(relay,plain)).rejects.toBe(error);expect(smtp.close).toHaveBeenCalledOnce();
  });

  it('has no database/private-store/session import and keeps existing callers on the extracted default',()=>{
    const leaf=readFileSync(new URL('../lib/internal-auth/smtp.ts',import.meta.url),'utf8');
    expect(leaf).not.toMatch(/from\s+['"][^'"]*(?:db\/|store|session|crypto)['"]/);
    const owner=readFileSync(new URL('../lib/internal-auth/mail.ts',import.meta.url),'utf8');
    expect(owner).toContain("import { sendSmtp, type Relay, type Mail, type MailTransport } from './smtp'");
    expect(owner).toContain('transport: MailTransport = sendSmtp');
  });
});
