import assert from 'node:assert/strict';

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
