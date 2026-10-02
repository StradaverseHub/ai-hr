import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';
import {PcbDetailView} from '../app/payroll/pcb-detail/pcb-detail-view';
import {explainPcb,pcbSlipSections,pcbClosingSections,pcbWorksheet} from '../core/pcb-explain';
import {statutory} from '../localization/my/payroll';
import type {PcbNonCashSnapshot} from '../localization/noncash-benefits';
const state=vi.hoisted(()=>({locale:'en'}));
vi.mock('next-intl/server',async()=>{const {createTranslator}=await import('next-intl');const fs=await import('node:fs');return {getTranslations:async(arg:any)=>{const locale=typeof arg==='string'?state.locale:arg.locale??state.locale;return createTranslator({locale,messages:JSON.parse(fs.readFileSync(`messages/${locale}.json`,'utf8')),namespace:typeof arg==='string'?arg:arg.namespace});}};});
const sides={profile:null,catalogue:[],rebateCatalogue:[],currentDeduction:null,accumulatedDeduction:null,previousDeduction:null,currentRebate:null,accumulatedRebate:null};
const zero={entered:0,exempt:0,taxable:0};
const entry={kind:'bik' as const,code:'SYNTHETIC_CAR',source:'recurring' as const,entered:800,exempt:200,taxable:600,exemptionCode:'SAVED_EXEMPTION'};
const ea={...entry,reportableAmount:600,exemptAmount:200,eaFormLine:'EA_B3',subjectPCB:true};
const benefits:PcbNonCashSnapshot={version:1,cashNormal:14000,current:{bik:{entered:800,exempt:200,taxable:600},vola:zero},ownedCurrent:{bik:{entered:800,exempt:200,taxable:600},vola:zero},owned:{bik:600,vola:0},cumulative:{bik:600,vola:0},before:{bik:0,vola:0},accumulated:{bik:1200,vola:0,complete:true},entries:[entry],ownedEntries:[entry],eaEntries:[ea],ownedEaEntries:[ea]};
describe('r383 recorded benefit screen renderer',()=>{
  it.each(['en','ms','zh','ta','th','vi'])('renders saved taxable and exemption facts using real %s translations',async locale=>{
    state.locale=locale;
    const generated=statutory(14000,{category:3},0,0,{month:7},{pcbNonCashNormal:{bik:600,vola:0}});
    const x=explainPcb({...generated,pcbNonCash:benefits},null);expect(x.kind).toBe('mtd');
    const html=renderToStaticMarkup(await PcbDetailView({ctx:{employeeCode:'SYNTH',employeeName:'Synthetic Benefit',company:'Synthetic Company',periodLabel:'July 2026',payPeriod:'2026-07',runType:'regular',runSeq:1,currency:'MYR',rulesetVersion:null,identityNumber:null,identityIsPassport:false,taxNumber:null,taxCategory:3},explanation:x,worksheet:pcbWorksheet(x,null),slip:pcbSlipSections(x,sides),closing:pcbClosingSections(x)}));
    const captions=JSON.parse(fs.readFileSync(`messages/${locale}.json`,'utf8')).payroll.pcbDetail;
    expect(html).toContain(captions.slipBikEntered);expect(html).toContain(captions.slipBikExempt);
    expect(html).toContain('600.00');expect(html).toContain('800.00');expect(html).toContain('200.00');expect(html).toContain('1,200.00');
    expect(html).not.toContain('slipBikEntered');expect(html).not.toContain('slipBikExempt');
  });
});
