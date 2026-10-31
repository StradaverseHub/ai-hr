'use client';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
export function PrintButton(){const t=useTranslations('jobDescriptions');return <Button onClick={()=>window.print()}>{t('print')}</Button>;}
