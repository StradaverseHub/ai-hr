import {beforeEach,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {Card,PageHeader} from '../components/ui';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import viMessages from '../messages/vi.json';import th from '../messages/th.json';
import {OrgChart} from '../components/org-chart';
import {OrgChartFilters} from '../app/org/filters';
import messages from '../messages/en.json';
const employees=[{employmentId:'a',name:'Fictional Manager',employeeCode:'M001',role:'Manager',department:'Finance',topLevel:true},{employmentId:'b',name:'Fictional Report',employeeCode:'E002',role:'Officer',department:'Finance'}];
const wrap=(node:React.ReactNode)=><NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>;
beforeEach(()=>{sessionStorage.clear();vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});Element.prototype.scrollIntoView=vi.fn();});
it('34b9579a: cards open an accessible quick view, preserve profile navigation, and close by Escape',()=>{
 render(wrap(<OrgChart employees={employees} edges={[{manager:'a',subordinate:'b',type:'administrative'}]}/>));
 fireEvent.click(screen.getByRole('button',{name:/Fictional Manager/}));
 const panel=screen.getByRole('dialog',{name:'Fictional Manager'});expect(within(panel).getByRole('link',{name:'Open full profile'})).toHaveAttribute('href','/personnel/a?from=org');
 fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();
});
it('34b9579a: collapsing branches removes their children and export state follows the actual view',()=>{
 const {container}=render(wrap(<OrgChart employees={employees} edges={[{manager:'a',subordinate:'b',type:'administrative'}]} filter={{asOf:'2026-06-01'}} canExport/>));
 fireEvent.click(screen.getByRole('button',{name:'Collapse all'}));
 expect(screen.queryByText('Fictional Report')).toBeNull();
 expect(JSON.parse((container.querySelector('input[name="collapsed"]') as HTMLInputElement).value)).toEqual(['a','b']);
 fireEvent.click(screen.getByRole('button',{name:'Expand all'}));expect(screen.getByText('Fictional Report')).toBeVisible();
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'E002'}});expect(screen.getByText('Fictional Report')).toBeVisible();
});
it('34b9579a: company and business-unit changes narrow their dependent choices',()=>{
 render(wrap(<OrgChartFilters restore={false} filter={{asOf:'2026-06-01'}} options={[{companyId:'first',company:'First company',businessUnitId:'one',businessUnit:'One unit',departmentId:'finance',department:'Finance'},{companyId:'second',company:'Second company',businessUnitId:'two',businessUnit:'Two unit',departmentId:'hr',department:'Human resources'}]}/>));
 fireEvent.change(screen.getByLabelText('Company'),{target:{value:'first'}});
 expect(within(screen.getByLabelText('Business unit')).queryByRole('option',{name:'Two unit'})).toBeNull();
 expect(within(screen.getByLabelText('Department')).queryByRole('option',{name:'Human resources'})).toBeNull();
});
it('34b9579a: large organisations render branches progressively rather than mounting every deep card',()=>{
 const many=Array.from({length:250},(_,i)=>({employmentId:String(i),name:`Employee ${i}`,employeeCode:String(i),role:null,department:null}));
 render(wrap(<OrgChart employees={many} edges={many.slice(1).map((e,i)=>({manager:String(i),subordinate:e.employmentId,type:'administrative'}))}/>));
 expect(screen.getByText('Employee 0')).toBeVisible();expect(screen.queryByText('Employee 249')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/Expand 1 report/}));expect(screen.getByText('Employee 1')).toBeVisible();
});

const orgCaptureLocales={en:messages,ms,zh,ta,vi:viMessages,th};
it.each(Object.entries(orgCaptureLocales))('34b9579a: captures the actual OrgChart and filter/export controls in %s at desktop and mobile sizes',async(locale,catalogue)=>{
 const chartEmployees=[
  {...employees[0],employmentId:'top',name:'Fictional Director',department:'Executive',company:'Fictional Company',directReportCount:2},
  {...employees[1],employmentId:'first',name:'Fictional Operations Manager',department:'Operations',company:'Fictional Company',directReportCount:0},
  {...employees[1],employmentId:'second',name:'Fictional Finance Manager',department:'Finance',company:'Other Fictional Company',crossCompany:true,directReportCount:0},
  {...employees[1],employmentId:'unassigned',name:'Fictional Pending Reassignment',department:'Operations',company:'Fictional Company',managerState:'inactive' as const,managerName:'Fictional Departed Superior',directReportCount:0},
 ];
 const view=render(<NextIntlClientProvider locale={locale} messages={catalogue}><div className="space-y-5"><PageHeader title={catalogue.org.title}/><Card className="p-5"><OrgChartFilters restore={false} filter={{asOf:'2026-06-01',status:'all'}} options={[{companyId:'company',company:'Fictional Company',businessUnitId:'operations',businessUnit:'Operations',departmentId:'operations',department:'Operations'},{companyId:'other-company',company:'Other Fictional Company',businessUnitId:'finance',businessUnit:'Finance',departmentId:'finance',department:'Finance'}]}/></Card><Card className="p-5"><OrgChart employees={chartEmployees} edges={[{manager:'top',subordinate:'first',type:'administrative'},{manager:'top',subordinate:'second',type:'administrative'}]} filter={{asOf:'2026-06-01',status:'all'}} canExport/></Card></div></NextIntlClientProvider>);
 expect(view.container.querySelectorAll('[data-org-node]')).toHaveLength(4);
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'org-chart-controls','Actual OrgChart/OrgChartFilters and shared page/card components; fictional permitted employees, hierarchy, cross-company link and vacancy; inert Chromium reflow through the live connector owner; no authenticated journey or installed acceptance.','atelier');
 view.unmount();
},120000);
