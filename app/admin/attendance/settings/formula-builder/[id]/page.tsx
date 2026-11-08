import {getTranslations} from 'next-intl/server';
import {notFound} from 'next/navigation';
import {scopedAdmin} from '@/lib/scope';
import {attendanceFormulaSetup,getAttendanceFormula} from '@/packs/attendance/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {AttendanceFormulaEditor} from '../editor';
export default async function AttendanceFormulaPage({params}:{params:Promise<{id:string}>}){const {s,scopeIds}=await scopedAdmin(),{id}=await params;if(!/^[a-f0-9-]{36}$/i.test(id))notFound();const initial=await getAttendanceFormula(s,id);if(!scopeIds.includes(initial.formula.companyId))notFound();const options=await attendanceFormulaSetup(s,scopeIds),t=await getTranslations('attendanceFormula');return <div className={pageWideCls+' space-y-6'}><PageHeader title={initial.formula.code} description={t('subtitle')} back={{href:'/admin/attendance/settings/formula-builder',label:t('title')}}/><AttendanceFormulaEditor initial={initial} options={options} today={todayInKualaLumpur()}/></div>;}
