import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({get:vi.fn(),set:vi.fn(),revalidate:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:f.get,set:f.set})}));
vi.mock('next/cache',()=>({revalidatePath:f.revalidate}));
import {setLocale} from '../app/i18n-actions';
beforeEach(()=>{vi.clearAllMocks();f.get.mockReturnValue({value:'en'});});
it('persists the requested UI locale without invalidating every page and shared data',async()=>{
 const form=new FormData();form.set('locale','zh');await setLocale(form);
 expect(f.set).toHaveBeenCalledWith('NEXT_LOCALE','zh',{sameSite:'lax',path:'/',maxAge:31536000});
 expect(f.revalidate).not.toHaveBeenCalled();
});
it('does no cookie write or global invalidation when that explicit preference is already selected',async()=>{
 const form=new FormData();form.set('locale','en');await setLocale(form);
 expect(f.set).not.toHaveBeenCalled();expect(f.revalidate).not.toHaveBeenCalled();
});
it('retains the default-language fallback for invalid input',async()=>{
 f.get.mockReturnValue({value:'zh'});const form=new FormData();form.set('locale','invalid');await setLocale(form);
 expect(f.set).toHaveBeenCalledWith('NEXT_LOCALE','en',expect.any(Object));
});
