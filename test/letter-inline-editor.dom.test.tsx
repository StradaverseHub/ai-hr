import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {LetterInlineEditor} from '../components/letters/inline-editor';
afterEach(cleanup);
const fields=new Map([['employee.name','Full name']]);const copy={field:'Insert field',unknown:'Check unknown token:',invalid:'Use plain text only.'};
it('shows the shared protected field atom as a label and serializes inserted fields to their canonical code',async()=>{
 const change=vi.fn();render(<LetterInlineEditor value="Dear {employee.name}" fields={fields} label="Body paragraph" copy={copy} onChange={change}/>);
 const textbox=await screen.findByRole('textbox',{name:'Body paragraph'});fireEvent.focus(textbox);await waitFor(()=>expect(screen.getByRole('textbox',{name:'Body paragraph'})).toHaveAttribute('contenteditable','true'));expect(screen.getByRole('textbox',{name:'Body paragraph'})).toHaveTextContent('Dear {Full name}');expect(screen.getByRole('textbox',{name:'Body paragraph'}).querySelector('[data-letter-field]')).toHaveAttribute('contenteditable','false');
 fireEvent.focus(screen.getByRole('combobox',{name:'Body paragraph: Insert field'}));fireEvent.change(screen.getByRole('combobox',{name:'Body paragraph: Insert field'}),{target:{value:'employee.name'}});
 await waitFor(()=>expect(change).toHaveBeenCalled());expect(change.mock.calls.at(-1)?.[0]).toContain('{employee.name}');expect(change.mock.calls.at(-1)?.[0]).not.toContain('{Full name}');
});
it('preserves unknown tokens visibly and refuses multiline cell paste without changing the saved cell',async()=>{
 const change=vi.fn(),valid=vi.fn();render(<LetterInlineEditor value="{unknown.value}" fields={fields} label="Terms, Row 1" cell copy={copy} onChange={change} onValidityChange={valid}/>);
 expect(screen.getByRole('status')).toHaveTextContent('Check unknown token: {unknown.value}');
 fireEvent.focus(await screen.findByRole('textbox',{name:'Terms, Row 1'}));await waitFor(()=>expect(screen.getByRole('textbox',{name:'Terms, Row 1'})).toHaveAttribute('contenteditable','true'));
 // Editor setup may publish its unchanged canonical value/validity; the refused paste must publish neither.
 const beforeChange=change.mock.calls.length,beforeValidity=valid.mock.calls.length;
 fireEvent.paste(screen.getByRole('textbox',{name:'Terms, Row 1'}),{clipboardData:{getData:()=> 'One\nTwo'}});expect(screen.getByRole('alert')).toHaveTextContent('Use plain text only.');expect(valid).toHaveBeenCalledTimes(beforeValidity);expect(change).toHaveBeenCalledTimes(beforeChange);expect(screen.getByRole('textbox',{name:'Terms, Row 1'})).toHaveTextContent('{unknown.value}');expect(screen.getByRole('textbox',{name:'Terms, Row 1'})).not.toHaveTextContent('One');
});

it('mounts only the focused editor and releases its view when focus leaves the field',async()=>{
 const change=vi.fn();const ui=render(<div>{Array.from({length:57},(_,index)=><LetterInlineEditor key={index} value="Terms" fields={fields} label={`Cell ${index+1}`} copy={copy} onChange={change}/>)}<button>Outside</button></div>);
 expect(ui.container.querySelectorAll('.tiptap')).toHaveLength(0);screen.getByRole('textbox',{name:'Cell 1'}).focus();await waitFor(()=>expect(ui.container.querySelectorAll('.tiptap')).toHaveLength(1));
 screen.getByRole('textbox',{name:'Cell 57'}).focus();await waitFor(()=>{expect(ui.container.querySelectorAll('.tiptap')).toHaveLength(1);expect(screen.getByRole('textbox',{name:'Cell 57'})).toHaveAttribute('contenteditable','true');});
 screen.getByRole('button',{name:'Outside'}).focus();await waitFor(()=>expect(ui.container.querySelectorAll('.tiptap')).toHaveLength(0));
});
