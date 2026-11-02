import {describe,expect,it} from 'vitest';
import {boundedUniqueName} from '../lib/bounded-unique-name';
describe('bounded suffix allocation',()=>{
 it('reserves suffix width for maximum length names',()=>{
  const base='a'.repeat(100);
  expect(boundedUniqueName(base,new Set([base]),100,n=>` (copy ${n})`)).toBe('a'.repeat(91)+' (copy 2)');
 });
 it('retains distinct suffixes at two digits',()=>{
  const taken=new Set(Array.from({length:8},(_,i)=>'a'.repeat(38)+`_${i+2}`));
  const name=boundedUniqueName('a'.repeat(40),taken,40,n=>`_${n}`);
  expect(name).toBe('a'.repeat(37)+'_10');expect(name.length).toBe(40);
 });
 it('does not split a Unicode code point to make room for the suffix',()=>{
  expect(boundedUniqueName('a'.repeat(37)+'😀',new Set(),40,n=>`_${n}`)).toBe('a'.repeat(37)+'_2');
 });
 it('refuses after a finite number of collisions',()=>{
  expect(()=>boundedUniqueName('x',new Set(['x_2','x_3']),40,n=>`_${n}`,2)).toThrow(/unique/i);
 });
});
