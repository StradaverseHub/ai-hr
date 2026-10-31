/** Authored UNRUN. Actual shared page boundary, not Assistant/native effect permission proof. */
import {beforeEach,describe,it,expect,vi} from 'vitest';
import en from '../messages/en.json';
vi.mock('next-intl/server',()=>({getMessages:async()=>en}));
const state=vi.hoisted(()=>({session:vi.fn(),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:state.session}));
vi.mock('next/navigation',()=>({redirect:state.redirect}));
import AssistantLayout from '../app/assistant/layout';
import {AuthRequiredError} from '../lib/auth-errors';
beforeEach(()=>{vi.clearAllMocks();state.redirect.mockImplementation(()=>{throw Error('FRAMEWORK_LOGIN_REDIRECT');});});
describe('one authenticated Assistant shell',()=>{
 it('uses the selected browser login for every descendant without requiring a PERSON or granting native effects',async()=>{const children='OWN_CHILDREN';state.session.mockResolvedValue({tenantId:'fictional-tenant',userId:'fictional-user',personId:undefined,roles:['employee'],grants:[]});const tree=await AssistantLayout({children});expect(tree.props.children).toBe(children);expect(state.session).toHaveBeenCalledOnce();expect(state.redirect).not.toHaveBeenCalled();});
 it('redirects an absent selected user to the existing login rather than a convenience fallback or child page',async()=>{state.session.mockResolvedValue({tenantId:'fictional-tenant',userId:undefined});await expect(AssistantLayout({children:'PRIVATE_CHILDREN'})).rejects.toThrow('FRAMEWORK_LOGIN_REDIRECT');expect(state.redirect).toHaveBeenCalledWith('/login');});
 it('handles the actual session resolver auth-required error without returning its text',async()=>{state.session.mockRejectedValue(new AuthRequiredError('PRIVATE expired session details'));await expect(AssistantLayout({children:'PRIVATE_CHILDREN'})).rejects.toThrow('FRAMEWORK_LOGIN_REDIRECT');expect(state.redirect).toHaveBeenCalledWith('/login');});
 it('does not reinterpret an infrastructure failure as a missing login or return protected children',async()=>{const fault=Error('PRIVATE database fault');state.session.mockRejectedValue(fault);await expect(AssistantLayout({children:'PRIVATE_CHILDREN'})).rejects.toBe(fault);expect(state.redirect).not.toHaveBeenCalled();});
});
