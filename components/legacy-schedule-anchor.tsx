'use client';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {COMPANY_POLICY,WORK_SCHEDULE_OVERTIME,REGISTERED_DEVICES} from '@/app/admin/attendance-policy/schedule-panel';
export function LegacyScheduleAnchor(){
 const router=useRouter();
 useEffect(()=>{
  const targets:Record<string,string>={'#company-policy-settings':COMPANY_POLICY,'#work-schedule-overtime':WORK_SCHEDULE_OVERTIME,'#overtime-rates':WORK_SCHEDULE_OVERTIME,'#backup-shift-coverage':WORK_SCHEDULE_OVERTIME,'#registered-devices':REGISTERED_DEVICES};
  const target=targets[window.location.hash];
  if(target)router.replace(target+window.location.hash);
 },[router]);
 return null;
}
