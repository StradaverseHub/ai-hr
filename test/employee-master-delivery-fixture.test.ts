import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,lstat,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {confirmOwnedReportArtifactRemoval,ownedReportArtifactPath} from './fixtures/managed-report-delivery/artifact-cleanup';
import {reportAttachment} from './fixtures/managed-report-delivery/smtp-sink';

const temporary:string[]=[];
afterEach(async()=>{for(const directory of temporary.splice(0))await rm(directory,{recursive:true,force:true});});
const missing=()=>Promise.reject(Object.assign(new Error('Missing fixture artifact'),{code:'ENOENT'}));
it('accepts only successful remove acknowledgement and independently proven exact-path absence',async()=>{
 const pair={id:randomUUID(),token:randomUUID()},send=vi.fn(async()=>({ok:true,removed:true})),inspect=vi.fn(missing);
 await expect(confirmOwnedReportArtifactRemoval(pair,send,inspect)).resolves.toBeUndefined();
 expect(send).toHaveBeenCalledExactlyOnceWith({phase:'remove',occurrenceId:pair.id,leaseToken:pair.token});expect(inspect).toHaveBeenCalledExactlyOnceWith(ownedReportArtifactPath(pair));
});
it.each([{ok:false,reason:'generationFailed'},{ok:true,removed:false},{ok:true,ready:true},null])('refuses a false/missing remove acknowledgement even if a path check would say absent: %j',async reply=>{
 const inspect=vi.fn(missing);await expect(confirmOwnedReportArtifactRemoval({id:randomUUID(),token:randomUUID()},async()=>reply,inspect)).rejects.toThrow('did not acknowledge');expect(inspect).not.toHaveBeenCalled();
});
it('refuses success acknowledgement when the generated artifact is actually still present',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'aihr-artifact-negative-'));temporary.push(directory);const file=path.join(directory,'present.xlsx');await writeFile(file,'fixture');
 const pair={id:randomUUID(),token:randomUUID()},inspect=vi.fn(async(exact:string)=>{expect(exact).toBe(ownedReportArtifactPath(pair));return lstat(file);});
 await expect(confirmOwnedReportArtifactRemoval(pair,async()=>({ok:true,removed:true}),inspect)).rejects.toThrow('still present');
});
it('does not count permission or other inspection failures as an absent artifact',async()=>{
 await expect(confirmOwnedReportArtifactRemoval({id:randomUUID(),token:randomUUID()},async()=>({ok:true,removed:true}),async()=>{throw Object.assign(new Error('Fixture inaccessible'),{code:'EACCES'});})).rejects.toThrow('could not be verified');
});
it('refuses an invalid occurrence identity before calling the renderer or filesystem',async()=>{
 const send=vi.fn(async()=>({ok:true,removed:true})),inspect=vi.fn(missing);await expect(confirmOwnedReportArtifactRemoval({id:'../../other',token:randomUUID()},send,inspect)).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();
});

const zip=Buffer.from('PKfixture-archive');
function mime(header:string,body=zip.toString('base64'),count=1){
 const attachment='--fixture\r\n'+header+'\r\nContent-Disposition: attachment; filename=Employee-Master.xlsx\r\n\r\n'+body+'\r\n';
 return Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/mixed;\r\n boundary="fixture"\r\n\r\n'+attachment.repeat(count)+'--fixture--\r\n','ascii');
}
it('accepts valid folded Nodemailer XLSX headers without changing body bytes',()=>{
 const value=mime('Content-Type:\r\n application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;\r\n name=Employee-Master.xlsx\r\nContent-Transfer-Encoding:\r\n\tbase64');
 expect(reportAttachment(value)).toEqual(zip);
});
it.each([
 ['application/octet-stream','base64'],
 ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','quoted-printable'],
 ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet-evil','base64'],
])('refuses wrong attachment media type or transfer encoding %s/%s', (type,encoding)=>{
 expect(()=>reportAttachment(mime('Content-Type: '+type+'\r\nContent-Transfer-Encoding: '+encoding))).toThrow('Unexpected attachment encoding');
});
it('does not unfold whitespace in the encoded body or accept MIME headers smuggled through body text',()=>{
 const header='Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\nContent-Transfer-Encoding: base64';
 expect(()=>reportAttachment(mime(header,zip.toString('base64').slice(0,4)+'\r\n '+zip.toString('base64').slice(4)))).toThrow('Invalid attachment encoding');
 expect(()=>reportAttachment(mime('Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64','Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n'+zip.toString('base64')))).toThrow('Unexpected attachment encoding');
});
it('refuses two attachments and duplicate content-type headers',()=>{
 const header='Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\nContent-Transfer-Encoding: base64';expect(()=>reportAttachment(mime(header,undefined,2))).toThrow('Expected one workbook attachment');
 expect(()=>reportAttachment(mime(header+'\r\nContent-Type: application/octet-stream'))).toThrow('repeated MIME header');
});
