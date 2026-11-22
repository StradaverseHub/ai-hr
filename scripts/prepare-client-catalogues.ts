import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AbstractIntlMessages } from 'next-intl';
import { messagesForLocale } from '../i18n/catalogs';
import { locales } from '../i18n/config';

// Shared signed-in controls and error states. Home's server-rendered cards pass their own copy.
const shellClientNamespaces = [
  'accessConfiguration', 'aiAsk.commandBar', 'aiCentre', 'approvalHistory', 'approvals',
  'assistant.fileImport', 'assistant.launcher', 'assistant.workspace.chat',
  'assistant.workspace.claimActions', 'assistant.workspace.decisionActions',
  'assistant.workspace.overtimeActions', 'assistant.workspace.proposal',
  'auth', 'bulkJobs.notification', 'commandBar', 'common', 'components.themeToggle',
  'components.uiTheme', 'delegations', 'employeeHome.greetingNotification', 'letters.notifications',
  'nav', 'notifications', 'onboarding', 'onehr.workspace',
  'operatorWorkspace', 'ownLeaveChange', 'pageStyleRecovery', 'payrollReadiness.reminder',
  'rewardsReviewPlans', 'scheduledActions', 'sessionTimeout', 'topbar',
];

const scopedClientNamespaces = {
  home: shellClientNamespaces,
  tp3: ['myTp3'],
  approvals: [
    'components.plannedAbsences', 'components.timelineNav',
    'labelExcelRoundTrip', 'leave', 'letters.reports', 'replacementRequest.formulaReview',
    'resignationCommunications', 'resignationJourney', 'review',
  ],
  // Dashboard filter and row-menu copy is passed by the server. The confirmation
  // dialog resolves its own copy when an administrator opens a draft action.
  'payroll-dashboard': ['components.confirmSubmit'],
  // The workspace retains the same client catalogue when changing tabs or selecting saved chats.
  // Native review pages under /assistant/* continue to select their own catalogue.
  assistant: [
    'aiAsk', 'assistant', 'chatImport', 'components.confirmSubmit', 'components.drawer',
    'employeeHome.calendar', 'employeeHome.taskNames', 'employeeHome.tasks', 'employeeHome.team',
    'labelExcelRoundTrip', 'letters.reports',
  ],
};

function projectCatalogue(messages: AbstractIntlMessages, namespaces: readonly string[]): AbstractIntlMessages {
  const projected: AbstractIntlMessages = {};
  for (const namespace of namespaces) {
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
  const scopes = Object.entries(scopedClientNamespaces);
  await Promise.all(scopes.map(([scope]) => mkdir(join(outputDirectory, scope), { recursive: true })));
  await Promise.all(locales.map(async locale => {
    const messages = await messagesForLocale(locale);
    const name = locale + '.json';
    await Promise.all([
      writeCatalogue(join(outputDirectory, name), messages),
      ...scopes.map(([scope, namespaces]) =>
        writeCatalogue(join(outputDirectory, scope, name), projectCatalogue(messages, namespaces))),
    ]);
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareClientCatalogues(join(process.cwd(), 'i18n', 'client-assets')).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
