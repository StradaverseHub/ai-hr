import 'server-only';
import en from '@/messages/en.json';
import ms from '@/messages/ms.json';
import zh from '@/messages/zh.json';
import ta from '@/messages/ta.json';
import th from '@/messages/th.json';
import vi from '@/messages/vi.json';
import type {PersonnelLabelResolver} from './personnel-import-contract';
const catalogs:unknown[]=[en,ms,zh,ta,th,vi];
export const personnelImportLabelResolvers:PersonnelLabelResolver[]=catalogs.map(catalog=>(key,fallback)=>{
  let value:unknown=catalog;
  for(const part of key.split('.'))value=value && typeof value==='object' ? (value as Record<string,unknown>)[part] : undefined;
  return typeof value==='string' ? value : fallback;
});
