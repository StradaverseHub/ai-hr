/** New shared Contract services start with a closed public boundary and no legacy import exceptions. */
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import {runImportRatchet} from './helpers/import-ratchet';

const root=fileURLToPath(new URL('..',import.meta.url));
const contractServices=readdirSync(fileURLToPath(new URL('../core',import.meta.url)))
 .filter(file=>/^contract-shared-.+\.ts$/.test(file)).map(file=>'core/'+file.replace(/\.ts$/,''));
const scan=['app','components','core','db','i18n','lib','localization','packs','scripts'];

describe('shared Contract service ownership',()=>{
 it('covers the implemented Contract services and guards their public facade without new exceptions',()=>{
  expect(contractServices).toEqual(expect.arrayContaining(['core/contract-shared-config','core/contract-shared-read','core/contract-shared-preview']));
  for(const boundary of contractServices){
   const result=runImportRatchet({root,scan,boundary,allowlist:[],allowedImporters:path=>path.startsWith('core/contract-shared-')||path==='packs/contracts/service.ts'});
   expect(result.violations,`Use the Contract pack facade for ${boundary}`).toEqual([]);
   expect(result.stale).toEqual([]);
  }
 });
 it('keeps the shared document-template store behind the automation facade',()=>{
  const result=runImportRatchet({root,scan,boundary:'core/automation-documents',allowlist:[],allowedImporters:path=>path.startsWith('core/automation-')||path==='packs/automation/service.ts'});
  expect(result.violations).toEqual([]);expect(result.stale).toEqual([]);
 });
});
