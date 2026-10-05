import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PcbDetailView} from '../app/payroll/pcb-detail/pcb-detail-view';
import fs from 'node:fs';
import {describe, it, expect, vi} from 'vitest';
import {readPcbExemptions, pcbExemptionDetail, type PcbExemptionSnapshot} from '../core/pcb-exemptions';
import {pcbExemptionTable} from '../app/payroll/pcb-detail/exemption-table';
import {pcbDetailLayout, explainPcb, pcbClosingSections, pcbWorksheet} from '../core/pcb-explain';
import {statutory} from '../localization/my/payroll';
const state=vi.hoisted(()=>({locale:'en'}));
vi.mock('next-intl/server',async()=>{const {createTranslator}=await import('next-intl');return {getTranslations:async(arg:any)=>{const locale=typeof arg==='string'?state.locale:arg.locale??state.locale;return createTranslator({locale,messages:JSON.parse(fs.readFileSync(`messages/${locale}.json`,'utf8')),namespace:typeof arg==='string'?arg:arg.namespace});}};});
const snapshot = (): PcbExemptionSnapshot => ({version:1,payPeriod:'2026-07',taxYear:2026,basis:'selected_calculation',rows:[
 {code:'PCB_TRA_BUSINESS',table:'pcb',annualLimit:6000,accumulated:3500,thisMonth:500,payItems:['Travel Allowance'],reused:false},
 {code:'PCB_CHILD_CARE',table:'pcb',annualLimit:3000,accumulated:0,thisMonth:0,payItems:['Child Care'],reused:false},
 {code:'PCB_NON-TAXABLE',table:'pcb',annualLimit:-1,accumulated:50,thisMonth:75,payItems:['Unrestricted'],reused:true},
 {code:'LP_DENTAL',table:'lp',annualLimit:1000,accumulated:200,thisMonth:0,payItems:['Dental'],reused:false},
]});
const en=JSON.parse(fs.readFileSync('messages/en.json','utf8')).payroll.pcbDetail;
const t=(key:string)=>en[key] as string;
describe('r387 recorded PCB exemption display evidence',()=>{
 it('reads exact selected calculation values without mutating or recomputing',()=>{
  const value=snapshot(),before=JSON.stringify(value);expect(readPcbExemptions(value)).toEqual(value);
  const projected=pcbExemptionDetail({pcbExemptions:value,exemptionUsed:{PCB_TRA_BUSINESS:999}},value.payPeriod);
  expect(projected).toEqual({source:'recorded',rows:value.rows});expect(JSON.stringify(value)).toBe(before);
 });
 it.each([
  ['wrong version',(v:any)=>v.version=2],['bad month',(v:any)=>v.payPeriod='2026-13'],
  ['wrong year',(v:any)=>v.taxYear=2025],['wrong basis',(v:any)=>v.basis='current_config'],
  ['negative amount',(v:any)=>v.rows[0].thisMonth=-1],['nonfinite amount',(v:any)=>v.rows[0].accumulated=Infinity],
  ['fractional cent',(v:any)=>v.rows[0].thisMonth=1.001],['string amount',(v:any)=>v.rows[0].thisMonth='500'],
  ['missing amount',(v:any)=>delete v.rows[0].accumulated],['unsupported sentinel',(v:any)=>v.rows[0].annualLimit=-2],
  ['duplicate code',(v:any)=>v.rows.push({...v.rows[0]})],['wrong table',(v:any)=>v.rows[0].table='lp'],
  ['empty name',(v:any)=>v.rows[0].payItems=[' ']],['duplicate name',(v:any)=>v.rows[0].payItems=['Travel','Travel']],
 ])('refuses %s and never falls back to legacy money',(_name,change)=>{
  const value=snapshot();change(value);expect(readPcbExemptions(value)).toBeNull();
  expect(pcbExemptionDetail({pcbExemptions:value,exemptionUsed:{PCB_TRA_BUSINESS:500}})).toEqual({source:'unavailable',rows:[]});
 });
 it('refuses mismatched selected period and explicit null without fallback',()=>{
  expect(pcbExemptionDetail({pcbExemptions:snapshot()},'2026-08').source).toBe('unavailable');
  expect(pcbExemptionDetail({pcbExemptions:null,exemptionUsed:{PCB_TRA_BUSINESS:500}}).source).toBe('unavailable');
 });
 it('retains known legacy current usage while missing caps/accumulation stay unavailable',()=>{
  const detail=pcbExemptionDetail({exemptionUsed:{PCB_TRA_BUSINESS:500,LP_DENTAL:0}});
  expect(detail.source).toBe('partial');expect(detail.rows).toHaveLength(2);
  expect(detail.rows.find(r=>r.code==='PCB_TRA_BUSINESS')).toMatchObject({annualLimit:null,accumulated:null,thisMonth:500,payItems:[]});
  const table=pcbExemptionTable(detail,t);expect(table.rows.find(r=>r.label==='PCB_TRA_BUSINESS')?.cells).toEqual([en.notRecordedShort,en.notRecordedShort,'RM 500.00']);
  expect(table.note).toBe(en.exemptionIncompleteNote);
 });
 it('distinguishes recorded empty applicability from missing history',()=>{
  const value=snapshot();value.rows=[];
  expect(pcbExemptionDetail({pcbExemptions:value})).toEqual({source:'recorded',rows:[]});
  expect(pcbExemptionDetail({})).toEqual({source:'unavailable',rows:[]});
 });
 it('prints all distinct types, genuine zeroes, unlimited and unknown caps without adding overlap',()=>{
  const value=snapshot();value.rows[0].annualLimit=null;
  const table=pcbExemptionTable(pcbExemptionDetail({pcbExemptions:value}),t);
  expect(table.rows).toHaveLength(4);expect(table.rows[0].cells).toEqual([en.notRecordedShort,'RM 3,500.00','RM 500.00']);
  expect(table.rows[1].cells).toEqual(['RM 3,000.00','RM 0.00','RM 0.00']);
  expect(table.rows[2].cells).toEqual([en.exemptionUnlimited,'RM 50.00','RM 75.00']);
  expect(table.rows[2].label).toContain(en.exemptionReused);
  expect(table.note).toBe(en.exemptionBasisNote);
 });
 it('adds a section after calculations while preserving their existing order',()=>{
  const x=explainPcb(statutory(10000,{category:1},0,0,{month:7}),null);
  const closing=pcbClosingSections(x);const list=pcbDetailLayout({explanation:x,worksheet:pcbWorksheet(x,null),slip:[],closing});
  const position=list.findIndex(e=>e.heading==='exemptionHeading');expect(position).toBeGreaterThan(-1);
  for(const section of closing)expect(list.findIndex(e=>e.heading===section.heading)).toBeLessThan(position);
  expect(list.findIndex(e=>e.heading==='sourceHeading')).toBeGreaterThan(position);
  expect(list.filter(e=>e.heading==='exemptionHeading')).toHaveLength(1);
 });
 it.each(['en','ms','zh','ta','th','vi'])('resolves every exemption caption in %s',locale=>{
  const messages=JSON.parse(fs.readFileSync(`messages/${locale}.json`,'utf8')).payroll.pcbDetail;
  for(const key of ['exemptionHeading','exemptionType','exemptionAnnualLimit','exemptionAccumulated','exemptionThisMonth','exemptionReused','exemptionUnlimited','exemptionNone','exemptionBasisNote','exemptionIncompleteNote'])expect(messages[key]).toEqual(expect.any(String));
 });
 it.each(['en','ms','zh','ta','th','vi'])('renders real %s table using identical shared PDF cells',async locale=>{
  state.locale=locale;
  const generated=statutory(10000,{category:1},0,0,{month:7});const before=JSON.stringify(generated);
  const x=explainPcb(generated,null),detail=pcbExemptionDetail({pcbExemptions:snapshot()});
  const messages=JSON.parse(fs.readFileSync(`messages/${locale}.json`,'utf8')).payroll.pcbDetail;
  const table=pcbExemptionTable(detail,key=>messages[key]);
  const html=renderToStaticMarkup(await PcbDetailView({ctx:{employeeCode:'SYNTH',employeeName:'Synthetic Exemption',company:'Synthetic Company',periodLabel:'July 2026',payPeriod:'2026-07',runType:'additional',runSeq:2,currency:'MYR',rulesetVersion:null,identityNumber:null,identityIsPassport:false,taxNumber:null,taxCategory:1},explanation:x,worksheet:pcbWorksheet(x,null),slip:[],closing:pcbClosingSections(x),exemptions:detail}));
  expect(html).toContain(messages.exemptionHeading);
  for(const row of table.rows){expect(html).toContain(row.label);for(const cell of row.cells)expect(html).toContain(cell);}
  expect(html).toContain(messages.exemptionBasisNote);expect(html).not.toContain('exemptionHeading');
  expect(JSON.stringify(generated)).toBe(before);
 });

});
