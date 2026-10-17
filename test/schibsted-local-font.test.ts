import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
// Use the existing fontkit dependency's CJS entry, the same parser family Next's local loader uses.
type Face={familyName:string;subfamilyName:string;numGlyphs:number;variationAxes:Record<string,{min:number;default:number;max:number}>;hasGlyphForCodePoint:(code:number)=>boolean;getVariation:(axes:{wght:number})=>{glyphForCodePoint:(code:number)=>{id:number;advanceWidth:number;path:{commands:unknown[]}}}};
const fontkit=createRequire(import.meta.url)('fontkit') as {create:(bytes:Buffer)=>Face};
const read=(name:string)=>readFileSync(new URL('../app/fonts/schibsted-grotesk/'+name,import.meta.url));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
describe('vendored official Schibsted local face',()=>{
 it('ships the exact unmodified upstream font and adjacent complete OFL',()=>{
  const bytes=read('SchibstedGrotesk-Variable.ttf'),license=read('OFL.txt');
  expect(bytes.length).toBe(176068);expect(sha(bytes)).toBe('6ceeadf6be8e1fd7687011c7fa38ed0edd1abe967a0b73d97caec183552e823d');
  expect(license.length).toBe(4406);expect(sha(license)).toBe('3b4f3063b6ac7c1e403e2c4a5e8ef3a58190ff83ed7b15af66511858699139ce');
  expect(license.toString()).toContain('Copyright 2023 The Schibsted-Grotesk Project Authors');expect(license.toString()).toContain('SIL OPEN FONT LICENSE Version 1.1');
 });
 it('parses as the intended real variable face with Latin coverage and real outlines at every retained weight',()=>{
  const face=fontkit.create(read('SchibstedGrotesk-Variable.ttf'));
  expect(face.familyName).toBe('Schibsted Grotesk');expect(face.subfamilyName).toBe('Regular');expect(face.numGlyphs).toBe(583);
  expect(Object.keys(face.variationAxes)).toEqual(['wght']);expect(face.variationAxes.wght).toMatchObject({min:400,default:400,max:900});
  const latin=Array.from({length:95},(_,i)=>String.fromCodePoint(32+i)).join('')+'éÇøŁāž';
  for(const letter of latin)expect(face.hasGlyphForCodePoint(letter.codePointAt(0)!)).toBe(true);
  for(const weight of [400,500,600]){const glyph=face.getVariation({wght:weight}).glyphForCodePoint(65);expect(glyph.id).toBeGreaterThan(0);expect(glyph.advanceWidth).toBeGreaterThan(0);expect(glyph.path.commands.length).toBeGreaterThan(0);}
 });
});
