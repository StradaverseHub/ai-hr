/** Real Chromium + shipped CSS; synthetic client fixtures never write to a database or installation. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import '../app/globals.css';
import '../app/atelier.css';
import en from '../messages/en.json';
import {REWARD_POLICY_GRADES} from '../packs/rewards/policy-grid-validation';
const ports=vi.hoisted(()=>({previous:vi.fn(),preview:vi.fn(),save:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/(app)/rewards/policy-grid-actions',()=>({loadPreviousRewardPolicyMatrices:ports.previous}));
vi.mock('../app/(app)/rewards/actions',()=>({previewSeniorMembershipAction:ports.preview,saveSeniorMembershipAction:ports.save}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
const {PolicyMatrixGrid}=await import('../app/(app)/rewards/policy-matrix-grid');
const {SeniorMembership}=await import('../app/(app)/rewards/[unitId]/senior-membership');
const bonus=()=>Object.fromEntries(REWARD_POLICY_GRADES.map(grade=>[grade,[0,10000,20000,30000,40000]]));
const roster=[{employmentId:'fixture-a',name:'Fictional operations manager A',employeeCode:'S-001',member:false,eligible:true,grade:'21'},{employmentId:'fixture-b',name:'Fictional regional manager B',employeeCode:'S-002',member:true,eligible:true,grade:'22'}];
afterEach(async()=>{cleanup();vi.clearAllMocks();document.documentElement.removeAttribute('data-ui-theme');document.body.style.margin='';await page.viewport(1280,720);});
function mount(node:React.ReactNode){document.documentElement.setAttribute('data-ui-theme','atelier');document.body.style.margin='0';render(<NextIntlClientProvider locale="en" messages={en}><main className="mx-auto max-w-5xl p-4">{node}</main></NextIntlClientProvider>);return document.querySelector('main')!;}
async function capture(name:string,element:Element){
 const width=window.innerWidth;await page.viewport(width,Math.ceil(element.scrollHeight+32));window.scrollTo(0,0);await document.fonts.ready;
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 // Remove only Vitest's outer iframe scaling so screenshots retain actual CSS pixels.
 const wrapper=window.frameElement?.parentElement,style=wrapper?.getAttribute('style'),scale=wrapper?.getAttribute('data-scale');
 wrapper?.style.setProperty('transform','none','important');wrapper?.setAttribute('data-scale','1');
 try{
  const shot=await page.screenshot({element,path:`../scratchpad/rewards-browser/${name}.png`,animations:'disabled',scale:'css',base64:true,style:'#vitest-tester [data-scale], #tester-ui [data-scale] { transform: none !important; }'});
  const bytes=Uint8Array.from(atob(shot.base64),char=>char.charCodeAt(0)),header=new DataView(bytes.buffer);
  expect(header.getUint32(16)).toBe(Math.round(element.getBoundingClientRect().width));
  expect(header.getUint32(20)).toBeGreaterThanOrEqual(Math.floor(element.getBoundingClientRect().height)-1);
 }finally{
  if(wrapper){if(style==null)wrapper.removeAttribute('style');else wrapper.setAttribute('style',style);if(scale==null)wrapper.removeAttribute('data-scale');else wrapper.setAttribute('data-scale',scale);}
 }
}
for(const width of [390,1280])describe(`approved Rewards controls at ${width}px`,()=>{
 it('contains the matrix in its scroll area and blocks invalid native form submission until corrected',async()=>{
  await page.viewport(width,1000);ports.previous.mockResolvedValue([{id:'prior',name:'Fictional prior-year policy',revision:2,year:2025,ranges:{},bonusMatrix:bonus(),branchFactors:{}}]);
  const main=mount(<form><PolicyMatrixGrid kind="bonusMatrix" year={2026} matrix={bonus()}/><button type="submit">Save fixture</button></form>),form=main.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
  const input=screen.getByRole('spinbutton',{name:'H UA'}) as HTMLInputElement;
  expect(input.getBoundingClientRect().width).toBeGreaterThanOrEqual(95);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  const scroller=main.querySelector('.overflow-x-auto')!;
  if(width===390)expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
  fireEvent.change(input,{target:{value:'1'}});
  expect(input.getAttribute('aria-invalid')).toBe('true');expect(input.validity.valid).toBe(false);expect(form.checkValidity()).toBe(false);
  await capture(`bonus-invalid-${width}`,main);
  fireEvent.change(input,{target:{value:'0'}});expect(form.checkValidity()).toBe(true);
  await page.getByRole('button',{name:en.rewards.policyGrids.copy}).click();
  await page.getByRole('button',{name:/Fictional prior-year policy/}).click();
  expect(screen.getByRole('heading',{name:en.rewards.policyGrids.preview})).toBeTruthy();
  expect((screen.getByRole('spinbutton',{name:'H UA'}) as HTMLInputElement).value).toBe('0');
  await page.getByRole('button',{name:en.rewards.policyGrids.apply}).click();
  expect(form.checkValidity()).toBe(true);expect(ports.previous).toHaveBeenCalledWith(2026);
 });
 it('retains hidden Senior selections and requires a fresh preview after another selection change',async()=>{
  await page.viewport(width,1000);ports.preview.mockResolvedValue({ok:true,preview:{unitId:'fixture-unit',revision:7,digest:'fixture-digest',convertingLegacy:false,rows:roster.map(row=>({...row,nextMember:true}))}});
  const main=mount(<SeniorMembership value={{unitId:'fixture-unit',revision:7,canEdit:true,mode:'named-members',rows:roster}}/>);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'S-001'}});
  expect(screen.queryByRole('checkbox',{name:/manager B/})).toBeNull();
  await page.getByRole('checkbox',{name:/manager A/}).click();
  await page.getByRole('button',{name:en.rewards.previewSeniorMembership}).click();
  await waitFor(()=>expect(ports.preview).toHaveBeenCalledWith('fixture-unit',7,{employmentIds:['fixture-a','fixture-b'],adoptLegacy:false}));
  expect(await screen.findByRole('button',{name:en.rewards.confirmSeniorMembership})).toBeTruthy();
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  await capture(`senior-preview-${width}`,main);
  await page.getByRole('checkbox',{name:/manager A/}).click();
  expect(screen.queryByRole('button',{name:en.rewards.confirmSeniorMembership})).toBeNull();expect(ports.save).not.toHaveBeenCalled();
 });
});
