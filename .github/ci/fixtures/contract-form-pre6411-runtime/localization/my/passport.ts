import { isCalendarDate } from '../../lib/calendar-date';
import { COUNTRY_CODE_OPTIONS } from '../../lib/countries';
import { isMalaysianNationality } from './ic-dob';
export type PassportFieldsMY = {passportNumber?:string|null;passportIssueDate?:string|null;passportExpiryDate?:string|null;passportRemark?:string|null;passportIssuingCountry?:string|null;passportIssuingCountryCode?:string|null};
/** Country-owned completeness and format rules, shared by previews and native writes. */
export function validPassportMY(input:PassportFieldsMY,nationality?:string|null):boolean {
 const number=input.passportNumber?.trim(),issue=input.passportIssueDate?.trim(),expiry=input.passportExpiryDate?.trim();
 if(issue&&!isCalendarDate(issue)||expiry&&!isCalendarDate(expiry)||issue&&expiry&&expiry<issue)return false;
 const code=input.passportIssuingCountryCode?.trim().toUpperCase();
 if(code&&!COUNTRY_CODE_OPTIONS.some(option=>option.value===code))return false;
 const any=[number,issue,expiry,input.passportRemark,input.passportIssuingCountry,input.passportIssuingCountryCode].some(value=>Boolean(value?.trim()));
 if(isMalaysianNationality(nationality))return !any||Boolean(number&&issue&&expiry);
 return Boolean(number);
}
