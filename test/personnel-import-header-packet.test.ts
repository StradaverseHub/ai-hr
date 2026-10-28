/** Authored UNRUN: exact header-only browser packet and revision binding; no provider/network call. */
import {createHash,webcrypto} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {preparePersonnelHeaderAssistancePacket} from '../lib/personnel-import-assistance-source';
import {personnelImportHeadersRevisionText,personnelImportRegistryRevisionText,personnelImportSourceRevisionText} from '../lib/personnel-import-assistance';
const companyId='11111111-1111-4111-8111-111111111111',operationNonce='22222222-2222-4222-8222-222222222222';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(()=>vi.unstubAllGlobals());
describe('minimal reviewed header wire packet',()=>{
 it('captures only approved indexed headings before awaits and matches canonical registry/source digest text',async()=>{
  const input={companyId,operationNonce,sendHeadingsOnly:true,headers:[{columnIndex:699,heading:'Unknown name',sample:'PRIVATE VALUE'}],fileName:'PRIVATE workbook.xlsx',sheetName:'PRIVATE team',rows:[['PRIVATE PERSON']]};
  const promise=preparePersonnelHeaderAssistancePacket(input);input.headers[0].heading='Retargeted';input.companyId=operationNonce;
  const packet=await promise,headers=[{columnIndex:699,heading:'Unknown name'}];
  expect(packet.companyId).toBe(companyId);expect(packet.headers).toEqual(headers);expect(JSON.stringify(packet)).not.toMatch(/PRIVATE|Retargeted|sample|fileName|sheetName|rows/);
  const registry=sha(personnelImportRegistryRevisionText()),headings=sha(personnelImportHeadersRevisionText(headers));expect(packet.registryDigest).toBe(registry);expect(packet.sourceRevision).toBe(sha(personnelImportSourceRevisionText(headings,registry)));
 });
 it('refuses missing provider consent, oversize selection and overlong headings without silently shortening a request',async()=>{
  await expect(preparePersonnelHeaderAssistancePacket({companyId,operationNonce,sendHeadingsOnly:false,headers:[{columnIndex:0,heading:'Unknown'}]})).rejects.toThrow();
  await expect(preparePersonnelHeaderAssistancePacket({companyId,operationNonce,sendHeadingsOnly:true,headers:Array.from({length:33},(_,columnIndex)=>({columnIndex,heading:`Unknown ${columnIndex}`}))})).rejects.toThrow();
  await expect(preparePersonnelHeaderAssistancePacket({companyId,operationNonce,sendHeadingsOnly:true,headers:[{columnIndex:0,heading:'X'.repeat(97)}]})).rejects.toThrow();
 });
});
