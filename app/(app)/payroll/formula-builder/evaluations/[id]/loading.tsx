import {getTranslations} from 'next-intl/server';
export default async function Loading(){const t=await getTranslations('payFormula');return <p role="status" className="p-6 text-sm text-muted-foreground">{t('traceLoading')}</p>;}
