import { describe, expect, it } from 'vitest';
import { evidenceFileExtensions, evidenceFileLimit, evidenceFileMaxBytes, validateEvidenceFile } from '../packs/performance/onehr/evidence-file-model';
describe('Source evidence-file contract',()=>{
 it('accepts the original twelve extensions, including case-insensitive names, up to two MB',()=>{
  expect(evidenceFileExtensions).toEqual(['pdf','png','jpg','jpeg','gif','webp','doc','docx','xls','xlsx','csv','txt']);
  for(const ext of evidenceFileExtensions)expect(()=>validateEvidenceFile(`Supporting proof.${ext.toUpperCase()}`,evidenceFileMaxBytes)).not.toThrow();
  expect(evidenceFileLimit).toBe(4);
 });
 it('rejects over-limit bytes, empty uploads, long names, and unsupported or disguised extensions',()=>{
  for(const [name,size] of [['proof.pdf',evidenceFileMaxBytes+1],['proof.txt',0],['x'.repeat(201)+'.pdf',1],['proof.svg',1],['proof.pdf.exe',1],['proof',1]] as const)expect(()=>validateEvidenceFile(name,size)).toThrow();
 });
});
