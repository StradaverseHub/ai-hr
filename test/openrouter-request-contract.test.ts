import {fixtureOpenRouterTransport as createOpenRouterTransport} from './helpers/provider-egress-fixture';
import Ajv2020 from 'ajv/dist/2020';
import type {AnySchemaObject} from 'ajv';
import {describe, expect, it, vi} from 'vitest';
import vendor from './fixtures/openrouter-chat-plugin-contract-20261029.json';
import endpoint from './fixtures/openrouter-tool-endpoint-contract-20261029.json';
import {buildOpenRouterRequest} from '../lib/ai/providers/openrouter-transport';
import type {ConverseArgs} from '../lib/ai/types';

// The oracle is the independently downloaded vendor contract, not our plugin allowlist.
// No key, network, database or HR fixture is used by these checks.
const schema = vendor.schema as AnySchemaObject;
const validate = new Ajv2020({strict: false, allErrors: true, validateFormats: false}).compile(schema);
const configuration = {model: 'openai/fictional-model', apiKey: 'fictional-contract-key',
  routing: {allowedProviders: ['azure'], allowFallbacks: false, sort: 'latency'}};
const marker = 'synthetic_contract_marker';
const tool = {name: 'integration_echo', description: 'Synthetic echo; no side effects.',
  inputSchema: {type: 'object' as const, properties: {marker: {type: 'string', enum: [marker]}},
    required: ['marker'], additionalProperties: false as const}};
const requests: Record<string, ConverseArgs> = {
  draft: {system: ['Synthetic protocol check'], turns: [{role: 'user', content: marker}], tools: []},
  tool: {system: ['Synthetic protocol check'], turns: [{role: 'user', content: marker}], tools: [tool]},
  continuation: {system: ['Synthetic protocol check'], tools: [tool], turns: [
    {role: 'user', content: marker},
    {role: 'assistant', content: '', toolCalls: [{id: 'synthetic_call', name: tool.name, input: {marker}}]},
    {role: 'tool', results: [{id: 'synthetic_call', name: tool.name, content: JSON.stringify({marker})}]},
  ]},
};
const body = (args: ConverseArgs) => JSON.parse(buildOpenRouterRequest(
  {model: configuration.model, routing: configuration.routing}, args));

describe('OpenRouter serialized request compatibility with the published plugin contract', () => {
  it('reproduces the invalid enabled field that the vendor explicitly refuses for jev-router', () => {
    expect(validate([{id: 'jev-router', enabled: false}])).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([expect.objectContaining({
      instancePath: '/0', keyword: 'additionalProperties', params: {additionalProperty: 'enabled'},
      schemaPath: '#/components/schemas/JevRouterPlugin/additionalProperties',
    })]));
  });

  it.each(Object.entries(requests))('validates the actual %s request plugin bytes', (_name, args) => {
    expect(validate(body(args).plugins), JSON.stringify(validate.errors)).toBe(true);
  });

  it('sends explicit off switches only where the vendor declares a boolean enabled field', () => {
    const plugins = body(requests.draft).plugins as {id: string; enabled: boolean}[];
    const security = new Set(['alignment', 'armor', 'moderation']);
    const components = schema.components.schemas as Record<string, AnySchemaObject>;
    const supported = Object.values(components)
      .filter(component => component.properties?.enabled?.type === 'boolean'
        && typeof component.properties?.id?.enum?.[0] === 'string')
      .map(component => component.properties.id.enum[0] as string)
      .filter(id => !security.has(id)).sort();
    expect(plugins.map(plugin => plugin.id).sort()).toEqual(supported);
    expect(plugins.every(plugin => plugin.enabled === false)).toBe(true);
    for (const id of ['jev-router', 'switchyard-router', 'web-fetch', ...security])
      expect(plugins.some(plugin => plugin.id === id)).toBe(false);
  });

  it('retains the approved route, privacy restrictions and generic endpoint contract', () => {
    expect(body(requests.draft)).toMatchObject({model: configuration.model, stream: false,
      provider: {only: ['azure'], order: ['azure'], allow_fallbacks: false,
        require_parameters: true, data_collection: 'deny', zdr: true}});
  });

  it('uses only advertised tool parameters without weakening strict endpoint filtering', () => {
    expect(endpoint.supportedParameters).toEqual(expect.arrayContaining(['tools', 'tool_choice']));
    expect(endpoint.supportedParameters).not.toContain('parallel_tool_calls');
    for (const args of [requests.tool, requests.continuation]) {
      const request = body(args);
      const toolParameters = Object.keys(request).filter(key => ['tools', 'tool_choice', 'parallel_tool_calls'].includes(key));
      expect(toolParameters.every(key => endpoint.supportedParameters.includes(key))).toBe(true);
      expect(request).not.toHaveProperty('parallel_tool_calls');
      expect(request.provider.require_parameters).toBe(true);
    }
  });

  it.each([2, 3])('rejects %i returned tool calls before exposing any for execution', async count => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({choices: [{
      finish_reason: 'tool_calls', message: {role: 'assistant', content: null,
        tool_calls: Array.from({length: count}, (_, n) => ({id: `synthetic_${n}`, type: 'function',
          function: {name: tool.name, arguments: JSON.stringify({marker})}}))}}],
      usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0}}),
    {status: 200, headers: {'Content-Type': 'application/json'}}));
    const terminal = vi.fn();
    await expect(createOpenRouterTransport(fetcher)(configuration, requests.tool, undefined, terminal)).rejects.toThrow('AI provider response unavailable.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0][0].accounting.totalTokens).toBe(2);
  });

  it('completes through the real transport against a local vendor-schema rejecting stub', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (!validate(request.plugins)) return new Response(JSON.stringify({error: {code: 400,
        message: 'Synthetic schema rejection: invalid plugin property'}}),
      {status: 400, headers: {'Content-Type': 'application/json'}});
      return new Response(JSON.stringify({choices: [{finish_reason: 'stop',
        message: {role: 'assistant', content: marker}}], usage: {prompt_tokens: 1,
        completion_tokens: 1, total_tokens: 2, cost: 0}}),
      {status: 200, headers: {'Content-Type': 'application/json'}});
    });
    const result = await createOpenRouterTransport(fetcher)(configuration, requests.draft);
    expect(result.completion.text).toBe(marker);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
