import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, newId, type Flow } from '@hermes/ir';
import {
  OpenRouterClient,
  assertAllowList,
  buildStepTools,
  checkAllowList,
  STEP_LIBRARY,
} from '../src/index.js';

function makeFlow(stepType: string): Flow {
  const now = '2026-05-28T00:00:00.000Z';
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId(),
    name: 't',
    createdAt: now,
    updatedAt: now,
    inputs: [],
    outputs: [],
    variables: [],
    defaults: {
      timeoutMs: 5000,
      retry: { attempts: 1 },
      screenshotOnError: false,
      waitBetweenStepsMs: 0,
    },
    steps: [{ id: newId(), type: stepType as 'click', enabled: true }],
    metadata: { origin: 'recorded', targets: ['web'], requiredPermissions: [] },
  };
}

describe('Step Library', () => {
  it('includes the v1 safe set and excludes dangerous types', () => {
    const names = Object.keys(STEP_LIBRARY);
    expect(names).toContain('click');
    expect(names).toContain('open_url');
    expect(names).toContain('ai_assert');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('http_request');
  });

  it('builds OpenAI-compatible tool definitions', () => {
    const tools = buildStepTools();
    expect(tools.length).toBe(Object.keys(STEP_LIBRARY).length);
    expect(tools[0]!.type).toBe('function');
    expect(tools[0]!.function.parameters).toBeDefined();
  });
});

describe('AllowList enforcement', () => {
  it('accepts a flow that uses only safe step types', () => {
    expect(checkAllowList(makeFlow('click'))).toEqual([]);
  });

  it('rejects an unknown step type', () => {
    const v = checkAllowList(makeFlow('launch_rocket'));
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toMatch(/Unknown step type/);
  });

  it('rejects a dangerous step type without opt-in', () => {
    const flow = makeFlow('exec');
    const v = checkAllowList(flow);
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toMatch(/explicit/);
  });

  it('accepts a dangerous step type when opt-in is set', () => {
    const flow = makeFlow('exec');
    flow.defaults.allowList = { enabledStepTypes: ['exec'] };
    expect(checkAllowList(flow)).toEqual([]);
  });

  it('assertAllowList throws on violation', () => {
    expect(() => assertAllowList(makeFlow('launch_rocket'))).toThrow(/AllowList violations/);
  });
});

describe('OpenRouterClient', () => {
  it('constructs and includes auth headers in chat request', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({
          id: 'x',
          model: 'google/gemini-2.5-flash',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const usage: Array<{ model: string; promptTokens: number }> = [];
    const client = new OpenRouterClient({
      apiKey: 'sk-test',
      fetch: fakeFetch,
      onUsage: (u) => usage.push(u),
      appName: 'Hermes',
    });
    const res = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.choices[0]!.message.content).toBe('hi');
    expect(captured.url).toContain('/chat/completions');
    const headers = captured.init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['X-Title']).toBe('Hermes');
    expect(usage[0]?.promptTokens).toBe(10);
  });

  it('throws OpenRouterError on non-2xx', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('rate limited', { status: 429, headers: {} });
    const client = new OpenRouterClient({ apiKey: 'sk-test', fetch: fakeFetch });
    await expect(
      client.chat({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/OpenRouter 429/);
  });
});
