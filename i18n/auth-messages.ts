import type { AbstractIntlMessages } from 'next-intl';

const authClientNamespaces = [
  'common',
  'internalAuth',
  'loginPresentation',
  'loginTour',
  'mobileSetup',
  'pageStyleRecovery',
] as const;

/** The public shell and its client controls share these namespaces. Server pages resolve their own copy. */
export function authClientMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  return Object.fromEntries(authClientNamespaces.map(namespace => [namespace, messages[namespace]]));
}
