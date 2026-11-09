import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {attendanceFormulaSetup} from '@/packs/attendance/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {AttendanceFormulaEditor} from '../editor';
export default async function NewAttendanceFormulaPage({searchParams}:{searchParams:Promise<{reference?:string|string[]}>}){const {s,scopeIds}=await scopedAdmin(),options=await attendanceFormulaSetup(s,scopeIds),t=await getTranslations('attendanceFormula'),{reference}=await searchParams;const referenceKey=typeof reference==='string'?reference:undefined;return <div className={pageWideCls+' space-y-6'}><PageHeader title={t('newFormula')} description={t('subtitle')} back={{href:'/admin/attendance/settings/formula-builder',label:t('title')}}/><AttendanceFormulaEditor key={referenceKey??'new'} referenceKey={referenceKey} initial={null} options={options} today={todayInKualaLumpur()}/></div>;}
