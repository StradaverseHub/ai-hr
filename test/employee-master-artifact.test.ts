import {createHash} from 'node:crypto';
import {mkdtemp,open,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it} from 'vitest';
import {buildXlsx} from '../lib/spreadsheet';
import {fingerprintReportBytes} from '../lib/employee-master-artifact';
import {masterArtifactFingerprint} from '../lib/employee-master-artifact-model';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE as MIME,XLSX_EMAIL_ATTACHMENT_MAX_BYTES as MAX} from '../lib/email-attachment';
import {MASTER_EMAIL_ATTACHMENT_MAX_BYTES} from '../lib/employee-master-delivery-model';
import {fingerprintOwnedReportArtifact,type ReportArtifactHandle} from '../deploy/identity-email/report-artifact';
import {rendererPeerRole,rendererPeerMayRequest} from '../deploy/identity-email/renderer-peer-policy';
const temporary:string[]=[];
afterEach(async()=>{for(const dir of temporary.splice(0))await rm(dir,{recursive:true,force:true});});
const uid=process.getuid?.()??1;
async function fixture(bytes:Uint8Array){const dir=await mkdtemp(path.join(tmpdir(),'aihr-report-hash-'));temporary.push(dir);const file=path.join(dir,'owned.xlsx');await writeFile(file,bytes);await chmod(file,0o640);return {file,handle:await open(file,'r')};}
type ArtifactStat=Awaited<ReturnType<ReportArtifactHandle['stat']>>;
function memory(bytes:Buffer,patch:Partial<ArtifactStat>={}) {
  const stat:ArtifactStat={dev:BigInt('1'),ino:BigInt('2'),uid:BigInt(uid),mode:BigInt(0o100640),size:BigInt(bytes.length),nlink:BigInt('1'),mtimeNs:BigInt('3'),ctimeNs:BigInt('4'),isFile:()=>true,...patch};
  let stats=0,reads=0;
  const handle:ReportArtifactHandle={stat:async()=>{stats++;return stat;},read:async(buffer,offset,length,position)=>{reads++;const part=bytes.subarray(position,position+length);buffer.set(part,offset);return {bytesRead:part.length};}};
  return {handle,stat,counts:()=>({stats,reads})};
}
describe('one exact XLSX fingerprint contract',()=>{
  it('hashes actual generated workbook bytes and the exact Uint8Array view without copying unrelated bytes',async()=>{
    const bytes=Buffer.from(await buildXlsx(['Employee ID','Name'],[['0012','Fictional employee']],{sheetName:'Employee Master',textColumns:[0],textRowFloor:1}));
    const value=fingerprintReportBytes(bytes,MIME);
    expect(value).toEqual({sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,contentType:MIME});
    const padded=Buffer.concat([Buffer.from('prefix'),bytes,Buffer.from('suffix')]);
    expect(fingerprintReportBytes(padded.subarray(6,6+bytes.length),MIME)).toEqual(value);
    expect(MASTER_EMAIL_ATTACHMENT_MAX_BYTES).toBe(MAX);expect(MAX).toBe(20_000_000);
  });
  it('accepts the exact byte bound and refuses empty/oversized bytes and wrong MIME',()=>{
    expect(fingerprintReportBytes(Buffer.alloc(MAX),MIME).byteLength).toBe(MAX);
    for(const bytes of [Buffer.alloc(0),Buffer.alloc(MAX+1)])expect(()=>fingerprintReportBytes(bytes,MIME)).toThrow();
    expect(()=>fingerprintReportBytes(Buffer.from('bytes'),'application/octet-stream')).toThrow();
  });
  it('rejects missing/forged/path-bearing fingerprint fields instead of normalizing them',()=>{
    const value=fingerprintReportBytes(Buffer.from('fixture'),MIME);
    for(const patch of [{sha256:'A'.repeat(64)},{byteLength:0},{byteLength:MAX+1},{byteLength:1.5},{contentType:'application/zip'},{path:'/tmp/file'},{bytes:'caller-content'}])expect(masterArtifactFingerprint.safeParse({...value,...patch}).success).toBe(false);
  });
});
describe('renderer-owned descriptor proof',()=>{
  it('streams a real regular owned file and matches the actual Buffer hash',async()=>{
    const bytes=Buffer.from('PK fictional owned workbook bytes'),{handle}=await fixture(bytes);
    try{expect(await fingerprintOwnedReportArtifact(handle,uid)).toEqual(fingerprintReportBytes(bytes,MIME));}finally{await handle.close();}
  });
  it.each([
    {label:'non-regular file',patch:{isFile:()=>false}},
    {label:'foreign owner',patch:{uid:BigInt(uid+1)}},
    {label:'group writable',patch:{mode:BigInt(0o100660)}},
    {label:'world readable',patch:{mode:BigInt(0o100644)}},
    {label:'empty file',patch:{size:BigInt('0')}},
    {label:'multiple hard links',patch:{nlink:BigInt('2')}},
  ])('refuses $label before reading bytes',async ({patch})=>{
    const io=memory(Buffer.from('fixture'),patch);
    await expect(fingerprintOwnedReportArtifact(io.handle,uid)).rejects.toMatchObject({reason:'generationFailed'});
    expect(io.counts().reads).toBe(0);
  });
  it('classifies initial oversize and growth beyond the shared bound without reading unbounded data',async()=>{
    const oversized=memory(Buffer.from('fixture'),{size:BigInt(MAX+1)});
    await expect(fingerprintOwnedReportArtifact(oversized.handle,uid)).rejects.toMatchObject({reason:'attachmentTooLarge',tooLarge:true});
    expect(oversized.counts().reads).toBe(0);
    const growing=memory(Buffer.from('x'));
    growing.handle.read=async(buffer,_offset,length)=>{buffer.fill(1,0,length);return {bytesRead:length};};
    await expect(fingerprintOwnedReportArtifact(growing.handle,uid)).rejects.toMatchObject({reason:'attachmentTooLarge'});
    expect(growing.counts().stats).toBe(1);
  });
  it.each(['dev','ino','uid','mode','size','nlink','mtimeNs','ctimeNs'] as const)('refuses descriptor %s drift even when the byte count is unchanged',async key=>{
    const io=memory(Buffer.from('fixture'));let calls=0;
    io.handle.stat=async()=>{calls++;return calls===1?io.stat:{...io.stat,[key]:io.stat[key]+BigInt('1')};};
    await expect(fingerprintOwnedReportArtifact(io.handle,uid)).rejects.toMatchObject({reason:'generationFailed'});
  });
  it('refuses truncated reads and a real same-length rewrite during hashing',async()=>{
    const short=memory(Buffer.from('fixture'),{size:BigInt('9')});
    await expect(fingerprintOwnedReportArtifact(short.handle,uid)).rejects.toMatchObject({reason:'generationFailed'});
    const {file,handle}=await fixture(Buffer.from('original'));
    let changed=false;
    const mutating:ReportArtifactHandle={stat:options=>handle.stat(options),read:async(buffer,offset,length,position)=>{
      const result=await handle.read(buffer,offset,length,position);
      if(!changed){changed=true;await writeFile(file,Buffer.from('modified'));await chmod(file,0o600);}
      return result;
    }};
    try{await expect(fingerprintOwnedReportArtifact(mutating,uid)).rejects.toMatchObject({reason:'generationFailed'});}finally{await handle.close();}
  });
});
describe('kernel-derived renderer phase boundary',()=>{
  const identity={selfUid:101,rendererUid:101,mailUid:102,peerUid:102};
  it('preserves default mail-only access for all existing phases',()=>{
    expect(rendererPeerRole(identity)).toBe('mail');
    for(const phase of ['status','render','authorize','remove'] as const)expect(rendererPeerMayRequest('mail',phase)).toBe(true);
    expect(rendererPeerRole({...identity,peerUid:103})).toBeNull();
  });
  it('permits only authorize for the explicitly configured broker and refuses root/self/unknown/colliding identity',()=>{
    expect(rendererPeerRole({...identity,brokerUid:103,peerUid:103})).toBe('broker');
    expect(rendererPeerMayRequest('broker','authorize')).toBe(true);
    for(const phase of ['status','render','remove'] as const)expect(rendererPeerMayRequest('broker',phase)).toBe(false);
    for(const patch of [{peerUid:0},{peerUid:101},{peerUid:999},{selfUid:999},{brokerUid:101},{brokerUid:102},{brokerUid:NaN}])expect(rendererPeerRole({...identity,brokerUid:103,...patch})).toBeNull();
  });
  it('keeps peer provenance in the launcher and broker authorization before filesystem/DB work',()=>{
    const peer=readFileSync(new URL('../deploy/identity-email/renderer-peer.py',import.meta.url),'utf8');
    expect(peer).toContain('SO_PEERCRED');expect(peer).toContain("os.environ.get('REPORT_RENDERER_AUTH_BROKER_UID')");
    expect(peer).not.toMatch(/AUTH_SESSION_KEY|MIGRATION_DATABASE_URL|SMTP_PASSWORD/);
    const source=readFileSync(new URL('../deploy/identity-email/report-renderer.ts',import.meta.url),'utf8');
    const guard=source.indexOf('rendererPeerMayRequest(peerRole,request.phase)'),cleanup=source.indexOf("const existing=peerRole==='mail'?await cleanExpired():0"),database=source.indexOf("await import('../../db/client')");
    expect(guard).toBeGreaterThanOrEqual(0);expect(cleanup).toBeGreaterThanOrEqual(0);expect(database).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(cleanup);expect(guard).toBeLessThan(database);
    expect(source).toContain('constants.O_RDONLY|constants.O_NOFOLLOW');expect(source).toContain('finally{await handle.close();}');
  });
});
