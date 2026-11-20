import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import type { Model } from '@strands-agents/sdk';
import { serviceCredentials } from '../aws.js';
import { MeteredAnthropicModel, MeteredBedrockModel } from '../citizens/model.js';
import type { Config } from '../config.js';

type Params = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>;
export interface LlmOptions {
  light?: boolean;
  fallback?: boolean;
}

/**
 * How the configured model is reached:
 * - `anthropic`: Claude through Bedrock's InvokeModel (the Anthropic Messages API), as the server has always run.
 * - `converse`: any other Bedrock model (Amazon Nova first) through Bedrock's Converse API, every call on Strands Agents.
 */
export type ModelFamily = 'anthropic' | 'converse';
export const familyOf = (modelId: string): ModelFamily => (/(^|\.)anthropic\./.test(modelId) ? 'anthropic' : 'converse');

export interface StrandsModelOptions {
  /** The cheaper model (chat answers, page classification). */
  light?: boolean;
  maxTokens: number;
  /** Claude only (Anthropic `output_config.effort`); Converse models have no equivalent and ignore it. */
  effort?: 'low' | 'medium' | 'high';
}

const NO_GATE = async (): Promise<void> => undefined;

/**
 * Claude via Amazon Bedrock (bedrock-runtime InvokeModel), authenticated with the same workshop profile.
 * Server-side `fallbacks` isn't available on Bedrock, so a refusal is retried once on the fallback model
 * (the documented client-side fallback pattern) — by `metered`, so the retry counts against the quota too.
 * A Converse model (Amazon Nova) has no Messages API: its routes run on Strands Agents through `strands()`.
 */
export const createLlm = (config: Config) => {
  const credentials = serviceCredentials(config);
  const family = familyOf(config.model);
  const client = new AnthropicBedrock({
    awsRegion: config.region,
    // The SDK default is 10 minutes per attempt; a turn should fail well inside the 100 s deploy drain.
    timeout: 90_000,
    maxRetries: 2,
    providerChainResolver: async () => credentials,
  });

  const modelFor = (opts: LlmOptions) => (opts.fallback ? config.fallbackModel : opts.light ? config.lightModel : config.model);
  const notOnConverse = () => new Error(`${config.model} is a Converse model: this route runs on Strands Agents (llm.strands)`);

  return {
    model: config.model,
    family,
    /** The Bedrock client itself, for the Strands citizens (same InvokeModel route, same credentials). */
    client: client as unknown as Anthropic,
    /** No limits here; `metered` replaces this with the kill switch and quotas. */
    gate: NO_GATE,

    /**
     * A Strands model for this server's configured family, every call through `gate` (`metered` passes its own).
     * Claude: Strands' Anthropic model on our Bedrock client. Anything else: Strands' Bedrock model (Converse).
     */
    strands(opts: StrandsModelOptions, gate: () => Promise<void> = NO_GATE): Model {
      const modelId = opts.light ? config.lightModel : config.model;
      if (family === 'anthropic') return new MeteredAnthropicModel({ client: client as unknown as Anthropic, modelId, maxTokens: opts.maxTokens, effort: opts.effort }, gate);
      return new MeteredBedrockModel({ modelId, region: config.region, credentials, maxTokens: opts.maxTokens }, gate);
    },

    /**
     * `light` = the cheaper model (page classification); planning, agents and the Copilot use the main one.
     * `fallback` = the refusal fallback model.
     */
    async create(params: Params, opts: LlmOptions = {}): Promise<Anthropic.Message> {
      if (family !== 'anthropic') throw notOnConverse();
      return client.messages.create({ ...params, model: modelFor(opts) });
    },

    /** Whether a refusal on this route can be retried on a different model. */
    canFallBack: (opts: LlmOptions = {}) => !opts.fallback && config.fallbackModel !== modelFor(opts),

    /** Streams text deltas (chat answers, on the light model); resolves with the final message. */
    async stream(params: Params, onText: (delta: string) => void): Promise<Anthropic.Message> {
      if (family !== 'anthropic') throw notOnConverse();
      const stream = client.messages.stream({ ...params, model: config.lightModel });
      stream.on('text', onText);
      return stream.finalMessage();
    },
  };
};

export type Llm = ReturnType<typeof createLlm>;
