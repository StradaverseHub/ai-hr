/** AI v2 Phase 2, P2-6 — which turns are gaps, and which intent each belongs to. Pure: no database, no clock, no model.
 *
 * A GAP is a turn AI Centre could not answer or do (core/learning/types.ts GapKind):
 *  - not_supported: the reply was an honest gap on a turn whose words asked what the person can do, or whether they can do
 *    something (the harness offered the capability catalogue, lib/product-context/capability-intent.ts);
 *  - no_route: the person asked for something to be done, suggest_action found nothing to prepare (no_match or
 *    not_available), and the turn ended without a card, a suggestion, an answer or a question back;
 *  - cannot_answer: any other honest gap.
 * A gated turn (a sensitive topic, a crisis, a workplace-harms or rule-override refusal) is never a gap: it stores no words,
 * so nothing is learned from it. The fixed fallback reply is a harness defect, not a missing capability, and is left out.
 *
 * THE INTENT is `<kind>:<area>`, from closed vocabularies only. The area is the product area (CAPABILITY_AREAS) the words
 * name, by the deterministic lexicon below; else the area of the private reads the turn made; else `general`. The words
 * are matched here and never stored by this function. English, Malay, Chinese and Vietnamese terms; Tamil and Thai terms
 * are PENDING NATIVE-SPEAKER REVIEW: a floor, not a reviewed list. */
import type {GapKind} from './types';

export type GapTurn=Readonly<{mode:string|null;sensitive:boolean;refused:boolean;crisis?:boolean;fallback:boolean;
 /** The tools the turn was offered (the trace's `offered`). */
 offered:readonly string[];
 /** The tool calls as the trace recorded them. */
 calls:readonly Readonly<{tool:string;status:string;refusal?:string}>[];
 /** A card was prepared or a suggestion offered. */
 suggested:boolean}>;

const NO_ROUTE_REFUSALS=new Set(['no_match','not_available']);
/** Modes in which the reply itself did the work: an answer, a question back, small talk. */
const ANSWERED_MODES=new Set(['answer','clarify','social','propose']);

export function gapKindOf(turn:GapTurn):GapKind|null{
 if(turn.sensitive||turn.refused||turn.crisis||turn.fallback)return null;
 const refusedRoute=turn.calls.some(call=>call.tool==='suggest_action'&&call.status==='refused'&&NO_ROUTE_REFUSALS.has(call.refusal??''));
 const noRoute=refusedRoute&&!turn.suggested&&!ANSWERED_MODES.has(turn.mode??'');
 if(turn.mode==='honest_gap')return turn.offered.includes('product_capabilities')?'not_supported':noRoute?'no_route':'cannot_answer';
 return noRoute?'no_route':null;
}

/** The product areas the lexicon recognises, most specific first. Each term is matched case-insensitively: as a word in
 * Latin scripts, as text in Chinese, Tamil and Thai. */
export const AREA_LEXICON:readonly (readonly [string,readonly string[]])[]=Object.freeze([
 ['claims',['claim','claims','expense','expenses','reimburse','reimbursement','receipt','mileage','tuntutan','resit','报销','报账','发票','hoàn ứng','chi phí','hóa đơn',
  // PENDING NATIVE-SPEAKER REVIEW (ta, th)
  'கோரிக்கை','செலவு','เบิก','ใบเสร็จ']],
 ['leave',['leave','mc','medical certificate','annual leave','sick leave','time off','holiday','holidays','cuti','请假','假期','年假','病假','休假','nghỉ phép','ngày phép','nghỉ ốm',
  // Not a bare 'ลา': it is also inside 'เวลา' (time).
  'விடுப்பு','การลา','วันลา','ลาป่วย','ลาพักร้อน','ขอลา','วันหยุด']],
 ['attendance',['attendance','clock in','clock out','clock-in','clock-out','clocking','punch','timesheet','overtime','ot','roster','shift','late','kehadiran','lebih masa','syif',
  '考勤','打卡','加班','排班','chấm công','tăng ca','ca làm','வருகை','கூடுதல் நேரம்','เข้างาน','ลงเวลา','ล่วงเวลา']],
 ['payroll',['payroll','payslip','payslips','pay slip','salary','bonus','epf','socso','eis','pcb','tax','ea form','kwsp','perkeso','gaji','slip gaji','cukai',
  '工资','薪水','薪资','工资单','公积金','lương','bảng lương','thuế','சம்பளம்','เงินเดือน','ภาษี','สลิปเงินเดือน']],
 ['lifecycle',['onboarding','offboarding','probation','confirmation','exit interview','percubaan','试用期','入职手续','thử việc','ทดลองงาน']],
 ['performance',['performance','appraisal','kpi','goal','goals','okr','prestasi','penilaian','绩效','考核','đánh giá','hiệu suất','செயல்திறன்','ประเมินผล']],
 ['rewards',['reward','rewards','recognition','ganjaran','奖励','khen thưởng','รางวัล']],
 ['approvals',['approve','approval','approvals','reject','lulus','kelulusan','审批','批准','phê duyệt','ஒப்புதல்','อนุมัติ']],
 ['reports',['report','reports','export','analytics','dashboard','headcount','turnover','laporan','报表','报告','báo cáo','அறிக்கை','รายงาน']],
 ['knowledge',['policy','policies','handbook','guide','faq','polisi','制度','手册','chính sách','கொள்கை','นโยบาย']],
 ['security',['access','permission','permissions','role','password','login','kebenaran','kata laluan','权限','密码','quyền','mật khẩu','அனுமதி','สิทธิ์','รหัสผ่าน']],
 ['notifications',['notification','notifications','reminder','reminders','pemberitahuan','peringatan','通知','提醒','thông báo','அறிவிப்பு','แจ้งเตือน']],
 ['organisation',['department','org chart','organisation chart','organization chart','position','reporting line','jabatan','部门','组织架构','phòng ban','துறை','แผนก']],
 ['people',['employee record','profile','address','bank account','new hire','hire','contract','resign','resignation','termination','personnel','alamat','akaun bank',
  '员工','入职','离职','地址','nhân viên','hồ sơ','địa chỉ','ஊழியர்','พนักงาน','ที่อยู่']],
]);
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const LATIN=/^[\p{Script=Latin}\p{M} .'-]+$/u;
const MATCHERS:readonly (readonly [string,RegExp])[]=AREA_LEXICON.map(([area,terms])=>[area,new RegExp(terms.map(term=>{
 const source=escape(term.normalize('NFKC').toLowerCase());
 return LATIN.test(term)?`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`:source;
}).join('|'),'u')] as const);

/** The product area the words name, or null. */
export function areaOfWords(words:string):string|null{
 const text=String(words??'').normalize('NFKC').toLowerCase();
 return MATCHERS.find(([,pattern])=>pattern.test(text))?.[0]??null;
}

/** The intent: the words' area, else the first area among the turn's private reads, else `general`. */
export function intentOf(kind:GapKind,words:string,readAreas:readonly string[]):Readonly<{area:string;intentKey:string}>{
 const area=areaOfWords(words)??readAreas.find(item=>/^[a-z_]{1,40}$/.test(item)&&item!=='general')??'general';
 return Object.freeze({area,intentKey:`${kind}:${area}`});
}

/** The ConversationTurn fields gap capture reads (core/teras-wiring/turn.ts), mapped without importing the wiring. A field
 * the turn does not carry reads as empty, so a turn that cannot be classified is simply not a gap. */
export function gapTurnOf(turn:Readonly<{mode?:string|null;sensitive?:boolean;refused?:boolean;crisis?:boolean;fallback?:boolean;suggestion?:unknown;proposals?:readonly unknown[];
 trace?:Readonly<{offered?:readonly string[];calls?:readonly Readonly<{tool:string;status:string;refusal?:string}>[]}>|null}>):GapTurn{
 const trace=turn.trace??{};
 return Object.freeze({mode:typeof turn.mode==='string'?turn.mode:null,sensitive:turn.sensitive!==false,refused:turn.refused===true,crisis:turn.crisis===true,
  fallback:turn.fallback===true,offered:Array.isArray(trace.offered)?[...trace.offered]:[],
  calls:Array.isArray(trace.calls)?trace.calls.map(call=>({tool:String(call.tool),status:String(call.status),...(typeof call.refusal==='string'?{refusal:call.refusal}:{})})):[],
  suggested:Boolean(turn.suggestion)||(Array.isArray(turn.proposals)&&turn.proposals.length>0)});
}
