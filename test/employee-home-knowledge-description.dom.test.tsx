import * as React from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import KnowledgeDescription from '../components/employee-home/knowledge-description';

afterEach(cleanup);
describe('Home authored search description display',()=>{
  it('shows authored text without activating external links, images or raw HTML',()=>{
    const {container}=render(<KnowledgeDescription markdown={'**Recorded** [policy guide](https://fictional.invalid/tracker)\n\n![tracking image](https://fictional.invalid/image)\n\n<script>privateScript()</script>\n\n<img src="https://fictional.invalid/raw" onerror="privateScript()" />'}/>);
    expect(screen.getByText('Recorded')).toBeVisible();expect(screen.getByText('policy guide',{exact:false})).toBeVisible();
    expect(container.querySelector('a,img,iframe,script')).toBeNull();expect(container.textContent).not.toContain('privateScript');
    expect(container.innerHTML).not.toContain('fictional.invalid');
  });
});
