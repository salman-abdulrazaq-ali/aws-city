// A model on this computer (Ollama's OpenAI-compatible endpoint) on Strands Agents, for when Bedrock is held or offline:
// local mode only, loopback only, the same gate as every model call, tools offered and never forced, and a Strands
// ModelRouter that tries Bedrock first and the local model when a Bedrock call fails. The "Ollama" here is a real HTTP
// server on 127.0.0.1 speaking the Chat Completions stream, so the wire format is checked, not a mock of the client.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelRouter } from '@strands-agents/sdk/models/routing';
import { createLlm, type Llm } from '../src/agents/llm.js';
import { pick, say } from '../src/agents/once.js';
import { MeteredOpenAIModel } from '../src/citizens/model.js';
import { DEFAULT_LOCAL_MODEL, DEFAULT_LOCAL_URL, isLoopbackUrl, loadConfig, validate } from '../src/config.js';
import { createOrchestrator } from '../src/contract/orchestrator.js';
import type { ServerEvent } from '../src/world.js';
import { snapshot } from './fixtures.js';

const TOKEN = { AWS_CITY_TOKEN: 'x'.repeat(32) };
const NOVA = { AWS_CITY_MODEL: 'amazon.nova-pro-v1:0', AWS_CITY_FALLBACK_MODEL: 'amazon.nova-lite-v1:0', AWS_CITY_LIGHT_MODEL: 'amazon.nova-lite-v1:0', AWS_CITY_REGION: 'eu-west-2' };

// ── A tiny Ollama: POST /v1/chat/completions, streamed as server-sent events ────────────────────────────────────────
type Body = { model: string; messages: { role: string; content: unknown }[]; tools?: unknown[]; tool_choice?: unknown; max_tokens?: number; stream?: boolean };
const bodies: Body[] = [];
let reply: (body: Body) => object[] = () => [];
let server: Server;
let url = '';

const chunk = (delta: object, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 0, model: DEFAULT_LOCAL_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = { id: 'c', object: 'chat.completion.chunk', created: 0, model: DEFAULT_LOCAL_MODEL, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } };
const text = (...parts: string[]) => [chunk({ role: 'assistant', content: '' }), ...parts.map((content) => chunk({ content })), chunk({}, 'stop'), usage];
const toolCall = (name: string, args: unknown) => [
  chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }),
  chunk({}, 'tool_calls'),
  usage,
];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Body;
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of reply(body)) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const bedrock = mockClient(BedrockRuntimeClient);
beforeEach(() => {
  bodies.length = 0;
  bedrock.reset();
});
afterEach(() => bedrock.reset());

/** A local-mode server with its gate counted (the kill switch and quotas live behind it). */
const gated = (env: Record<string, string>) => {
  const llm = createLlm(loadConfig({ ...TOKEN, ...env }));
  const gate = vi.fn(async () => undefined);
  return { llm: { ...llm, gate, strands: (o: Parameters<Llm['strands']>[0]) => llm.strands(o, gate) } as Llm, gate };
};
const localLlm = (extra: Record<string, string> = {}) => gated({ AWS_CITY_MODEL_PROVIDER: 'local', AWS_CITY_LOCAL_URL: url, ...extra });

describe('the local model is for this computer only', () => {
  it('defaults: Bedrock, and Ollama on 127.0.0.1 with a text-only model when asked for', () => {
    const c = loadConfig(TOKEN);
    expect(c.modelProvider).toBe('bedrock');
    expect(c.localFallback).toBe(false);
    expect(c.localModel).toEqual({ url: DEFAULT_LOCAL_URL, model: DEFAULT_LOCAL_MODEL, vision: false });
  });

  it('only http(s) on loopback, with no credentials in the address', () => {
    for (const ok of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:11434/v1', 'https://127.0.0.1/v1']) expect(isLoopbackUrl(ok), ok).toBe(true);
    for (const bad of ['http://example.com/v1', 'http://10.0.0.5:11434/v1', 'http://127.0.0.1.nip.io/v1', 'http://user:pw@127.0.0.1/v1', 'file:///etc/passwd', 'ftp://127.0.0.1', 'not a url'])
      expect(isLoopbackUrl(bad), bad).toBe(false);
    expect(() => loadConfig({ ...TOKEN, AWS_CITY_MODEL_PROVIDER: 'local', AWS_CITY_LOCAL_URL: 'http://example.com/v1' })).toThrow(/on this computer/);
    expect(() => loadConfig({ ...TOKEN, AWS_CITY_MODEL_PROVIDER: 'ollama' })).toThrow(/must be one of bedrock, local/);
  });

  it('hosted refuses it: hosted players’ questions go to Bedrock only', () => {
    const hosted = {
      ...loadConfig(TOKEN),
      authMode: 'cognito' as const,
      awsMode: 'assume-role' as const,
      cognito: { userPoolId: 'eu-west-2_x', clientId: 'c' },
      extensionOrigins: ['chrome-extension://abc'],
      selfAccountId: '111111111111',
      playerRoleTemplateUrl: 'https://example.com/r.yaml',
    };
    expect(() => validate(hosted)).not.toThrow();
    expect(() => validate({ ...hosted, modelProvider: 'local' })).toThrow(/local mode only/);
    expect(() => validate({ ...hosted, ...NOVA_CFG, localFallback: true })).toThrow(/local mode only/);
  });

  it('the fallback runs behind Amazon Nova, not Claude (Claude keeps its own fallback)', () => {
    expect(() => loadConfig({ ...TOKEN, AWS_CITY_LOCAL_FALLBACK: 'true' })).toThrow(/Amazon Nova/);
    expect(() => loadConfig({ ...TOKEN, ...NOVA, AWS_CITY_LOCAL_FALLBACK: 'true' })).not.toThrow();
  });
});
const NOVA_CFG = { model: NOVA.AWS_CITY_MODEL };

describe('Strands on the local model', () => {
  it('every route runs on Strands, through the gate; nothing calls Bedrock', async () => {
    reply = () => text('Buckets hold ', 'objects.');
    const { llm, gate } = localLlm();
    expect(llm.family).toBe('converse');
    expect(llm.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(llm.sees).toBe(false);
    expect(llm.strands({ maxTokens: 10 })).toBeInstanceOf(MeteredOpenAIModel);
    const deltas: string[] = [];
    const out = await say(llm, { system: 'You teach S3.', prompt: 'What is a bucket?', model: { light: true, maxTokens: 200 }, onText: (d) => deltas.push(d) });
    expect(out.text).toBe('Buckets hold objects.');
    expect(deltas.join('')).toBe('Buckets hold objects.');
    expect(gate).toHaveBeenCalledTimes(1);
    expect(bedrock.commandCalls(ConverseStreamCommand)).toHaveLength(0);
    // The wire: the configured model, a streamed call, max_tokens (every local server reads it), the system prompt.
    expect(bodies[0]).toMatchObject({ model: DEFAULT_LOCAL_MODEL, stream: true, max_tokens: 200 });
    expect(bodies[0].messages[0]).toMatchObject({ role: 'system' });
  });

  it('pick: the tool is offered, never forced, and its input comes back', async () => {
    reply = (body) => (body.messages.some((m) => m.role === 'tool') ? text('Done.') : toolCall('plan', { steps: ['Visit S3 Lake'] }));
    const { llm, gate } = localLlm({ AWS_CITY_LOCAL_MODEL: 'llama3.1:8b' });
    const got = await pick(llm, {
      system: 's',
      prompt: 'Plan it. Call plan.',
      tool: { name: 'plan', description: 'The plan', schema: z.object({ steps: z.array(z.string()) }) },
      model: { maxTokens: 500 },
    });
    expect(got).toEqual({ steps: ['Visit S3 Lake'] });
    expect(bodies[0].model).toBe('llama3.1:8b');
    expect(bodies[0].tools).toHaveLength(1);
    expect(bodies[0].tool_choice).toBeUndefined();
    expect(gate.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('the Lookout gives a text-only model the page’s address, not the screenshot', async () => {
    reply = (body) => (body.messages.some((m) => m.role === 'tool') ? text('ok') : toolCall('report_page', { serviceIds: ['s3'], summary: 'An S3 bucket list.' }));
    const { llm } = localLlm();
    const png = { bytes: Buffer.from('89504e47', 'hex'), contentType: 'image/png' };
    const out: ServerEvent[] = [];
    const orch = createOrchestrator({ llm, runner: { run: vi.fn() } as never, snapshot: async () => snapshot([]), uploads: { get: async () => png } as never, walkMs: 0, paceMs: 0 });
    await orch.classifyPage({ requestId: 'r1', context: { screenshotKey: 'k', url: 'https://eu-west-2.console.aws.amazon.com/s3/buckets', title: 'S3 buckets' } } as never, (e) => out.push(e));
    expect(JSON.stringify(bodies[0].messages)).not.toContain('image_url');
    expect(JSON.stringify(bodies[0].messages)).toContain('s3/buckets');
    expect(out.find((e) => e.type === 'page.classified')).toMatchObject({ serviceIds: ['s3'] });
    // A vision model gets the screenshot.
    bodies.length = 0;
    const { llm: seeing } = localLlm({ AWS_CITY_LOCAL_VISION: 'true' });
    expect(seeing.sees).toBe(true);
    const orch2 = createOrchestrator({ llm: seeing, runner: { run: vi.fn() } as never, snapshot: async () => snapshot([]), uploads: { get: async () => png } as never, walkMs: 0, paceMs: 0 });
    await orch2.classifyPage({ requestId: 'r2', context: { screenshotKey: 'k', url: 'https://x', title: 't' } } as never, () => {});
    expect(JSON.stringify(bodies[0].messages)).toContain('image_url');
  });
});

describe('Bedrock first, this computer when Bedrock fails (Strands ModelRouter)', () => {
  it('a held account’s throttle moves the answer to the local model', async () => {
    bedrock.on(ConverseStreamCommand).rejects(Object.assign(new Error('Too many tokens per day, please wait before trying again.'), { name: 'ThrottlingException' }));
    reply = () => text('From your laptop: ', 'S3 stores objects.');
    const { llm, gate } = gated({ ...NOVA, AWS_CITY_LOCAL_FALLBACK: 'true', AWS_CITY_LOCAL_URL: url });
    expect(llm.strands({ maxTokens: 10 })).toBeInstanceOf(ModelRouter);
    expect(llm.sees).toBe(false);
    const out = await say(llm, { system: 's', prompt: 'What is S3?', model: { light: true, maxTokens: 100 }, onText: () => {} });
    expect(out.text).toBe('From your laptop: S3 stores objects.');
    expect(bedrock.commandCalls(ConverseStreamCommand)).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    // Both model calls went through the gate.
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it('when Bedrock answers, the local model isn’t called', async () => {
    async function* stream() {
      yield { messageStart: { role: 'assistant' } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'From Bedrock.' } } };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: 'end_turn' } };
    }
    bedrock.on(ConverseStreamCommand).resolves({ stream: stream() } as never);
    const { llm } = gated({ ...NOVA, AWS_CITY_LOCAL_FALLBACK: 'true', AWS_CITY_LOCAL_URL: url });
    const out = await say(llm, { system: 's', prompt: 'p', model: { light: true, maxTokens: 100 }, onText: () => {} });
    expect(out.text).toBe('From Bedrock.');
    expect(bodies).toHaveLength(0);
  });
});
