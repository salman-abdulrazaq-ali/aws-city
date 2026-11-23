# AWS City — agent guide

An MV3 browser extension for Chrome/Edge, Firefox and Safari (WXT + React 19 + Phaser 4 + zustand): an isometric AWS learning city.
The frontend is complete against a mock backend; the AWS backend plugs in through one contract.

## Commands

Node 24 (`engines` `>=24` in `package.json`; proof: `npm pkg get engines.node`). 24.15+ is recommended: the launcher
(`scripts/launcher/require-node.mjs`) stops below 24 and prints a one-line note on 24.0–24.14, which still works.
There are three npm projects, each with its own lockfile: the extension (root), `server/` and `infra/`. Run `npm ci` in each one
you touch. The root `tsc` and ESLint skip `server/` and `infra/`.
npm before 11.12 (Node 24.9 ships 11.6) refuses the server's lockfile as out of sync, and a lockfile it writes is refused
by npm 12, so `npm run live`'s server install (`awsTools`, `scripts/start.mjs`) falls back to one `npm install`, as
`boot.mjs` does for the root. Proof: on Node 24.9, `npm --prefix server ci` fails (EUSAGE) and `npm --prefix server install` works.

```
npm start         # the guided launcher: demo / real AWS / deploy (scripts/launcher/boot.mjs → scripts/start.mjs)
npm start -- --demo --browser cft   # the same, no prompts (on stage); --help lists the flags
npm run check     # tsc --noEmit && vitest run (tests/**/*.test.{ts,tsx}; React components render under jsdom)
npx vitest run tests/ladder.test.ts              # one test file (the form every Proof below uses)
npx vitest run tests/ladder.test.ts -t "<name>"  # one test by name
npm run lint      # ESLint: rules of hooks + jsx-a11y (CI: --max-warnings 10)
npm run smoke     # build + Playwright Chromium demo run; screenshots in .output/smoke; must print "no page errors"
npm run smoke:copilot  # the 8 Console Copilot flows on the practice console (practice.html) + the demo Lookout; must print "no page errors"
npm run dev       # WXT dev with Chrome for Testing (`npx playwright install chromium` once; branded Chrome opens blank)
npm run live      # local server with real AWS (workshop profile) + the extension wired to it
npm run open:hosted   # the live city setup deployed, built for it, in Chrome for Testing with its own profile (.cache/chrome-profile-hosted)
npm run dev:firefox / npm run live -- --browser firefox|safari   # other browsers
npm run lint:firefox && npm run build:safari   # Firefox (Mozilla linter, 0 errors) and Safari builds
npm run safari:xcode   # Xcode project for Safari (.cache/safari)
npm run art       # regenerate the sprites in public/assets (runs `python3` with Pillow)
npm run assets    # refetch Kenney packs into .cache/ and copy the listed files into public/assets/kenney

cd server && npx tsc --noEmit && npm test       # server types + tests (tsc also catches contract drift)
cd server && npx vitest run test/hosted.test.ts -t "MFA"   # one server test
cd server && npm run build:bundle               # esbuild → dist/main.js, what the Docker image runs
cd infra && npx tsc --noEmit && npm test && npx cdk synth -q   # hosting; cdk-nag must pass (CI synths -c env=staging and -c env=prod)
```

CI (`.github/workflows/ci.yml`) has one job per project, each starting with `npm ci` and `npm audit --omit=dev
--audit-level=high`. The extension job also runs both smokes under xvfb, the server job builds the arm64 Docker image,
and the infra job cfn-lints `infra/player-role/player-role.yaml`.

## Architecture

- **Three projects, one protocol.** The extension (`src/`, WXT `srcDir`), the server (`server/`: `tsx` in dev, an
  esbuild bundle in the image) and the CDK app (`infra/`: stacks in `lib/`, the deploy wizard `setup/setup.mjs` that the root's
  `npm run setup` runs, the role players install in `player-role/`). `server/src/world.ts` re-exports the extension's `src/backend/contract.ts`,
  `src/world/taxonomy.ts` and `src/world/places.ts` (`server/src/contract/console.ts` imports `src/console/risk.ts`), so
  whatever those files import must also compile as NodeNext ESM in `server/`.
- **The backend is picked at build time** (`createBackend`, `src/backend/index.ts`): `WXT_BACKEND=aws` is the local server,
  `hosted` is the deployed one with Cognito sign-in, and anything else (or a hosted build in "Play the demo") is
  `MockBackend`, the in-browser demo. Both implement `AgentBackend`. `npm run setup` writes `.env.production` (hosted), which
  every plain build reads; the launcher's demo and `npm run smoke` force `WXT_BACKEND=mock`. A store build
  (`WXT_STORE_BUILD=true`: no manifest key, no `window.awsCity`, brand off, the `?season=` and `?map=legacy` dev params
  ignored) that is `hosted` fails when a `WXT_*` setting is missing, the privacy policy's `WXT_PRIVACY_URL` (https only) included
  (`wxt.config.ts` → `scripts/release-check.mjs`), instead of falling back to the demo. Proof: `npx vitest run tests/release-check.test.ts`.
- **Entrypoints** (`src/entrypoints/`): `sidepanel/` (`mount('panel')`; WXT turns it into Firefox's sidebar) and `city/`
  (`mount('full')`, the tab) run the same app (`src/app/mount.tsx` → `App.tsx`). `practice/` is the practice console,
  `console.content.ts` is the Console Copilot on console pages and `background.ts` is the service worker.
- **Layers in `src/`:** `state/` (the zustand store, the bus, and pure rule modules over `Progress`: ladder, wallet, srs,
  next, simple…), `world/` (the pure city model built from `shared/`: taxonomy, plan, zoning, terrain, park, airport, clients),
  `learning/` (pure game logic: spaced repetition, puzzle scoring, the practice terminal, station reducers, daily pay),
  `game/` (Phaser 4: `createGame.ts`, scenes in `game/scenes/` (Boot, World, City, Interior, mini-games)), `ui/` (React 19)
  and `console/` (the Copilot: page snapshot, risk checks, acting on the page). Most `tests/` target the pure modules directly.
- **Determinism.** A Region's terrain and props come from `mulberry32(hashCode(region))` (`src/world/terrain.ts`;
  `mulberry32` is in `src/game/rng.ts`) drawn in a fixed order. A new placement uses a hash and adds no `rng()` call, or every later prop moves.
- **Generated files.** `shared/region-facts.json`, `prices.json`, `aws-catalog.json`, `aws-icons.json` and `city-maps/` come
  from `scripts/fetch-*.mjs` (`npm run region-facts|prices|aws-catalog|icons|city-maps`), which read the curated
  `shared/regions.json` and `shared/city-centres.json`. `public/assets/city` and `public/assets/characters` come from
  `npm run art`. Change the generator or its curated input and re-run it; don't edit the output.
- **Playtest personas** in `.claude/agents/` (`auditor`, `fun-tester`, `newcomer`) are subagents that run in demo mode only
  and never edit the repo. The auditor also checks for drift between this file and the code.

## Decisions (each with the command that proves it)

When a change touches a decision, update its entry and run its Proof.

- **Backend: `server/`** (Node + TS, Claude on Bedrock). It runs locally against the workshop
  account, which denies CloudFormation and `iam:CreateRole`, or hosted in our own account via `infra/`.
  The AgentCore/Strands backend is parked on `parked/agentcore-backend`. Proof: `cd server && npm test`
  (the server imports `src/backend/contract.ts`, so contract drift breaks its build: `npx tsc --noEmit -p server`).
- **Two deployments of one server:** local (`AUTH_MODE=token`, workshop profile, files; loopback
  only; every caller needs the token, an Origin header never authenticates: the launcher mints one per run and builds it into
  the extension as `WXT_AWS_TOKEN`, `scripts/launcher/live-run.mjs`) and hosted (`AWS_CITY_MODE=hosted`: Cognito JWT in the WebSocket subprotocol, one tenant
  per player, DynamoDB/S3, each player's own account via `AWSCityPlayerRole-<region>` + ExternalId).
  `server/src/config.ts` refuses unsafe mixes. A deleted player's sockets close within about a minute on every task
  (`DELETED_CHECK_MS`). "Your data" (sign out, delete) shows only for hosted builds; the demo's ⋯ says "Demo: your progress stays on this device; nothing is sent anywhere." (`DEMO_PRIVACY_LINE`, `src/ui/Hud.tsx`) and links the privacy policy when the build has `WXT_PRIVACY_URL`. Proof: `cd server && npx vitest run test/hosted.test.ts`, `npx vitest run tests/a11y-focus.test.tsx`,
  `cd server && npx vitest run test/http.test.ts -t "origins|deleted|token"`.
- **The player role allows exactly what the server calls, and trusts only our account.** The trust is
  fixed at publish time, not a parameter. Proof: `cd server && npx vitest run test/player-role.test.ts`. The installed
  role, read-only through IAM's policy simulator (SCPs included): allowed on `aws-city-<account>-*` buckets, `city-*`
  tables and tagged IMDSv2 t4g instances in its Region; denied on other names, untagged resources, m5.large, other
  Regions, object/item reads, IAM, STS, secrets, KMS and Lambda. Proof: `cd infra && AWS_PROFILE=aws-city node
  scripts/check-player-role.mjs --account <test account> --assume arn:aws:iam::<test account>:role/OrganizationAccountAccessRole`
  (28/28 on 21 Nov 2026). Every agent write works end to end on a real account (ActionService → policy → executor →
  AWS, checked in AWS after each, everything named `livetest` removed): `cd server && AWS_PROFILE=aws-city
  AWS_CITY_LIVE_ROLE_ARN=<role> npx vitest run test/live/actions.live.test.ts --silent=false` (skipped without it).
- **Infra is CDK with cdk-nag AwsSolutions clean.** Every acknowledgement carries a reason. Deploys need no
  Docker: the server image is built in CodeBuild (`@cdklabs/deploy-time-build`). `npm run setup` prints a ⏳ line a
  minute from the busy stack's events while cdk deploys (`infra/lib/deploy-progress.ts`; cdk runs with `--progress
  events`), and the 5xx deploy-rollback alarm uses 1-minute periods (3 × 1 min, 5 a minute): ECS keeps a finished deploy
  open for a window it computes from that alarm, and 3 × 5 min held it ~16 minutes after the new servers were live.
  Proof: `cd infra && npm test && npx cdk synth -q`.
- **Agents are grounded, never unrestricted:** docs come from the read-only AWS Knowledge MCP server
  (allow-listed tools, `<aws_docs>` treated as data, official AWS hosts only). There's no AWS CLI tool
  and no managed AWS MCP Server (`aws___run_script`), and nothing from the Strands tools package.
  Proof: `cd server && npx vitest run test/knowledge.test.ts`.
- **Every agent runs on Strands Agents (TypeScript)**, pinned `@strands-agents/sdk` (npm `overrides` shares our
  `@anthropic-ai/sdk`). `AnthropicModel` gets our `AnthropicBedrock` client (the InvokeModel route) behind the quota
  gate; tools are the ActionService allowlist (citizens: read-only), a sequential executor, a 5-tool cap, no structured
  output (it forces `tool_choice`), no vended HITL (approval stays in ActionService: a write gets the player's approval
  channel or is refused). Citizens always; landmark agents too by default (`AWS_CITY_AGENT_ENGINE=classic` keeps the
  hand-written loop as a fallback). Landmark agents run at `effort: 'high'`, citizens `low`. Source: `.claude/references/cached-sources.md`.
  Proof: `cd server && npx vitest run test/citizens.test.ts`.
- **Amazon Nova runs the whole city on Strands Agents.** The model id picks the family (`familyOf`,
  `server/src/agents/llm.ts`): Claude keeps the Anthropic Messages API routes above; any other Bedrock model (Amazon
  Nova: `NOVA_MODELS` in `infra/lib/models.ts`, Pro for agents and planning, Lite for chat and the Lookout, on demand in
  the Region) goes through Bedrock's Converse API on Strands' `BedrockModel` (`MeteredBedrockModel`, the same gate:
  kill switch, quotas, token metrics). Agent turns take `llm.strands()`; the one-shot routes (concierge plan, `chat.ask`,
  the Lookout with its screenshot, the Console Copilot's step) run as fresh Strands Agents through `pick` (one tool,
  offered and never forced; a missing or invalid call keeps the route's fallback) and `say` (streamed text), in
  `server/src/agents/once.ts`. Locally: `npm run live -- --model nova` (the launcher checks Nova with Converse and passes
  the ids as env). Hosted: the setup wizard asks (Nova recommended; saved as `modelChoice`, `loadEnv` →
  `modelsForChoice`); the task role may invoke exactly the two Nova foundation models in its Region (`bedrockResources`:
  no wildcard, no cdk-nag acknowledgement; Claude keeps its profile + wildcard), and the budget's deny covers both. A new account's hold can be Region by Region and model by model: the wizard then looks for a Region where Nova answers (`NOVA_ELSEWHERE`) and offers `aiRegion` (the server calls Bedrock there, `AWS_CITY_BEDROCK_REGION`; data, sign-in and the server stay in `region`; the task role may invoke Nova only there) and `novaLiteOnly` (Lite in every slot); the launcher plays on Lite when Pro has no quota.
  Proof: `cd server && npx vitest run test/nova.test.ts` (includes "the AI can run in another Region"), `npx vitest run tests/launcher.test.ts`, `cd infra && npm test`.
- **Locally, the agents' AI can run on this computer** (for a Bedrock hold, or no network): `AWS_CITY_MODEL_PROVIDER=local`
  runs every route on Strands' `OpenAIModel` against Ollama's OpenAI-compatible endpoint (`MeteredOpenAIModel`,
  `server/src/citizens/model.ts`: the same gate; family `converse`, so the one-shot routes go through `once.ts`), and
  `AWS_CITY_LOCAL_FALLBACK=true` puts it behind Amazon Nova with Strands' `ModelRouter` (Bedrock with one attempt, then
  the local model). `server/src/config.ts` allows only loopback in local mode (`isLoopbackUrl`), only the city's own AI
  service by its private name when hosted (`isPrivateServiceUrl`, below), and refuses the fallback behind Claude. A text-only local model gets the Lookout's page address, not the screenshot
  (`llm.sees`; `AWS_CITY_LOCAL_VISION=true` for a vision model). The launcher: `npm run live -- --model local`
  (`--local-model`, default `qwen3:8b`; `--local-fallback` with `--model nova`) offers to install Ollama with
  Homebrew, start it and pull the model (`ensureOllama`, `scripts/start.mjs`).
  Proof: `cd server && npx vitest run test/local-model.test.ts` (a real HTTP "Ollama" on 127.0.0.1), `npx vitest run tests/launcher.test.ts`.
- **Hosted, the AI can run on AWS without Bedrock** (`EnvConfig.aiCpu`, offered by setup when Bedrock is held; a new
  account's GPU quotas start at 0 too): an open model (`CPU_MODEL` in `infra/lib/models.ts`, Qwen3 4B Instruct 2507,
  Apache-2.0, 4-bit) served by Ollama (`infra/ai-image/Dockerfile`: the release pinned by digest; the model pulled at build time in CodeBuild
  and checked by `infra/ai-image/verify-model.sh`: the registry manifest by its own digest, `CPU_MODEL.manifest`, and its
  five files by theirs, on Ollama's content-addressed blobs; `OLLAMA_NO_CLOUD=1`, so it calls nobody; the base image's
  Ubuntu packages patched at build time, `apt-get -y upgrade`, while the Go findings in the ollama binary wait for an
  Ollama built with `golang.org/x/net` 0.62) on its own Fargate
  service: Graviton, 8 vCPU / 16 GB, `FARGATE_SPOT` or
  `FARGATE`, a Cloud Map private name `ai.awscity-<env>.internal`, its own security group (in: 11434 from the server's
  group only; out: HTTPS only, for its image and logs), a task role with no policy, and no desired count in the template, so `npm run ai -- on|off|status`
  (`scripts/ai-switch.mjs`, the AWS CLI) sticks across deploys. The server gets `AWS_CITY_PRIVATE_DOMAIN`/`_LOCAL_URL`/
  `_LOCAL_MODEL` and, behind Nova, `AWS_CITY_LOCAL_FALLBACK` (Strands' ModelRouter: Bedrock first); behind Claude the
  model alone. Cost: `cpuAiHourly()` from `FARGATE_ARM_PRICE` (eu-west-2 Price List), shown in the review screen.
  Proof: `cd infra && npm test` ("the AI on AWS without Bedrock", cdk-nag with it on; `test/ai-image.test.ts` runs the
  model check), `cd server && npx vitest run test/local-model.test.ts`.
- **A new account is walked through, not left to guess** (`docs/self-hosting.md`): root MFA, the Paid plan (upgraded as
  root; a Free plan account closes when its credits run out), an admin user with MFA, `aws login` as that user, Nova or
  Claude, and a new account's Bedrock hold (verifying, 0 tokens a day, Free plan, use-case form, each with its fix and a
  support-case text). An expired or missing sign-in doesn't stop the wizard: it names it (`explainAwsError`) and offers
  **Sign in with your browser** (`aws login --profile aws-city`), then checks again and carries on (`--yes`, keys in the
  environment and runs without a terminal stop with the commands). The setup wizard checks the same before asking anything else: it warns on root (`sts` ARN), stops
  on the Free plan (`GetAccountPlanState`, `@aws-sdk/client-freetier`), and names the Bedrock wall (`explainAwsError`),
  each linking the guide's step. When Bedrock isn't ready, the wizard offers to deploy with the AI off (`aiEnabled:
  false` → the kill switch's starting value; everything but the agents works) and re-running it once Bedrock answers
  turns the AI on. **The questions only read AWS**: the Google secret is held in memory and the SES address only noted,
  then one review screen (`infra/lib/review.ts`: every answer, every AWS change in order, the us-east-1 note for
  CloudFront's WAF) offers Deploy / Change an answer (the questions again, pre-filled) / Cancel, and only then writes.
  The questions include publishing: the operator's name, a contact email and the privacy policy's https address
  (`privacyUrl`; setup writes the policy for the operator to host, and builds the store zips only with it), and the
  Chrome Web Store and Edge Add-ons ids (`chromeStoreId`/`edgeStoreId`, both in `extensionIds` for sign-in); GitHub
  deploys trust no default repo (pre-filled from this clone's origin, a warning when it differs, then a yes/no). SES
  in its sandbox and free-mail senders are named before the SES question; an SES identity an earlier run created
  (`sesIdentitiesCreated`) that nothing uses is offered for removal. Right after the environment, setup checks which code
  it would deploy (`codeProblem`, `infra/lib/code-state.ts`: a `git fetch`, then main behind GitHub's main, or prod off
  main) and offers Update now (`git pull --ff-only`, then run setup again) / Deploy this copy anyway / Stop; `--yes` stops
  unless `--any-commit`; the review shows "Code: main @ <sha>". A checkout 6 commits behind deployed the city without two
  merged fixes on 21 Nov 2026. Proof: `npm run setup -- --dry-run` (changes nothing in AWS), `cd infra && npm test` (`test/code-state.test.ts`),
  `npx vitest run tests/launcher.test.ts`; every link in the guide opens (checked when it changes).
- **AWS's public status and news reach every player, read once by the server** (`server/src/news/`, contract v2.6 `aws.health`/`aws.news`).
  The sources are the public Health Dashboard JSON (UTF-16 with a BOM), with the status RSS as fallback, and What's New. Hosts are
  allow-listed, there are no redirects, a size cap and a timeout, and a failure backs off. Feed text is untrusted data (neutralised,
  trimmed, never given to a model). Services map only through verified codes in `shared/aws-health-services.json`. There's no IAM and
  no Health API (it needs a Business support plan). The demo plays the real Bahrain/UAE events plus a `drill: true` practice event.
  Proof: `cd server && npx vitest run test/news.test.ts test/tenants.test.ts`, `npx vitest run tests/incidents.test.ts tests/contract.test.ts`.
- **AWS City Live: the city changes with what AWS is doing.** Events are data with an official page each
  (`shared/events.json`: re:Invent 2026, 30 Nov – 4 Dec, Las Vegas; links only to aws.amazon.com and meetup.com,
  `isEventUrl`). `src/world/liveEvents.ts` is pure (`eventPhase`, `bannerEvent`: live first, else the soonest within
  `BANNER_DAYS`); the City tab's `EventBanner` (both modes, never the primary button) opens the Events board, and
  `?date=YYYY-MM-DD` previews a day. A What's New launch that lands while the city is open (`bus` `launch`, after the news
  rung, never the batch on connect) bumps its building with "🚀 New from AWS" and its agent's line (`CityScene.onLaunch`,
  `LAUNCH_GAP_MS` apart, at most `LAUNCH_MAX` a batch, one toast); a building's card lists its newest launches
  (`WhatsNew`). The demo holds back its newest captured launch for `LAUNCH_AFTER_MS`. While re:Invent is live the server
  reads What's New every 10 minutes (`newsEvery`) and keeps `MAX_NEWS` 60. Strands Agents and Amazon Nova are taught in
  AgentCore Academy and Bedrock Mesa (cards from AWS pages, glossary terms); Strands isn't a service (no console, Region
  or icon). Proof: `npx vitest run tests/live-events.test.ts tests/events-ui.test.tsx tests/content.test.ts`,
  `cd server && npx vitest run test/news.test.ts`, `npm run smoke` (86: banner, board with axe, re:Invent live, a launch on S3).
- **Findings are rules; the model only explains.** `server/src/agents/findings.ts` checks each poll (no model calls);
  players read `shared/wa-rules.json`; an unreadable setting never raises a finding.
  Proof: `cd server && npx vitest run test/care.test.ts`.
- **Fixes only tighten, are opt-in, and each one is approved.** A fixed allowlist (`server/src/agents/fixes.ts`) re-reads
  the resource before the preview and again inside the account lock after approval, one fix per finding at a time. The
  player role grants the fix actions only with `AllowFixes=true`. IAM holds an IMDS change's `HttpTokens` to `required` (not its
  other options) and EBS to enable-only; for S3 Block Public Access, DynamoDB PITR and security-group revokes it can't, so the code does (and the
  template says so). Undo is the player's, in the console. Outside the city's own resources the player types the
  resource id, and the citizen must be level 3 (a teaching gate, not a security control). Local mode needs
  `AWS_CITY_ALLOW_FIXES=true` (`npm run live -- --allow-fixes`), and its "fixes are off" message says so (`howToAllowFixes`);
  so does the UI (`FixesOn` shows the CloudFormation steps and "Check again" only on hosted builds, locally `LOCAL_FIXES_COMMAND`).
  Hosted, fixes are per account (v2.19): the setup link sets `AllowFixes=true` when the player asks (`account.link {allowFixes}`),
  and verify learns whether the role allows them without changing anything (`fixesAllowed`: EC2's DryRun of the EBS fix,
  `DryRunOperation` = yes); "Check again" re-runs that DryRun for the linked record (`account.recheck`, read-only: no MFA, no
  new link window, the role version stays, the same world; an answer that can't tell keeps the known one, and a link that
  changed meanwhile is refused, never written back); `createCityCare` reads the latest answer at each fix (unknown:
  the server's setting) and `account.status` says it (`fixes`).
  Proof: `cd server && npx vitest run test/fixes.test.ts test/player-role.test.ts test/care.test.ts test/tenants.test.ts -t "Check again"`,
  `cd server && npx vitest run test/hosted.test.ts -t "Check again"`, `npx vitest run tests/deploy-account.test.tsx tests/account-ui.test.tsx`.
- **AWS plugins for Claude Code** (`.claude/settings.json`): `aws-core` and `aws-agents` from
  `claude-plugins-official` (Agent Toolkit for AWS). Use their skills (aws-cdk, aws-iam, aws-containers,
  aws-networking, aws-security, aws-well-architected-review…) when changing infra or the server. The
  aws-core MCP server's `aws___run_script` acts with the *developer's* credentials: it's for the dev
  session only, every call asks first (`permissions.ask` in `.claude/settings.json`), and it's never wired
  into the game's agents (they get only allow-listed read-only docs tools). Proof: `cd server && npx vitest run test/knowledge.test.ts`.
- **Every AWS write needs the player's approval** (contract v2 `deploy.preview` → `deploy.approve`).
  With no approval channel, writes are refused (only reads run). v2.19 `resource.remove` (no model) goes the same way:
  `ActionService.submit` with the socket's approvals, so policy, the preview, MFA on approve and the gate all apply (Jev
  needs the player's own words, so a take-down isn't sent; its preview asks for the typed name anyway).
  A destructive write (terminate, delete, a take-down) always carries `confirmText`, the resource's name or id, whether
  or not Jev asks (`server/src/contract/approvals.ts`); the demo's take-downs too. A new preview focuses its card's title
  (`.stack-title`), never Approve, so a stray Enter or Space approves nothing. A waiting approval leads Deploy (`Waiting for
  your OK`, after the account card, above Blueprints and My builds): where it writes first (`ChangeTarget`; the demo names
  the linked practice account, `usePracticeAccount`, on a fix card too), one plain line per resource (`plainType`, the
  logical ID second), one For AWS learners fold, and a plain-text Approve ("Approve & deploy").
  Proof: `server/test/approvals.test.ts`, `server/test/service.test.ts` ("refuses every write without an approval channel"),
  `cd server && npx vitest run test/tenants.test.ts -t "resource.remove"`, `npx vitest run tests/trust.test.tsx tests/ui.test.tsx tests/approval-card.test.tsx`.
- **A deterministic gate sits between the server and AWS** (`server/src/guard/`). One SDK middleware on every client with a
  player's credentials (`clientsFor`, lazy ones too; link.ts's STS) refuses, before signing: a command not in `RULES`
  (`guard/rules.ts`: as the SDK names it, `read`/`write`/`fix`, its IAM actions; the parsed role, `yaml` with CFN short tags as
  plain values, grants exactly the read/write/fix sets in aws-city-read/-build/-fix, no wildcard or NotAction anywhere); a request
  outside the home Region (AZ/Region lists anywhere, Cost Explorer us-east-1); a write or fix not shaped exactly as the server
  sends it, grant or not (strict zod: RunInstances one encrypted disk and `CpuCredits: standard`; PutBucketTagging/DeleteBucket
  `ExpectedBucketOwner` = the account, CreateBucket has none so its name prefix stands in); and one without a grant naming its
  command and exact target, once. The one exception is a rule's `probe`, its exact DryRun (`{DryRun: true}` on the EBS fix,
  v2.19): it changes nothing and needs no grant, and IAM checks it against the fix's own action, so it maps to aws-city-fix
  and answers "are fixes on?". What goes on to be serialised is zod's checked copy, never the caller's object (a later
  change, getter or Proxy can't alter it). A grant is minted for one account (refused from clients in another or an unknown
  one), its entries are frozen copies, and all are spent when `withGrant` ends (a timer started inside gets nothing). Only
  ActionService (after policy and approval) and care.ts (after approval, the re-read and the account lock; `FixDef.entry`
  names the write, `apply()` alone is refused) mint grants. Refusals are `GuardDeniedError` ("The city's safety gate stopped
  this: …"); audit lines (the gate's and the tenant's `aws change`, `targetHash`) carry the player as `who(sub)` and the target as
  a 12-hex sha256, never account ids or names. Honest
  scope: it stops mistakes in server code paths, not hostile in-process code (a client's `config.credentials` still holds the
  keys, a command's own middleware could relabel it); a source test keeps `.config.credentials`, `.middlewareStack`,
  presigners, `SignatureV4` and the player's credential providers inside `aws.ts`/`guard/` (allowlist with reasons: uploads'
  presigned POST on our own S3 client, main.ts/link.ts handing `assumedRole` to gated clients). The player role and IAM are the
  outer wall. Proof: `cd server && npx vitest run test/guard.test.ts test/player-role.test.ts test/service.test.ts test/fixes.test.ts test/care.test.ts`,
  `cd server && npx vitest run test/tenants.test.ts -t "aws change"`.
- **Jev, a second opinion that only tightens** (`server/src/agents/jev.ts`, `docs/jev.md`; its settings in `jev-config.ts`, which
  imports nothing, so `server/src/config.ts` stays light enough for the extension's tests to import). Off unless `TYPESAFE_API_KEY` is
  set (local or hosted). ActionService asks TypeSafe's Jev about a write after policy passes and before the player is asked
  (the `judge` dependency, in `write()`, so an agent's write and a plain request's direct one alike); never about a read,
  a denied write or one with no approval channel, and never without the player's own words (`TurnHooks.intent` =
  task.submit's prompt, on both paths in `server/src/contract/orchestrator.ts`): without them it's allow at once and
  nothing is sent (a take-down, city care; a destructive write carries `confirmText` anyway). The state is only
  `{request, change}`: those words (≤ 500 chars) and `describeAction`, with 12-digit ids and ARNs redacted; never the
  action type, `destructive` or anything else from AWS: a terminate's `change` names the server by its Name tag, or says it has
  none (`serverName`/`changeFor`), and an unnamed server counts as not named unless the player's words hold its id
  (`unnamedTarget`: an exact lookup, so code). Judgments from Jev, decisions in code: the questions are Nouls, worded
  with their criteria and the thresholds in `jev-config.ts` (`JEV_QUESTIONS`): `asked_for` (every write), and for a
  destructive one `asks_to_remove` and `names_target`. A Noul ≤ `AWS_CITY_JEV_NO` (0.3) is no, ≥ `AWS_CITY_JEV_YES` (0.7)
  yes, between unsettled; `decide` is the table, first row wins (blocks first): `asked_for` no → block; destructive and
  `asks_to_remove` no → block; `asked_for` unsettled → ask; `asks_to_remove` unsettled → ask; `names_target` not yes →
  ask; else allow. The old `AWS_CITY_JEV_BLOCK_BELOW`/`_ASK_BELOW`/`_ASK_RISK` are refused at startup. Block refuses with a plain sentence; ask adds a "Safety check" detail line and the
  preview's v2.3 `confirmText` (the resource's name; `approvals.answer` refuses a mismatch; a destructive write has one anyway); it never skips or answers
  the approval. A timeout (3 s), non-2xx, a reply over 32 KB, a redirect, a reply off the documented shape or a question
  not answered as a Noul is ask, never read as an answer. The model is pinned (`AWS_CITY_JEV_MODEL`, default
  `jev-1.14.0`); each decision is logged (id, model, each Noul, verdict, row, ms, tokens), never the state or the key.
  Injected text can sway Jev, so it can never loosen anything. `server/test/live/jev.live.test.ts` (skipped without
  `TYPESAFE_API_KEY`) sends 29 made-up cases one at a time (27/29 as expected on 23 Nov 2026, both misses an ask on the safe side), capped at 2M input tokens, and prints the whole record as JSON (no file: CodeQL flags network data written to disk).
  Proof: `cd server && npx vitest run test/jev.test.ts test/service.test.ts test/guard.test.ts`.
- **Linking an AWS account, approving a write, applying a fix and taking something down need MFA (step-up).** Hosted players must have TOTP
  on for `account.link`/`account.verify`, `deploy.approve`, `finding.fix` and `resource.remove` (Google sign-ins are exempt); prod Cognito runs Plus with threat protection.
  Each of those passes every check, in order, and none replaces another (`stepUp` in `server/src/http.ts`): the player
  wasn't deleted on another task (`stillHere`, else the socket closes with `4403`); an authenticator is on (else
  `mfa_required`); this session signed in after the server first saw it on (below, else code `auth`); and it signed in
  within the last 30 minutes (the token's `auth_time`, `recentSignIn` in `server/src/accounts/mfa.ts`; error
  `reauth_required`, "Sign in again" (`ReauthPrompt`) → `prompt=login`, then the fresh token goes over the open socket
  as `auth.renew` (v2.17) so a pending approval survives), so a stolen 30-day refresh token can't approve anything.
  There is no switch to turn step-up off hosted (the old `REQUIRE_MFA_FOR_LINK` is gone).
  The first-sight rule (`server/src/accounts/mfa.ts`): the server keeps the first time it saw TOTP on
  (`Stores.mfa` `since`, files or DynamoDB `USER#<sub> MFA`; seeing it off forgets it) and passes only an access token whose `auth_time` is at
  or after it; an older session gets code `auth` with `SIGN_IN_AGAIN_MESSAGE`, which the UI shows as sent (`errorText` keeps an
  `auth` error's own words). After enrolling, the extension calls `POST /me/mfa` (the server
  looks now and answers 204 only once the first sight is recorded, else 409 when Cognito doesn't list the authenticator yet,
  Cognito or DynamoDB throttles the look (`MFA_LOOK_REFUSED` by name, the SDK's `$retryable.throttling` or a 429) or Cognito no
  longer has the player: sign-up is open, so anything a player can cause is never a 5xx, which
  would feed the Http5xx alarm that pages and rolls a deploy back; only a failure that's ours, such as our role refused, is
  503; per player `MFA_NOTE_BURST` 3 in a row, then one every 5 s, else 429, its map swept at most once a minute (`sweeper`,
  like the export limiter's); the extension treats any refusal as not heard:
  `NOTE_TRIES` 3 tries, waits doubling from 250 ms, an older server's 404 counts as heard), then `GlobalSignOut` ends
  every session and the player signs in again with the code (`src/backend/auth.ts`). If that call never landed, the first sight
  is dated when the server first looks (`now()`), never from AdminGetUser's `UserLastModifiedDate`: whether Cognito moves it when
  TOTP goes on is unconfirmed, and an earlier date could pass a session a stolen password opened before the authenticator. So
  the player may have to sign in twice, and the toast says so (`confirmTotp` → `{signInTwice}`, `afterMfa`). A refused
  `resource.remove` is tracked like a fix (`StepUp` in `src/app/runtime.ts`: "press Take it down
  again"). `account.recheck` and `account.unlink` need no MFA (they change nothing, or take access away). Sign-out
  revokes the refresh token (`/oauth2/revoke`, bounded); an email change waits for its code (`keepOriginal`). A "TOTP is on" answer is
  cached 60 s at most. The Deploy tab walks a player through it one step at a time: the authenticator first ("🔐 First,
  protect your account": a QR code of the `otpauth://` link to scan, `src/ui/QrCode.tsx` with `uqr`, the key behind
  "Can't scan it?"), and only then the three linking steps (below). Proof: `cd server && npx vitest run
  test/hosted.test.ts -t "MFA|me/mfa|30 minutes|auth.renew"` (includes "MFA step-up for writes"),
  `npx vitest run tests/auth.test.ts tests/ui-logic.test.ts tests/runtime-session.test.ts tests/server-backend.test.ts tests/link-steps.test.tsx`, `cd infra && npm test`.
- **A linked account can be disconnected, notices a deleted stack, and upgrades its role** (contract v2.19). `account.unlink`
  needs no MFA (taking access away): `AccountStore.delete` (files or DynamoDB `USER#<sub> ACCOUNT`), an unlinked world, the
  poller stopped, `account.status {linked: false}` to every tab. Unlink and DELETE /me forget the record holding that AWS
  account's lock (`forgetUnderLock` in `server/src/tenants.ts`; no account id: at once), so a write already past `live()` on any
  task finishes first and once they return nothing more changes; a DELETE /me that fails (the lock timed out after ~36 s, a
  store error: a 500) rebuilds the city from the stored record instead of leaving it retired. Replacing a world retires the old one (`World.retired`, an
  AbortController aborted in `replaceWorld` with the reason): its pending previews (agent writes, fixes, removals) end
  `rejected` "That account was disconnected, so nothing changed." (`Approvals` watch the signal), and ActionService and
  CityCare ask `live()` inside the account lock right before minting a grant, which also re-reads the stored link before a
  write (CityCare checks the retired signal once more after its re-read; a store error in `live()` is a plain refusal,
  `LINK_UNCHECKED_REASON`, so the approved card still gets its outcome). A `live()` that says no refuses with `RETIRED_REASON` (`server/src/agents/service.ts`),
  so an approval given before the player re-linked another account never writes to the old one, and a retired world's
  fix is audited `denied`. Every open or warm city (its last tab closed, kept
  until eviction, still polling) re-reads its record once a minute (`ACCOUNT_CHECK_MS`, one read whether or not a tab is open)
  and rebuilds when it's gone or its status/account/Region/`brokenAt` or link changed (`linkKey`: also `linkedAt` and a hash
  of the ExternalId, kept in memory and never logged), so an unlink, a disconnect and new link of the same account and Region,
  or a broken mark on another ECS task reaches it (`accounts.get` is strongly consistent, DynamoDB `ConsistentRead`). Every
  write of the link record is conditional (`AccountStore.put(sub, record, ifLink)`: the same ExternalId and `linkedAt`,
  DynamoDB `ConditionExpression`, files in one synchronous step; `'new'` only creates, `attribute_not_exists(pk)`), so a
  DELETE /me or Disconnect on another task is never written back: verify writes onto the record it started from, link onto
  the one it read (a first link only creates, so two tasks' first links never swap ExternalIds), and both refuse a player
  deleted a moment ago (the linker's `deleted`: the tombstone); a refused write is `LINK_CHANGED_MESSAGE` ("Your AWS account
  link changed meanwhile. Try again."). "Check again" (`recheck`) and the broken mark change one field in place
  (`AccountStore.update`: DynamoDB `UpdateItem` `SET record.fixes`/`record.brokenAt`, the same condition, `ALL_NEW`), so a
  new setup link made on another task meanwhile (`pendingRegion`, its window) is kept; recheck refuses a link that's gone or
  another one, and a DryRun that can't tell keeps the known `fixes` and writes nothing. STS refusing the role itself (`RoleRefusedError`: only AccessDenied for `sts:AssumeRole` on the player's own role,
  `refusalsMarked`; our task credentials failing, ExpiredToken/InvalidClientTokenId, never mark a link broken, and
  'expired' never persists `brokenAt`) on `BROKEN_AFTER` (3) polls in a row, the first at least `REFUSAL_WINDOW_MS` (5 min)
  old, on a poll the breaker still takes for the player's own (polling goes on meanwhile, so each refused player stays in
  the breaker while other players' cached credentials expire), marks the record `brokenAt` (`broken: true`: "Was the stack deleted? Link again, or disconnect."), only when the record is still
  the link that world was built from (`linkKey`, and the write is conditional; otherwise the world is rebuilt from the
  record), and stops polling only once it's marked (the new world replaces the old; a failed read or write leaves polling
  on, and the next refused poll tries again, never a city frozen on old data that still says linked). Proof:
  `cd server && npx vitest run test/tenants.test.ts -t "broken"`. The our-side wording test (`OUR_POLICY` in `server/src/aws.ts`: an AccessDenied naming an identity-based
  policy, a service control policy, a permissions boundary or a session policy, all evaluated on our own role) has a
  breaker (`createRefusalBreaker`): the role
  refusing `REFUSAL_PLAYERS` (3) different players within `REFUSAL_WINDOW_MS` (5 min) on one server task, with no AssumeRole
  working in between, is our side (`ourSide`, the poll's `refusedOurSide`): not counted toward `BROKEN_AFTER`, and one
  `log.error` plus the `RoleRefusalBreaker` metric, which has its own alarm at 1 (a single line is under the `LoggedErrors`
  alarm's 20 per 5 minutes), until an AssumeRole works again (a task with fewer than 3 players can't tell). Only links
  already verified feed it (pollers, `recheck`): verify's AssumeRole passes `feedsBreaker: false` (`assumedRole`,
  `refusalsMarked`), so players pressing Verify before CREATE_COMPLETE, or with an older link's stack, never trip it (nor
  clear it). A refused poll says nothing else
  (no lock lessons, no findings resolved), a restart doesn't retry it, and a new link (back to pending) or a verify clears it.
  A deleted stack's last role session can last an hour, so its districts may show locked first (`docs/connect-aws-account.md`).
  Verify learns fixes by DryRun; the role version is the template version the link points at (`v<N>` of its URL), recorded
  only when the player installed or updated from that link (a pending record's first verify, another Region or account, or
  `account.verify {updated}` from "I've updated the stack"): the account can't be read for it, so it's the version installed
  from the city's link, and a template version that changes permissions must add a probe like fixes'. `account.recheck`
  never changes it. The account commands share a 5 s cooldown per socket, except one verify within 2 minutes of that
  socket's own successful link; a waiting `resource.remove` counts with the socket's tasks, not its request slots. Hosted
  `account.status` carries `fixes`, `roleVersion`, `latestRoleVersion`, `templateUrl`. Against a phished link
  (`infra/player-role/player-role.yaml` v5): the stack's visible `ConnectsPlayer` names who it serves (public Mayor name, else
  a masked email, else "Player " + 8 characters of the sub: `connectsPlayerLabel`), and verify is refused 24 h after the link.
  A refused link or verify (the 24 h one included) is `error {requestId}`, never an `account.status`: a status with a requestId always means success. `resource.remove` takes down one game-owned thing with no model (approved
  like any write). `GET /me/export` (once a minute per player on each server task, an in-memory map in `server/src/http.ts`,
  so with N tasks up to N a minute; 429 otherwise; a failed download doesn't count, so a retry works at once)
  downloads everything the privacy policy lists:
  progress, link metadata (never the ExternalId or role ARN), social rows, the bill, AI counts, the first AI day and the
  MFA time (`firstDay`/`mfa.get` are plain reads).
  Serverless quest templates (`hello-api`, `queue-worker`) are practice builds on the server (`ServerBackend.planPractice`),
  never an EC2 house. Proof: `cd server && npx vitest run test/tenants.test.ts test/hosted.test.ts test/poller.test.ts test/guard.test.ts test/player-role.test.ts test/care.test.ts test/service.test.ts`,
  `npx vitest run tests/server-backend.test.ts tests/contract.test.ts tests/runtime-session.test.ts`, `cfn-lint` on the template (CI).
- **The player's own AWS account: easy to find, linked where they choose, easy to let go** (contract v2.19; rules pure in
  `src/state/account.ts`, `src/ui/Account.tsx`, the card in `src/ui/DeployPanel.tsx`). On the hosted server (and on any build that can sign in, once signed in: `hosted || signedIn && canSignIn()` in
  `src/ui/Hud.tsx`, so Sign out is where players look first) ⋯ → Account
  has the AWS account (its card in Deploy), Sign in or out, Download my data (`exportMe`, saved as a local JSON file) and
  Delete my account… (asked first, in a dialog), and Privacy policy ↗ when the build has its address (`WXT_PRIVACY_URL`,
  https only, `privacyPolicyUrl`/`openPrivacyPolicy` in `src/app/runtime.ts`; also on Deploy's sign-in card; a hosted store
  build needs it, and `npm run setup` asks for it and builds the store zips only with it).
  The To-do row, the shift's line (Everything) and ⋯ open Deploy with the steps unfolded (`openAccountCard`; the City
  tab's `ConnectCard` opens Deploy, which unfolds them for a player who can connect). Step 1 picks the Region by name (`LINK_REGIONS`, the commercial partition only; it starts on the
  Region asked for last, the linked one, else the city's) and says "AWS City’s role will be made in <Region>. The city
  builds and checks for issues there; a few reads cover your whole account", and "What the role can do" (`ROLE_CAN`: in-Region
  reads, the account-wide bucket list, AZs and bill (the role allows it any time, the server reads it only once it's on), what
  it builds, never IAM) with "See the exact permissions ↗" (`templateLink`: account.status's `templateUrl`, else the setup
  link's `templateURL`, https on *.amazonaws.com only); step 2 has "Allow small fixes" (a new link with `allowFixes`; the box
  follows the link that arrived) with "What small fixes allow" (`FIX_GRANTS`: BPA on any bucket, any SG rule, PITR on any
  table, IMDSv2, EBS by default; IAM holds only the last two to tightening, the server the rest), the ExternalId under
  Details said plainly (not a password: AWS doesn't treat it as a secret), who
  the stack serves (`connectsPlayer`: the link's `param_ConnectsPlayer`, "don't create the stack if that isn't you"),
  one list of what the console will ask (your own account, the Region to keep by name, `linkRegion` from the link's
  `?region=`; a sign-in that may create IAM roles and stacks, which workshop accounts can't; the IAM acknowledgement;
  CREATE_COMPLETE in about a minute, then Done and Verify; `linkChecklist` in `src/state/account.ts` holds the same
  points, but the card writes its own), Open CloudFormation or Copy link (for an AWS session in another browser), that
  the link works for a day, and for a host to use a different account from the one the city runs in
  (`docs/self-hosting.md` step 9 shows how to make one). Step 3, the account number, opens once they press "Done: it says
  CREATE_COMPLETE" (`accountInput` accepts the console's 1234-5678-9012 and a stray full stop). A refused link, verify or Disconnect
  (`error {requestId}`: a failed verify, a link over a day old) is said in the card as an alert (`account.error`) with
  "Get a new setup link". The linked card names the Region, says whether small fixes are on (and how to turn them on),
  offers "Update your AWS City role (vN → vM)" when `roleVersion < latestRoleVersion` (steps, the template address, the
  ConnectsPlayer name to type, which comes with a fresh setup link, and the stacks page), "Use another Region or account"
  and "Disconnect" (asked first, its words in `--ink-soft`, ≥ 4.5:1 on the red tint; hosted and the demo, never the local server; afterwards it says how to delete the AWSCity
  stack in that Region). "Check again" (hosted, under "Turn small fixes on") is `account.recheck` (`recheckAccount`): the
  role is asked again whether it allows fixes, read-only. The role update ends with "I've updated the stack"
  (`confirmRoleUpdate`: a fresh link, then `account.verify {updated: true}`), and its card says the city goes by the version
  installed from its link (it can't read the stack). The local server shows the restart hint instead of the CloudFormation
  steps (`FixesOn`, `LOCAL_FIXES_COMMAND`; the demo shows a practice line instead). In the demo, step 2 opens nothing (a
  practice link, `PRACTICE_LINK`, `practice.invalid`). The practice account links in the city's own Region
  (`AWSCityPlayerRole-<cityRegion>`). Verified from a practice link, its small fixes follow the box (off by default); the
  one-press practice account allows them. A broken link shows its message with Link again (a
  new link in its Region at once) and Disconnect. Only a reply to this tab's own request is toasted (a reply carries the
  requestId of the tab that asked; `src/app/runtime.ts` drops it in the others): a welcome or a broken link updates the
  card quietly, and the unlinked hint is a muted line, never an alert. City care says up front
  when the role doesn't allow fixes (no Fix button, so no approve or MFA first), and the Today fix goal is a bonus then.
  My builds lists the inventory's `managedByGame` items, so it survives a reload, each with Take it down
  (`resource.remove` for an instance, a table or a bucket; anything else is removed in the console), and Delete my
  account warns while they're still there (they keep billing). Every build preview keeps `confirmText`, like a fix: its
  'detail' lines in words ("Safety check: …") and the name typed before Approve. A practice build (`isPracticeDeploy`)
  says it made nothing in the AWS account and has no Tear down. Proof: `npx vitest run
  tests/account.test.ts tests/account-ui.test.tsx tests/deploy-account.test.tsx tests/runtime-session.test.ts
  tests/session.test.ts tests/finding-pacing.test.ts tests/release-check.test.ts tests/link-steps.test.tsx tests/menu-signout.test.tsx`.
- **Red-team pass, 21 Nov 2026: what an attacker with a page, a token or a laptop process can't do.**
  - The Console Copilot fills fields and points; the player presses anything that commits (a button, link or menu item
    with a commit word anywhere in its name: create, save, launch, add, attach…; any form submit control but
    Cloudscape's) and types any value that opens access (`0.0.0.0/0`, `*`) or names an account
    (`isCommitControl`/`isRiskyValue`, `src/console/risk.ts`, checked in the extension and on the server, on every page;
    the real console's own rules are in "The Console Copilot hands risky steps back" below). Page text is
    fenced as `<console_page>` data. Proof: `npx vitest run tests/console.test.ts tests/practice-console.test.ts`,
    `npm run smoke:copilot` (it plays the player through `[data-awscity-your-turn]`).
  - The local server takes only its token, never an Origin alone; the launcher mints a fresh one every run
    (`liveConfig`, `scripts/launcher/live-run.mjs`) and builds it into the extension, and the token is never printed.
    Proof: `cd server && npx vitest run test/http.test.ts -t "token"`, `npx vitest run tests/launcher.test.ts`.
  - A deleted account's sockets on other tasks close with `4403` (`stillHere`: each minute, `DELETED_CHECK_MS`, and
    before step-up, the bill, scores and presence); an approval given before a re-link never writes to the old account
    (`live()` inside the account lock, `RETIRED_REASON`). Proof: `cd server && npx vitest run test/hosted.test.ts -t "another task"
    test/service.test.ts -t "re-linked"`.
  - Model input is bounded and clean: the snapshot is capped (100 resources, 64-char names, 8k chars), player text loses
    keys, secrets, tokens and emails (`server/src/secrets.ts`), every persona carries `NO_SECRETS_RULE`, and on the
    self-hosted model each player's calls take turns with no retries. Proof: `cd server && npx vitest run
    test/runner.test.ts test/secrets.test.ts test/local-model.test.ts -t "take turns"`.
  - The refresh token lives in the extension's own IndexedDB (`src/backend/vault.ts`), never in `storage.local`
    (content scripts can read that); auto-snap skips pages that can show a secret (`autoSnaps`: an AWS page that's
    neither `isSecretPage` nor `isSensitivePage`, `src/app/runtime.ts`); page focus and
    Copilot messages from a web page's content script are ignored (`fromWebPage`). Proof: `npx vitest run
    tests/auth.test.ts tests/runtime-session.test.ts`.
  - Limits: screenshots 10 then 1 per 6 s per player, server-made `screenshotKey`s only, board reads cached 15 s per
    player, a private profile leaves the boards whichever task saves it. CloudFront adds AWS's managed security
    headers (HSTS, nosniff). CI installs before AWS credentials exist, saves no git credentials, pins the binfmt image,
    CodeQL also scans the workflows, Dependabot waits 7 days, and releases build read-only and publish separately;
    the `staging` environment deploys only from protected branches (`gh api repos/salman-abdulrazaq-ali/aws-city/environments
    --jq '.environments[]|{name,deployment_branch_policy}'`). Proof: `cd server && npm test`, `cd infra && npm test`.
- **Security Hub's best-practice checks are each fixed, suppressed with a reason, or deferred** (`docs/runbook.md` →
  Security Hub). In code: the server task runs as its nonroot user, Cognito threat protection covers custom flows, the VPC's default
  security group allows nothing. While Bedrock is held the server asks only the Fargate model (`aiCpu.primary`: one
  call and one quota count per answer, not a failed Bedrock try first). Proof: `cd infra && npm test` ("Security Hub
  basics", "Bedrock held"), and the runbook's `aws securityhub get-findings` command.
- **The repo and the AWS account are locked down.** GitHub: `main` changes only through a pull request with CI green
  (ruleset "main": the `extension`, `server`, `infra`, `fresh-clone` ×3 and `analyze` checks, no force-push or deletion,
  only the admin may bypass); Actions run only GitHub-owned, verified-creator and `softprops/action-gh-release` actions,
  pinned to a full SHA (required); fork pull requests from outside collaborators wait for approval; secret scanning with
  push protection; the `prod` environment needs the maintainer's approval and deploys only from `main`; `SECURITY.md`
  (private reporting) and `.github/CODEOWNERS`. The deploy workflow skips until `AWS_DEPLOY_ROLE_ARN` is set. AWS: the
  baseline in `docs/runbook.md` step 5 (GuardDuty, CloudTrail, Access Analyzer, EBS default encryption, a password
  policy, account-wide S3 Block Public Access for ACLs), and for the organization: no root user in member accounts
  (central root management), an organization trail, GuardDuty and an analyzer for every account, the SCP
  `AWSCityGuardrails` (stay in the org, security services stay on, no member root, three Regions), and Security Hub
  (Foundational Best Practices), Config and Inspector ECR scanning. The server image runs on distroless Node
  (`server/Dockerfile`: no shell or package manager, uid 65532); the AI image as uid 65534 on a read-only disk. Proof: `gh api repos/salman-abdulrazaq-ali/aws-city/rulesets`,
  `gh api repos/salman-abdulrazaq-ali/aws-city/actions/permissions`, the runbook's "Check:" commands.
- **Hosted deploys with Claude only run in Regions with a Claude geo inference profile** (Amazon Nova: any Region that offers it on demand) (`infra/lib/models.ts`: `us`, `eu`, `au`,
  `in`; there is no `apac` profile, so e.g. Tokyo is refused). Each geo gets the newest pair with a profile there for
  both models (`GEO_MODELS`, from the Bedrock model cards): Claude Opus 5.5 / Sonnet 5.5 in `us`/`eu`/`au`; India has no
  5.5 profile and keeps Opus 5 / Sonnet 5. Model ids and their IAM ARNs derive from the Region; synth and the setup
  wizard refuse other Regions. Local mode (`npm start` real AWS, `npm run live`) uses the same table: `localModels(region)`
  (`scripts/launcher/lib.mjs`, from `modelsFor` in `infra/lib/models.ts`) picks the Region's models for the launcher's
  Bedrock check and the server's `AWS_CITY_MODEL`/`_FALLBACK_MODEL`/`_LIGHT_MODEL` (`modelEnv`; a player's own env wins),
  so eu-west-2 runs on `eu.`, and with Claude a Region with no profile is refused in plain words before sign-in
  (`unsupportedRegionText` names the Regions that work). Only the bare server (`cd server && npm start`) keeps the `us.`
  defaults in `server/src/config.ts`. A new account's Bedrock errors are named in plain words (account still being
  verified, the use-case form, a quota of 0: `explainAwsError`, and the wizard's note; the launcher links
  `BEDROCK_ACCESS_URL`). Proof: `cd infra && npm test`, `npx vitest run tests/launcher.test.ts`.
- **Bedrock calls never force `tool_choice`** (Bedrock rejects it while thinking is on, and always for
  Claude 5.5-generation models; the defaults are Opus 5.5 / Sonnet 5.5, `server/src/config.ts`, but any model can be
  configured). Ask for the tool in the prompt and handle a missing call. Short routes use `effort: 'low'`. On 5.5
  thinking can't be turned off (never send `thinking: {type: 'disabled'}`), Opus 5.5 defaults to `medium` effort (set it
  where depth matters), and agent histories stay append-only (edited turns are refused).
  Proof: `cd server && npx vitest run test/console.test.ts`.
- **Players see no internal errors.** Hosted errors are a sentence plus a `ref` that finds the log line
  (`publicError` in `server/src/log.ts`); Bedrock's AccessDenied (the budget's deny policy) reads as the city's AI resting (code `paused`).
  A WebSocket frame the server can't read is answered "Bad command: this server didn’t understand that request.", never the
  schema's own words, and the socket stays open.
  Every box whose words go to the city's AI (the prompt bar and Copilot, HQ chat, Explain it back, a job's Explain, a
  workshop's pasted error) shows `AiNote` (`src/ui/AiNote.tsx`, one line, `aria-describedby`; the prompt bar folds it in:
  shown above the box while it has focus or words in it, visually hidden otherwise): it goes to the city's AI,
  so share no passwords, keys or address.
  Proof: `cd server && npx vitest run test/log.test.ts`, `cd server && npx vitest run test/hosted.test.ts -t "metered"`,
  `cd server && npx vitest run test/http.test.ts -t "version handshake"`, `npx vitest run tests/trust.test.tsx tests/panel-room.test.tsx`.
- **Shared AI calls can't be farmed with free sign-ups** (`server/src/agents/metered.ts`). A player first seen within the last
  `NEW_PLAYER_DAYS` (3) days (`QuotaStore.firstSeen`, the `USER#<sub> SEEN` row's first day)
  gets a fifth of `DAILY_MODEL_CALLS` (100 → 20), and those players together at most a quarter of `GLOBAL_DAILY_MODEL_CALLS`
  (`GLOBAL#NEW`, 20,000 → 5,000). Only a call that proves the model never ran is refunded (`provenNotRun`: 429/Throttling,
  403/AccessDenied, a 400 validation error, or a connection refused before the request was sent); never a timeout, a 5xx,
  an abort or a stream that produced any event (a thinking block counts). Scores and
  leaderboard reads are rate-limited per socket (burst 5, then one per 5 s). Proof: `cd server && npx vitest run test/hosted.test.ts -t "metered"`,
  `cd server && npx vitest run test/http.test.ts -t "rate-limited"`.
- **One seam to the backend.** Only `src/backend/` does network I/O. `contract.ts` is the source of
  truth; `docs/backend-contract.md` mirrors it. UI code reading the extension's own files goes through
  `readAsset` (`src/backend/assets.ts`: same-origin `/assets/` paths only). A client needs a server of its contract version or newer
  (`CONTRACT_VERSION` `'2.19'`, `src/backend/contract.ts`; the server's strict `Progress` schema refuses unknown fields): deploy the server
  first. v2.17 is a fresh sign-in on an open socket (`auth.renew`, step-up's `reauth_required`), v2.18 the AWS account on
  an approval card (`deploy.preview.accountId`), v2.19 the account's lifecycle below and the version handshake (it was
  drafted as v2.17 on a branch). The v2.19 version handshake checks it: the client names its version as `?contract=` on `/ws` and every REST call (a
  query parameter, since a new request header would fail an older server's CORS preflight); every REST answer names the
  server's in `x-aws-city-contract` (CORS-exposed; `/health` has it and the server's version in its body, on purpose: ops
  read which build answers); a client newer than the server, or older than
  `MIN_CLIENT_CONTRACT` (`versionRefusal` in `server/src/http.ts`; versions compare as major.minor numbers, `compareContract`),
  is refused with 409 on the upgrade and on `GET`/`PUT /progress`, and an unversioned client predates it and is let in
  (`MIN_CLIENT_CONTRACT` stays `'2.0'`: a v2.18 client sends no version, and no older numbered client is turned away). After
  two refused upgrades `ServerBackend` asks GET /progress why: status `updating` (the server is older: saves wait on the device,
  asked again every 60–90 s) or `outdated` (update the extension; no retries), an amber dot and one calm line above the tabs
  (`SyncNote`, `syncLine` in `src/ui/logic.ts`: "The city’s server is being updated — your progress is kept on this device" /
  "A newer AWS City is ready — update the extension"), never a schema error. A `PUT /progress` refused with a 4xx (not 401 or
  409) isn't re-sent on every open: `onSave` reports `refused`, and the same line says "Not saved to your account — kept on
  this device" until a save goes through (`CityState.saveRefused`); 5xx, network errors, 401 and 409 keep the copy for the
  next open. v2.19 adds `account.unlink`, `account.recheck` and `resource.remove` (an older server refuses an unknown action
  as a bad command), `account.link.allowFixes` and `account.verify.updated` (an older server's `account.link`/`account.verify`
  schemas aren't strict, so it drops them silently: the link lacks AllowFixes, the version isn't moved), `account.status`'s
  lifecycle fields and REST `GET /me/export`; `ServerBackend.send` ends in a `never` default, so a new command can't be dropped silently.
  Proof: `npx vitest run tests/contract.test.ts tests/server-backend.test.ts tests/assets.test.ts tests/ui-logic.test.ts
  tests/account-ui.test.tsx tests/runtime-session.test.ts`, `cd server && npx vitest run test/http.test.ts -t "version handshake"`,
  and `grep -rn -e "fetch(" -e "WebSocket(" src | grep -v src/backend/` prints nothing.
- **Content is data in `shared/`** (world, flashcards, puzzles, quests, templates). JSON imports need
  `with { type: 'json' }` because the server runs as NodeNext ESM.
- **Art is generated, not hand-placed:** `npm run art` imports the team pack from
  `agentic-city/index.html`, then runs the character generator and the tile generator. The grid is
  **32×16**, the pack's exact scale. Sprite names must be unique, and the generator fails on duplicates. Frames are
  trimmed and MaxRects-packed: at most 3 pages of 2048 px and 10.5M packed px; two runs give a byte-identical atlas.
  Prop helpers live in `art/tiles/shapes.py`, the service-building kit in `art/tiles/services/kit.py` (a prism face is
  always solid; a bare `face()` shader returning None leaves the wall under it, for decals). The mini-games' stage props
  are `game:<game>:<prop>` from `art/tiles/games_art.py` (side views at 1×: Shield Wall's wall pieces and flood frames,
  Red Team's lane booths and scanner, Queue Juggler's belt, bench, tray and dead-letter bin, Permission Gate's posts,
  boom arm, notice board and booth, Edge Cache's counter, phones and envelopes); a game draws them at its play scale
  (`prop()`, `src/game/scenes/games/cast.ts`) and keeps a drawn fallback when `hasSprite` is false (the notice board and
  the counter are 9-slices, drawn off WebGL too); tiled and 9-slice pieces are opaque edge to edge so the atlas never
  trims them. Nothing covers what a player reads to decide: the Permission Gate's notice board hangs above the boom's
  whole lift (`gateRows`, `liftReach`), and Queue Juggler's belt labels lift clear of each other and of Eddie's chip on
  strings to their boxes (`stackChips`), inside the stage, the parcels keeping their timing. Proof: `npx vitest run tests/art.test.ts tests/stage-shield-redteam.test.ts tests/stage-queue-iamgate.test.ts tests/stage-edge.test.ts`.
- **Text is crisp in a pixelArt world:** use `crisp()` from `src/game/SpeechBubble.ts` (LINEAR filter
  plus DPR resolution) and counter-scale by `1/zoom`. Camera zoom stays on integers, and sprites on whole-number scales:
  a mini-game's play group is 1× in the side panel and 2× in the tab (`playScale`, `src/game/scenes/games/stageFx.ts`;
  `fitScale`, `cast.ts`), never 1.5×. Canvas text is never under 11 px (`MIN_TEXT_PX`, `textPx` in `src/game/theme.ts`)
  and follows ⋯ → Text size. Proof: `npx vitest run tests/game-stage.test.ts tests/game-theme.test.ts`.
- **Sound:** SFX only, no music; on by default and soft. One mixing path (synth voices play through Phaser's audio
  context), nothing scheduled before the first gesture (dropped, never queued), nothing while the page is hidden, a
  priority mixer so one action makes one sound (a big clip holds lower sounds for its own length), and mute synced across
  the panel and the tab (storage event), faded so it never clicks. Levels live in one table in `src/game/audio.ts`.
  Sounds answer the player: the city is silent while it sleeps (world map, HQs, games: `CityScene.play`), agents talking
  among themselves never blip (`silent`), one blip at a time in each speaker's fixed note, the work sound only for the
  player's own task, AWS status chimes follow the news rung, and the demo's chatter is talk only (no `agent.state`).
  Mini-game rounds start from a synced clock (`syncClock`), are laid out at the stage's current size (`fitParent`,
  `src/game/scenes/games/column.ts`: the side panel's stage grows for a game before Phaser's 500 ms size check), keep
  their end card on resize, and build combos (`combo.ts`). Each game is a scene with people in it, not a form: the
  service's agent at work and crowd citizens as requesters (`person`, `cast`, `cast.ts`; their loops hold still under
  reduced motion), the landmark at its level in this city where the game has a place (`landmarkFrame`), and props. Its chrome wears the
  desk's tokens (MiniGame's `PAL` = `GAME_PAL`, scoring's `PILL` = `GAME_PILL`, `src/game/theme.ts`: graphite, the one
  amber primary, pale gold for Expert, the flashcard's paper for the end card, `bad-ink` for red text); a scene's art
  keeps its own colours (skies, the lake, district colours). Its text is `TXT` (the design size × 0.85 × ⋯ → Text size,
  never under 11 px), and the end card lays its buttons out by measured width.
  Proof: `npx vitest run tests/audio.test.ts tests/game-clock.test.ts tests/contract.test.ts tests/game-theme.test.ts tests/game-stage.test.ts tests/stage-shield-redteam.test.ts`.
- **Each AWS Region is its own city, built from real facts.** A first run opens on the world map (`WorldScene`); picking a
  Region dives into its city (remembered in prefs), and so does the first run's "Start in <city>" (`requestDive`,
  `src/game/worldUi.ts`: the card steps aside at once, `inert`, and the Region opens when the dive has faded to the sea;
  with no map running or under reduced motion it opens at once). The map's own words fade as a dive starts, and the
  minimap's box waits for the city's first answer. The map's text follows ⋯ → Text size, never under 11 px
  (`worldText`), on the theme's tokens (`LABEL_BG`); its art and the data links' colours are its own. Each of the Region's real AZs is an island across the river that rings
  downtown (`zonesFor` → `azsFor`, slots in `AZ_SLOTS`; `shared/region-facts.json`: six in us-east-1, four in us-west-2; the
  linked account's own AZ names when known), with one bridge each onto a core road, so cross-AZ packets cross both bridges
  through downtown; a fenced lot for each service AWS doesn't offer there (with when, or whether, it's coming), and list prices per Region
  (`shared/prices.json`). Both files are generated with their sources: `npm run region-facts` (AWS Knowledge MCP; a service's own
  Regions page overrides the availability tool, see `OVERRIDES`; Security Agent, Macie and Polly have no tool rows, so their
  pages are the only source, `pageOnly`; `NOTES` carries a caveat a service's page states, re-read each run: App Runner is
  closed to new customers) and `npm run prices` (Price List Bulk API + the pricing pages'
  data; never the 440 MB EC2 file). The server mirrors every Region only with a Resource Explorer aggregator index in the home
  Region; findings are checked in the home Region. Proof: `npx vitest run tests/regions.test.ts tests/terrain.test.ts tests/roadgraph.test.ts tests/region-facts.test.ts tests/prices.test.ts tests/world-dive.test.tsx`,
  `cd server && npx vitest run test/care.test.ts`.
- **Live traffic is opt-in, and real.** `flow.enable` (contract v2.8, `Progress.flow`) turns on a read of a few request
  counts from the player's CloudWatch (`server/src/state/flow.ts`: four fixed Metrics Insights queries, one per
  `GetMetricData` call, at most every 5 minutes while a tab is open, 96 a day, kept in memory only). The player role
  grants `cloudwatch:GetMetricData` alone, held to its Region (v4). The city drives request cars for the rates
  (`carsPerMinute`): load balancer requests to the AZ islands that served them, the rest to their buildings.
  Proof: `cd server && npx vitest run test/flow.test.ts test/player-role.test.ts`, `npx vitest run tests/contract.test.ts tests/carriers.test.ts`.
- **The city mirrors the account's map; the bill is opt-in.** `city.inventory.zones`/`regionStatus` come from
  `ec2:DescribeAvailabilityZones`/`DescribeRegions`, cached a day; a Region that can't be read is left out. `city.bill`
  (`ce:GetCostAndUsage`, $0.01 a request) is read only after `bill.enable {on:true}`, then at most once a day per player;
  `shared/ce-services.json` maps only verified Cost Explorer service names (the rest show as "other"). Servers, tables and
  buckets follow the poller (DescribeInstances, ListTables + DescribeTable, ListBuckets), not the listing (Resource
  Explorer lags by minutes: on 22 Nov 2026 a terminated server stayed on the map, a new one called demo didn't appear,
  and a bucket and a table an agent built took minutes to show): `enrich` (`reconcileLive`, `server/src/state/inventory.ts`)
  drops what's on its way out (a terminated or shutting-down server, a DELETING table), adds what the listing hasn't
  caught up with (first, under the frame's item cap; a bucket in its own Region) and names servers from their Name tag;
  a listed item the poller doesn't show is dropped only when that service was read in full (ok, under
  `MAX_PER_SERVICE`). A table listed and then not found mid-poll is skipped, not a failed DynamoDB read. A poll that
  creates, removes or changes a server, table or bucket (`movesInventory`, `server/src/state/diff.ts`) re-sends the
  mirror from the last listing (`care.reconcile`, no AWS call), and the mirror's "changed?" signature includes the items,
  so a terminate plus a launch with the same counts is still sent. A listing builds from the newest snapshot once its
  `readGeo` is done, never the one from before it (seen 22 Nov 2026: a terminated server came back until the next
  listing). An agent's write re-polls at once and after 4 s (not once its world is retired), so the map follows it
  within seconds. The feed says each kind's and state's lesson once per session (`feedEvents(e, said)`,
  `server/src/contract/aws-feed.ts`), then just the change. HQ chat on the CPU model names servers the player made
  themselves (`otherServers` in `snapshotSummary`), and every chat answer knows it can't change AWS and that the city
  only changes what it built (`CHAT_CAN_DO`, `server/src/contract/orchestrator.ts`; seen 22 Nov 2026: asked to delete a
  console-made server, Eddie said he couldn't see it). An audit line hashes a new bucket's real name (never the `<account>` placeholder), so it matches the gate's line. A plain request's
  task ends at `task.done`: the agent's few words after it run on their own (`explainAfter`), so the task's slot (two a
  socket) is free at once (seen 22 Nov 2026: "Two tasks are already running" right after a card said done). They're
  skipped on the CPU model (`llm.small`: one call per player at a time, so they held the next chat answer 30–75 s; the
  card's result line says what changed; chosen 23 Nov 2026) and never said once the world is retired (Disconnect, a new
  link: the orchestrator's `retired`). A retired world says nothing more either: `onSnapshot` returns first thing, and
  a listing that lands after it isn't broadcast.
  Proof: `cd server && npx vitest run test/bill.test.ts test/care.test.ts test/player-role.test.ts test/diff.test.ts
  test/poller.test.ts test/runner.test.ts`, `cd server && npx vitest run test/care.test.ts test/contract.test.ts -t
  "DescribeInstances|bucket or table|newer snapshot|lesson|chat answers|explanation|retired"`, `cd server && npx vitest run
  test/tenants.test.ts test/service.test.ts -t "after account.unlink|retired"`, `npx vitest run tests/contract.test.ts`.
- **Street plans come from OpenStreetMap, baked.** A Region with `shared/city-maps/<region>.json` (v1, ODbL, © OpenStreetMap
  contributors) gets a 64×64 core of its real downtown's streets: `src/world/citymap.ts` decodes and validates it,
  `src/world/zoning.ts` zones it (superblocks keep today's insides, blocks → water/park/building, 3×3 lots fronting a
  sidewalk, seven districts grown from compass seeds round the square, round robin to `DISTRICT_RESERVE` lots, then to
  ≥ max(services + 2, 10); HQ nearest the square, services nearest their seed in world.json order, so appending one moves
  nobody while its district has room; the map must hold services + 20 lots). A tight map tries harder before giving up
  (`EFFORTS`: drop minor streets, a neighbour's spare block, split big blocks, back streets `withAlleys`, build on the
  smallest parks; `CityPlan.zoning` says what it took): every baked Region zones. Anything that doesn't decode or zone,
  a Region without a file, or `?map=legacy` (a dev param: a store build ignores it, `legacyForced`) keeps `legacyPlan()` (`tests/plan-snapshot.test.ts`): six lots a district
  and no plot for the seventh (management), so the services it has no lot for (`UNPLACED_SERVICES`) aren't in that
  city (the places list says "not here in the classic city"; a quest's visit counts at once). The
  ring's land and sea come from the baked water mask; the ring river, islands, highway, park and airport keep their rules.
  The city shows "© OpenStreetMap contributors" (bottom-left, every zoom; ⋯ credits; postcards), linking only
  openstreetmap.org/copyright through `openOsmCopyright` (no map requests: the data is bundled). Minimap: `src/game/minimap.ts`
  + `src/ui/Minimap.tsx` (M toggles; on in the tab, a 🗺 button in the panel; click pans).
  Proof: `npx vitest run tests/plan.test.ts tests/plan-snapshot.test.ts tests/minimap.test.tsx tests/terrain.test.ts tests/roadgraph.test.ts`,
  `npm run smoke` (section "street maps": three real cities, day/night, tab/panel, `?map=legacy`).
- **The city stands in a landscape.** `src/world/terrain.ts` (pure, the same per Region every time) rings the core (40×40 legacy, 64×64 street map):
  a river round downtown, the Region's AZs as islands with bridges, the highway out through the gate, and a coast and biome
  sampled from the world map at the Region's real position (an impression, not a survey). `src/game/Landscape.ts` bakes
  the ground into RenderTextures (Phaser 4 needs `.render()`, re-baked on `restorewebgl`) and draws at most `MAX_PROPS`
  props; there's one sea colour, `src/game/palette.ts`, and it matches the sea texture. The core's ground is baked in chunks
  (`src/game/GroundBake.ts`, `src/game/chunks.ts`) and static props off the view are culled (`src/game/cull.ts`).
  Proof: `npx vitest run tests/terrain.test.ts tests/chunks.test.ts tests/cull.test.ts`.
- **City life is ambience, never AWS activity, with three exceptions: AWS's own status, data carriers, and learning couriers.** Traffic, boats, the sky
  and the dim baseline packets (`src/game/Ambient.ts`) only say how much of the account lives here. Ambient cars are data-themed
  for looks only (server, packet, fibre and cloud vans, `CAR_SKINS` in `src/game/Traffic.ts`): no beacon, never a carrier's colour,
  not tappable. The demo's links to other Regions arrive only once the practice account is linked (`demoInventory`
  `crossRegion`), so nothing the player didn't connect crosses the world map. Only agents' work animations
  and data carriers mean work: a replication tanker, a standby van and a request car drive only for a real `DataLink` of the
  account (`RegionOverlay` → `Ambient.dispatchData` → `Traffic.spawnData`), wear the `veh:data:*` sprites with a roof beacon,
  can be tapped (`CarrierCard`, text in `shared/carriers.json`), share the vehicle cap (an ambient car gives way; at most
  `DATA_CAP` 6/3) and fall back to the packet convoy when they can't drive. Learning couriers (`src/world/couriers.ts`) teach,
  they don't report: each drives one leg of a `shared/flows.json` flow between two buildings the player has put up (CloudFront →
  S3, API Gateway → Lambda…), a plain white car tinted its district's colour with a dashed trail, never a `veh:data:*` skin
  or a beacon; tapping one says what the flow does ("How data flows", the combo's or the flow's sentence and source). They
  share the vehicle cap (`LEARN_CAP` 3/2, `LEARN_RUSH_CAP` 5/3, both under the vehicle cap beside `DATA_CAP`); at the
  city's rush hour (8–9 and 17–18 local) more set off and Auto Scaling plays at EC2 and Lambda (`SCALERS`: helpers in
  the workers' places, so the crowd cap holds; they scale in when it ends). Storms
  (`src/game/Weather.ts`) and red/amber outage fences come only from the public AWS Health Dashboard (contract v2.6 `aws.health`). They're
  pooled and run without tweens; they pause while the page is hidden and park under reduced motion. Walkers stand still
  under it too (`Stillness`, `src/game/stillness.ts`, re-read each second like Ambient): citizens, workers and visiting
  Mayors stop where they stand, an idle one gets `STILL_TIME` and never wanders off, and workers run no errands; the
  landmark agents and the Well-Architected patrols take the same still clock (CityScene's `stillness`), while a task's
  walk, a walk to work and a finding's visit still go. Everyone stays tappable and no walker is added or removed. Each surface has caps
  (applied by `Ambient.setSurface`, tab/panel; defined in `src/world/traffic.ts`, `Boats.ts`, `Sky.ts`, `Packets.ts`): citizens 26/14 (`crowdSize`: districts open plus one per Practitioner building), vehicles 14/8, boats 3/2, clouds 3/2, packets 24/16. A* gives up after
  6,000 expansions (a binary-heap open set), routes are cached per grid version, and `CityMap.sync` skips the ground pass unless a district or tier changed.
  Proof: `npx vitest run tests/traffic.test.ts tests/traffic-sim.test.ts tests/carriers.test.ts tests/roadgraph.test.ts tests/flow-trickle.test.ts tests/pathfinding.test.ts tests/walkers-still.test.ts tests/agents-still.test.ts`;
  `npm run smoke` asserts the caps from `awsCity.ambient.stats()` and logs FPS (it only warns, and headless caps it at 30).
  Learning traffic: `npx vitest run tests/living-city.test.ts`; `npm run smoke` (81: couriers and helpers at rush hour).
- **A city that looks and feels alive** (round 3). *Combos:* `shared/combos.json` (20 pairs and trios, each with one plain
  fact and its AWS docs source, `combo:<id>` art) are found when every service is put up in this city (`combosFound`);
  each prop stands on free ground nearest the middle of its buildings within its `radius` (`placeCombos`, before the
  rest of decor, a tile apart, never beside a door; no `rng()`), is tappable for its fact, and a new one sparkles and goes
  to the Codex (`discoverCombo`). *Seasons* (`src/world/seasons.ts`): meteorological, by the real month and the Region's
  hemisphere (summer all year inside the tropics); `?season=winter` (a dev param: a store build ignores it, `seasonParam`) or `prefs.season` overrides. The art swaps
  `<name>` for `season:<s>:<name>` where it exists (`seasonal()` in `src/game/assets.ts`, same canvas and anchor), the baked
  ground takes `SEASON_TINT` and stamped decals (snow, leaves, petals), and some flower beds become snowmen or umbrellas
  (nothing added, so no extra draw calls). *Next-level previews* (`src/world/preview.ts`): a picked building shows its next
  level's sprite see-through over it, rimmed in blueprint blue (Phaser 4 `Glow` filter, knockout, WebGL only), and one
  line ("Next: Practitioner · adds “…” · 7 reviews to go"). Combos already standing when a city loads go into the Codex
  quietly (`discoverCombo(id, { quiet: true })`: no toast, no coins). *Pocket parks*
  pick their centrepiece and corner piece by the lot (`pocketParkFor`, `bigParkFor`, `parkCornerFor`), and a building site
  (tier 0) draws only its own crane (no second `crane1x1`). Proof: `npx vitest run tests/living-city.test.ts tests/art.test.ts
  tests/plan-snapshot.test.ts tests/clients.test.ts`; `npm run smoke` (80 combo found, 82 ghost, 83 parks, 84 a business
  inside us-west-2, 85 winter).
- **Tabs: City · Learn · Jobs · Deploy** (`TABS` in `src/app/App.tsx`; ids `home`/`learn`/`jobs`/`deploy`). City is today's
  shift plus the places list, and a tapped building's card opens there (no other tab). Learn is Cards · Puzzles · Drawing
  board; Jobs is City Clients (the order board, then every business; `openClients(id)` routes there); Deploy is the old
  Build tab. HUD Build is "Decorate". Proof: `npx vitest run tests/ladder.test.ts tests/ui.test.tsx`, `npm run smoke`
  (checks the tab titles).
- **New players climb an unlock ladder, and unlocks are earned.** `src/state/ladder.ts` (pure) opens tabs and panels as
  progress grows. Going somewhere (a button that names a tab, a building tap) shows that tab while the player is there but
  never opens it for good; only ⋯ → Show everything does (`opened`; it also turns Simple mode off). Findings are held until city care unlocks (a linked account sees them at once),
  then drip in least severe first, at most `MAX_OPEN_FINDINGS` open; hardware-choice advice (`ADVANCED_RULES`: Graviton,
  previous generation, gp2) waits until a quest is finished and comes last. A finding with no automatic fix has "Got it"
  (`ackFinding`: resolved, remembered on the device until the player signs out, like held findings), so it never holds a place for good; the demo never sends a finding in
  `Progress.fixes` open again (`MockBackend.putProgress`). AWS news (the ticker and incident toasts) is a rung too:
  it opens after the first quest, and the demo's practice drill waits for it (`MockBackend.putProgress`); storms still show.
  There's no "Open anyway" list: the shift's "Coming up next" names the next unlock and how to earn it. Deploy also shows
  while a real account is being linked (`linking` in `src/state/account.ts`: a setup link is out, the server asked for an
  authenticator first, or the link broke), so its steps never vanish mid-link, and for a hosted player who can link one
  (`canConnect`); linking opens nothing else.
  Proof: `npx vitest run tests/ladder.test.ts tests/finding-pacing.test.ts tests/contract.test.ts tests/account.test.ts`.
- **Simple by default** (`prefs.simple`, absent = on; `src/state/simple.ts`). Every surface asks `shows(feature, prefs, ctx)`:
  Home, the HUD, the tabs and the Drawing board (`App.tsx`), My City (`Collection.tsx`), the news ticker, the toasts
  (`discoverCombo`, `watchBadges`), City care's release (`careUnlocked` in `src/app/runtime.ts`) and the city's courier
  hint, blueprint card and rush-hour surge (`CityScene`). Simple's City tab is one To-do list (`buildTodo`: the next
  action, today's goals and the order board's jobs, deduped by key, at most `TODO_MAX` 5, each a box, one line why and one
  button that says what happens; "To do n/m" counts only the rows that can tick (`todoProgress`: today's goals, never the
  next action or the board's filler jobs), then "Done for today. Come back tomorrow: N cards ready"; on a day with fewer
  than `DAY_MIN_DONE` 2 goals an open quest step holds the day open and counts as a row (`holds`), so a first day is the
  step plus one goal; a hosted, signed-in player with no working link gets one quiet row, "Connect your AWS account", or
  "Link it again" once the link broke (`connectOffer`, `src/state/account.ts`): after the goals, never counted, the first
  to go over `TODO_MAX`, gone once the day is done, while ⋯ → Account always has it); a walk run from a game, an HQ or the world map goes back to the city first (`walkTo`,
  `walkToStation`); in the city, Simple drops the islands' "AWS trouble" labels and the drill's citizen talk, and the
  "E · Visit X" hint goes once its step is done; the HUD is ⭐ · coins · To do · Decorate · ⋯; tabs City · Learn · Jobs, Deploy only for a deploy step, a linked
  account, a change waiting for approval, a real account being linked (`linking`) or a hosted player who can link one
  (`useCanConnect`: signed in, nothing linked; the ladder opens Deploy for them too, and Deploy shows the three linking
  steps at once). One way in to linking shows at a time: the City tab's `ConnectCard` (never a second primary button)
  stands above the list only while no "Connect your AWS account" row is in sight (so it comes back once the day is done
  or the row is under "+N more"), and with Everything on only when the shift's `ConnectLine` offers nothing
  (`useConnectOffer`, `src/ui/Home.tsx`); Learn hides the Drawing board (a design step shows it); City care waits for a
  finished quest; My City is buildings, stars and coins. Hidden, never deleted: badges, combos, coins, the season road and
  the shift keep recording, and ⋯ → Show everything / Keep it simple switches back and forth with nothing lost, and ⋯ → I already build on AWS turns Everything on, as the world intro's button does. The tour's
  second step points at the list. Proof: `npx vitest run tests/simple.test.ts tests/simple-ui.test.tsx tests/session.test.ts tests/account-ui.test.tsx tests/connect-card.test.tsx tests/a11y-focus.test.tsx`, `npm run smoke`
  (runs Simple first: `01s-simple-first-city`, `80-simple-home`, `80b-simple-task-ticked`, `80c-simple-day-done`,
  `80d-simple-panel`, `80e-simple-tour`; then turns Everything on for the feature checks).
- **Home is Today's shift** (with Everything on; the City tab, `src/ui/Home.tsx`): one big button from `nextAction` (`src/state/next.ts`, pure
  `planNext`: the active quest step, then ≥ `DUE_MIN` cards due, a new quest, a building one action from its next level,
  a client's job, then Connie's after-quests offers), labelled with exactly what happens ("Walk to S3 Lake", "Review 5
  cards", "Solve: Static site") and naming the tab it opens when the label doesn't ("opens Learn"); then the order board
  (3 open jobs, "Go → <station>"), Ready to upgrade, today's goals as a ring and chips, and an end-of-shift card once the
  day's own goals are done (`shiftSummary`: ⭐ by building from the device-local `shift` log, 🪙 from `Progress.wallet.log`,
  the streak, "Come back tomorrow: N cards will be ready"). A chosen certification shows on the shift as a progress bar
  (`CertGoal`: role=progressbar, "Cloud Practitioner: 3 of 5 areas ready" and the areas missing). Everything else is
  folded under More to do. Quest steps'
  buttons say what they do (`stepButton`: "Walk there", "Open cards (Learn)", "Solve it (Learn)", "Approve it in Deploy"),
  never a bare "Go"; each step done toasts a ✓ and bumps its building (`questStep` on the bus). The first screen says
  what AWS is in one line (`WorldIntro`); its "I already build on AWS" turns Everything on (Simple off) and opens every area, and after either button focus moves to the City tab's panel unless the city's canvas took the keys (then the arrows walk Kai); First Brick needs a building put up somewhere (`anyBuilt` in
  `src/state/badges.ts`); the news ticker doesn't rotate on its own under reduced motion (its button still steps). Proof:
  `npx vitest run tests/next.test.ts tests/ui.test.tsx tests/onboarding-fixes.test.tsx tests/world-intro.test.tsx`, `npm run smoke` (one primary button on the shift).
- **Learning has a daily rhythm and a goal.** The shift shows Today (a few cards, a puzzle, a fix: only areas that are open;
  `todayGoals` in `src/state/progress.ts`; the day's set is fixed at its first look, `settleToday`, and areas that open
  later are bonus goals that don't move "2/3 done"; "Fix something" is a day goal only while an open finding's fix gate
  passes (`fixableNow`) and "Do a workshop step" only while a step would still pay (`stepsLeftToPay`), else they're bonus
  chips, so neither holds "Done for today" shut) and the certification the player chose in Golden Jacket Hall
  (`prefs.certGoal`, `certProgress`). Each building's sign counts its reviewed cards due again (🃏, `dueFor` in
  `src/state/srs.ts`, re-read each minute; shown with the name under the label budget). Each building's card offers "Which one should I pick?" comparisons
  (`shared/comparisons.json`, AWS decision guides as sources, `CompareCard`). ⋯ → Save a postcard downloads the city as a
  PNG with its caption (`src/game/postcard.ts`, nothing uploaded). Proof: `npx vitest run tests/comparisons.test.ts
  tests/ui-logic.test.ts tests/culture.test.ts tests/content.test.ts`.
- **Partners are linked, never copied.** Each building's card has a Learn more shelf (`src/ui/ReadingShelf.tsx`,
  `shared/further-reading.json`): a Tutorials Dojo cheat sheet for every service, AWS Fundamentals articles where they
  have them, then books credited with their authors. Links open only on the partners' hosts (`isReadingUrl`, separate
  from `openDocs`, which stays AWS-only); the extension never fetches them. Check each link opens before adding it.
  Proof: `npx vitest run tests/reading.test.ts`.
- **Quests teach in order and end with "Explain it back".** A quest's drawing only asks for services the quests taught
  before it; a cards step that due cards can't fill tops up with practice cards, which pay review stars but don't move
  the schedule (`questPracticeDeck`). The celebration card asks one question about the quest's first service; the
  player answers in their own words (≥ 6 words, ≤ 600 characters). A rules-only check shows the service's keywords they
  used and missed (`src/state/explain.ts`), and the building's agent gives kind feedback through the ordinary `chat.ask`
  route (no contract change; the demo's reply starts from `EXPLAIN_MARK`). Proof: `npx vitest run tests/explain.test.ts tests/ui.test.tsx
  tests/content.test.ts tests/learning.test.ts`.
- **Each mini-game has an Expert round from building level 3** (`EXPERT_TIER`, `src/game/pace.ts`): quicker (`EXPERT_PACE`),
  quiz games deal only the two harder tiers (`dealRound`), stars × 1.5; it ends when the player leaves the game and never
  mixes with Games without a clock. Proof: `npx vitest run tests/a11y-prefs.test.ts`.
- **One goal, one celebration.** The City tab has one primary button (the shift's next action, or in Simple the first task still
  to do; nothing competes on a first run's world map). A big moment gets one channel: a tier-up celebrates on the building (no toast), in
  order (`tierUpTimeline`, `src/game/cityView.ts`): the camera lands while the new building waits on its ground floor,
  it rises floor by floor (or its crown drops), then one payoff (one burst, the banner, the fanfare, the cheer), then the
  push-in 250 ms later, only if the building is in view; under reduced motion a cut and the payoff at once, still. A
  finished quest opens the celebration card (`src/ui/Celebrate.tsx`, no toast). While that card or a mini-game is up, info toasts (badges, AWS
  status, a drill) wait and come one by one after it closes (`toastsHeld` in `src/state/store.ts`; errors still show), the
  ticker hides during the card, and the card's backdrop stops the presses Phaser hears on the window (`useShieldGame`).
  AWS status leads with plain words (`plainIncidentLead`: "Practice storm: nothing is wrong with your city"). A golden
  token's bubble is short and gold ("✨ Golden token! 1 of 6 · +5 points", no exam code) and waits for a tier-up's cheer;
  bubbles stay below the ticker (`setBubbleTopInset`). Players see stars (⭐) for knowledge and City Coins (🪙) to spend, never "XP".
  Proof: `npx vitest run tests/moments.test.ts tests/incidents.test.ts tests/tokens.test.ts tests/ui.test.tsx tests/city-view.test.ts`.
- **Each Region is its own city** (contract v2.7, `src/state/cities.ts`). Landmarks live in `Progress.cities[region]`;
  global services (`shared/region-facts.json` `global`) stay in `Progress.landmarks` and stand in every city. Knowledge
  (cards, quests, puzzles, citizens, streak) follows the player, and a building put up in a city for the first time
  starts from it: the new-card stars (4⭐) for each of its cards the player knows, below Expert at most (`carriedStars`,
  `CARRY_MAX`), once per city (copies merge by the higher xp). Old saves migrate into the city being built. Selectors
  take the Region (`isDiscovered(p, id, region)`); without one they mean "anywhere". Your real resources stand where they
  live (`src/world/resources.ts`, `shared/resource-props.json`): servers on their AZ's island, buckets on the lake. The
  server names each item's type the way the props are keyed (`CFN_TYPE` in `server/src/state/inventory.ts`: ARN types →
  CloudFormation names; S3, SQS and SNS ARNs have no type segment, `UNTYPED`); before 21 Nov 2026 every real item went
  out as `ec2:instance`-style types and stood in a shed. Proof: `npx vitest run tests/cities.test.ts tests/resources.test.ts`,
  `cd server && npx vitest run test/progress.test.ts test/care.test.ts -t "type names"`.
- **Plain language.** Player-facing text goes through `<Plain>` (`src/ui/Term.tsx`): every glossary term and service
  name can be tapped for its definition. Every acronym a player reads is a glossary term, a service name or on the allow-list.
  Simple words first: every flashcard has `simple` (≤ 110 chars), every puzzle `simpleWhy`, every service `simple` (≤ 90);
  the full text sits behind "Tell me more" / "For AWS learners" (so do a drawing's pillar meters and best-practice ids, and
  a practice build's real cost: the demo says "Practice: free, nothing is created"; a removal says what practice removes, its own "Practice:" note shown as it is). A flashcard's question only marks its
  terms (`still`: a tap anywhere flips it); the answer side repeats the question with tappable terms. "Learned" means known
  (`isKnown`: Knew it/Easy, not "Didn't know"). Proof: `npx vitest run tests/content.test.ts tests/ui.test.tsx tests/ui-logic.test.ts tests/deploy-copy.test.tsx`.
- **The map stays calm.** Labels follow one budget (`src/game/labels.ts`, colours in `src/game/theme.ts`): names on hover or
  zoom ≥ 2, technical labels (AZ IDs, network notes, distance signs) only with ⋯ → Show the map details (`prefs.mapDetails`).
  Every issue cone shows, but only the most urgent one's "!" tag (and it alone bounces); the rest show from zoom 2 or on the
  building the player is looking at (`IssueMarkers.setTagsShown`). The ticker leads with this city's Region; a weeks-old
  outage elsewhere waits behind fresh news (`tickerItems`). From zoom 2 a view holds at most `signCap` building signs
  (10 at zoom 2, 6 from zoom 3 on the tab's map, a share of that on a smaller one such as the panel, never under 3;
  picked ones don't count), ranked picked, then standing in view, ready to upgrade (`readyToUpgrade`), nearest Kai
  (`signRank`). A sign says "· Lv N" only while picked or hovered (`Landmark.setDetailed`); its service icon is
  counter-scaled with it and counts in its room with the "×N" badge (`labelBounds`). One overlap pass (`keepTags`, run by
  `placeSigns` on a view change and every 200 ms) keeps tags in `TAG_ORDER`: Kai's, the "E · …" hint, signs, working
  agents', then citizens' (a hidden walker's tag is muted, `Agent.muteTag`; hover shows it). During an upgrade's push-in
  labels go by the resting zoom (`labelZoom`), so nothing pops on and off. The first-courier tip waits while a toast or
  the coins note is up (`overlayUp`). At night each built landmark gets an additive copy over itself (`nightLift`,
  `src/game/cityView.ts`: 0.55 × the night at zoom 1, half at zoom 2, none from zoom 3), so a grown city doesn't flatten
  into one dark field. While decorating no building names show. Bubbles: the side panel keeps one at a time and none past 5 s (8 s in the tab)
  (`setBubbleRules`, `bubbleHold`, `src/game/SpeechBubble.ts`); a message's caption reads "Connie · to you".
  Proof: `npx vitest run tests/incidents.test.ts tests/ui.test.tsx tests/canvas-boards.test.tsx tests/city-view.test.ts`,
  `npm run smoke` (screenshots in `.output/smoke`).
- **The skyline grows with what you learn, block by block.** On a real map every free build tile of a block (not road,
  sidewalk, front row, work spot, footprint, water, park, superblock or decor) is infill (`src/game/infill.ts`, pure): cut
  into near-square segments (|w − h| ≤ 1, at most 3×4, so one `footprintDepth` orders each) of brownstones, walk-ups,
  lofts, pre-war blocks, slabs and setback towers (`art/tiles/infill.json`, style `infillStyle` per Region in
  `shared/region-flavour.json`). A building's height class is the lowest of the real density (`plan.density`), its
  district's level (locked: low-rise behind hoardings, walk-ups where density ≥ 2, never above mid; Novice mid,
  Practitioner high, Expert/Master sky; neighbourhoods follow density alone) and the clear ground behind each of its tiles (`clearBehind` with `CLEAR_BAND` 3, `CLEAR_MARGIN`
  1, 8 px a step; the AZ islands count), so it never hides a landmark. Street trees on every third sidewalk tile,
  signals at avenue corners (`signalPhase`, ambience only), plain parked cars on avenue kerbs (≤ 48, 24 in the panel).
  Variety by hash: each segment has a dominant kind with accents, a quarter take the other style, shops on block
  corners, ~1 in 8 big segments keep a courtyard garden; an open district's open lots stay pocket parks.
  `src/game/InfillLayer.ts` composes each segment into one frame on ≤ 2 canvas pages (1 in the panel; a CanvasTexture
  re-uploads itself after a lost context), one Image + one lights Image per segment. Lights sit in the top @lights layer
  (70,001, over the night overlay) and are composed occluded: cut by later buildings in the segment, nearer segments'
  buildings, landmarks in front (`setFronts`) and street trees/signals, re-composed when any of those change. Segments
  fade in front of Kai through their alpha mask, and only segments that changed are composed again. The legacy city
  keeps its district towers (`decorPlan`, `TOWER_STEPS`). Proof: `npx vitest run tests/infill.test.ts tests/decor.test.ts
  tests/depth.test.ts tests/plan-snapshot.test.ts`; `npm run smoke` (infill segments drawn, ≤ 1,800 objects drawn at
  zoom 1, ≤ 3,600 aimed / 4,500 fails, a lost WebGL context restored without errors).
- **Every Region's city has its own landmark.** `shared/region-flavour.json` gives each Region a `signature` (13 motifs ×
  variants, `art/tiles/signatures_art.py`: lattice tower, needle, bridge, spire, dome, gate, pavilion, rowhouses, wind
  towers, data-centre campus, shell roofs, harbour towers, modernist gallery), placed once by the highway outside the gate
  (`terrainFor`, no `rng()` calls so nothing else moves). Generic impressions only: no trademarked or protected buildings,
  flags, religious, political or military sites. The one brand allowed is Amazon Air (the airport hub's name and the
  jets' "PRIME AIR" livery), the player's choice, behind one switch: `shared/brand.json` `amazon` (`src/world/brand.ts`
  `branded`). A store build (`WXT_STORE_BUILD=true`) turns the names off at build time (`brandOn` reads
  `import.meta.env.WXT_STORE_BUILD`; other builds follow the file) and the generic names (`nameUnbranded`) show; the
  jets' livery and the hangar's sign are baked by `npm run art` from the file itself ("AIR CARGO" once it says false). The world map draws each city's signature as a tiny skyline, lit while
  it's night there (`isNightAt`, solar time from the longitude, redrawn each minute). Proof: `npx vitest run tests/signatures.test.ts tests/clients.test.ts`.
- **Learning visibly grows the city.** Every activity names the building it grew and how far (`growthOf`/`growthLine`,
  `src/state/growth.ts`): under each flashcard, on every game's end card, in the puzzle result. Each landmark grows a
  **knowledge tower** shaped by its service on the back of its lot: `tw_<id>` beside its front building `lm_<id>` in
  `art/tiles/services/<district>.py` (collected by `services.REGISTRY`; no generic fallback), composed by
  `art/tiles/growth_art.py` (none at Novice, mid-rise, tower, skyscraper at Master ending in a thin tip on the lot's centre
  line, where the crowns stand; the front building keeps its metaphor, so a lake stays a lake). District HQs are
  `art/tiles/services/hq.py`. The generator refuses a tip off the centre line and writes `art/tiles/report.json` (tips;
  each district's worst Master-skyline overlap, IoU < 0.8); the empty sky above every `lm:*` sprite is trimmed. A tier-up rises floor by floor (`Landmark.rise`, inside the one
  celebration), buildings in front of Kai or the picked building fade (`src/game/occlusion.ts`), and the camera frames a
  tall building by its middle without losing its ground (`buildingFocusY`, `src/game/camera.ts`). Between levels a building
  shows scaffolding (1/3 of the way) then a crane (2/3) (`constructionStage`, `TierProps.syncWorks`); a tier-up flies the
  camera there, and one earned while the city slept (game, HQ, world map) is celebrated on return. Camera flights
  (`flyTo`, `walkToStation`) are timed by their distance (`flightPlan`, `src/game/cityView.ts`, through CityScene's
  `glide`): 300 ms plus the screen distance at 2.5 px a ms, held to 350–1000 ms, slowing into the arrival
  (`Cubic.easeOut`); past 1.5 views a short sea-blue fade (140 ms out, 220 ms in); a cut under reduced motion. Drawings pay most
  (`src/learning/puzzleRewards.ts`: first pass 12/service + 10, the 10 only when the score with the mistakes on the way
  still reaches 70; better pass 4; a failed try 2 per right piece once a day). A drawing passes on the board as it stands
  (`src/learning/scoring.ts` `design`: nothing missing, 70+): decoys tried, wrong spots and shown cards (`penalty`) cost
  score and stars, never the pass, and ↺ Start fresh clears them. A pass records at least 70, so a puzzle's `best` is its
  best *pass* only, and the panel states the rule (70+, nothing missing) and what the mistakes cost. The board's spot
  labels never draw below `--fs-xs` (the diagram's min-width follows its viewBox and the text size; the 400 px column
  scrolls sideways for a wide one), Check design has its own row, the legend is in words, and the full tab has a Bigger
  board (the same board in a dialog over the city). Games pay full stars
  for 3 rounds a day per game or a new best, half for the next `HALF_ROUNDS_A_DAY` 10, then none, where their coins stop
  (`gameStars.ts` `roundStars`); a game with calls has a `minAccuracy` (`shared/minigames.json`)
  below which there's no New best and a third of the stars; a round that didn't count leads its end card with the next
  try (`nextTryLine`), the floor and its numbers second. One daily ledger, kept on the device for the local day
  (`src/learning/dailyLedger.ts`), limits game rounds, puzzle tries, drawing-board designs (they pay coins, 40 a day at
  most: `designPay`; their own learning kind, `designs`, not a Today goal), Lookout pages (each service once a day),
  console visits (2⭐ a service once a day), chat answers (3 a building, 10 in all) and agent tasks (3⭐, a helper 1⭐: 1 a
  building and 5 in all, then 0); workshop steps pay once per mode, so they're not on it. Again pays 0⭐, and a seen card never pays new-card stars again. District skylines average the buildings put up
  (at least 2). Proof: `npx vitest run tests/puzzle-rewards.test.ts tests/park.test.ts tests/game-clock.test.ts
  tests/learning.test.ts tests/minigames.test.ts tests/workshops.test.ts tests/daily-pay.test.ts tests/decor.test.ts tests/art.test.ts
  tests/occlusion.test.ts tests/camera.test.ts tests/ui.test.tsx tests/browse-growth.test.ts tests/wallet.test.ts tests/canvas-boards.test.tsx tests/city-view.test.ts`; `npm run smoke` checks a fully known S3 Lake reads Level 7 and audits the citizen question.
- **Past Master, crowns come from knowledge, not stars** (`src/state/mastery.ts`): Lv 5–7 (`tiers.legend` in
  `shared/world.json`: Mentor, Architect, Legend) need cards remembered for a week (`MASTERED_DAYS`; the first time pays
  `REMEMBERED_STARS` 6⭐, once per card, kept as `CardState.remembered`, contract v2.12, even after an Again), a passed drawing
  that uses the service, a finished quest and rounds of its game. Gold crowns stand on the tower's tip
  (`art/tiles/legend_art.py`; the Legend's beam is night-lights only) and the sign stands above them; the building card
  lists the next crown's steps. Proof: `npx vitest run tests/mastery.test.ts tests/learning.test.ts tests/art.test.ts`.
- **Walking counts.** A quest's visit step counts when Kai *arrives* (`store.arrive`, from `goTo`'s callback or stepping
  on the work spot), not on a tap; "Walk there", "Walk to <place>" and the tour walk him there (`src/state/walk.ts` `walkTo`; the building's card opens as the visit counts, never at the press: `cardWaitsForKai`; a walk that arrives at once, Kai already on the spot, opens it too), and a city that
  can't (asleep behind a game or HQ) counts it at once, so a quest never sticks. Now and then one existing citizen has a
  question (`src/state/requests.ts`, `src/game/Requests.ts`: a gold "?", at most 5 a day, no new walkers): reaching them
  opens `RequestCard`, an ordinary flashcard review plus a 2⭐ thank-you (never over Decorate: the citizen waits while it's open, and a card already up is held until the drawer closes); the "?" stays until it's answered, and only
  answers count toward the five. Open park rides are ridden (no stars). Six
  golden tokens hide on each city's streets (`src/world/tokens.ts`, hashed placement, no `rng()`), glint within 4
  tiles and are kept in `Progress.finds` (contract v2.9, union merge, earliest date). Mini-games count toward Today and
  the streak, and S3 fishing pays once a round under the daily rule (`fishingStars`). Proof: `npx vitest run
  tests/session.test.ts tests/requests.test.ts tests/requests-decorate.test.tsx tests/a11y-focus.test.tsx tests/tokens.test.ts tests/park.test.ts tests/game-clock.test.ts
  tests/ui-logic.test.ts tests/ui.test.tsx tests/contract.test.ts`, `cd server && npx vitest run test/progress.test.ts`.
- **re:Play Park.** An AWS theme park on a 6×5 site the terrain reserves outside the gate in every Region (`terrain.park`,
  no `rng()`); `src/world/park.ts` lays out six rides (EventBridge wheel, Lambda coaster, CloudFront drop tower, Route 53
  carousel, S3 flume, SQS teacups), each open when its building reaches Practitioner in this city, else under wraps
  with a hint (`src/game/Park.ts`; tap opens the building). Pocket parks stand on the lots global services leave open
  (`openLots`). Sprites: `art/tiles/park_art.py` (+ `crane1x1`, `scaffold1x1`). Proof: `npx vitest run tests/park.test.ts`.
- **`npm start` is calm, and works from a fresh clone.** `scripts/launcher/boot.mjs` uses only Node built-ins: it checks
  Node, runs `npm ci` when `node_modules` is missing, half-installed or older than `package-lock.json` (`depsPlan`; log in
  `.cache/npm-install.log`), then imports `start.mjs`; `npm run live` goes through it as `--live`. Every run prints the
  still AWS City scene (`printScene`: title, night skyline, moon, bay and bridge when wide; no road, no cars, no fireworks,
  one fixed moment `STILL_T`), centred, above the panel; `sceneLayout` keeps `panelReserve` rows for the panel, a resize
  reprints it, and a terminal too short for both gets the header's one-line skyline (`miniSkyline`, `stepsGrowth`). The
  panel (`scripts/launcher/panel.mjs`, `renderPanel`) is drawn in place, never full screen: a header, a ✓/spinner/✗
  checklist with times, one status line, the keys; plain lines without a TTY or in CI. The intro (`playIntro`: the title
  wipes in with its glow, the city rises floor by floor, no cars or fireworks) plays every run in `INTRO_SECONDS` (2 s, ~30 fps, drawn in
  place with the cursor hidden; any key skips) and ends on the exact still picture (`STILL_T`); `--no-intro` skips it (`introPlays`).
  The scene and the panel sit at the left edge at every width (`sceneLayout` has no offset). Later runs say "Play again?" (`startPlan`), and the build is
  skipped when `sourceStamp` (`src/`, `shared/`, `public/`, config, WXT env) matches `.cache/launcher.json` (`--rebuild`).
  The demo always builds with `WXT_BACKEND=mock` (`DEMO_ENV`), which beats the `.env.production` `npm run setup` writes.
  A window already holding the browser profile is named (`lockPid`, `ALREADY_OPEN`, `k` closes it). Proof:
  `npx vitest run tests/launcher.test.ts tests/launcher-skyline.test.ts`.
- **Hands-on workshops, step by step** (contract v2.10, `shared/workshops.json`, `src/ui/Workshop.tsx`). Each step is a
  command for the practice terminal (`src/learning/terminal.ts`: shell-style parsing, flags in any order, `<placeholders>`,
  the real CLI's other spellings (`sameAsCli`: `./file`, a copy to `s3://bucket` or `s3://bucket/` keeps the file name as
  its key), Hint never stops at a placeholder (`hintWord`: asked again there it types an example name), taught errors with
  the real CLI text (a taught error's `when` conditions all hold at once: `missing`, `flag`+`value`, `mismatch`, a `<name>`
  given two values; its message takes `{{name}}`); only an argument the real CLI requires (`CLI_REQUIRED`: its synopsis'
  unbracketed options, and `outfile`) prints its ParamValidation error, all at once; any other flag the step uses gets a
  coaching line ("Practice terminal: this step also sets …"), never a made-up CLI error; a step's `outputs` pick the answer by a flag's value (create-bucket's `"/<bucket>"` in us-east-1, the bucket address elsewhere), shorthand keys in any order and the JSON form count as the step's (`sameShape`), `itemKey` takes any well-formed DynamoDB item with the key; a command word one typo off gets the CLI parser's "Found invalid choice … Maybe you meant" and an `aws s3` path without `s3://` "Error: Invalid argument type" (`parserRefusal`, from aws-cli v2's argparser.py and customizations/s3); coaching lines ("Practice terminal: …", `isCoaching`) show as help, not errors; a step that comes up after a pass takes the terminal's focus, so typing never reaches the city; nothing touches AWS) or AWS CloudShell, where `workshop.verify` checks it with a
  read-only look at the poller's snapshot (`server/src/workshops/checks.ts`: a fixed registry, no SDK calls of its own, no
  new IAM). For real, each name a command needs is typed once in a box that fills both the command and the check;
  `<region>` is the linked account's Region (until the account says it, the Region gets a box too, so Copy never waits
  for a gap with nowhere to type it), and optional parts are kept once filled (`commandFor`,
  `src/world/workshops.ts`), so S3 keeps `LocationConstraint` outside us-east-1 and Copy waits until nothing is left as
  `<x>` (seen 22 Nov 2026: Oregon got `--bucket <bucket>` with no constraint, and CloudShell refused it). A step's `setup`
  (a file CloudShell doesn't have: `echo … > sample.txt`) runs first in the same line for real only (seen 23 Nov 2026:
  "Upload a file" failed in CloudShell). The bucket box has 🎲 Suggest a free name (`freeBucketName`: bucket names are
  global, "testdemo" was taken) and says what S3 would refuse before Copy (`bucketNameProblem`). Pasted errors
  match the step's known ones first, then go to the building's agent as quoted, redacted data, and its answer shows under
  the step, not only in the HQ chat, with the agent's portrait while it reads and each command in it (between backticks)
  on its own line with a Copy button (`AnswerWithCode`).
  Steps pay stars once per mode, ever (`src/learning/workshopRewards.ts`, real > practice; no daily ledger, so a
  workshop done in one sitting pays in full). The terminal helps like a shell: Tab finishes a word, ↑ recalls lines,
  💡 Hint types the next word for −1⭐ on that step (a paying step still pays one), and Fill my names swaps `<table>` for
  the name used earlier; names and lines are remembered per workshop (`prefs.workshopMemory`, `rememberWorkshop`). The
  demo is honest: "for real" there runs in the practice terminal and pays practice, never "real" (`honestMode`). Six
  quests have one workshop step each, and any step of that workshop counts (a step done again too, so it never sticks).
  A finished workshop gets one moment, the "Workshop complete" card (`src/ui/WorkshopDone.tsx`; store `workshopDone`
  holds toasts, its "Established" badge included, until it closes), while the city drops the "established" plaque in
  front of its building; it counts as the hands-on crown step. Text is copied from an AWS
  workshop only when its repo's licence allows it (`licenses`; `source` credits it), otherwise the steps are ours and
  link the workshop. The Town Square's Workshop Studio lists them all. Proof: `npx vitest run tests/terminal.test.ts
  tests/workshops.test.ts tests/workshop-ui.test.tsx tests/moments.test.ts tests/content.test.ts tests/contract.test.ts`,
  `cd server && npx vitest run test/workshops.test.ts test/progress.test.ts`; `npm run smoke` (Hint/Fill/Tab in sight at
  1400×880 and in the 400 px panel).
- **AWS North Hall** (campus, `shared/conference.json`, `src/ui/NorthHall.tsx`): the AWS North conference's talks in our
  own words, speakers unnamed, every fact from AWS docs (unverifiable claims dropped). Passing a talk's three questions
  grows its buildings once (`Progress.talks`, v2.10). Each attempt deals the options in a new order (`choiceOrder`,
  `<talk>#<question>#<attempt>`), and wrong options are plausible, never jokes. Proof: `npx vitest run tests/conference.test.ts tests/north-hall-ui.test.tsx`.
- **Drawing → stack.** Each deploy template has real CloudFormation (`shared/templates/<id>.yaml`, cfn-lint clean): shown,
  copied or downloaded (a local Blob) in the Deploy tab and after a passed drawing (`templateForPuzzle`): every drawing has
  one, its quest's deploy step or its own `templateId`. Proof (and `cfn-lint shared/templates/*.yaml`):
  `npx vitest run tests/templates.test.ts`.
- **Security Agent and the Red Team Range.** `securityagent` takes the lot IAM leaves open in the security district (in
  the classic city a district's 7th+ service takes a global's open lot, `lotsOf`; past that it isn't placed there). Its game (`RedTeamGame`, `minigames.json` `redteam`) is
  a pen test of your own app on screen: flag the flawed requests, let the fine ones pass. The city never sends traffic
  anywhere. Region facts come from its own Regions page (`pageOnly` override; an unlisted Region is `not-listed`).
  Proof: `npx vitest run tests/taxonomy.test.ts tests/region-facts.test.ts tests/minigames.test.ts`.
- **The airport grows with learning** (`src/world/airport.ts`, `src/game/Airport.ts`). Runway and tower outside the gate
  in every Region with room. Its level (0 to 3, `airportLevel`) is the Amazon Air hub's City Clients level, with the old
  rule as a floor (3 Practitioner buildings: level 1, the terminal; 6: level 2, the hangar); level 3 comes only from the
  hub's jobs. Each level swaps the `air:*` sprites in the same slots. Each level-up (and each hub level) flies in a cargo
  jet (livery per `shared/brand.json`; anchored at its ground centre, gear up in the air) that lands, taxis, unloads
  crates and leaves, one at a time, none under reduced motion. Its site and the park's annex (three more rides) are placed after every other prop and clear the props
  under them, so no `rng()` draw moves. Proof: `npx vitest run tests/airport.test.ts tests/park.test.ts tests/terrain.test.ts`;
  `npm run smoke` asserts at most one cargo jet.
- **Decorate: the player decorates their own city** (build mode; contract v2.13 `Progress.decor`, rules in `src/state/buildmode.ts`,
  drawer `src/ui/BuildDrawer.tsx`, scene `src/game/BuildLayer.ts`, art `art/tiles/builder_art.py`: `deco:<kind>`, 51
  sprites, `-r` = turned, district colours as variants). The HUD's 🌳 Decorate (named Decorate where the panel hides the word) and ⋯ → Decorate open a palette; its tool and category chips are at least 28 px (WCAG 2.5.8) (33 items
  in 6 categories, each with a price in 🪙 City Coins and some unlocked by a badge or this city's rank); the ghost is green or red,
  R turns, Esc leaves, Ctrl/⌘+Z undoes (this session only), arrows move it and "✔ Here" builds (keyboard). Never on roads,
  water, sidewalks, buildings, work spots or the row in front of a building, nor on decor, infill or a business; only in
  open districts (pocket parks included), a real map's parks and neighbourhoods, and the Town Square's lawn ring (its
  ways in kept clear). Placed props block walkers (a grid version bump drops cached routes), and decor and infill leave
  their tiles. Caps 120 a city, 240 in all, 20 cities (the server holds the same). Decorations cost coins, never stars
  (see Currencies); removing gives half the coins back, moving is free, undo returns the coins. Prices renew as a sink
  (`priceFor`): past `FREE_COPIES` of one item a city each copy costs `COPY_STEP` more, past `CROWD_FREE` props every one
  costs `CROWD_STEP` more; a crate item not won yet is bought for good by placing it (`MARKET_PRICE`, `drops.bought`;
  monuments stay earned-only); crate spares raise a reward's per-city cap. v2.16: a city merges prop by prop (`gone`
  tombstones, `mergeDecor`; a pre-v2.16 copy without `gone` still merges newer-wins) and undo touches only its step's
  prop (`UndoStep.prop`). While building, one invisible sheet takes every tap and nothing
  auto-pans the camera. The drawer's tool is one segmented switch (Place · Move · Remove) with ✔ Here beside it, and the
  categories one row that scrolls sideways; starting Decorate puts the tab's side column back on the shift.
  Proof: `npx vitest run tests/buildmode.test.ts tests/build-ui.test.tsx tests/art.test.ts tests/a11y-focus.test.tsx tests/a11y-games.test.ts tests/canvas-boards.test.tsx`,
  `cd server && npx vitest run test/progress.test.ts`; `npm run smoke` places three by clicking in the tab and the panel
  (`58-build-mode*.png`, axe on the drawer).
- **Currencies: ⭐ is knowledge, 🪙 is what you spend** (contract v2.14 `Progress.wallet {earned, spent, log?, refunded?, shift?}`,
  `src/state/wallet.ts`). Stars only grow buildings and are never spent. City Coins are earned by doing things and spent in
  Decorate (later combos and cosmetics). Pay (`COIN_PAY`): a side job 15 (once ever) + 40 when its level finishes, a
  scoring mini-game round 6 (3 for the next `HALF_ROUNDS_A_DAY` 10 after a game's first 3 rounds a day, then 0, unless a new best;
  `roundCoins`; Launch Day too; relaxed rounds of a game with an accuracy floor need `RELAXED_MIN_CALLS` calls), a Watch-it-done
  repeat whose stars are used up 2 (`COIN_PAY.watch`, 5 a day), a workshop step that
  pays stars 5, each service on a passing drawing-board design 5 (once a day per service, at most 8 a design and
  `DESIGN_COINS_A_DAY` 40 a day: `designPay`), finishing the day's
  shift 30 (once a day: Home calls `payShift` when the shift is done, and `wallet.shift` remembers the day across surfaces). A casual session (shift + 2 rounds + a job ≈ 57) buys a
  decoration (most cost 4–30; the 2×2 landmarks 50–80 are worth saving for). Both counters only go up (a refund adds to
  `earned`), so a merge takes the higher of each (coins earned on two surfaces in the same instant count once); `log`
  keeps 14 days for "today" lines. Decorations bought with stars before v2.14 (`CityDecor.spent`) are refunded once as
  coins on load (`migrateWallet`; v2.16 `refundedBy` counts it per city, so an old client buying in one city is refunded those). The store's API: `earnCoins(n, reason)`,
  `spendCoins(n)`, selectors `coins(p)`, `coinsToday(p, day)`. The panel draws a coin as a pixel icon (`Coin`, `withCoins` in
  `src/ui/icons.tsx`; `Plain` swaps any 🪙 the state layer writes), never the emoji, which is a grey ball without a colour
  emoji font. The HUD shows only ⭐ · coins · 💡 (City Lights), the rank chip, a one-time "spend them in Decorate" note
  under the coins (under the news ticker; it steps aside for a toast and counts as read after 45 s on screen) and 🚦 Rush hour while it runs (`src/game/rush.ts`); citizens'
  meters count 🎓 lessons, not stars. Where pay halves or stops (game rounds, chat answers, agent tasks), the card says
  so kindly ("full stars again tomorrow"). Golden tokens are ✨, never 🪙. Proof: `npx vitest run tests/wallet.test.ts
  tests/wallet-store.test.ts tests/buildmode.test.ts tests/build-ui.test.tsx tests/contract.test.ts tests/panel-room.test.tsx`,
  `cd server && npx vitest run test/progress.test.ts`.
- **Agent tasks are "Watch it done"** (`src/state/watch.ts`, `TaskCard` and `AgentOffer` in `src/ui/ActivityFeed.tsx`).
  Before the agent works, the card frames a little story ("Sally will store your holiday photos in S3 Lake. Watch Sally
  walk there.") with 👀 Watch (the camera follows the agent: `flyTo` `agent:<id>`; the card folds to one live step, the
  walk there included, the same step the canvas bubble shows);
  during, its steps mirror the city (the demo plans every step it runs, the helper's visit included); after, what was
  built, what it teaches in one line, what it paid (`TASK_STARS` 3⭐, a helper `TASK_HELPER_STARS` 1⭐: the agent did the
  work; a building's first task a day and the city's first `TASK_PAID_A_DAY_TOTAL` 5, else the daily-cap line:
  `TaskView.paid`/`capped`; a practice deploy pays what it reports, once per template), the next step
  (`nextAction`) and, in the demo when a task matches a practice template, 🏗️ See it in Deploy (`planDeploy`, link first
  if needed; Home passes `openTab` so it opens Deploy). Home's agent offer is the same `AgentOffer`, and each featured
  request's words route to the agent offering it (`FEATURED_REQUESTS`, `matchText`: a keyword counts only at a word's start, "ebs" never inside "website"). A building card separates 💬 Ask a question (the HQ chat) from 🛠️ Watch it done (an agent task, whose TaskCard then shows on that same card, scrolled into view). Its sign's marks are said in words there (`signLegend`: ×N resources, ! N things to check). Small talk typed in the request box ("Eddie, how are you?", "Thanks Sally": a greeting or social question, at most 8 words, no word that asks for a change) is a chat, not a task: it opens that agent's HQ and asks there (`smallTalkTo`, `src/state/smallTalk.ts`, from `submitPrompt`; seen 23 Nov 2026: sent as a task, the CPU concierge planned "launch a t4g.nano called Eddie"); every request, question about the account and featured request stays a task. Proof:
  `npx vitest run tests/watch.test.ts tests/watch-ui.test.tsx tests/taxonomy.test.ts tests/daily-pay.test.ts tests/cards-order.test.tsx tests/small-talk.test.ts`, `npx vitest run tests/runtime-session.test.ts -t "small talk"`; `npm run smoke` (`03`–`06-task-*.png`).
  The agent is told the concierge's plan after the player's words, fenced as `<concierge_plan>` data it acts on only as
  far as the player asked; a step that destroys something reaches it only when the player's own words ask for one (`withPlan`,
  `planForAgent`, `server/src/contract/orchestrator.ts`: the concierge reads page context, which anyone can word), and
  a plan step that changes AWS (`isActionStep`: its first verb) but that no tool call made shows `failed`, "not done: no
  change was made", and the task isn't ok; only explanation steps walk through as done. A plain request in the player's
  own words ("Create a bucket called holiday-123", "Terminate i-0123…": `parseCommand`, `server/src/agents/commands.ts`)
  skips the model: its own agent (`ownerOf`) walks there and the server submits it through the same ActionService and
  approval card at once (`direct`, `server/src/contract/orchestrator.ts`; Jev reads the same words as `intent`), then the
  agent explains it in a few words after `task.done`; a request understood but not allowed (an m5.large) is answered at
  once with why (`ok: false`). Only `task.submit`'s prompt is read, never page context or a plan; a small CPU model took 1–3 minutes before the card and
  sometimes said "I'll build it now" without a tool call (Qwen3 4B, 21 Nov 2026; Ollama's OpenAI API ignores
  `tool_choice`). Every approval card names the account and Region it writes to (`deploy.preview.accountId`, v2.18, read
  when the card is made), and every write asked for, done or refused (fixes too), is logged as `aws change` (`audit`,
  `server/src/tenants.ts`: the player as `who(sub)`, the Region, the action and its outcome, the target as the gate's
  `targetHash`; never a resource name or the account id). The card can't be missed: a task card with one waiting says "⏳ Waiting for your Approve" with
  Approve in Deploy → (`openDeployAt`, leaving an HQ first), elsewhere a toast opens it, and Deploy brings the card up with
  focus on its title (`deployFocus`, `.stack-title`), never Approve, so no approval happens by accident (#105). "My builds" is one card per resource for the agents' changes (`arrangeBuilds`,
  `src/state/builds.ts`: a launch joins its server's later cards by `deploy.status.outputs.ResourceId`; status words fit
  the action; Tear down only while it exists, sent as a plain request, and not when My builds' inventory list already
  offers Take it down for the same resource: one removal button each). The card says where the task is: "Watch Sally
  walk there", then "Sally is there and on it" once she's arrived (`watchLine`), "💭 thinking… up to a minute" while her
  model call runs (`thinkingLine`, from `agent.state`), and a failed task its reason (`failedReason`) with ↻ Try again;
  the city's bubble says the reason too, and "Real AWS calls" lists the hosted server's calls (`s3:CreateBucket` from
  service + "CreateBucket — …", never its model calls). A request refused at once keeps the concierge's reason on screen
  ("X, you're up!" waits for the first step that runs), and the agent's last bubble says why (`bubbleText`, whole
  sentences that fit, asides dropped; `failedBubble`, `src/state/watch.ts`), never only "That didn't work…" (seen 22 Nov
  2026: a refused m5.large read as nothing happening). Proof: `cd server && npx vitest run
  test/contract.test.ts test/commands.test.ts test/service.test.ts test/approvals.test.ts test/care.test.ts`; `npx vitest
  run tests/approval-target.test.tsx tests/builds.test.ts tests/approve-flow.test.tsx tests/ui.test.tsx tests/progress-chat.test.tsx`,
  `npm run smoke` (`06b-task-refused`).
- **HQ chat answers every question, one at a time** (`src/ui/ChatPanel.tsx`). The answer's bubble shows at once,
  thinking (`addUserChat`); a question asked while one is answering waits in `chatQueue` ("· next") and goes when the
  answer ends, never dropped; the agent in the HQ only points to the chat ("Answered in the chat ↓", not the answer a
  second time). A fix waiting for its approval has its own slots (`MAX_FIXES_PER_SOCKET`, `server/src/http.ts`), so it
  never blocks the chat's three. A small CPU model (`llm.small`: the local provider) reads a short city summary
  (`snapshotSummary`: what the city built, by id; the rest counted) and one docs page instead of the full snapshot and
  three: reading the prompt is most of its time (~27 tokens a second). Proof: `npx vitest run tests/progress-chat.test.tsx`,
  `cd server && npx vitest run test/runner.test.ts test/contract.test.ts -t "summary|small CPU"`.
- **"My AWS, live": the linked account as one map** (`src/ui/AccountMap.tsx`, pure `src/world/accountMap.ts`; Deploy's
  account card and ⋯, linked only). Built from what the server already sends (`city.inventory`, `city.bill`,
  `city.flow`): services in columns the way a request travels (`tierOf`: network & front door, compute and messaging,
  data, security & operations, other), each with its count, this month's cost and live rate, tap for its resources;
  servers and databases in their lettered Zone; the only lines are the data links AWS reports (replication, standby).
  Which resource talks to which isn't read yet (it needs read-only player-role permissions: API Gateway integrations,
  Lambda event sources, load-balancer targets, CloudFront origins), and the map says so rather than guessing. Two views
  (an `aria-pressed` group): Services (the columns) and **Diagram** (asked for on 22 Nov 2026: the account drawn, data
  moving, each service's cost by day and month): `layoutArch` (`src/world/archDiagram.ts`, pure: lanes per column,
  right-angle links whose last segment is straight, left to right in the tab and top to bottom in the 400 px panel) and
  `accountDiagram` (`src/world/accountDiagram.ts`). Its solid lines are the data links AWS reports (replicas, standbys,
  load-balancer traffic) to where the data goes; its dashed lines are how those services usually connect (`courierLegs`
  over `shared/flows.json`, adjacent pairs, `FAN_IN` flows left out, each with its AWS source in "How these usually
  connect"): they teach, they don't report, and the legend says so. Dots move with SVG `animateMotion` (`src/ui/ArchDiagram.tsx`;
  more and quicker at a service's `city.flow` rate, `dotPlan`), sit still under reduced motion and pause while the page is
  hidden. Costs (`src/world/accountCost.ts`): AWS's month so far per service; a day = that ÷ UTC days so far, a month = a
  day × the month's days, both marked est. There's no list-price estimate: the client doesn't know a server's size or
  whether it's running. Each box is a real button (arrow keys move, `nextSlot`) labelled with its name and figures.
  What the city has no building for is listed, not just counted (`unmappedItems`: tap "No building yet" in the Diagram,
  or open "N more…" under Services; seen 22 Nov 2026: "×15" said nothing). A server named from its Name tag shows its id
  beside it (`itemLine`: "server demo2 (i-0d3e…)", to copy for "Terminate i-…"); months read "November 2026"
  (`monthName`, `src/world/accountCost.ts`: "2026-11: $0.00" read like $2,026,110); Show my bill / Show live traffic
  are real buttons. Sign out is in the ⋯ menu too (signed in and able to sign out), not only Deploy → Your data.
  The Diagram draws Everything or **Built by the city** (`accountDiagram(…, { builtOnly })`, asked for on 22 Nov 2026:
  your own project): only services with something the city built, counted by those, with the usual links between them,
  and no cost lines (AWS bills a service for the whole account, not each thing the city built); a picked service counts
  what the city built, like its box; nothing built yet says so (`role="status"`). A picked box's details scroll into
  view (focus stays on the box). Regions read by name with the code beside them ("US West (Oregon) (us-west-2)",
  `regionName`, as Deploy shows them; seen 22 Nov 2026: Oregon vs us-west-2 confused). Proof:
  `npx vitest run tests/account-map.test.tsx tests/account-diagram.test.ts tests/menu-signout.test.tsx`, `npm run smoke` (`18b-my-aws-map`,
  `18c-my-aws-diagram`, `18c2-built-by-the-city`, `18e-my-aws-diagram-panel`, axe, still dots under reduced motion). A third view, **How AWS City
  runs** (`shared/city-architecture.json`, `src/world/cityArchitecture.ts`), draws the city's own hosted parts the same
  way (blue lines, in request order, from `infra/lib`); its only prices are Fargate's, worked out from the task sizes and
  `FARGATE_ARM_PRICE` (servers $1.09 a day, the AI $8.72 a day while on), the rest is pay per use, and the idle total is
  the README's own estimate; the file holds no dollar figure of its own. It describes the published defaults, never the
  private `aws-city.config.json`. Proof: `cd infra && npx vitest run test/city-architecture.test.ts` (the sizes match the
  synthesized task definitions, `CPU_MODEL`, `cpuAiHourly()` and prod's `minTasks`), `npx vitest run
  tests/city-architecture.test.ts tests/content.test.ts`, `npm run smoke` (`18d-city-architecture`).
- **City Clients: side jobs for real kinds of business** (`shared/clients.json`, `src/world/clients.ts`, `src/ui/clients/`).
  18 businesses: wave 1 (Amazon Air hub, bank, stadium, hospital, shop, school) and wave 2 (streaming studio, game studio,
  news site, port, energy utility, factory, farm co-op, car maker, phone network, town council, hotel, charity), three
  levels of 4 to 6 jobs; facts only from each business's fetched AWS pages or cited flashcards, source titles name no
  customer, and every CLI error text is checked against the AWS API reference or the aws-cli source (a missing argument
  the CLI requires prints `aws: [ERROR]: An error occurred (ParamValidation): the following arguments are required: …`,
  `CLI_REQUIRED` in `src/learning/terminal.ts`; a flag it doesn't require gets a coaching line). A job is done at a named station of the business's site (Kai walks
  there with `walkToStation`, the job opens on arrival; a ring site is reached at the city gate, a sleeping city opens it
  at once) and reuses a part: the architecture board (`Builder` with `job`, `src/learning/jobPuzzle.ts`; never
  `Progress.puzzles`), the practice terminal, a choose card, the practice console's Copilot, a settings checklist,
  Explain it back (`checkKeywords`), or one of 7 station panels (`src/learning/stations/`: sort, match, route, rotate,
  scale, spot, order; pure reducers, buttons for keyboard and pointer, Games without a clock drops the timer). The ladder
  opens Clients after the first quest; a job whose services aren't put up here says "Put up <X> first" and how (its
  Show me flies there; learning one of its cards puts it up) and never blocks the rest of the level. One station job is a
  `starter` (stadium "Sort the fans' requests"): open from day one in every city, with nothing put up (`missingFor`,
  `STARTER_TASKS`; doing it puts its buildings up). A job pays its services once ever (`completeTask`, `Progress.clients`
  v2.13: higher level, union of done, earliest date); a level's last job pays its bonus, opens one card (`clientDone`,
  `toastsHeld`) and grows the site (`clientLevelUp`: the camera flies there unless the player is steering it, then the
  next `client:<id>:<level>` sprite stands up with a small settle and 16 dark-outlined confetti pieces of 7–9 px fan out
  and fall on whole px in quarter turns, `confettiPieces`/`confettiAt` in `src/game/Clients.ts`; none under reduced
  motion). Sites
  are placed without `rng()`: the airport hub on the airport, the rest inside a real map's core (`hoodLots`, the art's
  size: bank and shop 3×3, the rest 4×4; wave 1 chooses first (`waveOf`), then big lots): neighbourhood blocks first, then the quiet back of a
  district block (never a landmark's lot or the tile round it, its front row or work spot, a pocket-park lot, the square,
  campus, Day 1 Quarter, road, sidewalk or water; infill leaves them; stations never on water). Every real city stands
  wave 1 inside (us-west-2 included) and as many of wave 2 as fit (5 to 17); the rest take the ring's lots
  (`terrain.clientLots`, up to 17 aims beside the highway, after every other site), as all 17 do in the classic city. An
  empty site (level 0) shows a "coming soon" `lotSign`. Yellow "!" markers (map and minimap) show the
  focused business's open stations. `Progress.decor` (v2.13, per city, newest copy wins) is defined for build mode.
  Proof: `npx vitest run tests/clients.test.ts tests/clients-ui.test.tsx tests/stations.test.ts tests/stations-ui.test.tsx
  tests/airport.test.ts tests/ladder.test.ts tests/contract.test.ts tests/plan-snapshot.test.ts tests/city-view.test.ts tests/answer-motion.test.ts`, `cd server && npx vitest
  run test/progress.test.ts`; `npm run smoke` (section 70–77: one job of every kind in Montreal, a level done, axe; 85 a
  wave 2 business: the port's jobs and its empty site).
- **You're the Mayor; your city has a rank** (`src/state/rank.ts`: building levels and golden tokens → Village, Town, City,
  Metropolis, Megacity, Global City at 60/250/700/1400/2200 points, then the crown ranks Crown City, Cloud Capital,
  Legendary City at 2800/3400/4000: all 58 buildings at Master are 2,320, every crown and token 4,090, in every Region (a
  fenced service still counts what's known of it); a rank's `title` is shown, its `name` is what `presence.beat` sends,
  v2.12, so the crown ranks go as Global City). The HUD's rank chip opens **My City** (`src/ui/Collection.tsx`), the one progress hub: ⭐ · 🪙 · 💡 · 👑 crowns, the rank ladder, badges, the live city (👥), the loops below (`src/ui/Loops.tsx`), collections, and you
  beside AWS at scale. Badges are read from Progress (`src/state/badges.ts`); only moment badges are stored
  (`Progress.badges`, v2.11), and a new one is celebrated once (`watchBadges`). Rank flags stand round the Console
  Plaza. The shift always has a next step (`src/state/next.ts`: never a fenced lot, "Upgrade" only when the deck can pay
  now, "Review N" counts the deck it opens), 3–5 goals (`todayGoals`: the order board feeds a job goal, `SHIFT_MAX`) and
  an optional overtime goal once done, a workshop goal in Today, a weekly challenge game paying
  ×1.5 (`src/state/events.ts`, the ISO week), and one streak freeze a week (`nextStreak`). Proof:
  `npx vitest run tests/rank.test.ts tests/events.test.ts tests/streak.test.ts tests/next.test.ts tests/codex.test.ts`.
- **Loops that bring you back are earned, cosmetic, free and never decay** (contract v2.15, `Progress.lights`/`seasons`/
  `drops`/`codex`; `src/state/{lights,season,drops,codex,cosmetics,rewards,cityhall,welcome}.ts`, all pure; store actions
  `lightDay`, `fillSeason`, `claimSeason`, `openDrop`, `discoverCombo`). **City Lights** replaces the streak display (HUD 💡,
  Home, City health): each learning day (`noteLearning`) lights a window for good; a missed day dims one until a learning
  day relights it; a freeze is earned every 7 learning days (3 held at most) and covers a missed day (v2.16 counters
  `freezesEarned`/`freezesUsed`, merged max/max, so no freeze is lost between surfaces); `nextStreak` stays for badges. At night the windows glow on the city's buildings (CityScene's `// ── Juice (round 3 step 2)` block, solid pixels
  only, colour `prefs.glow`). A finished shift opens one **Daily Supply Drop** a day (a decoration or a window colour only,
  free, the real chances for what's left shown before opening (`dropOdds`), never a cosmetic owned from any source
  (`ownedCosmetics`), a spare copy once all are owned (`MAX_SPARES`), plus a bonus crate for the shift's overtime goal
  (`overtimeGoal`, `drops.overtime`), a 1 s shake then a pop in its rarity's colour
  (none under reduced motion, `CRATE_SHAKE_MS`) in one box: the shaking card keeps the closed card's words with
  "Opening…" on its button, and the reveal holds that height, so nothing below it moves; never coins or stars, rolled from the day so every surface opens the same crate; its button is
  never Home's primary) and fills one **season road** once a day (12 monthly themes, 8 steps to 100 points, the last the
  season's landmark; every road is open to everyone, picked in `prefs.road` (`prefs.season` is only the art's season);
  points past a road's end flow into the next unfinished one; a freeze step with the freezes full gives a crate item). **Service Codex**: a card per
  service put up anywhere and sets in `shared/codex.json` (Serverless Starter, the six pillars, exam sets) whose monuments
  are free in Decorate (`category: 'rewards'`); combos found (S3's `syncCombos` → `discoverCombo`) pay `COIN_PAY.combo`
  once ever (quietly too, when found while the city slept). **City Hall** levels with this city's rank and opens Decorate items and past seasons, never learning. The
  **return note** is opt-in (My City), one positive line a day, no notifications. **Juice**: right answers chime a step
  higher in a run (`feel.good`, `pitchOf`), a beam of light runs from the card into its building and lands as a
  tile-shaped pulse (`bus` `answer`; `beam`/`beamAt` in `src/game/juice.ts`: a 3 px gold core, a 1 px pale-gold glint and
  one 7 px halo step, normal blend, whole px, 600 ms), coins fly to the
  HUD counter (`src/ui/CoinFly.tsx`, `bus` `coins`), an upgrade pushes the camera in one integer step and back, a wrong
  answer wobbles and shows the answer; none under reduced motion, sounds through `audio.ts` (captions hold).
  Proof: `npx vitest run tests/lights.test.ts tests/season.test.ts tests/drops.test.ts tests/codex.test.ts
  tests/juice.test.ts tests/loops-store.test.ts tests/loops-ui.test.tsx tests/buildmode.test.ts tests/contract.test.ts
  tests/wallet.test.ts tests/welcome.test.ts tests/next.test.ts tests/answer-motion.test.ts`,
  `cd server && npx vitest run test/progress.test.ts`; `npm run smoke` (43–46: night City Lights, season road, Codex, crate).
- **The live city and leaderboards are opt-in and name nobody** (contract v2.11). A game's board gets this ISO week's
  best timed round only (v2.12 `Progress.games` `bestTimed`/`bestWeek`, the UTC ISO week the server's boards use:
  `isoWeekUtc`; relaxed rounds never count; `scored` counts rounds above 0 for the crown). `Progress.profile` is off by default; its
  name is two generated words (`src/state/names.ts`), never typed. Presence rows (90 s) and weekly board rows (9 weeks)
  live in the player table under a salted hash (`server/src/social.ts`, `store/social-dynamo.ts`), only public profiles
  are named, scores are clamped and best-of-week, and going private or `DELETE /me` removes every row. Visiting Mayors
  walk your streets in a crowd-size gold jacket inside the crowd cap (`src/game/Visitors.ts`). The demo plays a labelled
  practice version. Proof: `cd server && npx vitest run test/social.test.ts test/hosted.test.ts test/progress.test.ts`,
  `npx vitest run tests/contract.test.ts tests/learning.test.ts tests/events.test.ts`.
- **AWS at scale comes from AWS's pages** (`npm run aws-catalog` → `shared/aws-catalog.json`: "over 200 AWS services",
  the edge network; Regions and AZs from region facts), each fact with its source (`src/world/scale.ts`). Proof:
  `npx vitest run tests/scale.test.ts`.
- **Well-Architected, cited.** Every rule and every drawing tip names its best practice (`bp`, read from the framework
  pages), every drawing links its AWS reference architecture, and City care has a Well-Architected review of the
  account (`src/state/review.ts`, `src/ui/WaReview.tsx`; "no issue found", never "passed"; a pillar says the risks found,
  `risksLine` "1 risk found", never a score: the WA Tool scores nothing). Proof:
  `npx vitest run tests/wa-bp.test.ts tests/review.test.ts`, `cd server && npx vitest run test/care.test.ts`.
- **The Drawing board** (Learn → Drawing board, once "the sandbox", `src/ui/diagram/Sandbox.tsx`): an intro card (a blank
  page for your own ideas, where Puzzles give you a brief) and a short first-time guide in the buttons' own words (➜ Draw an
  arrow), one live hint line; official icons of the services you've put
  up, AWS group boxes, arrows you draw; a rules-only review of what's drawn and how it's wired, each finding with a
  verified best practice (`src/learning/designRules.ts`, `bp()` looks ids up in the data). It passes with 3+ services wired
  by 2+ arrows, every arrow the way requests travel (`backwardArrows`: against every `shared/flows.json` flow that has the
  pair; queues, topics, buses and streams go both ways), and nothing red; the verdict shows beside the button and what's
  missing comes first (`passGaps`). A pass pays City Coins (never ⭐),
  counts a quest's `design` step (Draw It Once, Build It Anywhere) and the Today chip "Draw a design" (always a bonus,
  never the finish line).
  Designs sync (`Progress.designs`, 20 at most); PNG/SVG export inlines the icons and stays local. Proof: `npx vitest run
  tests/design-rules.test.ts tests/watch-ui.test.tsx tests/ui-logic.test.ts tests/next.test.ts`; `npm run smoke` (`39a-drawing-board-intro.png`).
- **Launch Day, the builder game** (`src/learning/launch.ts`, `src/ui/launch/LaunchDay.tsx`, `shared/launch.json`): build a
  stack within a budget from the services you've put up, then live through a launch (rush, viral moment, a dark AZ, a bot
  flood). Pure and deterministic; every part's behaviour cites its AWS page, every loss names the part and best practice
  that would have held, and serving bots costs score (they're billed). Days open with Practitioner buildings. Proof:
  `npx vitest run tests/launch.test.ts`.
- **Each service has workers on the street.** Every discovered service in the city sends a worker dressed as its agent
  (crowd copy) on errands between its building and the services it works with in `shared/flows.json`; tapping one opens
  the building and shares a tip from that service's deck (`src/game/Workers.ts`, no model calls from walking). They
  take pedestrians' places, so the crowd cap holds (`WORKER_CAP` 8/4). Proof: `npm run smoke` (caps).
- **People stand to scale.** Pedestrians and the Well-Architected citizens use 3/4-size crowd sheets (`<id>-crowd`, 36×54,
  made by `art/characters/crowd_small.py` in `npm run art`, never shrunk at runtime: that would drop pixels at zoom 1). Kai
  and the landmark agents stay full size so they can be found. Proof: `npx vitest run tests/art.test.ts`.
- **Accessibility is a setting, not a fork.** ⋯ → Accessibility sets text size (125/150 %), high contrast and an easy-read
  font on `<html>` (`data-text`, `data-contrast`, `data-font`); `styles/22-access.css` only overrides tokens, and the canvas's
  text scales with the text size, never under 11 px: the city's labels, the world map (`worldText`), an HQ room and every
  mini-game (`TXT`). Games without a clock (`prefs.relaxed`, `src/game/pace.ts`) end rounds on Done and stretch
  reaction windows and spawns (Rush Hour's day, which is the game, runs at half speed instead); Sound captions
  (`prefs.captions`) show a word pill for each meaningful sound (`CAPTIONS` in `src/game/audio.ts`, not steps or blips).
  Every mini-game plays from the keyboard (`onKeys`, or in Fishing and Edge Cache the maps in `src/game/scenes/games/gameKeys.ts`: Space casts and hooks, 1–3 pick a bucket; 1–4 pick a cache slot, I invalidates, C caches; `tests/game-keyboard.test.ts`), its end card too (`endCardKey`: Enter plays again, X the Expert round when open, Escape back to the city, after 800 ms; fishing: Space/Enter, X, Escape). A key press shows where it went: its button sinks (`pressLook`), the answer's target is framed (`answerPop`, `src/game/scenes/games/stageFx.ts`: green with sparks, red, or amber for a plain action; still under reduced motion), and a right answer's sparks burst where the pointer pressed or, after a key, where the answer went (`sparkSpot`: `answerPop`'s spot or `MiniGame.answerAt`, else the press's first verdict or floater, else the view's centre); Rush Hour's buttons name their keys (`RUSH_BUTTONS`). Mini-games speak through App's one polite live region (`announce`, `src/state/announce.ts`: one update per line, ≥ 150 ms apart, `replace` keeps the newest): the goal and keys first (`startLine`, a game's `keysHelp` when its title doesn't name them), each prompt (fishing's fish and buckets, the sorting office's parcel, the Dance Hall's question, the gate's request, the food stall's orders, the shield wall's arrivals, the queue's messages, Edge Cache's misses and changes, the Red Team Range's requests), every verdict and the player's own score changes in one line a frame (`MiniGame.speak`), and the end card in words (`endLine`, `src/game/scenes/games/say.ts`); the canvas is named for the game while it runs. Sound captions stay `aria-hidden` (the live region already says it). Keyboard: arrows walk, E talks, `]` / `[` step through buildings (announced by their sign's name, never an id, as "Place N of M on the map": `stepLine`), `+` / `−` zoom. ⋯ is a menu: opening it focuses its first item, arrows/Home/End move (never reaching the game), Escape returns to ⋯; its sections are labelled groups (Sound & view, Accessibility, How you play, Your city; Account first when hosted) and the street-maps credit is an item; Decorate is a plain item that returns focus to ⋯. A glossary definition opens in the top layer (popover API, `popPlace` keeps it in view); a flashcard's hidden face is `inert` and `aria-hidden`, and `visibility: hidden` half-way through the flip (Safari drew its z-index text mirrored over the answer whatever `backface-visibility` said; seen 23 Nov 2026), and its small print is ≥ 4.5:1 on both papers (7:1 high contrast). Keys go
  to the canvas when a game or the city starts, unless the player is in the UI (`keysBelongToUi`, `mayFocusGame`; a workshop's next step takes the focus the passed one dropped,
  `src/game/keys.ts`).
  Arriving in a city announces its summary (`citySummary`: the AWS services put up here of all of them, issues, AWS status, live traffic). Focus never falls to `<body>`: a side-panel control that goes away leaves it on the new panel's heading (`useKeepFocus`, `src/ui/useDialog.ts`), and a ⋯ item gives focus to ⋯ before it opens a dialog, so closing My City or the tour returns there. The smoke runs
  axe-core (WCAG 2.2 AA) on the world map, a building's card, the tab and the panel; serious or critical violations fail it. Proof: `npx vitest run tests/a11y-prefs.test.ts tests/game-keys.test.ts tests/game-say.test.ts tests/announce.test.ts tests/a11y-menu.test.tsx tests/panel-room.test.tsx tests/term-popover.test.tsx tests/ui.test.tsx tests/a11y-focus.test.tsx tests/a11y-games.test.ts tests/terminal-ui.test.tsx tests/game-theme.test.ts tests/game-stage.test.ts tests/answer-motion.test.ts tests/world-dive.test.tsx`, `npm run smoke`.
- **Kai wears the team's gold jacket.** Always, everywhere (`KAI_SHEET` = the `player-gold` sheet, `src/world/culture.ts`).
  Golden Jacket Hall tracks the certification trophies (`hasGoldenJacket`: every one lit, a moment the first time). The real
  Golden Jacket recognises holders of every current AWS Certification; `shared/certifications.json` is that list.
  The Day 1 Quarter is open from the start (`ladder.ts` `day1: true`). Proof: `npx vitest run tests/ladder.test.ts tests/art.test.ts`.
- **Seven districts, 58 services.** `shared/world.json` lists the districts (the seventh, `management`, is the Civic Centre,
  south-east of the square) in their official AWS Architecture Icon category colours (Management & Governance is
  `#E7157B`, read from the icon package's category SVG). The Global Gate's four campus lots go to the global services in
  `shared/region-facts.json` `global` order (Route 53, CloudFront, IAM, Global Accelerator: add a new one last; the order
  lives in `GLOBAL` in `scripts/fetch-region-facts.mjs`). A district has 6 to 11 services and its HQ room
  (`InteriorScene`, laid out by the pure `src/game/hqRoom.ts`) has work for each: six at the desks, up to five more
  standing at the wall of racks at their city activity (`staffSpots`); past that an agent walks the room, so nobody is
  dropped. Proof: `npx vitest run tests/art.test.ts tests/taxonomy.test.ts tests/plan.test.ts tests/hq-room.test.ts`.
- **Content is data.** Districts, services, metaphors and layout live in `src/world/`. Game and UI code
  never hard-code service ids (the exceptions are `bedrock`, the default router target, and the
  mini-games, each built for one landmark: `s3` fishing, `lambda` food stall, `route53` dance, `shield` wall, `ec2` rush hour, `dynamodb` sorting office, `securityagent` red team range, `sqs` queue juggler, `iam` permission gate, `cloudfront` edge cache). Proof: `npx vitest run tests/taxonomy.test.ts` checks every service has a
  place, a landmark and a valid work spot. A service's first `consolePaths` entry is what "Open the console" opens
  (`consoleUrl`): `vpcconsole#TransitGateways:` is a hash route, `lightsail.aws.amazon.com/ls/webapp` a console on its own
  host; `matchUrl` reads both back (same test). With a linked account it opens in that account's Region
  (`<region>.console.aws.amazon.com/…?region=`, a Region code only; `openConsole` in `src/app/runtime.ts`, global services
  keep their own console; seen 23 Nov 2026: the console opened in London while the city builds in Oregon), and Deploy's
  linked card has 🖥️ Open the AWS console (not in the demo) with whose sign-in to use: the city never signs the player in.
  Proof: `npx vitest run tests/taxonomy.test.ts tests/deploy-account.test.tsx`, `npx vitest run tests/runtime-session.test.ts -t "Open the console"`.
- **State vs moments.** Persistent state goes in the zustand store (`src/state/store.ts`); one-off
  animations and camera moves go on the bus (`src/state/bus.ts`). Scenes subscribe to both and must
  unsubscribe on both SHUTDOWN and DESTROY, because React StrictMode destroys the first game.
- **Agent animation = real AWS activity.** `agent.state working/idle` from the backend drives the
  work animation. Browsing only moves focus: the camera pans, the agent waves, and first visits
  discover landmarks. "Browsing grew it": a service's console page is a moment the player sees (a toast with the
  building's icon and its growth line, `browsedText`; the camera flies there; at most once a minute a service), and it
  waits behind a celebration card or a game. It pays 2⭐ once a day a service (the daily ledger, `visit:<id>`); docs pages
  and other sites never make the moment and pay nothing.
  Proof: `npx vitest run tests/browse-growth.test.ts`.
- **Surfaces.** The side panel (Chrome/Edge), the Firefox sidebar (same entrypoint) and the full tab at
  `/city.html` run the same app and merge progress through `storage.local`. Under 720 px wide the tab stacks like the
  panel (`src/app/styles/01-layout.css`: the map `minmax(220px, 45%)` over the side column, a mini-game the whole
  height), so a narrow window never squeezes the map to nothing. The toolbar opens the panel, the
  sidebar, or (Safari, which has neither) the tab: `src/app/surface.ts`. With a real account the Lookout and Console
  Copilot need the panel/sidebar (they see the console tab beside it). In the demo both use the practice console inside
  the extension (`practice.html`, `src/console/practice.ts`; nothing there touches AWS) from every surface; if the
  browser wants the player's OK for the Lookout's photo it asks ("📷 Allow"), and a no reads the page's address
  instead (`lookByAddress`). Proof: `npx vitest run tests/surface.test.ts tests/practice-console.test.ts
  tests/console-clarity.test.tsx tests/panel-room.test.tsx`, `npm run smoke:copilot` (8 flows on the practice console, then the demo Lookout).
- **The Console Copilot hands risky steps back, by rules.** It acts with the signed-in console user's own rights (outside
  the player role, the ActionService and `deploy.approve`), so pure rules in `src/console/risk.ts` decide, never the model
  (the server imports the same file). `isRisky` reads every label a control carries and its section: deletes, billing,
  credentials, full-access and power-user policies (one CamelCase word: no leading `\b`), Block Public Access and "I
  acknowledge" boxes, public, share, anywhere (Anywhere-IPv4/6), `0.0.0.0` alone or as `/0` (never inside a private
  range: `10.0.0.0/16` is an ordinary VPC CIDR), `::/0`, All traffic, account ids and other accounts, trust, Create role. On
  the real console's `PLAYER_ONLY_PAGES` (IAM, IAM Identity Center, Organizations, KMS, Secrets Manager, security group
  rules, S3 permissions) `mayAct` refuses every click, pick and keystroke; the practice console is never one. The press
  that commits is the player's when either of two rules says so (`mayAct` in `src/console/safety.ts`; also a "select"
  aimed at it, which ends in the same press unless the element opens a list), reason `commit`: "Your turn: press
  “Create database” when you’re happy with the settings.", the settings part only when the button's form, else the
  page's `main`, has a field to look over (`hasSettings`: never a search box, a table's row boxes or a hidden field),
  else "Your turn: press “Create database”.". On every page, the practice console too: a button, link or menu item with
  a commit word anywhere in its name (`isCommitControl`/`isCommitWord`: create, save, launch, add, attach, edit, set,
  copy, stop, test…: an allowlist of what the Copilot may press, not a list of bad words), and a form's submit control
  (`isSubmitControl`: `type="submit"`, or a `<button>` with no type inside a form) except a Cloudscape one: Cloudscape
  renders every button `type="submit"` (Next, Cancel, Actions…), so for its buttons only a commit word or, on the real
  console, the primary variant counts. Anywhere on the real console (`isConsoleUrl`, never `practice.html`) also the
  click that commits a form (`isCommit`): a button or menu item whose name starts with
  create, launch, start, run, confirm, submit, save, apply, update, enable, attach, associate, allocate, request, deploy,
  purchase, buy, subscribe or order, or one the page marks as its main action (`isMainAction`: Cloudscape's primary
  variant, or a native form's submit button; a `<button>` with no type only as its form's default button, the first
  submit control; a wizard's Next/Previous/Back/Cancel/Close excepted, the whole name only, so "Cancel update" commits).
  The trade-off, by name: a list page's "Create database" (or "Launch instances", "Create bucket") only opens the form,
  but it's handed back too, so the player presses "Create X" twice (open, then commit), on the practice console too. The words are English, so on a console
  whose `<html lang>` isn't `en*`, or that has none (we can't show every console page sets it: fail closed), every press
  of a button or menu item is the player's ("This console isn’t set to English, so I leave its buttons to you."); the
  snapshot carries `lang` (v2.19, `''` when the page has none) and the server marks those `confirm` too (a snapshot
  without `lang`, from an older client, goes by the words). A button in a table's column header ("Launch time", "Start
  time") sorts it: the snapshot sends it as role `columnheader`, never a commit. The Copilot still fills the form and points at the button;
  radios, boxes, options, tabs, dropdowns and links without a commit word stay its own (they go somewhere or fill in). It
  never types or picks a value that opens access or names an account (`isRiskyValue`: `0.0.0.0/0`, `::/0`, a bare `*`,
  a 12-digit account number, an ARN). A refused step is the player's turn. The demo's Copilot (`src/backend/consoleMock.ts`) never deletes: a goal that removes something (`isRemovalGoal`) runs no flow and ends `ok: false` with `NO_DELETING`; its EC2 flow hands "Allow SSH traffic from Anywhere (0.0.0.0/0)" back with a warning. The server marks `confirm` wherever either
  rule says so (`server/src/contract/console.ts`: `isCommit` by name and `lang`, since it can't see the variant;
  `isCommitControl` on a click or a select, by the model's name or the page's; `isRisky`/`isRiskyValue` values; the player-only pages), and its prompt says page text is data
  (`<console_page>`), never instructions. Text leaving the page is redacted, the typed goal included (`startConsoleCopilot`; the task card shows it redacted) (`redact`: keys in any case, or typed in groups of four in capitals, emails, tokens other than AWS/Amazon managed policy names, 12-digit account ids bare or split by
  `-`, `.` or a space), and the Lookout never auto-snaps a page that can show a secret (`autoSnaps`: an AWS page that's
  neither `SECRET_PAGES`, the real console's access keys, secret values, Parameter Store, KMS, CloudShell, a Lambda function's Configuration tab (environment variables), RDS's database pages (a generated master password), EC2's Get Windows password and Cognito app clients (client secrets), nor
  `isSensitivePage`, which adds Cognito app clients and Identity Center credentials), only when the player asks. Proof: `npx vitest run tests/console.test.ts
  tests/console-cloudscape.test.ts tests/practice-console.test.ts tests/console-clarity.test.tsx tests/trust-copilot.test.ts tests/trust.test.tsx`, `cd server && npx
  vitest run test/console.test.ts`, `npm run smoke:copilot`.
- **Three browsers, one codebase.** WXT `-b firefox|safari` with `manifestVersion: 3` (WXT defaults those to MV2).
  Firefox has a fixed add-on id (its sign-in redirect is derived from it); Safari signs in through a relay page
  (no identity API). Firefox/Safari origins are random per install, so the server allows them by scheme, and a
  wildcard never authenticates by Origin alone. Proof: `npm run lint:firefox && npm run build:safari`,
  `cd server && npx vitest run test/http.test.ts -t "origins"`, `npx vitest run tests/auth.test.ts`.

## Gotchas found the hard way

- `Element.scrollIntoView()` returns a Promise in current Chromium. Never write
  `useEffect(() => el.scrollIntoView())`; use a block body instead.
- Phaser 4: in-world text is counter-scaled by camera zoom (`setUiScale`) so it stays readable in
  the 400 px side panel.
- Upstream sources: `.claude/references/cached-sources.md` (opensrc). Check them before guessing
  about WXT or Phaser behaviour.
