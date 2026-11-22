import type { AbstractIntlMessages } from 'next-intl';

/** Route assets add namespaces to the shared shell, including under shared parents. */
export function mergeClientCatalogues(
  shell: AbstractIntlMessages,
  route: AbstractIntlMessages,
): AbstractIntlMessages {
  const messages = { ...shell };
  for (const [key, value] of Object.entries(route)) {
    const existing = messages[key];
    messages[key] = typeof existing === 'object' && typeof value === 'object'
      ? mergeClientCatalogues(existing, value)
      : value;
  }
  return messages;
}
