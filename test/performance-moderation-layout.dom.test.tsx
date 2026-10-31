import React from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { defaultPolicy,type KPI } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
vi.mock('../app/(app)/performance/onehr/performance-insight',()=>({PerformanceInsight:({onResult}:{onResult?:(data:unknown)=>void})=><button type="button" onClick={()=>onResult?.({kpis:[{kpi:'Service delivery',justified:'yes',justified_why:'The file supports the delivery.'}]})}>Read cached insight</button>}));
import { KpiModerationTable } from '../app/(app)/performance/onehr/kpi-moderation-table';
const policy=defaultPolicy(framework);
function kpi(title:string,patch:Partial<KPI>={}):KPI{return {id:crypto.randomUUID(),title,description:'Delivery measure',weightBp:5000,unit:'units',moderatorEmploymentId:null,setting:'approved',settingRemark:'',actual:100,note:'Submitted explanation',approvedActual:null,moderationRemark:'',locked:false,scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},...patch};}
const show=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);
afterEach(cleanup);
it('puts the self result, before/after scale, files and private moderation in one table and keeps company data read-only',()=>{
 const own=kpi('Service delivery'),company=kpi('Company objective',{hrOwned:true,actual:200,approvedActual:200,locked:true});
 show(<form aria-label="Moderation"><KpiModerationTable reviewId="review" kpis={[own,company]} editableIds={[own.id]} draft={{lines:[{id:own.id,actual:150,note:'Verified increased delivery.'}]}} files={[{id:'file',fileName:'Delivery.txt',kpiId:own.id}]} bands={policy} companyId="company" remark="" remarkApplies selfRemark="Submitted employee remark" selfRemarkAvailable/></form>);
 const row=screen.getByRole('row',{name:/Service delivery/}),form=screen.getByRole('form',{name:'Moderation'}) as HTMLFormElement;
 expect(within(row).getByText('150').className).toContain('bg-primary');expect(within(row).getAllByText('100').some(node=>node.className.includes('line-through'))).toBe(true);
 expect(screen.getByRole('link',{name:'Delivery.txt'}).getAttribute('href')).toBe('/performance/attachment/file?inline=1');
 expect(screen.getByText('4 · AE')).toBeTruthy();expect(screen.getByText(en.onehr.moderationTable.scopeHelp)).toBeTruthy();
 expect(new FormData(form).getAll('kpiId')).toEqual([own.id]);expect(new FormData(form).has(`${company.id}.actual`)).toBe(false);
 const overall=screen.getByLabelText(/Your overall remark/) as HTMLTextAreaElement;expect(overall.required).toBe(true);
 fireEvent.change(screen.getByLabelText('Moderated result for Service delivery'),{target:{value:'100'}});expect(overall.required).toBe(false);
 fireEvent.change(screen.getByLabelText('Justification for Service delivery'),{target:{value:'Updated explanation only.'}});expect((screen.getByLabelText('Moderated result for Service delivery') as HTMLInputElement).value).toBe('100');
 fireEvent.click(screen.getByRole('button',{name:'Read cached insight'}));expect(within(row).getByText(en.onehr.insight.justified.yes)).toBeTruthy();expect(within(row).getByText('The file supports the delivery.')).toBeTruthy();
});
it('keeps a matrix reviewer’s overall remark optional and never calls a withheld employee remark absent',()=>{
 const own=kpi('Service delivery');show(<KpiModerationTable reviewId="review" kpis={[own]} editableIds={[own.id]} draft={{lines:[{id:own.id,actual:200,note:'Verified'}]}} files={[]} bands={policy} companyId="company" remark="" remarkApplies={false} selfRemark="Withheld private overall words" selfRemarkAvailable={false}/>);
 expect((screen.getByLabelText(/Your overall remark/) as HTMLTextAreaElement).required).toBe(false);expect(screen.queryByText('Withheld private overall words')).toBeNull();expect(screen.queryByText(en.onehr.moderationTable.theirRemark)).toBeNull();
});
it('retains the exact fractional submitted result and turns a locked review into a read-only table',()=>{
 const own=kpi('Precise delivery',{actual:100.12345,approvedActual:150,locked:true});show(<KpiModerationTable reviewId="review" kpis={[own]} editableIds={[]} draft={{lines:[{id:own.id,actual:999,note:'An obsolete private value'}]}} files={[]} bands={policy} companyId="company" remark="Confirmed reviewer words" remarkApplies selfRemark="Submitted" selfRemarkAvailable/>);
 expect(screen.getByText('100.12345')).toBeTruthy();expect(screen.queryByText('999')).toBeNull();expect(screen.queryByRole('spinbutton')).toBeNull();expect((screen.getByLabelText(/Your overall remark/) as HTMLTextAreaElement).readOnly).toBe(true);expect(screen.getByText(en.onehr.confirmed)).toBeTruthy();
});
it('uses the configured mechanism B ladder and achievement bands for both previews',()=>{
 const own=kpi('Achievement',{weightBp:10000,actual:100,scoring:{mechanism:'B',variant:'excellence',method:'more',threshold:50,target:100,multiple:0,excellence:150}});
 show(<KpiModerationTable reviewId="review" kpis={[own]} editableIds={[own.id]} draft={{lines:[{id:own.id,actual:120,note:'Verified additional delivery'}]}} files={[]} bands={{aBands:policy.aBands,bBands:[{companyId:'company',minima:[0,50,90,110,140]}]}} companyId="company" remark="Verified" remarkApplies selfRemark="Submitted" selfRemarkAvailable/>);
 expect(screen.getByRole('columnheader',{name:en.onehr.excellence})).toBeTruthy();expect(screen.getByRole('columnheader',{name:en.onehr.moderationTable.theirRating})).toBeTruthy();expect(screen.getByText('120% · AE')).toBeTruthy();
});
