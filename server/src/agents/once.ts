import { Agent, NullConversationManager, tool, type ContentBlockData } from '@strands-agents/sdk';
import type { z } from 'zod';
import type { Llm, StrandsModelOptions } from './llm.js';

/**
 * One-shot model calls on Strands Agents, for the routes that are a single decision rather than a conversation: the
 * concierge's plan, a chat answer, the Lookout's page report, the Console Copilot's next step. Each call is a fresh
 * Agent with no memory and no AWS tools (nothing here can act on an account); every model call goes through
 * `llm.strands`, so the kill switch, the player's quota and the token metrics apply as everywhere else.
 */

/** The prompt: text, or content blocks (a screenshot for the Lookout, then text). */
export type Prompt = string | ContentBlockData[];

const agentFor = (llm: Llm, system: string, model: StrandsModelOptions, tools: ReturnType<typeof tool>[] = []) =>
  new Agent({
    model: llm.strands(model),
    systemPrompt: system,
    tools,
    printer: false,
    sandbox: false,
    toolExecutor: 'sequential',
    // The Bedrock client already retries throttling; a second layer would double-count the quota.
    retryStrategy: null,
    conversationManager: new NullConversationManager(),
  });

const textOf = (content: readonly { type: string }[]) =>
  content
    .filter((b): b is { type: 'textBlock'; text: string } => b.type === 'textBlock')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * Asks for one structured answer through a tool the model calls (never a forced tool_choice, never a
 * structuredOutputSchema: the prompt asks for the tool, and a missing or invalid call returns undefined so the caller
 * keeps its own fallback). Two model turns at most: the call, then the model's closing line.
 */
export async function pick<T>(
  llm: Llm,
  o: { system: string; prompt: Prompt; tool: { name: string; description: string; schema: z.ZodType<T> }; model: StrandsModelOptions },
): Promise<T | undefined> {
  let picked: T | undefined;
  const capture = tool({
    name: o.tool.name,
    description: o.tool.description,
    inputSchema: o.tool.schema as z.ZodType<Record<string, unknown>>,
    callback: (input: unknown) => {
      const parsed = o.tool.schema.safeParse(input);
      if (parsed.success) picked ??= parsed.data;
      return parsed.success ? 'Recorded.' : 'That did not match the schema.';
    },
  });
  await agentFor(llm, o.system, o.model, [capture]).invoke(o.prompt, { limits: { turns: 2 } });
  return picked;
}

/** A text answer, streamed: `onText` gets each delta as it arrives. `refused` when the model declined. */
export async function say(llm: Llm, o: { system: string; prompt: Prompt; model: StrandsModelOptions; onText: (delta: string) => void }): Promise<{ text: string; refused: boolean }> {
  const stream = agentFor(llm, o.system, o.model).stream(o.prompt, { limits: { turns: 1 } });
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      const result = next.value;
      return { text: textOf(result.lastMessage.content), refused: result.stopReason === 'refusal' || result.stopReason === 'contentFiltered' || result.stopReason === 'guardrailIntervened' };
    }
    const ev = next.value;
    if (ev.type === 'modelStreamUpdateEvent' && ev.event.type === 'modelContentBlockDeltaEvent' && ev.event.delta.type === 'textDelta') o.onText(ev.event.delta.text);
  }
}
