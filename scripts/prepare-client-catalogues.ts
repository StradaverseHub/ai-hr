import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { messagesForLocale } from '../i18n/catalogs';
import { locales } from '../i18n/config';

export async function prepareClientCatalogues(outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(locales.map(async locale => {
    const content = JSON.stringify(await messagesForLocale(locale));
    const target = join(outputDirectory, locale + '.json');
    const existing = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing === content) return;
    const temporary = target + '.' + process.pid + '.tmp';
    await writeFile(temporary, content);
    await rename(temporary, target);
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareClientCatalogues(join(process.cwd(), 'i18n', 'client-assets')).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
