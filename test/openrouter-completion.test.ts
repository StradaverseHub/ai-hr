import { describe, expect, it } from 'vitest';
import { readOpenRouterCompletion } from '../lib/ai/providers/openrouter-completion';
const call = { id: 'call_1', type: 'function', function: { name: 'leave_balance', arguments: '{"date":"2026-10-26"}' } };
const response = (finish: string | null, calls: unknown[] = []) => ({ choices: [{ finish_reason: finish,
  message: { role: 'assistant', content: null, tool_calls: calls } }],
  usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } });

describe('unregistered non-streaming OpenRouter completion boundary', () => {
  it('translates a tool request without executing it and counts cache once', () => {
    expect(readOpenRouterCompletion(response('tool_calls', [call]))).toEqual({ text: '', stop: 'tool_use',
      toolCalls: [{ id: 'call_1', name: 'leave_balance', input: { date: '2026-10-26' } }],
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 }, usageReported: true });
  });
  it.each(['content_filter', 'length', 'future_finish_reason', null])('strips executable calls for terminal label %s', finish => {
    const result = readOpenRouterCompletion(response(finish, [call]));
    expect(result.toolCalls).toEqual([]);
    expect(result.stop).toBe(finish === 'content_filter' ? 'refusal' : finish === 'length' ? 'max_tokens' : 'other');
  });
  it('does not turn claimed tool use without calls into completion', () => {
    expect(readOpenRouterCompletion(response('tool_calls')).stop).toBe('other');
  });
  it('lets explicit refusal win over a stop label and stray tool request', () => {
    const value = response('stop', [call]);
    Object.assign(value.choices[0].message, { content: 'discarded', refusal: 'private provider text' });
    const result = readOpenRouterCompletion(value);
    expect(result.stop).toBe('refusal'); expect(result.toolCalls).toEqual([]); expect(result.text).toBe('');
  });
  it('retains malformed JSON as invalid input, never a guessed tool argument', () => {
    const value = { ...call, function: { ...call.function, arguments: '{' } };
    expect(readOpenRouterCompletion(response('tool_calls', [value])).toolCalls[0].input).toBeUndefined();
  });
  it.each([
    { error: { message: 'PRIVATE_PROVIDER_BODY' }, ...response('stop') },
    { choices: [{ ...response('stop').choices[0], error: { message: 'PRIVATE_PROVIDER_BODY' } }] },
    response('error', [call]), response('tool_calls', [call, call]),
    response('tool_calls', [{ ...call, type: 'custom' }]),
    { choices: [] }, { choices: [...response('stop').choices, ...response('stop').choices] },
    response('tool_calls', [{ ...call, function: { ...call.function, arguments: 'x'.repeat(65_537) } }]),
  ])('refuses errors or malformed protocol without raw provider detail %#', value => {
    try { readOpenRouterCompletion(value); throw new Error('expected refusal'); }
    catch (error) { expect((error as Error).message).toBe('No complete AI response was available.');
      expect((error as Error).cause).toBeUndefined(); }
  });
  it('keeps missing accounting explicitly unreported despite neutral placeholder zeros', () => {
    const result = readOpenRouterCompletion({ choices: response('stop').choices });
    expect(result.usageReported).toBe(false);
  });
});
