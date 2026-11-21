import { describe, expect, it } from 'vitest';
import { cleanEmailPaste } from '../components/email-body-editor/paste-clean';

const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{mso-style-parent:"";font-family:Calibri}</style><!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]--></head>
<body lang="EN-GB" style="tab-interval:36.0pt">
<p class="MsoNormal" style="margin:0cm;font-size:11.0pt;font-family:'Calibri',sans-serif;color:#1F3864;text-align:justify;mso-highlight:yellow"><b><span style="font-size:14.0pt;mso-bidi-font-weight:normal">Welcome</span></b> to <i>Northwind</i> <u>Fixture</u><o:p></o:p></p>
<p class="MsoNormal" style="background:yellow"><span style="font-family:Wingdings;color:red">Line one<br>Line two</span></p>
<p class="MsoListParagraphCxSpFirst" style="mso-list:l0 level1 lfo1"><![if !supportLists]><span style="font-family:Symbol;mso-list:Ignore">·<span style="font:7.0pt">&nbsp;&nbsp;</span></span><![endif]>Laptop</p>
<p class="MsoListParagraphCxSpLast" style="mso-list:l0 level1 lfo1"><![if !supportLists]><span style="mso-list:Ignore">·</span><![endif]>Badge</p>
<p class="MsoListParagraphCxSpFirst" style="mso-list:l1 level1 lfo2"><![if !supportLists]><span style="mso-list:Ignore">1.<span>&nbsp;</span></span><![endif]>First step</p>
<p><a href="https://portal.example.test/start" style="color:blue" class="x" target="_self">Portal</a> <a href="javascript:alert(1)">bad</a> <a href="mailto:hr@example.test">mail</a> <a href="file:///c:/secret.docx">file</a></p>
<p><img src="file:///C:/Users/fixture/image001.png" width="300"><v:shape><v:imagedata src="image001.png"></v:imagedata></v:shape><img src="https://tracker.example.test/p.gif"></p>
<script>alert(1)</script><p onclick="alert(1)">Clicked</p>
</body></html>`;

describe('cleanEmailPaste', () => {
  it('keeps structure and basic formatting from Word and drops Word markup, styles, scripts and pasted images', () => {
    const result = cleanEmailPaste(word);
    const html = result.html;
    expect(html).toContain('<b>Welcome</b> to <i>Northwind</i> <u>Fixture</u>');
    expect(html).toContain('Line one<br>Line two');
    expect(html).toContain('<ul><li><p>Laptop</p></li><li><p>Badge</p></li></ul>');
    expect(html).toContain('<ol><li><p>First step</p></li></ol>');
    expect(html).toContain('<a href="https://portal.example.test/start">Portal</a> bad <a href="mailto:hr@example.test">mail</a> file');
    expect(html).toContain('<p>Clicked</p>');
    expect(result.droppedImages).toBe(2);
    expect(result.truncated).toBe(false);
    for (const forbidden of ['style=', 'class=', 'mso-', 'o:p', '<img', 'imagedata', 'script', 'alert(1)', 'onclick', 'Calibri', 'Wingdings', 'yellow', 'justify', 'target=', '·', 'font'])
      expect(html, forbidden).not.toContain(forbidden);
  });
  it('turns CSS-only formatting (Google Docs) into tags and ignores the Docs non-bold wrapper', () => {
    const html = cleanEmailPaste('<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">Bold</span> <span style="font-style:italic">it</span> <span style="text-decoration:underline">u</span> plain</p></b>').html;
    expect(html).toBe('<p><strong>Bold</strong> <em>it</em> <u>u</u> plain</p>');
  });
  it('keeps a pasted table as a real table and truncates an 8 x 40 table to 6 x 30 with a flag', () => {
    const rows = Array.from({ length: 40 }, (_, r) => `<tr>${Array.from({ length: 8 }, (_, c) => r === 0 ? `<th style="background:#ccc">H${c}</th>` : `<td colspan="1" style="border:1px solid">r${r}c${c}</td>`).join('')}</tr>`).join('');
    const result = cleanEmailPaste(`<table class="MsoTableGrid" border="1" style="width:500pt"><tbody>${rows}</tbody></table>`);
    expect(result.truncated).toBe(true);
    const dom = new DOMParser().parseFromString(result.html, 'text/html');
    const trs = Array.from(dom.querySelectorAll('tr'));
    expect(trs).toHaveLength(30);
    expect(trs.every(tr => tr.children.length === 6)).toBe(true);
    expect(trs[0].children[0].tagName).toBe('TH');
    expect(trs[29].children[5].textContent).toBe('r29c5');
    expect(result.html).not.toMatch(/colspan|style|border|class/);
  });
  it('flattens nested tables into paragraphs and keeps our own chips, document links and uploaded images', () => {
    const result = cleanEmailPaste('<table><tr><td>Outer<table><tr><td>Inner A</td><td>Inner B</td></tr></table></td></tr></table><p><span data-email-field="employee.name">Full name</span><span data-email-field="employee.icNo">IC</span><a data-email-link="document" data-email-document="nda" href="#">Sign</a><img data-email-image="img-1" alt="Logo" src="blob:x"><img data-email-image="img-x" alt="Other"></p>',
      { imageIds: ['img-1'], documentIds: ['nda'], fieldKeys: ['employee.name'] });
    expect(result.html).toContain('<td>Outer<p>Inner A Inner B</p></td>');
    expect(result.html).toContain('<span data-email-field="employee.name">Full name</span>IC<a');
    expect(result.html).toContain('<a data-email-link="document" data-email-document="nda">Sign</a>');
    expect(result.html).toContain('<img data-email-image="img-1" alt="Logo">');
    expect(result.droppedImages).toBe(1);
  });
  it('refuses an oversized paste', () => {
    expect(cleanEmailPaste('a'.repeat(600_000))).toEqual({ html: '', truncated: false, droppedImages: 0, tooLarge: true });
  });
});
