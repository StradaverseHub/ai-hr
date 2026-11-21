/** Owner rule 13 Nov 2026 — the words payroll admins see for "a Pay Item the employee does not have in this run counts as 0":
 * "What this formula does", the trace/test-receipt line, the Pay Item help, the registry and the divide-by checks.
 * Database behaviour is covered by pay-formula-missing-item-zero.test.ts. */
import {describe,expect,it} from 'vitest';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vi from '../messages/vi.json';import zh from '../messages/zh.json';
import {parsePayFormula} from '../lib/pay-formula-language';
import {describePayFormula,describeMissingPayItem,explainPayFormula,PAY_FORMULA_ZERO_WHEN_MISSING} from '../lib/pay-formula-explain';
import {diagnosePayFormula} from '../lib/pay-formula-diagnostics';
import {payFormulaFunction} from '../lib/pay-formula-registry';

const catalogues={en,ms,ta,th,vi,zh};
type Translate=Parameters<typeof describePayFormula>[1];
const translator=(locale:keyof typeof catalogues)=>createTranslator({locale,messages:catalogues[locale],namespace:'payFormula'}) as unknown as Translate;
const words={and:'and',or:'or',not:'not',true:'True',false:'False',variable:(code:string)=>code};
const NORMAL_OT='If {#EmployeeProfile}("companyCode") = "ARIT" Then\n Return ((((({#Basic} + {#PayItemInput}("A0128")) + {#PayItemInput}("A0100")) / 26) / 8) * 1.5) * {#Input}\nElse\n Return {#Basic} / 26 / 8 * 1.5 * {#Input}\nEnd If';

describe('What this formula does',()=>{
 it('ends with one line naming each current-run Pay Item read, in source order, without repeats',()=>{
  const rows=describePayFormula(parsePayFormula(NORMAL_OT+'\n'),translator('en'));
  expect(rows.at(-1)).toEqual({depth:0,text:'A Pay Item the employee does not have in this run counts as 0: Pay Item input (A0128), Pay Item input (A0100).'});
  const lines=explainPayFormula(parsePayFormula('Dim A As Decimal = {#PayItem}("X1") + {#PayItemNoProrate}("X2")\nIf {#Accumulation}("G1") > 0 Then\n Return A + {#PayItem}("X1")\nElse\n Return {#PayItemInput}("X3")\nEnd If'),words);
  expect(lines.filter(l=>l.key==='missingZero')).toEqual([{depth:0,key:'missingZero',values:{items:'PayItem (X1), PayItemNoProrate (X2), Accumulation (G1), PayItemInput (X3)'}}]);
  expect(lines.at(-1)?.key).toBe('missingZero');
 });
 it('adds nothing to a formula without current-run Pay Items; a historical result is not covered',()=>{
  expect(explainPayFormula(parsePayFormula('Return {#Basic} / 26 * {#Input}'),words).some(l=>l.key==='missingZero')).toBe(false);
  expect(explainPayFormula(parsePayFormula('Return {#PayItem}("BASIC") / 10'),words).some(l=>l.key==='missingZero')).toBe(false);
  expect(explainPayFormula(parsePayFormula('Return {#AnotherPayItems}("A0128", "2026-09", "REGULAR", "1")'),words).some(l=>l.key==='missingZero')).toBe(false);
  expect([...PAY_FORMULA_ZERO_WHEN_MISSING].sort()).toEqual(['Accumulation','PayItem','PayItemInput','PayItemNoProrate']);
 });
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s has the closing line and the trace lines with their values',locale=>{
  const t=translator(locale),rows=describePayFormula(parsePayFormula(NORMAL_OT),t),last=rows.at(-1)!.text;
  expect(last).toContain('A0128');expect(last).toContain(catalogues[locale].payFormula.functions.PayItemInput);
  const item=describeMissingPayItem({source:'PayItemInput',code:'A0128'},t),member=describeMissingPayItem({source:'Accumulation',code:'A0128',group:'OT_GROSS'},t);
  expect(item).toContain('A0128');expect(item).toContain(catalogues[locale].payFormula.functions.PayItemInput);
  expect(member).toContain('A0128');expect(member).toContain('OT_GROSS');expect(member).toContain(catalogues[locale].payFormula.functions.Accumulation);
  for(const text of [last,item,member])expect(text).not.toMatch(/[{}]/);
  for(const code of ['PayItem','PayItemNoProrate','PayItemInput','Accumulation'])expect(catalogues[locale].payFormula.functionHelp[code as 'PayItem']).toContain('0');
 });
});

describe('the trace and test receipt line',()=>{
 it('says the item was not in the run and counted as 0',()=>{
  const t=translator('en');
  expect(describeMissingPayItem({source:'PayItemInput',code:'A0128'},t)).toBe('Pay Item input (A0128): not in this run, counted as 0');
  expect(describeMissingPayItem({source:'PayItem',code:'A0128'},t)).toBe('Calculated Pay Items (A0128): not in this run, counted as 0');
  expect(describeMissingPayItem({source:'PayItemNoProrate',code:'A0128'},t)).toBe('Unprorated Pay Items (A0128): not in this run, counted as 0');
  expect(describeMissingPayItem({source:'Accumulation',code:'A0128',group:'OT_GROSS'},t)).toBe('Accumulation group (OT_GROSS), member A0128: not in this run, counted as 0');
 });
});

describe('registry and checks',()=>{
 it('the registry describes the rule for the four current-run sources and not for history',()=>{
  for(const code of ['PayItem','PayItemNoProrate','PayItemInput','Accumulation'])expect(payFormulaFunction(code)?.description).toMatch(/does not have in this run counts as 0/);
  expect(payFormulaFunction('PayItemInput')?.description).toMatch(/input cannot be determined is still refused/);
  expect(payFormulaFunction('AnotherPayItems')?.description).not.toMatch(/counts as 0/);
 });
 it('dividing by a current-run Pay Item is a may-be-0 check that names the rule; other sources keep the plain check',()=>{
  for(const call of ['{#PayItem}("A0128")','{#PayItemNoProrate}("A0128")','{#PayItemInput}("A0128")','{#Accumulation}("OT_GROSS")'])
   expect(diagnosePayFormula('Return 100 / '+call)).toEqual([expect.objectContaining({severity:'warning',code:'possible_zero_divisor',missingItem:true})]);
  for(const call of ['{#Input}','{#AnotherPayItems}("A0128", "2026-09", "REGULAR", "1")'])
   expect(diagnosePayFormula('Return 100 / '+call)[0]).not.toHaveProperty('missingItem');
  expect(diagnosePayFormula('If {#PayItem}("A0128") > 0 Then\n Return 100 / {#PayItem}("A0128")\nElse\n Return 0\nEnd If')).toEqual([]);
  for(const catalogue of Object.values(catalogues))expect(catalogue.payFormula.checks.possible_zero_divisorMissingItem).toContain('{name}');
 });
});
