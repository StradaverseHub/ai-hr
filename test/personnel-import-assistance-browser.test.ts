/** Authored UNRUN. Browser command must never inherit a development fallback identity. */
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({session:vi.fn(),assist:vi.fn()}));
vi.mock('@/lib/session',()=>({getBrowserCommandSession:h.session}));
vi.mock('@/core/personnel-import-assistance',()=>({assistPersonnelImportHeaders:h.assist,PERSONNEL_IMPORT_ASSISTANCE_UNAVAILABLE:'Let’s review those headings again.'}));
import {assistPersonnelImportHeadersAction} from '../app/admin/personnel/import/assistance-actions';
beforeEach(()=>{vi.resetAllMocks();});
it.each(['absent cookie','unknown cookie'])('refuses %s without invoking provider owner or exposing raw auth text',async reason=>{h.session.mockRejectedValue(Error('private '+reason));const result=await assistPersonnelImportHeadersAction({rows:'private'});expect(result).toEqual({kind:'unavailable',message:'Let’s review those headings again.'});expect(h.assist).not.toHaveBeenCalled();});
it('uses the strict browser session and contains owner errors',async()=>{h.session.mockResolvedValue({userId:'actual cookie actor'});h.assist.mockRejectedValue(Error('raw provider key or stack'));expect(await assistPersonnelImportHeadersAction({version:1})).toEqual({kind:'unavailable',message:'Let’s review those headings again.'});expect(h.assist).toHaveBeenCalledWith({userId:'actual cookie actor'},{version:1});});
