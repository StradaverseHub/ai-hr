/** Operator-only systemctl behavior; no systemd, processes, installation or database access. */
import {describe,it,expect,vi} from 'vitest';
import {stopInternalReportWorkers} from '../deploy/identity-email/internal-report-stop-workers';
const socket='aihr-report-auth.socket',sender='aihr-internal-report.service',broker='aihr-report-auth@0-4774-997.service';
function fake(states:Record<string,string>){
 return vi.fn((...args:string[])=>{
  if(args[0]==='list-units')return Object.keys(states).map(unit=>unit+' loaded inactive dead').join('\n');
  if(args[0]==='show'){const state=states[args[1]];if(state===undefined)throw new Error('Unknown fixture unit');return state;}
  if(args[0]==='stop'){
   if(args.slice(1).some(unit=>states[unit]?.includes('LoadState=not-found')))throw new Error('Unit not loaded (exit5)');
   return '';
  }
  throw new Error('Unexpected command');
 });
}
const loaded='LoadState=loaded\nActiveState=active\nMainPID=4774';
describe('internal installer owned worker stop',()=>{
 it('stops existing owned workers while ignoring unrelated services',()=>{
  const command=fake({[sender]:loaded,[broker]:loaded,'postgresql.service':loaded,'aihr-report-acceptance.service':loaded});
  stopInternalReportWorkers(command);
  expect(command.mock.calls.filter(args=>args[0]==='stop')).toEqual([['stop',sender,broker]]);
 });
 it.each(['LoadState=not-found\nActiveState=inactive','LoadState=not-found\nActiveState=inactive\nMainPID=0'])('does not issue failing stop for an absent inactive socket (%s)',state=>{
  const command=fake({[socket]:state,[sender]:loaded});
  expect(()=>stopInternalReportWorkers(command)).not.toThrow();
  expect(command.mock.calls.filter(args=>args[0]==='stop')).toEqual([['stop',sender]]);
 });
 it('does not call stop when all three rollback socket entries are confirmed absent',()=>{
  const command=fake(Object.fromEntries(['aihr-report-auth.socket','aihr-internal-report.socket','aihr-report-renderer.socket'].map(unit=>[unit,'LoadState=not-found\nActiveState=inactive'])));
  expect(()=>stopInternalReportWorkers(command)).not.toThrow();expect(command.mock.calls.some(args=>args[0]==='stop')).toBe(false);
 });
 it.each(['LoadState=not-found\nActiveState=active\nMainPID=0','LoadState=not-found\nActiveState=inactive\nMainPID=4774','LoadState=not-found\nActiveState=failed','LoadState=error\nActiveState=inactive','LoadState=not-found\nActiveState=inactive\nMainPID=unknown','LoadState=not-found\nActiveState=inactive\nLoadState=not-found'])('refuses ambiguous absence before stopping any worker (%s)',state=>{
  const command=fake({[sender]:loaded,[socket]:state});expect(()=>stopInternalReportWorkers(command)).toThrow();expect(command.mock.calls.some(args=>args[0]==='stop')).toBe(false);
 });
 it('retains a genuine stop command failure for a loaded owned unit',()=>{
  const command=fake({[sender]:loaded});
  const original=command.getMockImplementation()!;command.mockImplementation((...args)=>{if(args[0]==='stop')throw new Error('Actual stop failed');return original(...args);});
  expect(()=>stopInternalReportWorkers(command)).toThrow('Actual stop failed');
 });
});
