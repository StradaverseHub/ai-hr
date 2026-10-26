'use client';
import { useTranslations } from 'next-intl';
import { useDatabaseErrorText } from './database-error-text';
import { nricPolicyMessage } from '../lib/nric-policy-message';
/** Shared by preview, commit results and downloaded row errors. */
export function useNricPolicyMessage() {
  const t = useTranslations('peopleGeneral');
  const databaseText = useDatabaseErrorText();
  return (message: string) => databaseText(nricPolicyMessage(message, key => t(key)));
}
