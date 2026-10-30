import { expect, it } from 'vitest';
import { v9AddressRole, v9LiteralAddress } from '../lib/lifecycle-v9-recipient';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
it('accepts a plain explicit mailbox and rejects names, lists, headers and malformed addresses', () => {
  expect(v9AddressRole(' team+hr@fictional.invalid ')).toBe('address:team+hr@fictional.invalid');
  expect(v9LiteralAddress('address:team+hr@fictional.invalid')).toBe('team+hr@fictional.invalid');
  for (const value of ['Name <team@fictional.invalid>','one@fictional.invalid,two@fictional.invalid','one@fictional.invalid\r\nBcc: two@fictional.invalid','a..b@fictional.invalid','not an address','x'.repeat(255)+'@fictional.invalid']) expect(v9AddressRole(value)).toBeNull();
  expect(v9LiteralAddress('person:team@fictional.invalid')).toBeNull();
});
it('uses explicit destination keys in the same validated role slots as account references', () => {
  const config = v9Defaults(); config.emails[0].cc.push('address:archive@fictional.invalid');
  expect(parseV9Config(config).emails[0].cc).toContain('address:archive@fictional.invalid');
  config.emails[0].cc.push('address:Invalid <archive@fictional.invalid>');
  expect(() => parseV9Config(config)).toThrow();
});
