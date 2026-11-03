/** AI v2 Phase 1, slice 1 (harness spec v17): when the harness offers product_capabilities, decided in code from the
 * person's words (lib/product-context/capability-intent.ts). Expected values are written out by hand: for the 65 scored
 * questions (test/assistant-smart-eval-set.ts), which ones ask what the person can do, how, or to import, set up, add or
 * create something; and twenty hand-written questions per language, ten offered and ten not (facts and status). Tamil and
 * Thai cases are pending native-speaker review, as the patterns are. Pure. */
import {describe,expect,it} from 'vitest';
import {answersNumberedChoice,asksCapability,CAPABILITY_INTENT_REVISION,CHOICE_ANSWER_MAX_CHARS,capabilityOffered} from '../lib/product-context/capability-intent';
import {HARNESS_SPEC} from '../core/harness/spec';
import {SMART_EVAL_SET} from './assistant-smart-eval-set';

/** The scored turns that are offered the catalogue: what can you do, can you or can I, how do I, import, set up, add new. */
const OFFERED=new Set(['emp-howto-1','emp-self-approve-1','emp-what-1','grp-ai-1','grp-import-1','grp-ms-1','hr-import-1','hr-leave-types-1',
 'hr-new-hire-1','hr-payroll-import-1','hr-what-1','hr-zh-1','mgr-ms-1','pay-code-1','pay-import-1','pay-run-1',
 // Merged with slices 2 and 3 (eleven more turns): the two Leave Credit questions ask "can I get …?", and the chat
 // import's first turn is "help me import data", as hr-import-1. The explanations, the approver decisions, the import's
 // second turn and the workforce metrics are facts or a request to act, not offered; so is the letter request (emp-letter-1).
 'emp-toil-1','emp-toil-ask-1','hr-import-file-1']);

describe('the capability offer on the scored questions',()=>{
 const turns=SMART_EVAL_SET.flatMap(conversation=>conversation.turns);
 // AI v2 Phase 2 P2-3 adds emp-before-payroll-1, a status question: not offered.
 it('covers all 67 questions, and the spec records the classifier revision',()=>{
  // AI v2 Phase 2 P2-5 adds emp-handbook-1, a question about the company's own policy: not offered.
  expect(turns).toHaveLength(67);expect(turns.filter(turn=>OFFERED.has(turn.id))).toHaveLength(OFFERED.size);
  expect(HARNESS_SPEC.offer.capabilityIntentRevision).toBe(CAPABILITY_INTENT_REVISION);
 });
 it.each(turns.map(turn=>[turn.id,turn.question,OFFERED.has(turn.id)] as const))('%s',(_id,question,offered)=>{
  expect(asksCapability(question)).toBe(offered);
 });
 it('never offers it for the fact and status questions the v13 to v15 runs called it for',()=>{
  for(const question of ["is this month's payroll done?",'这个月的工资处理好了吗？','我们集团有哪些公司？',"is Nur's leave request ok to approve?",
   'how many employees do we have in each company?','give Aina 2 extra days of annual leave',"what's not set up yet?"])expect(asksCapability(question),question).toBe(false);
 });
});
describe('English',()=>{
 it.each([
  ["can you help me apply for leave?",true],
  ["Can I change my bank details here?",true],
  ["what can you help me with?",true],
  ["how do I submit a claim",true],
  ["how to import leave balances",true],
  ["upload the attendance clockings",true],
  ["I need to set up a payroll cycle",true],
  ["create a new leave type",true],
  ["is it possible to cancel an approved leave?",true],
  ["are you able to prepare overtime requests?",true],
  ["is payroll done for October?",false],
  ["how much leave do I have?",false],
  ["how many employees are in Acme?",false],
  ["what's not set up yet?",false],
  ["is the payroll cycle set up?",false],
  ["when is my next payslip?",false],
  ["who is on leave tomorrow?",false],
  ["what was my net pay last month?",false],
  ["show my pending claims",false],
  ["did the September run close?",false],
 ] as const)('%s',(question,offered)=>{expect(asksCapability(question)).toBe(offered);});
});
describe('Malay',()=>{
 it.each([
  ["Boleh anda import data pekerja?",true],
  ["Bolehkah saya batalkan cuti saya?",true],
  ["Bagaimana saya memohon cuti?",true],
  ["Macam mana nak tukar akaun bank?",true],
  ["Apa yang anda boleh buat untuk saya?",true],
  ["Tolong muat naik fail kehadiran",true],
  ["Sediakan kitaran gaji untuk syarikat",true],
  ["Tambah jenis cuti baharu",true],
  ["Cara untuk import baki cuti",true],
  ["Boleh tolong saya sediakan jenis cuti baharu?",true],
  ["Berapa baki cuti tahunan saya?",false],
  ["Adakah gaji bulan ini sudah siap?",false],
  ["Siapa yang bercuti esok?",false],
  ["Bila cuti umum seterusnya?",false],
  ["Apakah gaji purata syarikat saya?",false],
  ["Berapa ramai pekerja dalam syarikat?",false],
  ["Tunjukkan tuntutan saya yang belum selesai",false],
  ["Slip gaji saya bulan lepas",false],
  ["Status permohonan cuti saya",false],
  ["Cuti sakit saya masih ada berapa hari?",false],
 ] as const)('%s',(question,offered)=>{expect(asksCapability(question)).toBe(offered);});
});
describe('Chinese',()=>{
 it.each([
  ["你能帮我导入员工资料吗？",true],
  ["我可以取消已批准的假期吗？",true],
  ["怎么申请年假？",true],
  ["如何设置假期类型？",true],
  ["你可以做什么？",true],
  ["上传考勤打卡数据",true],
  ["新建一个薪资项目",true],
  ["能不能帮我批量导入假期余额",true],
  ["我能修改银行账户吗？",true],
  ["怎样添加新员工？",true],
  ["这个月的工资处理好了吗？",false],
  ["我还有几天年假？",false],
  ["我们集团有哪些公司？",false],
  ["我的团队有没有待审批的申请？",false],
  ["下一个公共假期是哪天？",false],
  ["帮我请明天的病假",false],
  ["我上个月的实发工资是多少？",false],
  ["谁明天请假？",false],
  ["我的报销申请到哪一步了？",false],
  ["九月的工资单发了吗？",false],
 ] as const)('%s',(question,offered)=>{expect(asksCapability(question)).toBe(offered);});
});
describe('Vietnamese',()=>{
 it.each([
  ["Bạn có thể nhập dữ liệu nhân viên không?",true],
  ["Tôi có thể hủy đơn nghỉ phép không?",true],
  ["Làm sao để xin nghỉ phép?",true],
  ["Cách thiết lập loại nghỉ phép",true],
  ["Bạn giúp được gì cho tôi?",true],
  ["Tải lên dữ liệu chấm công",true],
  ["Tạo mới mã lương phụ cấp đi lại",true],
  ["Xin nghỉ phép như thế nào?",true],
  ["Cài đặt chu kỳ lương cho công ty",true],
  ["Thêm mới một nhân viên",true],
  ["Tôi còn bao nhiêu ngày phép?",false],
  ["Lương tháng này đã xong chưa?",false],
  ["Thu nhập tháng trước của tôi là bao nhiêu?",false],
  ["Ai nghỉ phép ngày mai?",false],
  ["Ngày lễ tiếp theo là khi nào?",false],
  ["Đơn yêu cầu của tôi đã được duyệt chưa?",false],
  ["Phiếu lương tháng chín của tôi",false],
  ["Công ty có bao nhiêu nhân viên?",false],
  ["Số ngày nghỉ ốm còn lại",false],
  ["Yêu cầu tăng ca của tôi đang ở đâu?",false],
 ] as const)('%s',(question,offered)=>{expect(asksCapability(question)).toBe(offered);});
});
describe('Tamil (pending native review)',()=>{
 it.each([
  ["ஊழியர் தரவை இறக்குமதி செய்ய முடியுமா?",true],
  ["விடுப்புக்கு எப்படி விண்ணப்பிப்பது?",true],
  ["நீங்கள் என்ன செய்ய முடியும்?",true],
  ["வருகைத் தரவைப் பதிவேற்றவும்",true],
  ["விடுப்பு வகைகளை அமைக்க உதவுங்கள்",true],
  ["புதிய ஊதியக் குறியீட்டை உருவாக்கவும்",true],
  ["என் விடுப்பை ரத்து செய்ய இயலுமா?",true],
  ["சம்பள சுழற்சியை எவ்வாறு அமைப்பது?",true],
  ["வங்கி விவரங்களை மாற்ற முடியுமா?",true],
  ["புதிதாக சேர் ஊழியர்",true],
  ["என்னிடம் எத்தனை நாள் விடுப்பு உள்ளது?",false],
  ["இந்த மாத சம்பளம் முடிந்ததா?",false],
  ["நாளை யார் விடுப்பில் இருக்கிறார்கள்?",false],
  ["அடுத்த பொது விடுமுறை எப்போது?",false],
  ["என் கடந்த மாத நிகர ஊதியம் என்ன?",false],
  ["என் கோரிக்கை அங்கீகரிக்கப்பட்டதா?",false],
  ["நிறுவனத்தில் எத்தனை ஊழியர்கள்?",false],
  ["என் சம்பளச் சீட்டு",false],
  ["மீதமுள்ள மருத்துவ விடுப்பு",false],
  ["என் கூடுதல் நேர கோரிக்கையின் நிலை",false],
 ] as const)('%s',(question,offered)=>{expect(asksCapability(question)).toBe(offered);});
});
describe('Thai (pending native review)',()=>{
 it.each([
  ["นำเข้าข้อมูลพนักงานได้ไหม",true],
  ["ฉันยกเลิกการลาได้หรือไม่",true],
  ["ลาพักร้อนทำอย่างไร",true],
  ["ช่วยอะไรได้บ้าง",true],
  ["อัปโหลดข้อมูลการลงเวลา",true],
  ["ตั้งค่าประเภทการลา",true],
  ["สร้างรหัสเงินเดือนใหม่",true],
  ["เพิ่มพนักงานใหม่",true],
  ["เปลี่ยนบัญชีธนาคารยังไง",true],
  ["คุณทำอะไรได้บ้าง",true],
  ["ฉันเหลือวันลากี่วัน",false],
  ["เงินเดือนเดือนนี้เสร็จหรือยัง",false],
  ["พรุ่งนี้ใครลาบ้าง",false],
  ["วันหยุดนักขัตฤกษ์ถัดไปคือวันไหน",false],
  ["เงินเดือนสุทธิเดือนที่แล้วของฉันเท่าไร",false],
  ["คำขอของฉันอนุมัติแล้วหรือยัง",false],
  ["บริษัทมีพนักงานกี่คน",false],
  ["สลิปเงินเดือนของฉัน",false],
  ["วันลาป่วยที่เหลือ",false],
  ["สถานะคำขอทำงานล่วงเวลาของฉัน",false],
 ] as const)('%s',(question,offered)=>{expect(asksCapability(question)).toBe(offered);});
});

/** Spec v18, revision 2: an answer to the previous turn's numbered question keeps the catalogue offered. Tamil and Thai
 * cases are pending native-speaker review, as the patterns are. */
describe('a follow-up answer picking a numbered option (revision 2)',()=>{
 it.each([
  ['1','en'],['2.','en'],['3)','en'],['#2','en'],['2, the leave balances','en'],['2 - payroll history','en'],['option 2','en'],['Number 4','en'],
  ['the second one','en'],['Second','en'],['the last option.','en'],['2nd','en'],
  ['pilihan 2','ms'],['yang kedua','ms'],['Ketiga','ms'],
  ['第二个','zh'],['第2个','zh'],['选2','zh'],['2号','zh'],
  ['số 2','vi'],['cái thứ hai','vi'],['thứ nhất','vi'],
  ['இரண்டாவது','ta'],['எண் 3','ta'],
  ['ข้อ 2','th'],['อันแรก','th'],
 ] as const)('%s (%s) picks an option',(question,_locale)=>{expect(answersNumberedChoice(question)).toBe(true);});
 it.each([
  'how much annual leave do I have?','2 days of annual leave next week','10','I want to apply for leave','second thoughts about my request','Siti',
  'Berapa baki cuti saya?','这个月的工资处理好了吗？','',' '.repeat(3),'2, '+'x'.repeat(CHOICE_ANSWER_MAX_CHARS),
 ])('%j is not a pick',question=>{expect(answersNumberedChoice(question)).toBe(false);});
 it('offers the catalogue for a pick only while a question is pending; asksCapability alone decides otherwise',()=>{
  expect(capabilityOffered('2','choice')).toBe(true);expect(capabilityOffered('the second one','leave_type')).toBe(true);
  expect(capabilityOffered('2',null)).toBe(false);expect(capabilityOffered('how much leave do I have?','choice')).toBe(false);
  expect(capabilityOffered('can you import my leave balances?',null)).toBe(true);
  // The scored follow-up turn (hr-import-file-2) is now offered it when the first turn asked its question.
  const followUp=SMART_EVAL_SET.flatMap(conversation=>conversation.turns).find(turn=>turn.id==='hr-import-file-2')!;
  expect(asksCapability(followUp.question)).toBe(false);expect(capabilityOffered(followUp.question,'choice')).toBe(true);
 });
});
