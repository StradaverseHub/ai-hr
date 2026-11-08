/** Pure complete route partition. Workflow activation awaits actual qualified native owners. */
import assert from 'node:assert/strict';
import {nativeNextUnit} from './singleton-protocol.mjs';
import {employeeLifecycleMatrixRow} from './employee-lifecycle-profile.mjs';
import {nativeNoDbProfile} from './native-nodb-profiles.mjs';
const frozen=values=>Object.freeze(values.map(value=>typeof value==='object'?Object.freeze(value):value));
export function normalTestMatrices(plan,selected){
 assert(plan&&Array.isArray(plan.units)&&plan.units.length>0&&plan.units.length<=256,'Complete bounded source plan required');
 assert(plan.units.every(unit=>unit&&typeof unit.id==='string'&&['nodb','db','browser'].includes(unit.kind))&&new Set(plan.units.map(unit=>unit.id)).size===plan.units.length,'Unique complete source units required');
 for(const unit of plan.units)nativeNoDbProfile(unit); // Check owned intent BEFORE browser/selection filtering.
 const complete=plan.units.filter(unit=>unit.kind!=='browser'),all=complete.map(unit=>unit.id);
 const ids=selected??all;assert(Array.isArray(ids)&&ids.length>0&&ids.length<=256&&new Set(ids).size===ids.length&&ids.every(id=>all.includes(id)),'Exact bounded non-browser selection required');
 const ordinary=[],native=[],semantic=[],cli=[];
 for(const id of ids){
  const unit=complete.find(row=>row.id===id),profile=nativeNoDbProfile(unit);
  if(profile?.owner==='classifier'){
   if(profile.purpose==='semantic')semantic.push(id);else{assert(['cli-b','cli-c'].includes(profile.purpose));cli.push(id);}
  }else if(nativeNextUnit(unit))native.push(id);
  else ordinary.push(profile?{unit:id,employeeLifecycle:false,nativeNoDb:true,purpose:profile.purpose}:employeeLifecycleMatrixRow(unit));
 }
 assert(semantic.length<=1,'Only the fixed semantic parent may precede CLI witnesses');
 assert(cli.length===0||semantic.length===1,'Actual same-run semantic parent must be selected for CLI witnesses');
 const union=[...ordinary.map(row=>row.unit),...native,...semantic,...cli];
 assert.deepEqual(union.slice().sort(),ids.slice().sort(),'Normal route union differs from complete selection');
 return Object.freeze({
  test_matrix:Object.freeze({include:frozen(ordinary)}),native_matrix:Object.freeze({unit:frozen(native)}),
  classifier_semantic_matrix:Object.freeze({unit:frozen(semantic)}),classifier_cli_matrix:Object.freeze({unit:frozen(cli)}),
  has_tests:ordinary.length>0,has_native:native.length>0,has_classifier_semantic:semantic.length>0,has_classifier_cli:cli.length>0,
 });
}
