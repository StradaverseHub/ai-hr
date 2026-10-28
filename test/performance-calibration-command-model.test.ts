import { describe,expect,it } from 'vitest';
import { calibrationCommand } from '../packs/performance/onehr/calibration-command-model';
const targets=[{id:'alice',name:'Alice Tan'},{id:'bob',name:'Bob Lim'}];
describe('human calibration commands',()=>{
 it('retains the human band and explanation and distinguishes a held department edit from a final save',()=>{
  expect(calibrationCommand('Set performance: Alice Tan: AE: Verified delivery: operational records. ',targets,'performance','hod')).toEqual({reviewId:'alice',axis:'performance',band:'AE',reason:'Verified delivery: operational records.',submit:false});
  expect(calibrationCommand('Save department potential: Bob Lim: high: Demonstrated the agreed skills.',targets,'potential','hod')).toMatchObject({axis:'potential',band:'High',submit:true});
 });
 it('understands natural explicit moves and retains the current saved reason without confirming a department',()=>{
  expect(calibrationCommand('Please move Alice Tan to Outstanding because Verified exceptional delivery.',targets,'performance','hod')).toEqual({reviewId:'alice',axis:'performance',band:'OU',reason:'Verified exceptional delivery.',submit:false});
  expect(calibrationCommand('Rate Bob Lim potential as High with my reason: Ready for wider responsibility.',targets,'both','bg')).toMatchObject({axis:'potential',band:'High',reason:'Ready for wider responsibility.',submit:false});
  expect(calibrationCommand('Mark Alice Tan as Above Expectation with this remark',[{...targets[0],performanceNote:'Previously refined and saved words.'}],'performance','hod')).toMatchObject({band:'AE',reason:'Previously refined and saved words.',submit:false});
  expect(()=>calibrationCommand('Move Alice Tan to Outstanding with this remark',targets,'performance','hod')).toThrow(/explanation/);
  expect(()=>calibrationCommand('Move Alice Tan to High because Supporting work.',targets,'performance','bu')).toThrow(/axis/);
  expect(()=>calibrationCommand('Move Alice Tan to Outstanding',targets,'performance','hod')).toThrow(/explanation/);
  expect(calibrationCommand('Should I move Alice Tan to Outstanding because of delivery?',targets,'performance','bu')).toBeNull();
 });
 it('APR-022: a BU or BG CEO may move a band without an explanation, in either form; a given one is kept',()=>{
  for(const tier of ['bu','bg']){
   expect(calibrationCommand('Move Alice Tan to Outstanding',targets,'performance',tier),tier).toEqual({reviewId:'alice',axis:'performance',band:'OU',reason:'',submit:false});
   expect(calibrationCommand('Rate Bob Lim potential as High.',targets,'both',tier),tier).toEqual({reviewId:'bob',axis:'potential',band:'High',reason:'',submit:false});
   expect(calibrationCommand('Move Alice Tan to Outstanding with this remark',targets,'performance',tier),tier).toMatchObject({band:'OU',reason:''});
   expect(calibrationCommand('Set performance: Alice Tan: ME',targets,'performance',tier),tier).toEqual({reviewId:'alice',axis:'performance',band:'ME',reason:'',submit:false});
   expect(calibrationCommand('Set performance: Alice Tan: ME: ',targets,'performance',tier),tier).toMatchObject({band:'ME',reason:''});
   expect(calibrationCommand('Set performance: Alice Tan: AE: Verified delivery.',targets,'performance',tier),tier).toMatchObject({band:'AE',reason:'Verified delivery.'});
   expect(()=>calibrationCommand('Move Alice Tan to Excellent',targets,'performance',tier),tier).toThrow(/configured band/);
  }
 });
 it('refuses an unknown or ambiguous person, wrong axis, unknown band and the HOD’s empty justification',()=>{
  expect(()=>calibrationCommand('Set performance: Stranger: AE: Words',targets,'performance','bu')).toThrow(/cohort/);
  expect(()=>calibrationCommand('Set performance: Alice Tan: AE: Words',[...targets,targets[0]],'performance','bu')).toThrow(/unambiguous/);
  expect(()=>calibrationCommand('Set potential: Bob Lim: High: Words',targets,'performance','bu')).toThrow(/axis/);
  expect(()=>calibrationCommand('Set performance: Alice Tan: Excellent: Words',targets,'performance','bu')).toThrow(/configured band/);
  expect(()=>calibrationCommand('Set performance: Alice Tan: ME: ',targets,'performance','hod')).toThrow(/explanation/);
  expect(()=>calibrationCommand('Set performance: Alice Tan: ME',targets,'performance','hod')).toThrow(/explanation/);
 });
 it('does not interpret model payloads, questions or lock requests as human moves and keeps Group read-only',()=>{
  for(const text of ['Lock calibration','Could Alice be AE?','{"action":"move_band","subject":"alice","band":"OU"}'])expect(calibrationCommand(text,targets,'both','bu')).toBeNull();
  expect(()=>calibrationCommand('Set performance: Alice Tan: OU: Words',targets,'performance','group')).toThrow(/read-only/);
  expect(()=>calibrationCommand('Save department performance: Alice Tan: ME: Words',targets,'performance','bg')).toThrow(/department reviewer/);
 });
});
