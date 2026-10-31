/** Authored UNRUN. Browser command must never inherit a development fallback identity. */
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({session:vi.fn(),assist:vi.fn(),prepare:vi.fn(),reopen:vi.fn()}));
vi.mock('@/lib/session',()=>({getBrowserCommandSession:h.session}));
vi.mock('@/core/personnel-import-assistance',()=>({assistPersonnelImportHeaders:h.assist,preparePersonnelImportHeaders:h.prepare,reopenPersonnelImportHeaders:h.reopen,PERSONNEL_IMPORT_ASSISTANCE_UNAVAILABLE:'Let’s review those headings again.'}));
import {assistPersonnelImportHeadersAction,preparePersonnelImportHeadersAction,reopenPersonnelImportHeadersAction} from '../app/(app)/admin/personnel/import/assistance-actions';
beforeEach(()=>{vi.resetAllMocks();});
it.each(['absent cookie','unknown cookie'])('refuses %s without invoking provider owner or exposing raw auth text',async reason=>{h.session.mockRejectedValue(Error('private '+reason));for(const action of [assistPersonnelImportHeadersAction,preparePersonnelImportHeadersAction,reopenPersonnelImportHeadersAction]){const result=await action({rows:'private'});expect(result).toEqual({kind:'unavailable',message:'Let’s review those headings again.'});expect(h.assist).not.toHaveBeenCalled();expect(h.prepare).not.toHaveBeenCalled();expect(h.reopen).not.toHaveBeenCalled();}});
it('uses the strict browser session and contains owner errors',async()=>{h.session.mockResolvedValue({userId:'actual cookie actor'});h.assist.mockRejectedValue(Error('raw provider key or stack'));expect(await assistPersonnelImportHeadersAction({version:1})).toEqual({kind:'unavailable',message:'Let’s review those headings again.'});expect(h.assist).toHaveBeenCalledWith({userId:'actual cookie actor'},{version:1});});
