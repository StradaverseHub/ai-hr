import {describe,it,expect,vi} from 'vitest';
import {fireEvent,render,screen,within,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {PolicyMatrixGrid} from '../app/rewards/policy-matrix-grid';
import {BranchPolicyFields} from '../app/rewards/branch-policy-fields';
import {REWARD_POLICY_GRADES,policyGridIssues,parsePolicyGridDecimal,policyGridRows} from '../packs/rewards/policy-grid-validation';
vi.mock('../app/rewards/policy-grid-actions',()=>({loadPreviousRewardPolicyMatrices:vi.fn(async()=>[{id:'prior',name:'Previous policy',revision:2,year:2025,ranges:{H:[10000,20000,30000]},bonusMatrix:{H:[0,10000,20000,30000,40000]},branchFactors:{retail:[0,10000,15000,20000,25000]}}])}));
function wrap(node:React.ReactNode){return <NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;}
const validBonus=()=>Object.fromEntries(REWARD_POLICY_GRADES.map(grade=>[grade,[0,10000,20000,30000,40000]]));
describe('approved Rewards policy grids',()=>{
 it('parses exact supported decimals and refuses accidental precision or malformed numeric forms',()=>{
  expect(parsePolicyGridDecimal('14.01',100)).toBe(1401);expect(parsePolicyGridDecimal('0',100)).toBe(0);
  for(const value of ['1.001','1e2','-1','Infinity','=SUM(1,2)',''])expect(parsePolicyGridDecimal(value,100)).toBeNull();
 });
 it('requires complete known grades, strict ranges and ascending two-decimal bonus months with UA zero',()=>{
  const bonus=policyGridRows('bonusMatrix',validBonus());expect(policyGridIssues('bonusMatrix',bonus)).toEqual([]);
  bonus[0][1]='1';expect(policyGridIssues('bonusMatrix',bonus)).toContainEqual({row:'H',column:1,code:'zero'});
  bonus[0][1]='0';bonus[0][3]='1';expect(policyGridIssues('bonusMatrix',bonus).some(issue=>issue.code==='order')).toBe(true);
  bonus[0][3]='2.001';expect(policyGridIssues('bonusMatrix',bonus).some(issue=>issue.code==='precision')).toBe(true);
  expect(policyGridIssues('bonusMatrix',bonus.slice(1)).some(issue=>issue.row==='H'&&issue.code==='missing')).toBe(true);
  const ranges=policyGridRows('ranges',Object.fromEntries(REWARD_POLICY_GRADES.filter(grade=>grade!=='23').map(grade=>[grade,[100,200,300]])));
  expect(policyGridIssues('ranges',ranges)).toEqual([]);ranges[0][2]='1';expect(policyGridIssues('ranges',ranges).some(issue=>issue.code==='order')).toBe(true);
 });
 it('highlights invalid cells and blocks native form validation until corrected',()=>{
  render(wrap(<form><PolicyMatrixGrid kind="bonusMatrix" year={2026} matrix={validBonus()}/><button>Save</button></form>));
  const input=screen.getByRole<HTMLInputElement>('spinbutton',{name:'H ME'});fireEvent.change(input,{target:{value:'0.5'}});
  expect(input).toHaveAttribute('aria-invalid','true');expect(input.checkValidity()).toBe(false);
  fireEvent.change(input,{target:{value:'2.5'}});expect(input.checkValidity()).toBe(true);
  const encoded=document.querySelector<HTMLInputElement>('input[name="bonusMatrix"]')!.value;expect(encoded).toContain('H, 0, 1, 2.5, 3, 4');
 });
 it('previews a permitted previous-year configuration and applies it only after confirmation',async()=>{
  cleanup();render(wrap(<PolicyMatrixGrid kind="branchFactors" year={2026} matrix={{old:[0,20000,20000,20000,20000]}}/>));
  fireEvent.click(screen.getByRole('button',{name:en.rewards.policyGrids.copy}));
  fireEvent.click(await screen.findByRole('button',{name:'Previous policy · Version 2'}));
  expect(screen.getByRole('heading',{name:en.rewards.policyGrids.preview})).toBeVisible();
  expect(screen.getByRole<HTMLInputElement>('textbox',{name:en.rewards.policyGrids.segment}).value).toBe('old');
  fireEvent.click(screen.getByRole('button',{name:en.rewards.policyGrids.apply}));
  expect(screen.getByRole<HTMLInputElement>('textbox',{name:en.rewards.policyGrids.segment}).value).toBe('retail');
 });
 it('shows branch factors only for the branch structure and retains disabled values when hidden',()=>{
  cleanup();render(wrap(<BranchPolicyFields structure="standard" factors={{retail:[0,10000,15000,20000,25000]}} year={2026}/>));
  expect(screen.queryByRole('heading',{name:en.rewards.policyGrids.branchFactors})).toBeNull();
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'branch'}});
  expect(screen.getByRole('heading',{name:en.rewards.policyGrids.branchFactors})).toBeVisible();
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'standard'}});
  expect(document.querySelector<HTMLInputElement>('input[name="branchFactors"]:not(:disabled)')?.value).toContain('retail, 0, 1, 1.5, 2, 2.5');
 });
});
