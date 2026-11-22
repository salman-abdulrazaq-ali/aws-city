import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import type { Model } from '@strands-agents/sdk';
import { ModelRouter, RoutingCandidate } from '@strands-agents/sdk/models/routing';
import { serviceCredentials } from '../aws.js';
import { MeteredAnthropicModel, MeteredBedrockModel, MeteredOpenAIModel } from '../citizens/model.js';
import type { Config } from '../config.js';

type Params = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>;
export interface LlmOptions {
  light?: boolean;
  fallback?: boolean;
}

/**
 * How the configured model is reached:
 * - `anthropic`: Claude through Bedrock's InvokeModel (the Anthropic Messages API), as the server has always run.
 * - `converse`: every call on Strands Agents: any other Bedrock model (Amazon Nova first) through Bedrock's Converse API,
 *   or a model on this computer (`AWS_CITY_MODEL_PROVIDER=local`, Strands' OpenAI model on Ollama).
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
  const local = config.modelProvider === 'local';
  const family: ModelFamily = local ? 'converse' : familyOf(config.model);
  const client = new AnthropicBedrock({
    awsRegion: config.bedrockRegion,
    // The SDK default is 10 minutes per attempt; a turn should fail well inside the 100 s deploy drain.
    timeout: 90_000,
    maxRetries: 2,
    providerChainResolver: async () => credentials,
  });

  const modelFor = (opts: LlmOptions) => (opts.fallback ? config.fallbackModel : opts.light ? config.lightModel : config.model);
  const notOnConverse = () => new Error(`${config.model} is a Converse model: this route runs on Strands Agents (llm.strands)`);

  /** The model on this computer: one model for every slot (a laptop holds one at a time). */
  const localModel = (opts: StrandsModelOptions, gate: () => Promise<void>, refund?: (err: unknown) => Promise<void>) =>
    new MeteredOpenAIModel({ baseURL: config.localModel.url, modelId: config.localModel.model, maxTokens: opts.maxTokens }, gate, refund);

  return {
    model: local ? config.localModel.model : config.model,
    family,
    /**
     * Whether the model reads images (the Lookout's screenshot). Bedrock's models do; a local one only with
     * AWS_CITY_LOCAL_VISION, and with a local fallback the screenshot is left out too, so either model can answer.
     */
    sees: !(local || config.localFallback) || config.localModel.vision,
    /**
     * A small model on CPU (the local provider: Ollama on this computer or the city's Fargate service). Reading the
     * prompt is most of its time (~27 tokens a second on Graviton), so routes give it a short city summary and one
     * docs page instead of the full snapshot and three (seen 21 Nov 2026: 40-60 s a chat answer).
     */
    small: local,
    /** The Bedrock client itself, for the Strands citizens (same InvokeModel route, same credentials). */
    client: client as unknown as Anthropic,
    /** No limits here; `metered` replaces this with the kill switch and quotas. */
    gate: NO_GATE,
    /** Gives back a call `gate` took whose failure (`err`) proves the model never ran (nothing to give back here; see `metered`). */
    refund: async (_err?: unknown): Promise<void> => undefined,

    /**
     * A Strands model for this server's configured family, every call through `gate` and a failure before any event
     * offered to `refund` (`metered` passes its own). Claude: Strands' Anthropic model on our Bedrock client. A local
     * model: Strands' OpenAI model on this computer. Anything else: Strands' Bedrock model (Converse), and with
     * `localFallback` a Strands ModelRouter that tries Bedrock first and the model on this computer when a call fails (its
     * FallbackStrategy; agents run with no retry strategy, so it switches on the first failure).
     */
    strands(opts: StrandsModelOptions, gate: () => Promise<void> = NO_GATE, refund?: (err: unknown) => Promise<void>): Model | ModelRouter {
      if (local) return localModel(opts, gate, refund);
      const modelId = opts.light ? config.lightModel : config.model;
      if (family === 'anthropic') return new MeteredAnthropicModel({ client: client as unknown as Anthropic, modelId, maxTokens: opts.maxTokens, effort: opts.effort }, gate, refund);
      const bedrock = new MeteredBedrockModel({ modelId, region: config.bedrockRegion, credentials, maxTokens: opts.maxTokens, maxAttempts: config.localFallback ? 1 : 3 }, gate, refund);
      if (!config.localFallback) return bedrock;
      return new ModelRouter([new RoutingCandidate({ model: bedrock, name: 'bedrock' }), new RoutingCandidate({ model: localModel(opts, gate, refund), name: 'local' })]);
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

    /** Streams text deltas (chat answers, on the light model); resolves with the final message. `onEvent`: any stream event arrived. */
    async stream(params: Params, onText: (delta: string) => void, onEvent?: () => void): Promise<Anthropic.Message> {
      if (family !== 'anthropic') throw notOnConverse();
      const stream = client.messages.stream({ ...params, model: config.lightModel });
      stream.on('text', onText);
      if (onEvent) stream.on('streamEvent', onEvent);
      return stream.finalMessage();
    },
  };
};

export type Llm = ReturnType<typeof createLlm>;
