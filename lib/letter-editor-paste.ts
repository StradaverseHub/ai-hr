import DOMPurify from 'dompurify';
import {LetterModelError} from './letter-model';
/** Browser-only clipboard boundary. No styles, external resources, links, forms or executable content. */
export function sanitiseLetterPaste(html:string):string{
 if(!DOMPurify.isSupported)throw new LetterModelError('invalid','editor.browser');
 if(html.length>256000)throw new LetterModelError('limit','editor.paste');
 return DOMPurify.sanitize(html,{ALLOWED_TAGS:['p','br','strong','b','em','i','u','h1','h2','h3','ul','ol','li','table','tbody','thead','tr','td','th','span','div','section'],ALLOWED_ATTR:['colspan','rowspan','start'],ADD_ATTR:['data-letter-field','data-letter-condition','data-letter-conditional','data-letter-conditional-content','data-letter-branch','data-letter-branch-content'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,RETURN_TRUSTED_TYPE:false});
}
