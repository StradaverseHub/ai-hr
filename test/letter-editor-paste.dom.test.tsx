import {it,expect} from 'vitest';
import {sanitiseLetterPaste} from '../lib/letter-editor-paste';
it('keeps supported formatting and field tokens while removing executable and remote resources from pasted HTML',()=>{
 const result=sanitiseLetterPaste('<p onclick="alert(1)" style="background:url(https://foreign.fixture.test)">Dear <b>employee</b><span data-letter-field="employeeName">name</span><img src="https://foreign.fixture.test/track"><a href="javascript:alert(1)">text</a></p><script>alert(1)</script><svg onload="alert(1)"><image href="https://foreign.fixture.test/x"></image></svg>');
 expect(result).toContain('<b>employee</b>');expect(result).toContain('data-letter-field="employeeName"');expect(result).toContain('text');for(const forbidden of ['onclick','style=','<script','<svg','<img','href=','foreign.fixture.test'])expect(result).not.toContain(forbidden);
});
it('refuses an oversized paste rather than silently truncating it',()=>{expect(()=>sanitiseLetterPaste('a'.repeat(256001))).toThrow('limit: editor.paste');});
