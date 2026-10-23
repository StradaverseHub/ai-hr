'use client';

import {useRef,useState,type InputHTMLAttributes,type SelectHTMLAttributes} from 'react';

/** A refused form action must leave the employee's unsaved declaration intact. */
export function Tp3PersonalInput({defaultValue,...props}:Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'defaultValue'> & {defaultValue:string}) {
 const [value,setValue]=useState(defaultValue);
 return <input {...props} value={value} onChange={event=>setValue(event.target.value)}/>;
}

export function Tp3PersonalSelect({defaultValue,...props}:Omit<SelectHTMLAttributes<HTMLSelectElement>,'value'|'onChange'|'defaultValue'> & {defaultValue:string}) {
 const [value,setValue]=useState(defaultValue);
 return <select {...props} value={value} onChange={event=>{
  const selected=event.target.value;
  setValue(selected);
  for(const option of event.target.options)option.defaultSelected=option.value===selected;
 }}/>;
}

export function Tp3PersonalDeclaration({defaultChecked,className}:{defaultChecked:boolean;className?:string}) {
 const [checked,setChecked]=useState(defaultChecked);
 const input=useRef<HTMLInputElement>(null);
 return <input ref={input} type="checkbox" name="declarationAccepted" value="yes" className={className}
  checked={checked} onChange={event=>{
   setChecked(event.target.checked);
   // React's form reset restores checkboxes from the native default; keep it in sync with the tick.
   if(input.current)input.current.defaultChecked=event.target.checked;
  }}/>;
}
