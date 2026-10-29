import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readVerifiedInformationManifest} from '../scripts/reconcile-information-snapshots';
it('requires independently bound evidence bytes, real dates and unique original documents',()=>{
 const directory=mkdtempSync(join(tmpdir(),'information-evidence-'));
 try{
  const bytes=Buffer.from('Fictional independently reviewed original');writeFileSync(join(directory,'original.txt'),bytes);
  const item={payslipId:randomUUID(),employmentId:randomUUID(),companyId:randomUUID(),original:{grade:null,employmentType:'full_time',hiredOn:'2025-01-01',joinDate:null},evidence:[{path:'original.txt',sha256:createHash('sha256').update(bytes).digest('hex'),reference:'Reviewed fixture original'}]};
  const manifest={version:1,tenantId:randomUUID(),actorUserId:randomUUID(),verifiedOriginals:true,items:[item]};
  expect(readVerifiedInformationManifest(manifest,directory)).toEqual(manifest);
  expect(()=>readVerifiedInformationManifest({...manifest,verifiedOriginals:false},directory)).toThrow();
  expect(()=>readVerifiedInformationManifest({...manifest,items:[item,item]},directory)).toThrow('more than once');
  expect(()=>readVerifiedInformationManifest({...manifest,items:[{...item,original:{...item.original,hiredOn:'2025-02-30'}}]},directory)).toThrow();
  writeFileSync(join(directory,'original.txt'),'Changed evidence');expect(()=>readVerifiedInformationManifest(manifest,directory)).toThrow('checksum');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
