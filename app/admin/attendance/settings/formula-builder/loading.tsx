import {getTranslations} from 'next-intl/server';
import {pageWideCls} from '@/components/ui';
export default async function Loading(){const t=await getTranslations('attendanceFormula');return <div className={pageWideCls} role="status" aria-busy="true">{t('loading')}</div>;}
