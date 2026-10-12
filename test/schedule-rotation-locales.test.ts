import { describe,expect,it } from 'vitest';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const placeholders=(value:string)=>[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
describe('rotation controls and explanatory copy are translated in all six locales',()=>{
  for(const [locale,messages] of Object.entries({ms,ta,th,vi,zh})) {
    it(`${locale} has every rotation message, translated with the same placeholders`,()=>{
      const source=en.admin.rotation;
      const translated=messages.admin.rotation;
      expect(Object.keys(translated).sort()).toEqual(Object.keys(source).sort());
      for(const [key,value] of Object.entries(source)){
        const copy=translated[key as keyof typeof translated];
        expect(copy.trim(),`${locale}: ${key}`).not.toBe('');
        expect(copy,`${locale}: ${key} must not remain an English fallback`).not.toBe(value);
        expect(placeholders(copy),`${locale}: ${key}`).toEqual(placeholders(value));
      }
    });
  }
});
