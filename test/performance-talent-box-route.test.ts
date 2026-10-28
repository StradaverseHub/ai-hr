/**
 * D-P1-27 — which Talent Box the standalone route opens (BU, BG and Group Talent Box parts the viewer holds; never
 * an HOD, never a crafted session) and where each Calibration tab leads. Pure; the page reads it over the viewer's
 * own workspace items. The page's DOM is pinned in performance-talent-box-route.dom.test.tsx.
 */
import { describe,expect,it } from 'vitest';
import { talentBoxRoute } from '../app/performance/calibration/talent-box/talent-box-route';
import type { PerformanceWorkspaceItem } from '../packs/performance/service';
import { SCREENS } from '../lib/permissions';

type Part={id:string;view:string;stage:string;kind?:string;module?:string;title?:string};
const item=(p:Part)=>({key:`${p.id}.${p.stage}`,id:p.id,kind:p.kind??'calibration',cycleId:'c1',cycle:'Annual',periodEnd:'2026-12-31',view:p.view,module:p.module??'cal',axis:'both',state:'open',title:p.title??'BU review',stage:p.stage,locked:false}) as PerformanceWorkspaceItem;
const hod=[item({id:'d',view:'dept',stage:'department_review'}),item({id:'d',view:'dept',stage:'department_potential_review'}),item({id:'r',view:'mine',kind:'review',module:'pm',stage:'results'})];
const bu=[item({id:'session',view:'bu',stage:'calibration'}),item({id:'session',view:'bu',stage:'potential_calibration'}),item({id:'session',view:'bu',stage:'talent_box'})];
const bg=[item({id:'session',view:'bg',stage:'talent_box',title:'BG review'})];
const group=[item({id:'session',view:'group',stage:'group_calibration',title:'Group review'}),item({id:'session',view:'group',stage:'talent_box',title:'Group review'})];
const workspace=(stage:string,view='bu')=>`/performance/workspace?cycle=c1&view=${view}&module=cal&stage=${stage}&calibration=session`;

describe('talentBoxRoute',()=>{
 it('opens only a BU, BG or Group Talent Box part the viewer holds',()=>{
  expect(talentBoxRoute(hod,{})).toBeNull();
  expect(talentBoxRoute([],{})).toBeNull();
  expect(talentBoxRoute(bu,{session:'someone-else'})).toBeNull();
  expect(talentBoxRoute(bu,{session:''})).toBeNull();
  expect(talentBoxRoute(bu,{})?.box.key).toBe('session.talent_box');
  const two=[...bu,item({id:'other',view:'bg',stage:'talent_box',title:'BG review'})];
  expect(talentBoxRoute(two,{})?.box.id).toBe('session');expect(talentBoxRoute(two,{session:'other'})?.box.id).toBe('other');
  expect(talentBoxRoute(two,{})?.boxes.map(b=>b.id)).toEqual(['session','other']);
 });
 it('leads each Calibration tab to where that work lives: BU and Group workspace parts, the BG lists',()=>{
  expect(talentBoxRoute(bu,{})?.tabs).toEqual([
   {id:'performance',href:workspace('calibration'),active:false},
   {id:'potential',href:workspace('potential_calibration'),active:false},
   {id:'box',href:'/performance/calibration/talent-box?session=session',active:true},
  ]);
  expect(talentBoxRoute(bu,{})?.returnTo).toBe(workspace('talent_box'));
  expect(talentBoxRoute(bg,{axis:'potential'})?.tabs).toEqual([
   {id:'performance',href:'/performance/calibration/talent-box?session=session&axis=performance',active:false},
   {id:'potential',href:'/performance/calibration/talent-box?session=session&axis=potential',active:true},
   {id:'box',href:'/performance/calibration/talent-box?session=session',active:false},
  ]);
  // The Group tier has no potential part.
  expect(talentBoxRoute(group,{})?.tabs.map(tab=>[tab.id,tab.href])).toEqual([['performance',workspace('group_calibration','group')],['box','/performance/calibration/talent-box?session=session']]);
 });
 it('refuses a per-axis list outside the BG tier and an unknown axis',()=>{
  expect(talentBoxRoute(bu,{axis:'performance'})).toBeNull();
  expect(talentBoxRoute(group,{axis:'performance'})).toBeNull();
  expect(talentBoxRoute(bg,{axis:'both'})).toBeNull();
  expect(talentBoxRoute(bg,{axis:'performance'})?.axis).toBe('performance');
 });
 it('is registered on the onehrAssignments screen only',()=>{
  expect(SCREENS.filter(screen=>screen.routes.includes('/performance/calibration/talent-box')).map(screen=>screen.screenKey)).toEqual(['onehrAssignments']);
 });
});

