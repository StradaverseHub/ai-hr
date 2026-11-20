import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { messagesForLocale } from '../i18n/catalogs';
import { locales } from '../i18n/config';
import { prepareClientCatalogues } from '../scripts/prepare-client-catalogues';

it('writes exactly one complete canonical message catalogue per browser language', async () => {
  const output = await mkdtemp(join(tmpdir(), 'aihr-test-client-catalogues-'));
  try {
    await prepareClientCatalogues(output);
    expect((await readdir(output)).sort()).toEqual(locales.map(locale => locale + '.json').sort());
    for (const locale of locales) {
      const generated = await readFile(join(output, locale + '.json'), 'utf8');
      expect(generated).toBe(JSON.stringify(await messagesForLocale(locale)));
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
