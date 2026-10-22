/** Editable starter wording, separate from employee records and from language-model output. */
import {DEFAULT_HOME_QUICK_ACTIONS,HOME_TEMPLATE_FIELDS,validateEmployeeHomeConfiguration,type EmployeeHomeConfiguration,type HomeTemplateKey} from './employee-home';
import type {Locale} from '../i18n/config';

const text:Record<Locale,Record<HomeTemplateKey,string>>={
 en:{greetingMorning:'Good morning, {name}.',greetingAfternoon:'Good afternoon, {name}.',greetingEvening:'Good evening, {name}.',
  greetingBirthday:'Happy birthday, {name}!',greetingFirstDay:'Welcome, {name}!',greetingAnniversary:'Happy work anniversary, {name} — {years} years!',greetingReturn:'Welcome back, {name}.',
  tasksPending:'Tasks waiting for you: {count}.',leaveApproved:'Your leave on {dates} is approved.',holidayComing:'{name} is on {date}.',paydayComing:'Scheduled payday: {date}.',payslipReady:'Your payslip for {period} is ready.',calm:'Nothing needs your attention today.'},
 ms:{greetingMorning:'Selamat pagi, {name}.',greetingAfternoon:'Selamat tengah hari, {name}.',greetingEvening:'Selamat petang, {name}.',
  greetingBirthday:'Selamat hari lahir, {name}!',greetingFirstDay:'Selamat datang, {name}!',greetingAnniversary:'Selamat ulang tahun perkhidmatan, {name} — {years} tahun!',greetingReturn:'Selamat kembali, {name}.',
  tasksPending:'Menunggu anda: {count} tugasan.',leaveApproved:'Cuti anda pada {dates} telah diluluskan.',holidayComing:'{name} pada {date}.',paydayComing:'Tarikh gaji yang dijadualkan: {date}.',payslipReady:'Slip gaji anda untuk {period} sudah tersedia.',calm:'Tiada perkara yang memerlukan perhatian anda hari ini.'},
 zh:{greetingMorning:'早上好，{name}。',greetingAfternoon:'下午好，{name}。',greetingEvening:'晚上好，{name}。',
  greetingBirthday:'生日快乐，{name}！',greetingFirstDay:'欢迎，{name}！',greetingAnniversary:'工作周年快乐，{name}——{years} 年！',greetingReturn:'欢迎回来，{name}。',
  tasksPending:'等待您处理的任务：{count} 项。',leaveApproved:'您在 {dates} 的休假已获批准。',holidayComing:'{name}在 {date}。',paydayComing:'计划发薪日：{date}。',payslipReady:'您 {period} 的工资单已可查看。',calm:'今天没有需要您处理的事项。'},
 ta:{greetingMorning:'காலை வணக்கம், {name}.',greetingAfternoon:'மதிய வணக்கம், {name}.',greetingEvening:'மாலை வணக்கம், {name}.',
  greetingBirthday:'பிறந்தநாள் வாழ்த்துகள், {name}!',greetingFirstDay:'வரவேற்கிறோம், {name}!',greetingAnniversary:'பணி ஆண்டு நிறைவு வாழ்த்துகள், {name} — {years} ஆண்டுகள்!',greetingReturn:'மீண்டும் வரவேற்கிறோம், {name}.',
  tasksPending:'உங்களுக்காகக் காத்திருக்கும் பணிகள்: {count}.',leaveApproved:'{dates} அன்று உங்கள் விடுப்பு ஒப்புதல் பெற்றது.',holidayComing:'{date} அன்று {name}.',paydayComing:'திட்டமிடப்பட்ட சம்பள நாள்: {date}.',payslipReady:'{period} மாதத்திற்கான உங்கள் சம்பளச் சீட்டு தயாராக உள்ளது.',calm:'இன்று உங்கள் கவனம் தேவைப்படும் விஷயங்கள் இல்லை.'},
 th:{greetingMorning:'สวัสดีตอนเช้า {name}',greetingAfternoon:'สวัสดีตอนบ่าย {name}',greetingEvening:'สวัสดีตอนเย็น {name}',
  greetingBirthday:'สุขสันต์วันเกิด {name}!',greetingFirstDay:'ยินดีต้อนรับ {name}!',greetingAnniversary:'สุขสันต์วันครบรอบการทำงาน {name} — {years} ปี!',greetingReturn:'ยินดีต้อนรับกลับมา {name}',
  tasksPending:'งานที่รอคุณดำเนินการ: {count} รายการ',leaveApproved:'วันลาของคุณในวันที่ {dates} ได้รับอนุมัติแล้ว',holidayComing:'{name} ตรงกับวันที่ {date}',paydayComing:'กำหนดจ่ายเงินเดือน: {date}',payslipReady:'สลิปเงินเดือนสำหรับ {period} พร้อมให้ดูแล้ว',calm:'วันนี้ไม่มีเรื่องที่ต้องให้คุณดำเนินการ'},
 vi:{greetingMorning:'Chào buổi sáng, {name}.',greetingAfternoon:'Chào buổi chiều, {name}.',greetingEvening:'Chào buổi tối, {name}.',
  greetingBirthday:'Chúc mừng sinh nhật, {name}!',greetingFirstDay:'Chào mừng, {name}!',greetingAnniversary:'Chúc mừng kỷ niệm làm việc, {name} — {years} năm!',greetingReturn:'Chào mừng bạn trở lại, {name}.',
  tasksPending:'Đang chờ bạn: {count} công việc.',leaveApproved:'Ngày nghỉ của bạn vào {dates} đã được duyệt.',holidayComing:'{name} vào ngày {date}.',paydayComing:'Ngày trả lương dự kiến: {date}.',payslipReady:'Phiếu lương cho kỳ {period} của bạn đã sẵn sàng.',calm:'Hôm nay không có việc nào cần bạn xử lý.'},
};
export function defaultEmployeeHomeConfiguration():EmployeeHomeConfiguration{
 const keys=Object.keys(HOME_TEMPLATE_FIELDS) as HomeTemplateKey[];
 return validateEmployeeHomeConfiguration({version:1,templates:keys.map(key=>({version:1,key,enabled:true,priority:100,
  text:Object.fromEntries(Object.entries(text).map(([locale,words])=>[locale,words[key]]))})),
  quickActions:[...DEFAULT_HOME_QUICK_ACTIONS],effortMinutes:{},teamVisibility:'off',celebrations:{enabled:false,scope:'direct'}});
}
