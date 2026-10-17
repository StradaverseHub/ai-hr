import {describe,expect,expectTypeOf,it} from 'vitest';
import {typescriptCliExports} from '../scripts/typescript-cli-exports.mjs';

describe('Node/tsx TypeScript CLI export boundary',()=>{
 it('uses the actual owner in either native namespace or CommonJS default namespace form',()=>{
  const owner={read:(id:string)=>({id}),constant:'kept'};
  expect(typescriptCliExports(owner)).toBe(owner);
  expect(typescriptCliExports({default:owner,...owner})).toBe(owner);
  const resolved=typescriptCliExports(owner);
  expectTypeOf(resolved.read).parameters.toEqualTypeOf<[string]>();
  expectTypeOf(resolved.read).returns.toEqualTypeOf<{id:string}>();
  expect(resolved.read('subject')).toEqual({id:'subject'});
 });
 it('does not substitute or synthesize an absent domain export',()=>{
  const owner={present:true};
  expect(typescriptCliExports({default:owner,...owner})).toBe(owner);
  expect(typescriptCliExports(owner)).not.toHaveProperty('read');
 });
});
