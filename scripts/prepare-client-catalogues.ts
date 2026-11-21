import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AbstractIntlMessages } from 'next-intl';
import { messagesForLocale } from '../i18n/catalogs';
import { locales } from '../i18n/config';

// Browser module references from the signed-in shell and personal TP3. Include
// the common error states and the shell controls that can open from this route.
const tp3ClientNamespaces = [
  'accessConfiguration', 'aiAsk.commandBar', 'aiCentre', 'approvalHistory', 'approvals',
  'assistant.fileImport', 'assistant.launcher', 'assistant.workspace.chat',
  'assistant.workspace.claimActions', 'assistant.workspace.decisionActions',
  'assistant.workspace.overtimeActions', 'assistant.workspace.proposal',
  'auth', 'bulkJobs.notification', 'commandBar', 'common', 'components.themeToggle',
  'components.uiTheme', 'delegations', 'employeeHome.greetingNotification', 'letters.notifications',
  'myTp3', 'nav', 'notifications', 'onboarding', 'onehr.workspace',
  'operatorWorkspace', 'ownLeaveChange', 'pageStyleRecovery', 'payrollReadiness.reminder',
  'rewardsReviewPlans', 'scheduledActions', 'sessionTimeout', 'topbar',
];

function tp3Catalogue(messages: AbstractIntlMessages): AbstractIntlMessages {
  const projected: AbstractIntlMessages = {};
  for (const namespace of tp3ClientNamespaces) {
    const keys = namespace.split('.');
    let source = messages;
    let target = projected;
    for (const key of keys.slice(0, -1)) {
      const child = source[key];
      if (!child || typeof child === 'string') throw new Error('Unknown message namespace ' + namespace);
      source = child;
      const branch = target[key] ??= {};
      if (typeof branch === 'string') throw new Error('Invalid message namespace ' + namespace);
      target = branch;
    }
    const key = keys[keys.length - 1];
    const subtree = source[key];
    if (!subtree || typeof subtree === 'string') throw new Error('Unknown message namespace ' + namespace);
    target[key] = subtree;
  }
  return projected;
}

async function writeCatalogue(target: string, messages: AbstractIntlMessages) {
  const content = JSON.stringify(messages);
  const existing = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing === content) return;
  const temporary = target + '.' + process.pid + '.tmp';
  await writeFile(temporary, content);
  await rename(temporary, target);
}

export async function prepareClientCatalogues(outputDirectory: string) {
  const tp3Directory = join(outputDirectory, 'tp3');
  await mkdir(tp3Directory, { recursive: true });
  await Promise.all(locales.map(async locale => {
    const messages = await messagesForLocale(locale);
    const name = locale + '.json';
    await Promise.all([
      writeCatalogue(join(outputDirectory, name), messages),
      writeCatalogue(join(tp3Directory, name), tp3Catalogue(messages)),
    ]);
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareClientCatalogues(join(process.cwd(), 'i18n', 'client-assets')).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
