import type Anthropic from '@anthropic-ai/sdk';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import type { Message, StreamOptions } from '@strands-agents/sdk';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
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
    opts: { modelId: string; region: string; credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider; maxTokens: number },
    private readonly gate: () => Promise<void>,
  ) {
    // The SDK retries throttling itself (3 attempts); a turn should fail well inside the 100 s deploy drain.
    super({ modelId: opts.modelId, region: opts.region, maxTokens: opts.maxTokens, clientConfig: { credentials: opts.credentials, maxAttempts: 3 }, requestTimeout: 90_000 });
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
