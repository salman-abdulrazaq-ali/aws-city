/**
 * Claude on Bedrock through a geographic cross-Region inference profile (`<geo>.anthropic.<model>`). The geo prefix
 * depends on the Region the server runs in, and not every Region has one: these are the source Regions AWS lists
 * ("Geo inference details" on https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html,
 * .../model-card-anthropic-claude-sonnet-5-5.html, and the Claude Opus 5 / Sonnet 5 cards, checked 2026-10-12).
 * Claude Opus 5.5 and Sonnet 5.5 have `us.`, `eu.` and `au.` profiles (Opus 5.5 also `jp.`, Sonnet 5.5 not); India has
 * no 5.5 profile, so `in.` keeps Claude Opus 5 / Sonnet 5 (still active). There is no `apac.` profile. GovCloud is
 * left out (another partition; our ARNs are arn:aws:).
 *
 * Plain erasable TypeScript, no imports: infra/setup/setup.mjs imports this file directly (Node 24 strips the types).
 */
export const GEO_SOURCE_REGIONS = {
  us: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'ca-west-1'],
  eu: ['eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-2', 'eu-west-3'],
  au: ['ap-southeast-2', 'ap-southeast-4'],
  in: ['ap-south-1', 'ap-south-2'],
} as const satisfies Record<string, readonly string[]>;

export type Geo = keyof typeof GEO_SOURCE_REGIONS;

export const SUPPORTED_REGIONS: readonly string[] = Object.values(GEO_SOURCE_REGIONS).flat();

/** The inference-profile geo for a Region, or undefined where the server's models have no geo profile. */
export const geoFor = (region: string): Geo | undefined =>
  (Object.keys(GEO_SOURCE_REGIONS) as Geo[]).find((g) => (GEO_SOURCE_REGIONS[g] as readonly string[]).includes(region));

export const unsupportedRegionMessage = (region: string) =>
  `Claude has no Bedrock geo inference profile in ${region} for both of the server's models. Deploy in one of: ${SUPPORTED_REGIONS.join(', ')}.`;

/** Each geo's main and light model: the newest pair that has a profile there for both. */
export const GEO_MODELS = {
  us: { main: 'claude-opus-5-5', light: 'claude-sonnet-5-5' },
  eu: { main: 'claude-opus-5-5', light: 'claude-sonnet-5-5' },
  au: { main: 'claude-opus-5-5', light: 'claude-sonnet-5-5' },
  in: { main: 'claude-opus-5', light: 'claude-sonnet-5' },
} as const satisfies Record<Geo, { main: string; light: string }>;

/** The server's two models as inference-profile ids for this Region; throws where there are none. */
export const modelsFor = (region: string): { main: string; light: string } => {
  const geo = geoFor(region);
  if (!geo) throw new Error(unsupportedRegionMessage(region));
  const m = GEO_MODELS[geo];
  return { main: `${geo}.anthropic.${m.main}`, light: `${geo}.anthropic.${m.light}` };
};

/**
 * Amazon Nova, Amazon's own models, through Bedrock's Converse API (the server runs them on Strands Agents' Bedrock
 * model). On-demand in the Region itself, no geo profile, so these ids are the same everywhere Nova is offered on demand
 * (eu-west-2 lists Nova Pro and Nova Lite as ON_DEMAND: `aws bedrock list-foundation-models --by-inference-type ON_DEMAND`).
 * Pro thinks for the agents and the concierge, Lite answers chat and classifies pages.
 */
export const NOVA_MODELS = { main: 'amazon.nova-pro-v1:0', light: 'amazon.nova-lite-v1:0' } as const;

/**
 * The open model the city runs on Fargate when Bedrock can't (EnvConfig.aiCpu): Qwen3 4B Instruct 2507 (Apache-2.0,
 * tool calling, no thinking step, which a CPU can't afford), 4-bit, from the Ollama registry. `digests` pins the whole
 * model (config, weights, chat template, licence, params): infra/ai-image/Dockerfile fails the build if the manifest it
 * pulled lists anything else.
 */
export const CPU_MODEL = {
  id: 'qwen3:4b-instruct-2507-q4_K_M',
  name: 'Qwen3 4B',
  digests: [
    'sha256:b72accf9724e93698c57cbd3b1af2d3341b3d05ec2089d86d273d97964853cd2',
    'sha256:85e4a5b7b8ef0e48af0e8658f5aaab9c2324c76c1641493f4d1e25fce54b18b9',
    'sha256:eade0a07cac7712787bbce23d12f9306adb4781d873d1df6e16f7840fa37afec',
    'sha256:d18a5cc71b84bc4af394a31116bd3932b42241de70c77d2b76d69a314ec8aa12',
    'sha256:0914c7781e001948488d937994217538375b4fd8c1466c5e7a625221abd3ea7a',
  ],
  /** Task size: the model (2.5 GB) and two 16k-token conversations' KV cache fit in 16 GB. */
  cpu: 8192,
  memoryMiB: 16384,
} as const;
/** Fargate on Graviton (ARM) in eu-west-2, on demand (AWS Price List API, Nov 2026): per vCPU-hour and per GB-hour. */
export const FARGATE_ARM_PRICE = { region: 'eu-west-2', vcpuHour: 0.03725, gbHour: 0.00409 } as const;
/** What the AI service costs an hour on demand at FARGATE_ARM_PRICE (Spot is usually well under half of it). */
export const cpuAiHourly = () => (CPU_MODEL.cpu / 1024) * FARGATE_ARM_PRICE.vcpuHour + (CPU_MODEL.memoryMiB / 1024) * FARGATE_ARM_PRICE.gbHour;

export type ModelChoice = 'claude' | 'nova';

/**
 * The server's two models for this Region and choice; Claude throws where it has no geo profile, Nova doesn't.
 * `liteOnly` (Nova): Lite in both slots, for an account whose Region has a Nova Lite quota but none for Pro yet (a new
 * account's Bedrock hold lifts model by model).
 */
export const modelsForChoice = (region: string, choice: ModelChoice, opts: { liteOnly?: boolean } = {}): { main: string; light: string } =>
  choice === 'nova' ? (opts.liteOnly ? { main: NOVA_MODELS.light, light: NOVA_MODELS.light } : { ...NOVA_MODELS }) : modelsFor(region);

/** The foundation model behind a profile id: us.anthropic.claude-opus-5-5 → anthropic.claude-opus-5-5. */
export const foundationModel = (profileId: string) => profileId.replace(/^[a-z]+\.(?=anthropic\.)/, '');

/** A geo inference profile id (`us.`, `eu.`…) routes across Regions; an on-demand id (Amazon Nova) stays in its own. */
export const isProfileId = (id: string) => /^[a-z]+\.(?=anthropic\.)/.test(id);

/**
 * What the server's task role may invoke for these models (bedrock:InvokeModel and InvokeModelWithResponseStream, the
 * same two actions for InvokeModel and Converse). A geo profile: the profile in this Region, plus the foundation model in
 * every Region it routes to (a wildcard, acknowledged in cdk-nag). An on-demand model (Amazon Nova): exactly that model
 * in this Region, no wildcard.
 */
export const bedrockResources = (region: string, account: string, models: readonly string[]) => [
  ...models.filter(isProfileId).map((m) => `arn:aws:bedrock:${region}:${account}:inference-profile/${m}`),
  ...models.map((m) => (isProfileId(m) ? `arn:aws:bedrock:*::foundation-model/${foundationModel(m)}*` : `arn:aws:bedrock:${region}::foundation-model/${m}`)),
];

/** The wildcard resources in `bedrockResources` (each needs a cdk-nag acknowledgement). */
export const bedrockWildcards = (models: readonly string[]) => models.filter(isProfileId).map((m) => `arn:aws:bedrock:*::foundation-model/${foundationModel(m)}*`);
