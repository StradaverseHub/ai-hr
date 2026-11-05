'use client';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
export function PrintRewardRules(){const t=useTranslations('rewardRules');return <Button type="button" variant="outline" className="print:hidden" onClick={()=>window.print()}>{t('print')}</Button>;}
