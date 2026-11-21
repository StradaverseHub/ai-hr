'use client';
import {useTranslations} from 'next-intl';
export function SystemLabelScope({ids}:{ids?:readonly string[]|null}){
  const t=useTranslations('systemLabelExchange');
  return <span className="text-xs text-muted-foreground">{ids==null?t('global'):t('companies',{count:ids.length})}</span>;
}
