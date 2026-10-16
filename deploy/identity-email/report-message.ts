/** Fixed report attachment copy; exported employee values never become message text. */
const copy={
 en:{subject:'Employee Master report',text:'Your scheduled Employee Master report is attached. It uses the saved as-at date.'},
 ms:{subject:'Laporan Induk Pekerja',text:'Laporan Induk Pekerja berjadual anda dilampirkan. Laporan ini menggunakan tarikh setakat yang disimpan.'},
 zh:{subject:'员工主报表',text:'附件为您的定期员工主报表。报表使用已保存的截至日期。'},
 ta:{subject:'பணியாளர் முதன்மை அறிக்கை',text:'உங்கள் திட்டமிடப்பட்ட பணியாளர் முதன்மை அறிக்கை இணைக்கப்பட்டுள்ளது. இது சேமிக்கப்பட்ட நிலவரத் தேதியைப் பயன்படுத்துகிறது.'},
 th:{subject:'รายงานข้อมูลหลักพนักงาน',text:'แนบรายงานข้อมูลหลักพนักงานตามกำหนดเวลาแล้ว รายงานใช้วันที่ ณ วันที่ที่บันทึกไว้'},
 vi:{subject:'Báo cáo hồ sơ nhân viên',text:'Báo cáo hồ sơ nhân viên theo lịch của bạn được đính kèm. Báo cáo sử dụng ngày chốt đã lưu.'},
} as const;
export function employeeMasterMailMessage(locale:string){return copy[locale as keyof typeof copy]??copy.en;}
