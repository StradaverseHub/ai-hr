import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {Tp1DeclarationsList,type Tp1DeclarationListRow} from '../components/tp1-declarations-list';
const nav=vi.hoisted(()=>({replace:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>nav,useSearchParams:()=>new URLSearchParams('dPage=1&dSize=25&context=retained')}));
vi.mock('../components/ui-theme-context',()=>({useUiTheme:()=>'atelier'}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('returns from the second TP1 page to matching search results without dropping the independent query context',async()=>{
 const rows:Tp1DeclarationListRow[]=Array.from({length:26},(_,i)=>({id:`fictional-${String(i).padStart(2,'0')}`,assessmentYear:2026,deductionMonth:1,monthLabel:i===0?'January':'February',amount:'0.00',status:'draft',versions:1,lastSaved:'Fictional saved date',href:`?id=fictional-${i}`,readOnly:false,deleteHref:null}));
 render(<NextIntlClientProvider locale="en" messages={en}><Tp1DeclarationsList rows={rows}/></NextIntlClientProvider>);
 expect(screen.queryByText('January')).not.toBeInTheDocument();
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'January'}});
 await waitFor(()=>expect(nav.replace).toHaveBeenCalledWith('?dSize=25&context=retained',{scroll:false}));
});
