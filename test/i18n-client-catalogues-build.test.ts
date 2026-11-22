import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { messagesForLocale } from '../i18n/catalogs';
import { locales } from '../i18n/config';
import { prepareClientCatalogues } from '../scripts/prepare-client-catalogues';

it('writes the canonical catalogue and smaller signed-in route catalogues for every browser language', async () => {
  const output = await mkdtemp(join(tmpdir(), 'aihr-test-client-catalogues-'));
  try {
    await prepareClientCatalogues(output);
    const localeFiles = locales.map(locale => locale + '.json').sort();
    expect((await readdir(output)).sort()).toEqual([...localeFiles, 'home', 'tp3'].sort());
    expect((await readdir(join(output, 'home'))).sort()).toEqual(localeFiles);
    expect((await readdir(join(output, 'tp3'))).sort()).toEqual(localeFiles);
    for (const locale of locales) {
      const generated = await readFile(join(output, locale + '.json'), 'utf8');
      const canonical = await messagesForLocale(locale);
      expect(generated).toBe(JSON.stringify(canonical));
      const tp3 = await readFile(join(output, 'tp3', locale + '.json'), 'utf8');
      const projected = JSON.parse(tp3);
      expect(projected.nav).toEqual(canonical.nav);
      expect(projected.assistant.launcher).toEqual(canonical.assistant.launcher);
      expect(projected.payroll).toBeUndefined();
      expect(Buffer.byteLength(tp3)).toBeLessThan(Buffer.byteLength(generated) / 4);
      const home = await readFile(join(output, 'home', locale + '.json'), 'utf8');
      const { myTp3, ...shared } = projected;
      expect(myTp3).toEqual(canonical.myTp3);
      expect(JSON.parse(home)).toEqual(shared);
      expect(shared.common.actionFeedback).toEqual(canonical.common.actionFeedback);
      expect(Buffer.byteLength(home)).toBeLessThan(Buffer.byteLength(generated) / 4);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
