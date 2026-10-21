import * as React from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {EmployeeHomeSurface} from '../components/employee-home/home-surface';
import {defaultEmployeeHomePreferences} from '../lib/employee-home';
import type {EmployeeHomeIdentity} from '../lib/employee-home-read-model';

afterEach(cleanup);
const labels={title:'Home',employment:'Employment',chooseEmployment:'Choose employment',chooseHelp:'Choose an employment to see your Home.',
  showEmployment:'Show Home',noEmployment:'No employment is linked to your account.',companyUnavailable:'Company unavailable',employeeCodeUnavailable:'Employee ID unavailable'};
const identity:EmployeeHomeIdentity={version:1,name:'Fictional Alex',photoHref:null,role:'employee',employmentState:'selected',selectedEmploymentId:'own-one',companyEstablished:true,
  employments:[{employmentId:'own-one',employeeCode:'0007',company:'Fictional One'},{employmentId:'own-two',employeeCode:'0008',company:'Fictional Two'}]};
const cards={summary:<p>Recorded update</p>,today:<p>Your Day</p>,calendar:<p>Calendar</p>,notices:<p>Notices</p>,tasks:<p>Assigned tasks</p>};
const slots=(container:HTMLElement)=>[...container.querySelectorAll('[data-home-slot]')].map(node=>node.getAttribute('data-home-slot'));
describe('Employee Home composition',()=>{
  it('keeps the approved default reading order and accepts cosmetic order only for supplied cards',()=>{
    const preferences=defaultEmployeeHomePreferences();
    const {container,rerender}=render(<EmployeeHomeSurface identity={identity} labels={labels} preferences={preferences} cards={cards}/>);
    expect(slots(container)).toEqual(['summary','today','calendar','notices','tasks']);
    expect(screen.getByText('0007',{exact:false})).toBeInTheDocument();
    rerender(<EmployeeHomeSurface identity={identity} labels={labels} preferences={{...preferences,hiddenCards:['today'],cardOrder:[...preferences.cardOrder].reverse()}} cards={cards}/>);
    expect(slots(container)).toEqual(['tasks','notices','calendar','summary']);
    expect(container.querySelector('[data-home-slot="team"]')).toBeNull();
  });
  it('does not display employment cards or choose a first employer while explicit selection is required',()=>{
    const {container}=render(<EmployeeHomeSurface identity={{...identity,employmentState:'choose',selectedEmploymentId:null}} labels={labels} preferences={null} cards={cards}/>);
    expect(screen.getByRole('combobox',{name:labels.employment})).toHaveValue('');
    expect(slots(container)).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent(labels.chooseHelp);
    const form=container.querySelector('form');expect(form).toHaveAttribute('action','/');expect(form).toHaveAttribute('method','get');
  });
  it('resets an unsaved selector value when navigation changes the authorized employment',()=>{
    const {rerender}=render(<EmployeeHomeSurface identity={identity} labels={labels} preferences={null} cards={cards}/>);
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'own-two'}});
    rerender(<EmployeeHomeSurface identity={{...identity,selectedEmploymentId:'own-two'}} labels={labels} preferences={null} cards={cards}/>);
    rerender(<EmployeeHomeSurface identity={{...identity,selectedEmploymentId:'own-one'}} labels={labels} preferences={null} cards={cards}/>);
    expect(screen.getByRole('combobox')).toHaveValue('own-one');
    expect(screen.getByText('Fictional One',{exact:true})).toBeVisible();
  });
  it('shows a truthful no-employment state without an empty selector or employment content',()=>{
    const {container}=render(<EmployeeHomeSurface identity={{...identity,employmentState:'none',selectedEmploymentId:null,employments:[]}} labels={labels} preferences={null} cards={cards}/>);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();expect(slots(container)).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent(labels.noEmployment);
  });
});
