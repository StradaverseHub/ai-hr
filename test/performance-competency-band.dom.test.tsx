import React from 'react';
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {CompetencyBandPreview} from '../app/(app)/performance/onehr/competency-band-preview';
afterEach(cleanup);
it('keeps the employee band while the manager changes their own answers, including a missing answer',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><CompetencyBandPreview statements={[{id:'current',principle:'Service',text:'Deliver',future:false},{id:'next',principle:'Service',text:'Lead',future:true}]} selfAnswers={{current:'yes',next:'yes'}} initialAnswers={{current:'yes',next:'yes'}} policy={{lowMaxPct:40,midMaxPct:26/35*100}} hasFramework><form><select name="answer.next" aria-label="Next level" defaultValue="yes"><option value="">Choose</option><option value="yes">Demonstrate</option><option value="no">Developing</option></select><select name="answer.unassigned" aria-label="Unassigned"><option value="yes">Yes</option><option value="no">No</option></select></form></CompetencyBandPreview></NextIntlClientProvider>);
 expect(screen.getByText(/Employee competency band/).textContent).toContain('High');expect(screen.getByText(/Your review competency band/).textContent).toContain('High');
 fireEvent.change(screen.getByLabelText('Next level'),{target:{value:'no'}});
 expect(screen.getByText(/Your review competency band/).textContent).toContain('Low');expect(screen.getByText(/Employee competency band/).textContent).toContain('High');
 fireEvent.change(screen.getByLabelText('Unassigned'),{target:{value:'no'}});expect(screen.getByText(/Your review competency band/).textContent).toContain('Low');
 fireEvent.change(screen.getByLabelText('Next level'),{target:{value:''}});expect(screen.getByText(/Your review competency band/).textContent).toContain('—');
});
