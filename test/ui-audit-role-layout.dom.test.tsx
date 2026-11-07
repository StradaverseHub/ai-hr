import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import {chromium} from 'playwright';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import en from '../messages/en.json';
import {PersonnelOrganisationFilters} from '../app/admin/personnel/organisation-filters';
import {RequestLeaveDialog} from '../components/leave/request-leave-dialog';
import {EmployeePanel} from '../components/my-team/employee-panel';
import {teamSnapshot,teamNavigation} from './fixtures/my-team-ui';
import {applicationCss} from './helpers/ai-review-screenshots';
import styles from '../components/leave/inquiry-table.module.css';
import {CreateEmployeeDialog} from '../app/admin/personnel/create-employee-dialog';
vi.mock('../app/admin/personnel/new/actions',()=>({createDraftAction:vi.fn(),checkEmployeeCodeAction:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()}),useSearchParams:()=>new URLSearchParams()}));
afterEach(cleanup);

/** Real component/CSS fixtures on hosted Chrome. Role authorization is tested separately;
 * these captures do not claim an authenticated installation or physical touch hardware. */
async function verifyLayout(role:string,html:string,table=false){
 const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
 if(!evidence)return;
 if(process.env.GITHUB_ACTIONS!=='true')throw Error('Rendered checks run on the hosted runner.');
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});
 const out=join(evidence,'ui-audit-layout');mkdirSync(out,{recursive:true});
 const css=await applicationCss();const results=[];
 try{
  for(const [device,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
   const page=await browser.newPage({viewport:{width,height}});
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.route('**/*',route=>route.abort());
   await page.setContent(`<html lang="en" data-ui-theme="atelier"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="bg-background text-foreground font-sans">${table?`<main class="p-4">${html}</main>`:html}</body></html>`);
   await page.addStyleTag({content:css+(table?'\n'+readFileSync('components/leave/inquiry-table.module.css','utf8').replaceAll('.table','.'+styles.table):'')});
   await page.evaluate(()=>document.fonts.ready);
   // The fixture adds compiled CSS after its markup. Let registered transform properties
   // and font metrics reach a painted frame before measuring the centred portal.
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const geometry=await page.evaluate(()=>{
    const dialog=document.querySelector<HTMLElement>('[role="dialog"]');const rect=dialog?.getBoundingClientRect();
    return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,dialog:rect?{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}:null,buttons:Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button, [data-tour="people-hire"]')).filter(button=>button.getBoundingClientRect().width>0).map(button=>({name:button.textContent,height:button.getBoundingClientRect().height})),headings:Array.from(document.querySelectorAll('th')).map(th=>({wrap:getComputedStyle(th).whiteSpace,width:th.clientWidth,content:th.scrollWidth}))};
   });
   await page.screenshot({path:join(out,`${role}-${device}.png`),fullPage:true});results.push({role,device,...geometry});
   writeFileSync(join(out,`${role}.json`),JSON.stringify({kind:'real-component fixtures; not authenticated role acceptance',results},null,2));
   expect(geometry.pageWidth,`${role}/${device} root overflow`).toBeLessThanOrEqual(width+1);
   if(geometry.dialog){expect(geometry.dialog.left).toBeGreaterThanOrEqual(0);expect(geometry.dialog.right).toBeLessThanOrEqual(width+1);expect(geometry.dialog.top).toBeGreaterThanOrEqual(0);expect(geometry.dialog.bottom).toBeLessThanOrEqual(height+1);}
   if(device==='mobile')for(const button of geometry.buttons)expect(button.height,button.name??'button target').toBeGreaterThanOrEqual(43.5);
   if(table)for(const heading of geometry.headings){expect(heading.wrap).toBe('normal');expect(heading.content).toBeLessThanOrEqual(heading.width+1);}
   await page.close();
  }
  writeFileSync(join(out,`${role}.json`),JSON.stringify({kind:'real-component fixtures; not authenticated role acceptance',results},null,2));
 }finally{await browser.close();}
}

it.each(['admin','employee','manager','company-hr'] as const)('%s desktop and mobile component layout',async role=>{
 const snapshot=teamSnapshot(),employee=snapshot.employees[0];
 const view=render(<NextIntlClientProvider locale="en" messages={en}><main>
  {(role==='admin'||role==='company-hr')?<PersonnelOrganisationFilters companies={[{id:'allowed',name:'Fictional Company With A Long Legal Name Sdn Bhd',parentCompanyId:null,parentCompany:null,businessGroupId:null,businessGroup:null,businessUnitId:null,businessUnit:null}]} fields={[]} values={{}} labels={{filter:'Filter',apply:'Apply',clearAll:'Clear all',activeCount:'0'}} companySearchLabel="Search companies"/>:
   role==='employee'?<RequestLeaveDialog types={[{id:'annual',code:'ANNUAL',label:'Annual leave',durations:null}]} startDefault="2026-11-09" ownEmploymentId="own" previewAction={async()=>null} submitAction={async()=>({error:'Fixture rejection'})} summaryAction={async()=>null}/>:
   <EmployeePanel employee={employee} selectedDate={snapshot.today} snapshot={snapshot} navigation={teamNavigation()} locale="en" t={createTranslator({locale:'en',messages:en,namespace:'myTeam'})} onClose={()=>{}}/>}
 </main></NextIntlClientProvider>);
 if(role==='admin'||role==='company-hr')fireEvent.click(screen.getByRole('button',{name:'Filter'}));
 else if(role==='employee')fireEvent.click(screen.getByRole('button',{name:en.leave.requestLeave}));
 else fireEvent.click(screen.getByRole('tab',{name:en.myTeam.leaveBalance}));
 await verifyLayout(role,document.body.innerHTML);
},120000);

it('leave inquiry headings wrap within their columns in the actual theme and module CSS',async()=>{
 const headings=['Employee ID','Employee Name','Company','Department','Leave type','Entitlement Year','Eligible','Earned to Date','Brought Forward','Adjustment','System','Forfeited','Taken','Pending Approval','Available Balance','Explanation'];
 const view=render(<div className="max-w-full overflow-x-auto"><table className={styles.table} data-wrap-headings><thead><tr>{headings.map(heading=><th key={heading}>{heading}</th>)}</tr></thead><tbody><tr>{headings.map((heading,i)=><td key={heading}>{i<5?'Fictional example':'0.00'}</td>)}</tr></tbody></table></div>);
 await verifyLayout('leave-headings',view.container.innerHTML,true);
},120000);

// The live audit caught a button-styled link missed by button-only geometry checks.
it('the actual Create new employee link has the shared phone target while preserving its route',async()=>{
 const view=render(<NextIntlClientProvider locale="en" messages={en}><main><CreateEmployeeDialog triggerLabel="Create new employee" companies={[]} employeeIdRules={{}}/></main></NextIntlClientProvider>);
 expect(screen.getByRole('link',{name:'Create new employee'})).toHaveAttribute('href','/admin/personnel/new');
 await verifyLayout('create-employee-target',view.container.innerHTML);
},120000);
