import {todayInKualaLumpur} from './hr-date';
export type MyTp3JoinDates={joinDate:string|null;hiredOn:string;terminatedOn:string|null;resignationDate:string|null;lastWorkingDate:string|null;blacklistedAt:Date|null};
/** Eligibility describes the product gate; the database rechecks the same dated employment on every write. */
export function myTp3Eligibility(row:MyTp3JoinDates|undefined,today=todayInKualaLumpur()):{eligible:boolean;joinDate:string|null;fallback:boolean;year:number|null} {
  const joinDate=row?.joinDate??row?.hiredOn??null;
  const valid=!!joinDate&&/^\d{4}-\d{2}-\d{2}$/.test(joinDate)&&!Number.isNaN(Date.parse(joinDate+'T00:00:00Z'))&&new Date(joinDate+'T00:00:00Z').toISOString().slice(0,10)===joinDate;
  const year=valid?Number(joinDate.slice(0,4)):null;
  return {eligible:!!row&&joinDate!==null&&valid&&joinDate<=today&&row.hiredOn<=today&&!row.blacklistedAt&&(!row.terminatedOn||row.terminatedOn>=today)&&(!row.resignationDate||row.resignationDate>=today)&&(!row.lastWorkingDate||row.lastWorkingDate>=today)&&year===Number(today.slice(0,4)),joinDate:valid?joinDate:null,fallback:!!row&&!row.joinDate,year};
}
