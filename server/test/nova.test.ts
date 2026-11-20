// Amazon Nova (Bedrock's Converse API) on Strands Agents: the model family follows the configured id, every Nova call
// goes through the gate (kill switch, quotas), tools are offered but never forced, and the one-shot routes (the
// concierge's plan, a chat answer) work without the Anthropic Messages API.
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamCommandInput, type ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLlm, familyOf, type Llm } from '../src/agents/llm.js';
import { pick, say } from '../src/agents/once.js';
import { loadConfig } from '../src/config.js';
import { createOrchestrator } from '../src/contract/orchestrator.js';
import type { ServerEvent } from '../src/world.js';
import { snapshot } from './fixtures.js';

const bedrock = mockClient(BedrockRuntimeClient);
beforeEach(() => bedrock.reset());
afterEach(() => bedrock.reset());

/** A Converse stream, as Bedrock sends it. */
async function* events(list: ConverseStreamOutput[]) {
  for (const e of list) yield e;
}
const textReply = (...parts: string[]) => ({
  stream: events([
    { messageStart: { role: 'assistant' } },
    ...parts.map((text) => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } })),
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } } },
  ] as ConverseStreamOutput[]),
});
const toolReply = (name: string, input: unknown) => ({
  stream: events([
    { messageStart: { role: 'assistant' } },
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 't1', name } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify(input) } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } } },
  ] as ConverseStreamOutput[]),
});

const NOVA = { AWS_CITY_MODEL: 'amazon.nova-pro-v1:0', AWS_CITY_FALLBACK_MODEL: 'amazon.nova-lite-v1:0', AWS_CITY_LIGHT_MODEL: 'amazon.nova-lite-v1:0', AWS_CITY_REGION: 'eu-west-2' };
/** A local-mode server on Nova, its gate counted (the kill switch and quotas live behind it). */
const novaLlm = () => {
  const llm = createLlm(loadConfig({ ...NOVA, AWS_CITY_TOKEN: 'x'.repeat(32) }));
  const gate = vi.fn(async () => undefined);
  return { llm: { ...llm, gate, strands: (o: Parameters<Llm['strands']>[0]) => llm.strands(o, gate) } as Llm, gate };
};
const requests = () => bedrock.commandCalls(ConverseStreamCommand).map((c) => c.args[0].input as ConverseStreamCommandInput);

describe('the model family follows the configured id', () => {
  it('Claude stays on the Anthropic Messages API; Amazon Nova (and any other Bedrock model) goes through Converse', () => {
    expect(familyOf('us.anthropic.claude-opus-5-5')).toBe('anthropic');
    expect(familyOf('anthropic.claude-sonnet-5-5')).toBe('anthropic');
    expect(familyOf('amazon.nova-pro-v1:0')).toBe('converse');
    expect(familyOf('eu.amazon.nova-lite-v1:0')).toBe('converse');
    expect(familyOf('global.amazon.nova-2-lite-v1:0')).toBe('converse');
  });

  it('a Nova server never calls the Messages API', async () => {
    const { llm } = novaLlm();
    expect(llm.family).toBe('converse');
    await expect(llm.create({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/Strands Agents/);
  });
});

describe('one-shot calls on Strands Agents (Nova)', () => {
  const Plan = z.object({ agentId: z.string(), reply: z.string() });

  it('pick: offers the tool (never forced), records its input, and gates every model call', async () => {
    bedrock
      .on(ConverseStreamCommand)
      .resolvesOnce(toolReply('plan_task', { agentId: 's3', reply: 'A job for Sally!' }))
      .resolvesOnce(textReply('Done.'));
    const { llm, gate } = novaLlm();
    const got = await pick(llm, { system: 'You route requests.', prompt: 'Store my photos', tool: { name: 'plan_task', description: 'Pick the agent.', schema: Plan }, model: { maxTokens: 4000 } });
    expect(got).toEqual({ agentId: 's3', reply: 'A job for Sally!' });
    const [first] = requests();
    expect(first.modelId).toBe('amazon.nova-pro-v1:0');
    expect(first.system?.[0]).toMatchObject({ text: 'You route requests.' });
    expect(first.toolConfig?.tools?.map((t) => t.toolSpec?.name)).toEqual(['plan_task']);
    expect(first.toolConfig?.toolChoice).toBeUndefined();
    expect(first.inferenceConfig?.maxTokens).toBe(4000);
    expect(gate).toHaveBeenCalledTimes(requests().length);
  });

  it('pick: a reply without the tool (or with a bad input) gives undefined, so the caller keeps its fallback', async () => {
    bedrock.on(ConverseStreamCommand).resolvesOnce(textReply('Hmm, not sure.'));
    const { llm } = novaLlm();
    expect(await pick(llm, { system: 's', prompt: 'p', tool: { name: 'plan_task', description: 'd', schema: Plan }, model: { maxTokens: 100 } })).toBeUndefined();
    bedrock.reset();
    bedrock.on(ConverseStreamCommand).resolvesOnce(toolReply('plan_task', { agentId: 7 })).resolvesOnce(textReply('ok'));
    expect(await pick(llm, { system: 's', prompt: 'p', tool: { name: 'plan_task', description: 'd', schema: Plan }, model: { maxTokens: 100 } })).toBeUndefined();
  });

  it('say: streams the answer on the light model', async () => {
    bedrock.on(ConverseStreamCommand).resolvesOnce(textReply('S3 stores ', 'objects in buckets.'));
    const { llm } = novaLlm();
    const deltas: string[] = [];
    const out = await say(llm, { system: 'Be brief.', prompt: 'What is S3?', model: { light: true, maxTokens: 500 }, onText: (d) => deltas.push(d) });
    expect(deltas.join('')).toBe('S3 stores objects in buckets.');
    expect(out).toEqual({ text: 'S3 stores objects in buckets.', refused: false });
    expect(requests()[0].modelId).toBe('amazon.nova-lite-v1:0');
  });
});

describe('the city on Nova', () => {
  const orchestrator = (llm: Llm) =>
    createOrchestrator({ llm, runner: { run: vi.fn() } as never, snapshot: async () => snapshot([]), uploads: { get: async () => undefined }, walkMs: 0, paceMs: 0 });

  it('answers a district chat question, streamed, through Strands', async () => {
    bedrock.on(ConverseStreamCommand).resolvesOnce(textReply('Use a lifecycle rule ', 'to move old photos.'));
    const { llm } = novaLlm();
    const out: ServerEvent[] = [];
    await orchestrator(llm).ask({ requestId: 'r1', districtId: 'storage', question: 'How do I keep old photos cheaply?', context: {} } as never, (e) => out.push(e));
    const answers = out.filter((e): e is Extract<ServerEvent, { type: 'chat.answer' }> => e.type === 'chat.answer');
    expect(answers.map((a) => a.delta).join('')).toBe('Use a lifecycle rule to move old photos.');
    expect(answers.at(-1)?.done).toBe(true);
    expect(out.some((e) => e.type === 'error')).toBe(false);
  });
});
