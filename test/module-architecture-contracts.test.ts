/** Coverage/ownership gate only. Referenced behavioral files must also run in the release gate. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import '../packs/register-all';
import {listPacks,type ModulePack} from '../packs/registry';
import contracts from '../docs/architecture/module-contracts.json';
const modules=listPacks('module') as ModulePack[];
describe('future module contract coverage',()=>{
 it('requires every registered business module to name its public boundary and executable proofs',()=>{
  expect(contracts.formatVersion).toBe(1);
  expect(Object.keys(contracts.modules).sort()).toEqual(modules.map(pack=>pack.id).sort());
  const byId:Record<string,{facade:string;boundaryProof:string;behaviorProofs:string[]}>=contracts.modules;
  for(const pack of modules){
   const contract=byId[pack.id];
   expect(contract.facade).toBe(pack.serviceFacade);
   expect(existsSync(resolve(contract.facade+'.ts'))).toBe(true);
   expect(contract.behaviorProofs.length).toBeGreaterThan(0);
   for(const file of [contract.boundaryProof,...contract.behaviorProofs]){
    expect(file).toMatch(/^test\/[a-z0-9-]+\.test\.tsx?$/);
    const source=readFileSync(resolve(file),'utf8');
    expect(source).toMatch(/\b(?:it|test|describe)\s*[.(]/);
   }
  }
 });
 it('does not allow two modules to declare ownership of the same table',()=>{
  const owners=new Map<string,string>();
  for(const pack of modules){
   expect(pack.satelliteTables?.length,`${pack.id} has no declared data ownership`).toBeGreaterThan(0);
   for(const {table} of pack.satelliteTables??[]){
    expect(owners.get(table),`${table} is claimed by ${owners.get(table)} and ${pack.id}`).toBeUndefined();
    owners.set(table,pack.id);
   }
  }
 });
});
