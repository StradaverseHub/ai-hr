/** Issue 10 follow-up — a chat request names one of the caller's own leave types in any of the six product languages
 * (core/proposals/leave-type-match.ts). Each locale's common phrasing maps to the right type, an ambiguous phrasing is
 * unclear (the person is asked), and a type missing from the caller's own menu is never chosen. Pure, fictional. */
import {describe,expect,it} from 'vitest';
import {leaveKindOf,leaveKindOfType,matchLeaveTypeWords,type MatchableLeaveType} from '../core/proposals/leave-type-match';

const type=(id:string,name:string,code:string,role:string|null,names:string[]=[]):MatchableLeaveType=>({id,name,code,role,names:[name,...names]});
/** A fictional tenant: classified types (role), and types only their seeded code or name describes. */
const MENU=[type('annual','Annual Leave','AL','annual'),type('sick','Medical Leave','MC','sick'),type('hospital','Hospitalisation Leave','HOSP','hospitalization'),
 type('emergency','Emergency Leave','EL',null),type('unpaid','Unpaid Leave','NOPAY',null),type('maternity','Maternity Leave','MAT','maternity'),
 type('paternity','Paternity Leave','PAT','paternity'),type('compassionate','Compassionate Leave','COMP',null)];
const picked=(menu:readonly MatchableLeaveType[],words:string)=>{const match=matchLeaveTypeWords(menu,words);return match.kind==='one'?match.type.id:'unclear';};

const PHRASES:Readonly<Record<string,Readonly<Record<string,readonly string[]>>>>={
 en:{annual:['annual leave','vacation','AL'],sick:['sick leave','medical leave','MC'],hospital:['hospitalisation','hospital leave'],emergency:['emergency leave','urgent leave'],
  unpaid:['unpaid leave','no pay leave'],maternity:['maternity leave'],paternity:['paternity leave']},
 ms:{annual:['cuti tahunan'],sick:['cuti sakit','cuti perubatan'],hospital:['cuti masuk wad','cuti sakit hospital'],emergency:['cuti kecemasan'],unpaid:['cuti tanpa gaji'],
  maternity:['cuti bersalin'],paternity:['cuti paterniti','cuti isteri bersalin']},
 zh:{annual:['年假','年休假'],sick:['病假','医疗假'],hospital:['住院假'],emergency:['紧急假'],unpaid:['无薪假','停薪留职'],maternity:['产假'],paternity:['陪产假']},
 vi:{annual:['nghỉ phép năm','phép năm'],sick:['nghỉ ốm','nghỉ bệnh'],hospital:['nằm viện','nhập viện'],emergency:['nghỉ khẩn cấp'],unpaid:['nghỉ không lương'],
  maternity:['nghỉ thai sản'],paternity:['nghỉ khi vợ sinh']},
 ta:{annual:['வருடாந்திர விடுப்பு','ஆண்டு விடுப்பு'],sick:['மருத்துவ விடுப்பு','நோய் விடுப்பு'],hospital:['மருத்துவமனை விடுப்பு'],emergency:['அவசர விடுப்பு'],
  unpaid:['ஊதியமில்லா விடுப்பு'],maternity:['மகப்பேறு விடுப்பு'],paternity:['தந்தைமை விடுப்பு']},
 th:{annual:['ลาพักร้อน','ลาพักผ่อนประจำปี'],sick:['ลาป่วย'],hospital:['ลานอนโรงพยาบาล'],emergency:['ลาฉุกเฉิน'],unpaid:['ลาไม่รับค่าจ้าง'],
  maternity:['ลาคลอด'],paternity:['ลาดูแลภรรยาคลอด']},
};

describe('each locale\'s common phrasing names the right leave type',()=>{
 for(const [locale,kinds] of Object.entries(PHRASES))it(locale,()=>{
  for(const [id,phrases] of Object.entries(kinds))for(const phrase of phrases)expect(picked(MENU,phrase),locale+': '+phrase).toBe(id);
 });
 it('names a type by its own name in any language it carries, or its code',()=>{
  const menu=[...MENU.filter(row=>row.id!=='compassionate'),type('compassionate','Compassionate Leave','COMP',null,['Cuti Ihsan','丧假'])];
  for(const words of ['Compassionate Leave','compassionate','Cuti Ihsan','丧假','COMP'])expect(picked(menu,words),words).toBe('compassionate');
 });
 it('reads a type\'s kind from its role, else its code, else its own names',()=>{
  expect(leaveKindOfType(type('x','Cuti X','ZZ','sick'))).toBe('sick');
  expect(leaveKindOfType(type('x','Cuti X','EMERGENCY',null))).toBe('emergency');
  expect(leaveKindOfType(type('x','Cuti Sakit','ZZ',null))).toBe('sick');
  expect(leaveKindOfType(type('x','Replacement Leave','RL','replacement'))).toBeNull();
  expect(leaveKindOfType(type('x','Study Leave','STUDY',null))).toBeNull();
 });
});

describe('an ambiguous phrasing is unclear, so the person is asked',()=>{
 it.each(['leave','cuti','请假','nghỉ phép','விடுப்பு','ลา','','unpaid medical leave','time off'])('%j',words=>{
  expect(picked(MENU,words)).toBe('unclear');
 });
 it('two of the caller\'s types of one kind are a choice, in every language',()=>{
  const menu=[...MENU,type('sick2','Medical Leave (Outpatient)','MC2','sick')];
  for(const words of ['sick leave','cuti sakit','病假','nghỉ ốm','மருத்துவ விடுப்பு','ลาป่วย'])expect(picked(menu,words),words).toBe('unclear');
 });
 it('names one kind, or none when the words name two unrelated kinds',()=>{
  expect(leaveKindOf('陪产假')).toBe('paternity');expect(leaveKindOf('cuti sakit hospital')).toBe('hospitalization');
  expect(leaveKindOf('unpaid sick leave')).toBeNull();expect(leaveKindOf('annual or medical')).toBeNull();
 });
});

describe('a type the caller may not apply for is never chosen',()=>{
 it('matches only the menu it is given: a type missing from it leaves the request unclear',()=>{
  const menu=MENU.filter(row=>row.id!=='maternity'&&row.id!=='sick');
  for(const words of ['maternity leave','cuti bersalin','产假','nghỉ thai sản','மகப்பேறு விடுப்பு','ลาคลอด','Maternity Leave','MAT'])expect(picked(menu,words),words).toBe('unclear');
  // Medical words do not fall through to another kind of type the caller does have.
  for(const words of ['病假','sick leave','ลาป่วย'])expect(picked(menu,words),words).toBe('unclear');
  const ids=new Set(menu.map(row=>row.id));
  for(const kinds of Object.values(PHRASES))for(const phrases of Object.values(kinds))for(const phrase of phrases){const id=picked(menu,phrase);if(id!=='unclear')expect(ids.has(id),phrase).toBe(true);}
 });
});
