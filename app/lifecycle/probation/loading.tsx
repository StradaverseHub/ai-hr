import {getTranslations} from 'next-intl/server';
export default async function Loading(){const t=await getTranslations('probation');return <section className="v9-panel" role="status" aria-live="polite">{t('loading')}</section>;}
