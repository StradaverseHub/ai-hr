import {appLocale} from './i18n';
const keys=['before','after','lastDay','consequence','acknowledge','version','sender','published','done'] as const;
const rows={
 en:['Current','Proposed','Last working day','Accepting this resignation ends employment on the requested last working day. The existing annual-leave settlement policy is applied.','Acknowledge receipt','Content version','Published by','Published','Your action was recorded.'],
 ms:['Semasa','Dicadangkan','Hari bekerja terakhir','Menerima peletakan jawatan ini menamatkan pekerjaan pada hari bekerja terakhir yang diminta. Polisi penyelesaian cuti tahunan sedia ada digunakan.','Akui penerimaan','Versi kandungan','Diterbitkan oleh','Diterbitkan','Tindakan anda direkodkan.'],
 zh:['当前','拟议','最后工作日','接受此辞职将于申请的最后工作日终止雇佣关系，并应用现有年假结算政策。','确认收到','内容版本','发布者','已发布','您的操作已记录。'],
 ta:['தற்போதையது','முன்மொழியப்பட்டது','கடைசி வேலை நாள்','இந்த ராஜினாமாவை ஏற்றால் கோரிய கடைசி வேலை நாளில் வேலை உறவு முடியும். தற்போதைய ஆண்டு விடுப்பு தீர்வுக் கொள்கை பொருந்தும்.','பெறுதலை உறுதிசெய்','உள்ளடக்கப் பதிப்பு','வெளியிட்டவர்','வெளியிடப்பட்டது','உங்கள் செயல் பதிவானது.'],
 th:['ปัจจุบัน','เสนอ','วันทำงานสุดท้าย','การยอมรับการลาออกนี้จะยุติการจ้างงานในวันทำงานสุดท้ายที่ร้องขอ และใช้นโยบายชำระวันลาประจำปีที่มีอยู่','รับทราบการได้รับ','เวอร์ชันเนื้อหา','เผยแพร่โดย','เผยแพร่','บันทึกการดำเนินการแล้ว'],
 vi:['Hiện tại','Đề xuất','Ngày làm việc cuối cùng','Chấp nhận đơn này sẽ chấm dứt việc làm vào ngày làm việc cuối cùng được yêu cầu. Chính sách thanh toán phép năm hiện có được áp dụng.','Xác nhận đã nhận','Phiên bản nội dung','Người đăng','Đã đăng','Đã ghi nhận thao tác của bạn.'],
};
export const requestCopy=()=>Object.fromEntries(keys.map((key,i)=>[key,rows[appLocale()][i]])) as Record<typeof keys[number],string>;
