import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { defaultPolicy, type KPI } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { KpiResultsTable } from '../app/(app)/performance/onehr/kpi-results-table';
import { JourneyPanel, JourneyProgressProvider, JourneySteps } from '../app/(app)/performance/workspace/journey-panel';

const policy=defaultPolicy(framework);
function kpi(title:string,patch:Partial<KPI>={}):KPI {
 return {id:crypto.randomUUID(),title,description:'Delivery measure',weightBp:5000,unit:'units',moderatorEmploymentId:null,setting:'approved',settingRemark:'',actual:100,note:'',approvedActual:null,moderationRemark:'',locked:false,scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},...patch};
}
const show=(element:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
afterEach(cleanup);

it('includes the readonly company KPI in the live weighted score without submitting it as an employee edit',()=>{
 const own=kpi('Service delivery',{weightBp:7500}),company=kpi('Company objective',{weightBp:2500,hrOwned:true,actual:200});
 show(<form aria-label="Results"><KpiResultsTable kpis={[own,company]} draft={null} files={[]} bands={policy} companyId="company" evidence={false}/></form>);
 const form=screen.getByRole('form',{name:'Results'}) as HTMLFormElement;
 expect(screen.getByRole('rowheader',{name:own.title})).toBeTruthy();
 expect(screen.getByText('3.5 · ME')).toBeTruthy();
 fireEvent.change(screen.getByLabelText(en.onehr.actual),{target:{value:'150'}});
 expect(screen.getByText('4.25 · AE')).toBeTruthy();
 expect(new FormData(form).getAll('kpiId')).toEqual([own.id]);
 expect(new FormData(form).get(`${own.id}.actual`)).toBe('150');
 expect(new FormData(form).has(`${company.id}.actual`)).toBe(false);
 fireEvent.change(screen.getByLabelText(en.onehr.actual),{target:{value:''}});
 expect(form.querySelector('tfoot')?.textContent).toContain('—');
});

it('shows configured excellence values and the correct company achievement band',()=>{
 const own=kpi('Achievement',{weightBp:10000,actual:120,scoring:{mechanism:'B',variant:'excellence',method:'more',threshold:50,target:100,multiple:0,excellence:150}});
 show(<KpiResultsTable kpis={[own]} draft={null} files={[]} bands={{aBands:policy.aBands,bBands:[{companyId:'company',minima:[0,50,90,110,140]}]}} companyId="company" evidence={false}/>);
 expect(screen.getByRole('columnheader',{name:en.onehr.excellence})).toBeTruthy();
 expect(screen.queryByRole('columnheader',{name:en.onehr.multiple})).toBeNull();
 expect(screen.getByText('120% · AE')).toBeTruthy();
 fireEvent.change(screen.getByLabelText(en.onehr.actual),{target:{value:'200'}});
 expect(screen.getByText('150% · OU')).toBeTruthy();
});

it('keeps file bytes out of the results payload and associates them with the matching upload form',()=>{
 const own=kpi('Supporting proof');
 show(<><form id={`kpi-file-${own.id}`} aria-label="Upload"/><form aria-label="Results"><KpiResultsTable kpis={[own]} draft={null} files={[{id:'file',fileName:'Delivery.txt',kpiId:own.id}]} bands={policy} companyId="company" evidence/></form></>);
 const result=screen.getByRole('form',{name:'Results'}) as HTMLFormElement,upload=screen.getByRole('form',{name:'Upload'});
 const input=screen.getByLabelText(en.onehr.evidenceFile) as HTMLInputElement;
 expect(result.contains(input)).toBe(true);expect(input.form).toBe(upload);
 expect(new FormData(result).has('file')).toBe(false);
 fireEvent.click(screen.getByLabelText(`${own.title}: ${en.onehr.attachments} (1)`));
 expect(screen.getByRole('link',{name:'Delivery.txt'}).getAttribute('href')).toBe('/performance/attachment/file?inline=1');
});

it('shares live progress with the module bar and jumps to confirmation without submitting',()=>{
 const submit=vi.fn(),scroll=vi.fn();
 show(<JourneyProgressProvider initial={{answered:0,total:1,remark:false,submitted:false}} labels={['Results','Justification','Confirm']}><JourneySteps/><JourneyPanel initial={{answered:0,total:1,remark:false,submitted:false}} labels={['Results','Justification','Confirm']}><div data-review-scroll><form data-assessment-draft onSubmit={submit}><input name="draftKind" value="results" readOnly/><input name="kpiId" value="first" readOnly/><table><tbody><tr><td><input aria-label="Actual" name="first.actual" type="number"/></td></tr></tbody></table><textarea aria-label="Overall remark" name="overallRemark"/><button type="button" data-journey-confirm>Submit results</button></form></div></JourneyPanel></JourneyProgressProvider>);
 const viewport=document.querySelector('[data-review-scroll]')!;Object.assign(viewport,{scrollTo:scroll});
 expect(screen.getAllByRole('list')).toHaveLength(1);
 fireEvent.change(screen.getByLabelText('Actual'),{target:{value:'100'}});
 expect(screen.getByRole('button',{name:'Results 1/1'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Justification'}));expect(document.activeElement).toBe(screen.getByLabelText('Overall remark'));
 fireEvent.change(screen.getByLabelText('Overall remark'),{target:{value:'Delivered the planned work.'}});
 expect(screen.getByRole('button',{name:'Confirm'}).getAttribute('aria-current')).toBe('step');
 fireEvent.click(screen.getByRole('button',{name:'Confirm'}));expect(document.activeElement).toBe(screen.getByRole('button',{name:'Submit results'}));
 expect(scroll).toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
 expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(3);
});
