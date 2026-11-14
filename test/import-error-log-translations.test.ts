import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {locales} from '../i18n/config';

// Import Error Log copy (boards c074c6b8 / d3ba1e9f): every translation keeps the English ICU arguments,
// and names what the admin must find on screen or in the workbook exactly as it appears there.
type Dict=Record<string,unknown>;
function leaves(value:Dict,prefix='',out:Record<string,string>={}):Record<string,string>{
 for(const [key,item]of Object.entries(value)){
  const path=prefix?prefix+'.'+key:key;
  if(item&&typeof item==='object'&&!Array.isArray(item))leaves(item as Dict,path,out);
  else if(typeof item==='string')out[path]=item;
 }
 return out;
}
const catalogue=(locale:string)=>leaves(JSON.parse(readFileSync(resolve(__dirname,'..','messages',locale+'.json'),'utf8')));
const PREFIXES=['importProblems.','importErrorLogEmployee.','importErrorLogDataBankCostInfo.','labelsImportWizard.problem.','labelsImportWizard.fix.'];
const EXACT=['labelsImportWizard.problemsTitle','labelsImportWizard.stoppedTitle','labelsImportWizard.problemsUnavailable','people.importHistory.errorReport.rowsHint'];
const en=catalogue('en');
const scoped=Object.keys(en).filter(key=>EXACT.includes(key)||PREFIXES.some(prefix=>key.startsWith(prefix)));
const args=(text:string)=>[...text.matchAll(/\{\s*(\w+)/g)].map(match=>match[1]).sort();
const others=locales.filter(locale=>locale!=='en');
const dash=(text:string)=>text.replace(/\s*[—–-]\s*/g,' - ');

describe('import Error Log translations',()=>{
 it('covers a nonempty set of source strings',()=>{
  expect(scoped.length).toBeGreaterThan(150);
 });
 it.each(others)('%s keeps every ICU argument and balanced braces',locale=>{
  const messages=catalogue(locale);
  for(const key of scoped){
   const text=messages[key];
   expect(text,`${locale} ${key}`).toBeTypeOf('string');
   expect(args(text),`${locale} ${key}`).toEqual(args(en[key]));
   expect(text.split('{').length,`${locale} ${key}`).toBe(text.split('}').length);
  }
 });
 it.each(others)('%s keeps the English template sheet names the admin must find',locale=>{
  const messages=catalogue(locale);
  const keys=scoped.filter(key=>/\bReference sheet\b/.test(en[key]));
  expect(keys.length).toBeGreaterThan(4);
  for(const key of keys)expect(messages[key],`${locale} ${key}`).toContain('Reference');
  expect(messages['importErrorLogEmployee.correction.choice']).toContain('Instructions');
 });
 it.each(others)('%s names the on-screen import choice and page in their translated form',locale=>{
  const messages=catalogue(locale);
  const option=dash(messages['people.import.sectionFull']);
  const optionKeys=scoped.filter(key=>/Everything\s*[—-]\s*new employees/.test(en[key]));
  expect(optionKeys.length).toBe(3);
  for(const key of optionKeys)expect(dash(messages[key]),`${locale} ${key}`).toContain(option);
  const pageKeys=scoped.filter(key=>en[key].includes('System Labels'));
  expect(pageKeys.length).toBe(3);
  for(const key of pageKeys)expect(messages[key],`${locale} ${key}`).toContain(messages['nav.systemLabels']);
 });
});
