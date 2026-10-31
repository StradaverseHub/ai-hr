import {getTranslations} from 'next-intl/server';
export default async function LoadingAttendanceCalendar() {
 const t=await getTranslations('attendance.myCalendar');return <p role="status" className="p-6 text-sm text-muted-foreground">{t('loading')}</p>;
}
