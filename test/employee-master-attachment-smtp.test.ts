import {afterAll,beforeAll,expect,it} from 'vitest';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {buildXlsx} from '../lib/spreadsheet';
import {startReportSmtpSink,reportAttachment,type SinkMode} from './fixtures/managed-report-delivery/smtp-sink';
let directory:string;
beforeAll(async()=>{
 directory=mkdtempSync(path.join(tmpdir(),'aihr-report-smtp-'));
 writeFileSync(path.join(directory,'extensions.cnf'),'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
 const run=(args:string[])=>execFileSync('openssl',args,{cwd:directory,stdio:'ignore'});
 run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-subj','/CN=Disposable report fixture CA','-days','1']);
 run(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=127.0.0.1']);
 run(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','1','-extfile','extensions.cnf']);
 writeFileSync(path.join(directory,'report.xlsx'),await buildXlsx(['Employee ID','Name'],[['000123','Fictional recipient']],{sheetName:'Fictional report',textColumns:[0]}));
});
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
async function relay(mode:SinkMode,trust=true){
 const sink=await startReportSmtpSink({key:readFileSync(path.join(directory,'server.key')),cert:readFileSync(path.join(directory,'server.pem')),recipients:['recipient@report-acceptance.invalid']});sink.setMode(mode);
 try{
  const result=await new Promise<{outcome:string;error?:string}>((resolve,reject)=>{
   const env={...process.env};delete env.NODE_EXTRA_CA_CERTS;if(trust)env.NODE_EXTRA_CA_CERTS=path.join(directory,'ca.pem');
   const child=spawn(process.execPath,['--import','tsx','test/fixtures/managed-report-delivery/smtp-client.ts',String(sink.port),path.join(directory,'report.xlsx')],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});let text='';
   const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Disposable report SMTP timed out'));},25_000);child.stderr.resume();child.stdout.on('data',chunk=>text+=chunk);
   child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);try{if(code!==0)throw new Error('Transport child failed');resolve(JSON.parse(text));}catch(error){reject(error);}});
  });return {result,messages:[...sink.messages]};
 }finally{await sink.close();}
}
it('transmits the actual XLSX once to the exact fictional envelope, with fixed localized copy',async()=>{
 const value=await relay('accept');expect(value.result).toEqual({outcome:'sent'});expect(value.messages).toHaveLength(1);expect(value.messages[0].recipients).toEqual(['recipient@report-acceptance.invalid']);
 expect(value.messages[0].raw.toString()).toContain('Subject: Employee Master report');expect(value.messages[0].raw.toString()).toContain('Employee-Master.xlsx');
 const bytes=reportAttachment(value.messages[0].raw);expect(bytes).toEqual(readFileSync(path.join(directory,'report.xlsx')));
 const book=XLSX.read(bytes,{type:'buffer'}),sheet=book.Sheets['Fictional report'];expect(sheet.A2).toMatchObject({t:'s',v:'000123'});expect(sheet.B2.v).toBe('Fictional recipient');
});
it('sends no attachment through untrusted TLS',async()=>{const value=await relay('accept',false);expect(value.result.outcome).not.toBe('sent');expect(value.messages).toEqual([]);});
it('distinguishes rejected DATA from SMTP acknowledgement loss without issuing another send',async()=>{
 const rejected=await relay('temporary'),lost=await relay('lost');expect(rejected.result).toEqual({outcome:'retry',error:'smtpTemporary'});expect(lost.result).toEqual({outcome:'uncertain',error:'uncertain'});expect(rejected.messages).toHaveLength(1);expect(lost.messages).toHaveLength(1);
 // The report orchestration converts temporary transport failure into terminal failed; it does not use workflow retry.
});
