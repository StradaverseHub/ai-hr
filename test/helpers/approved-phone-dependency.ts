import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/** Reverse only the approved additive leaf from the PREPARED dependency comparison.
 * Historical archives and executed worker bytes remain unchanged. Unknown graph drift still fails. */
const additions:Readonly<Record<string,readonly string[]>>={
 'package.json':['    "libphonenumber-js": "1.13.16",\n'],
 'pnpm-lock.yaml':[
  '      libphonenumber-js:\n        specifier: 1.13.16\n        version: 1.13.16\n',
  '  libphonenumber-js@1.13.16:\n    resolution: {integrity: sha512-tIOCM9yx2Go6d5/ZANe0K+G4AZek1Ymx81HxQpf19Sri4zMP95eQbKdnUGHAvFQ4nx0PeLhFqvAfisTADXj3tQ==}\n\n',
  '  libphonenumber-js@1.13.16: {}\n\n',
 ],
};
export function withoutApprovedPhoneDependency(file:string,prepared:string,historical:string):string {
 const blocks=additions[file];
 if(!blocks)throw new Error('Only the approved package manifest and lockfile can reverse the phone leaf.');
 for(const block of blocks){
  assert.equal(historical.includes(block),false,file+' frozen runtime lacks the new leaf');
  assert.equal(prepared.split(block).length,2,file+' exact approved leaf occurs once');
  prepared=prepared.replace(block,'');
 }
 return prepared;
}

/** The reviewed postgres.js patch (patches/postgres@3.4.9.patch, patches/README.md) gained the reserve() fix after the
 * historical archives were frozen. In the lockfile only that patch's own hash moves (its patchedDependencies entry and
 * every `patch_hash=` reference). Map the current reviewed hash back to the frozen one for the PREPARED comparison;
 * the patch bytes must still be exactly the reviewed ones, and any other lockfile drift still fails. */
export const FROZEN_POSTGRES_PATCH_SHA256='f7b3e18bb2ab89095c19643e292f4ba33afd1d258a0afb96d63fba6508e804bd';
export const REVIEWED_POSTGRES_PATCH_SHA256='7e38ff029cad5caef83af883f7aeff0fcc942377b311c2b697d16079232d4953';
/** root: the repository checkout holding patches/ (the current prepared source). */
export function withFrozenPostgresPatchHash(file:string,prepared:string,historical:string,root:string=process.cwd()):string {
 if(file!=='pnpm-lock.yaml')return prepared;
 const current=createHash('sha256').update(readFileSync(join(root,'patches/postgres@3.4.9.patch'))).digest('hex');
 assert.equal(current,REVIEWED_POSTGRES_PATCH_SHA256,'patches/postgres@3.4.9.patch is the reviewed patch');
 if(historical.includes(current))return prepared;
 const uses=prepared.split(current).length-1;
 assert.ok(uses>0,'the lockfile records the reviewed postgres patch hash');
 assert.equal(historical.split(FROZEN_POSTGRES_PATCH_SHA256).length-1,uses,'the frozen lockfile records the frozen patch hash in the same places');
 return prepared.split(current).join(FROZEN_POSTGRES_PATCH_SHA256);
}
