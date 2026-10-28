import {appOrigin} from './real-auth';
import {LETTER_LANGUAGES} from './letter-model';

/** This is the sole anonymous surface; no prefix-wide bypass and no letter identifiers. */
export const isLetterVerificationRoute=(path:string)=>/^\/letters\/verify\/[A-Za-z0-9_-]{43}$/.test(path);
export function letterVerificationUrl(token:string,language:typeof LETTER_LANGUAGES[number]){
 if(!/^[A-Za-z0-9_-]{43}$/.test(token)||!LETTER_LANGUAGES.includes(language))throw new Error('Invalid verification token');
 const configured=appOrigin();if(!configured)throw new Error('Letter verification requires a configured public origin');
 const origin=new URL(configured);if(origin.protocol!=='https:'||origin.username||origin.password)throw new Error('Letter verification requires HTTPS');
 return `${origin.origin}/letters/verify/${token}?lang=${language}`;
}
export const letterVerificationWords={
 en:{title:'Letter verification',valid:'Valid',invalid:'Invalid',unavailable:'Verification unavailable',limited:'Too many verification requests. Try again shortly.',caption:'Scan to check the current letter record status'},
 ms:{title:'Pengesahan surat',valid:'Sah',invalid:'Tidak sah',unavailable:'Pengesahan tidak tersedia',limited:'Terlalu banyak permintaan pengesahan. Cuba sebentar lagi.',caption:'Imbas untuk menyemak status semasa rekod surat'},
 zh:{title:'信函验证',valid:'有效',invalid:'无效',unavailable:'暂时无法验证',limited:'验证请求过多，请稍后重试。',caption:'扫描以查询信函记录的当前状态'},
 ta:{title:'கடித சரிபார்ப்பு',valid:'செல்லுபடியாகும்',invalid:'செல்லுபடியாகாது',unavailable:'சரிபார்ப்பு கிடைக்கவில்லை',limited:'அதிக சரிபார்ப்பு கோரிக்கைகள். சிறிது நேரம் கழித்து முயற்சிக்கவும்.',caption:'கடிதப் பதிவின் தற்போதைய நிலையைச் சரிபார்க்க ஸ்கேன் செய்யவும்'},
 th:{title:'ตรวจสอบจดหมาย',valid:'ใช้ได้',invalid:'ใช้ไม่ได้',unavailable:'ไม่สามารถตรวจสอบได้',limited:'คำขอตรวจสอบมากเกินไป โปรดลองอีกครั้งในภายหลัง',caption:'สแกนเพื่อตรวจสอบสถานะปัจจุบันของระเบียนจดหมาย'},
 vi:{title:'Xác minh thư',valid:'Hợp lệ',invalid:'Không hợp lệ',unavailable:'Không thể xác minh',limited:'Quá nhiều yêu cầu xác minh. Vui lòng thử lại sau.',caption:'Quét để kiểm tra trạng thái hiện tại của hồ sơ thư'},
} as const;
