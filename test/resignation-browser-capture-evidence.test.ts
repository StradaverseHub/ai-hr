import {describe,expect,it} from 'vitest';
import {assertResignationCaptureVisibility} from '../scripts/resignation-browser-acceptance.mjs';

describe('actual resignation capture evidence',()=>{
 const desktop=()=>({bounds:{x:300,y:200,width:1000,height:400},clip:{left:248,top:48,width:1192,height:952},visibleWidth:1000,visibleHeight:400});
 it('accepts a fully visible section in the app scroll area',()=>{expect(()=>assertResignationCaptureVisibility(desktop(),'settings')).not.toThrow();});
 it('refuses an offscreen section even when its DOM content exists',()=>{expect(()=>assertResignationCaptureVisibility({...desktop(),visibleHeight:0},'settings')).toThrow(/clipped/);});
 it('refuses a section clipped by an inner app scroller',()=>{expect(()=>assertResignationCaptureVisibility({...desktop(),clip:{left:248,top:300,width:1192,height:600},visibleHeight:200},'routing')).toThrow(/clipped/);});
 it('refuses horizontal clipping instead of treating fullPage as proof',()=>{expect(()=>assertResignationCaptureVisibility({...desktop(),visibleWidth:300},'mobile offer')).toThrow(/horizontally clipped/);});
 it('allows the available vertical slice of a tall section but records its real size',()=>{expect(()=>assertResignationCaptureVisibility({...desktop(),bounds:{x:300,y:-400,width:1000,height:2000},visibleHeight:952},'long letter')).not.toThrow();});
 it('refuses an empty target and an unusable content viewport',()=>{expect(()=>assertResignationCaptureVisibility({...desktop(),bounds:{x:0,y:0,width:0,height:0}},'empty')).toThrow(/empty/);expect(()=>assertResignationCaptureVisibility({...desktop(),clip:{left:248,top:990,width:1192,height:10}},'covered')).toThrow(/no available/);});
});
