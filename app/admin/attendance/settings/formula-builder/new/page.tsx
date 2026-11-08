import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {attendanceFormulaSetup} from '@/packs/attendance/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {AttendanceFormulaEditor} from '../editor';
export default async function NewAttendanceFormulaPage(){const {s,scopeIds}=await scopedAdmin(),options=await attendanceFormulaSetup(s,scopeIds),t=await getTranslations('attendanceFormula');return <div className={pageWideCls+' space-y-6'}><PageHeader title={t('newFormula')} description={t('subtitle')} back={{href:'/admin/attendance/settings/formula-builder',label:t('title')}}/><AttendanceFormulaEditor initial={null} options={options} today={todayInKualaLumpur()}/></div>;}
