import {describe,expect,it} from 'vitest';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vn from '../messages/vi.json';
import {annualText,instantDateText,formatMyTeamCell,visualStatus,type MyTeamTranslate} from '../components/my-team/presentation';
import {teamDay,teamEmployee,ids} from './fixtures/my-team-ui';
const catalogues={en,ms,zh,ta,th,vi:vn};const layers={roster:true,attendance:true,leave:true};
const options={today:'2026-10-02',view:'week' as const};
const translate=(locale:keyof typeof catalogues):MyTeamTranslate=>createTranslator({locale,messages:catalogues[locale],namespace:'myTeam'});
function leave(session:'full_day'|'AM'|'PM'|'hourly'='full_day',status:'approved'|'pending'='approved'){return {requestId:ids.request,leaveTypeId:ids.leave,code:'AL',name:'Annual',color:'violet',session,status,days:session==='full_day'?1:0.5,fromTime:null,toTime:null};}
describe('My Team presents saved source facts without deriving attendance or leave entitlements',()=>{
 it('formats application instants in KL without changing plain grid calendar dates',()=>{
  expect(instantDateText('2026-10-01T20:30:00Z','en')).toContain('Oct 2');
 });
 it('uses the source status, never lateness inferred from shift or clock comparison',()=>{
  const day=teamDay();day.attendance!.checkInAt='2026-10-02T03:30:00Z';day.attendance!.lateMinutes=0;
  expect(visualStatus(day,options.today)).toBe('present');day.attendance!.flag='late';expect(visualStatus(day,options.today)).toBe('late');
 });
 it('full approved leave outranks a rest day, but half-day leaves retain actual attendance',()=>{
  const day=teamDay();day.roster!.kind='rest';day.roster!.isRestDay=true;day.leave=[leave()];expect(visualStatus(day,options.today)).toBe('approved_leave');
  day.leave=[leave('AM')];expect(visualStatus(day,options.today)).toBe('off');day.roster!.kind='shift';day.roster!.isRestDay=false;day.attendance!.flag='late';expect(visualStatus(day,options.today)).toBe('late');
  const shown=formatMyTeamCell(day,layers,'en',translate('en'),options);expect(shown.primary).toContain('AL ½ AM');expect(shown.secondary).toContain('08:30');
 });
 it('pending leave stays pending and does not erase an absent attendance result',()=>{
  const day=teamDay();day.attendance!.status='absent';day.attendance!.checkInAt=null;day.attendance!.checkOutAt=null;day.leave=[leave('full_day','pending')];
  const shown=formatMyTeamCell(day,layers,'en',translate('en'),options);expect(shown.status).toBe('absent');expect(shown.pending).toBe(true);expect(shown.description).toContain(en.myTeam.status_absent);expect(shown.primary).toContain('pending');
 });
 it('future days do not display absence computed before a scheduled shift occurs',()=>{
  const day=teamDay('2026-10-03');day.attendance!.status='absent';day.attendance!.checkInAt=null;day.attendance!.checkOutAt=null;
  const shown=formatMyTeamCell(day,layers,'en',translate('en'),options);expect(shown.status).toBe('upcoming');expect(shown.primary).toBe('08:30–17:30');expect(shown.description).not.toContain(en.myTeam.status_absent);
 });
 it('explicit OFF differs from a missing or unassigned shift; it never guesses a rest day',()=>{
  const day=teamDay();day.roster!.kind='off';day.roster!.code=null;day.attendance=null;
  expect(formatMyTeamCell(day,layers,'en',translate('en'),{...options,view:'month'})).toMatchObject({status:'off',compact:'·'});
  day.roster!.kind='unassigned';expect(formatMyTeamCell(day,layers,'en',translate('en'),options)).toMatchObject({status:'unavailable',roster:'—'});
 });
 it('out-without-in and in-without-out retain exact recorded clocks and warning status',()=>{
  const day=teamDay();day.attendance!.flag='odd';day.attendance!.checkOutAt=null;
  expect(formatMyTeamCell(day,layers,'en',translate('en'),options).primary).toBe('In 08:30 · no out');day.attendance!.checkOutAt='2026-10-02T09:30:00Z';day.attendance!.checkInAt=null;
  expect(formatMyTeamCell(day,layers,'en',translate('en'),options).primary).toBe('Out 17:30 · no in');
 });
 it('all layers off hides visible/export text while keeping full source status and descriptive detail',()=>{
  const day=teamDay();day.leave=[leave('PM','pending')];day.attendance!.flag='late';
  const shown=formatMyTeamCell(day,{roster:false,attendance:false,leave:false},'en',translate('en'),options);
  expect(shown).toMatchObject({roster:null,primary:null,secondary:null,compact:'',exportText:'',status:'late',pending:true});expect(shown.description).toContain('AL ½ PM');expect(shown.description).toContain('08:30');
 });
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('uses the %s catalogue for odd, pending, half-day and null balance text',locale=>{
  const day=teamDay();day.attendance!.checkOutAt=null;day.leave=[leave('AM','pending')];
  const shown=formatMyTeamCell(day,layers,locale,translate(locale),options);expect(shown.primary).toContain(translate(locale)('session_AM'));expect(shown.secondary).toBe(translate(locale)('inNoOut',{time:'08:30'}));
  const employee=teamEmployee();employee.annualAvailable=null;expect(annualText(employee,translate(locale))).toBe(catalogues[locale].myTeam.annualUnavailable);
  employee.annualAvailable=1.5;employee.balances[0].pending=99;expect(annualText(employee,translate(locale))).toContain('1.5');
 });
 it('all six catalogues contain the same keys and exact ICU placeholders, with no dropped existing My Team control',()=>{
  const expected=Object.keys(en.myTeam).sort();const placeholders=(value:string)=>[...value.matchAll(/\{(\w+)(?:\}|,)/g)].map(match=>match[1]).sort();
  for(const catalogue of Object.values(catalogues)){expect(Object.keys(catalogue.myTeam).sort()).toEqual(expected);for(const key of expected as (keyof typeof en.myTeam)[]){expect(catalogue.myTeam[key].trim().length).toBeGreaterThan(0);expect(placeholders(catalogue.myTeam[key])).toEqual(placeholders(en.myTeam[key]));}}
 });
});
