import type Anthropic from '@anthropic-ai/sdk';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import type { Message, StreamOptions } from '@strands-agents/sdk';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import OpenAI from 'openai';
import { log } from '../log.js';

/** Token use per model call (EMF): what the bill is made of, and whether prompt caching works. */
const recordUsage = (usage: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number } | undefined) => {
  if (!usage) return;
  log.metric('InputTokens', usage.inputTokens ?? 0);
  log.metric('OutputTokens', usage.outputTokens ?? 0);
  log.metric('CacheReadTokens', usage.cacheReadInputTokens ?? 0);
};

/**
 * Strands' Bedrock model (the Converse API: Amazon Nova, or any model Converse serves) with the same gate as every other
 * model call: kill switch, the player's quota, the global cap. Credentials are the server's own (the local profile, or
 * the task role when hosted); a player's account is never used for model calls. No structuredOutputSchema here either:
 * tools are asked for in the prompt and a missing call is handled by the caller.
 */
export class MeteredBedrockModel extends BedrockModel {
  constructor(
    opts: { modelId: string; region: string; credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider; maxTokens: number; maxAttempts?: number },
    private readonly gate: () => Promise<void>,
  ) {
    // The SDK retries throttling itself (3 attempts); a turn should fail well inside the 100 s deploy drain. With a local
    // fallback behind it, one attempt: the router moves on at once (a held account's 0 tokens a day won't pass on a retry).
    super({ modelId: opts.modelId, region: opts.region, maxTokens: opts.maxTokens, clientConfig: { credentials: opts.credentials, maxAttempts: opts.maxAttempts ?? 3 }, requestTimeout: 90_000 });
  }

  override async *stream(messages: Message[], options?: StreamOptions) {
    await this.gate();
    for await (const event of super.stream(messages, options)) {
      if (event.type === 'modelMetadataEvent') recordUsage(event.usage);
      yield event;
    }
  }
}

/**
 * Strands' Anthropic model on our Bedrock client (InvokeModel, the workshop's route to the 5.x models), with every
 * model call going through the same gate as the rest of the server: kill switch, the player's quota, the global cap.
 * Never give the agent a structuredOutputSchema: that is the one place Strands forces tool_choice, which Bedrock
 * rejects while thinking is on (agent.ts structuredOutputChoice, @strands-agents/sdk 1.20.0).
 */
export class MeteredAnthropicModel extends AnthropicModel {
  constructor(
    opts: { client: Anthropic; modelId: string; maxTokens: number; effort?: 'low' | 'medium' | 'high' },
    private readonly gate: () => Promise<void>,
  ) {
    super({
      client: opts.client,
      modelId: opts.modelId,
      maxTokens: opts.maxTokens,
      ...(opts.effort ? { params: { output_config: { effort: opts.effort } } } : {}),
      cacheConfig: { strategy: 'auto' },
    });
  }

  override async *stream(messages: Message[], options?: StreamOptions) {
    await this.gate();
    for await (const event of super.stream(messages, options)) {
      if (event.type === 'modelMetadataEvent') recordUsage(event.usage);
      yield event;
    }
  }
}

/**
 * Strands' OpenAI model (Chat Completions) on a model served on this computer (Ollama's OpenAI-compatible endpoint), for
 * when Bedrock is held or offline, with the same gate as every other model call. Local mode only: config.ts refuses it
 * hosted and refuses any address off this computer. Ollama ignores the API key, but the OpenAI client wants one, so it
 * gets a placeholder (never a real key). The limit goes as `max_tokens`, which every local server reads (Strands'
 * `maxTokens` sends OpenAI's newer `max_completion_tokens`).
 */
export class MeteredOpenAIModel extends OpenAIModel {
  constructor(
    opts: { baseURL: string; modelId: string; maxTokens: number },
    private readonly gate: () => Promise<void>,
  ) {
    super({
      api: 'chat',
      modelId: opts.modelId,
      params: { max_tokens: opts.maxTokens },
      // A local model can be slow on a laptop; still well inside the 100 s deploy drain. One retry for a cold start.
      client: new OpenAI({ baseURL: opts.baseURL, apiKey: 'local', timeout: 90_000, maxRetries: 1 }),
    });
  }

  override async *stream(messages: Message[], options?: StreamOptions) {
    await this.gate();
    for await (const event of super.stream(messages, options)) {
      if (event.type === 'modelMetadataEvent') recordUsage(event.usage);
      yield event;
    }
  }
}
