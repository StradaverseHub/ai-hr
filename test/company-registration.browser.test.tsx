/** Real browser/CSS with fictional scoped projections; companion DB tests establish authorization. */
import {afterEach,it,expect} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {page} from 'vitest/browser';
import {CompanyRegistrationPreview} from './fixtures/company-registration-preview';
import '../app/globals.css';
import '../app/atelier.css';
afterEach(cleanup);
it('keeps the registration number adjacent to a readable status and a direct Complete action on desktop and mobile',async()=>{
 const oldTheme=document.documentElement.getAttribute('data-ui-theme');document.documentElement.setAttribute('data-ui-theme','atelier');try{
 for(const width of [1280,390]){await page.viewport(width,900);const result=render(<CompanyRegistrationPreview/>);
  expect(screen.getByText('Missing')).toBeVisible();expect(screen.getByText('Not required')).toBeVisible();const complete=screen.getByRole('link',{name:'Complete'});expect(complete).toHaveAttribute('href','/admin/organization/demo-a?tab=statutory');complete.focus();expect(document.activeElement).toBe(complete);const main=document.querySelector('main')!;expect(main.getBoundingClientRect().width).toBeLessThanOrEqual(width);const image=await page.screenshot({element:main,path:`../.vitest-attachments/company-registration-${width}.png`,animations:'disabled',base64:true,scale:'css'});console.info('COMPANY_REGISTRATION_SCREENSHOT '+JSON.stringify({width,source:'fictional-scoped-projection',base64:image.base64}));result.unmount();
 }
 }finally{if(oldTheme===null)document.documentElement.removeAttribute('data-ui-theme');else document.documentElement.setAttribute('data-ui-theme',oldTheme);}
});
