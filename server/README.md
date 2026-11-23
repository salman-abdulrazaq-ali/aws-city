# AWS City backend (`server/`)

A Node 24 + TypeScript server that implements the frontend contract
([`docs/backend-contract.md`](../docs/backend-contract.md), v2.17, source of truth `src/backend/contract.ts`)
against a **real AWS account** and **Claude on Amazon Bedrock**. It runs two ways: **locally** (this README: one player,
your own AWS profile, a token, files) or **hosted** (`AWS_CITY_MODE=hosted`: Cognito sign-in, one tenant per player acting in
their own account through `AWSCityPlayerRole-<region>`, DynamoDB and S3; see `infra/` and
[`docs/runbook.md`](../docs/runbook.md)). `src/config.ts` refuses unsafe mixes at startup.

It imports `src/backend/contract.ts`, `src/world/taxonomy.ts` and `src/world/places.ts` directly. Event
types, service ids, agent names and places therefore come from the frontend, and a contract change breaks
this build instead of drifting.

**Why local, not API Gateway + Lambda:** the AWS Workshop Studio account denies CloudFormation and
`iam:CreateRole`, so Lambdas (which need an execution role) can't be deployed. The server runs next to the
browser on `127.0.0.1:8787`, uses your AWS CLI profile (`workshop` when run directly; `npm start` sets it), and the extension never sees AWS keys.
The contract is transport-shaped (WebSocket + REST), so a Lambda version can replace it later without
frontend changes.

## Connect the frontend

From the repo root, one command does all of this for you:

```bash
npm start          # pick "Real AWS": AWS sign-in, Bedrock check, server, extension build, browser
npm run live       # the same without questions (npm run live -- --help)
```

It builds the extension against `ws://127.0.0.1:8787`, starts this server with your AWS profile, and allows
exactly that build's origin (the unpacked extension id is fixed by `extension.pubkey`; Firefox's UUID is pinned
with a pref; Safari gets a one-off token).

### By hand (advanced)

```bash
cd server && npm ci && EXTENSION_ORIGIN=chrome-extension://<id> AWS_CITY_PROFILE=<profile> AWS_CITY_TOKEN=<token> npm start
```

and build the extension with `WXT_BACKEND=aws`, `WXT_AWS_WS_URL=ws://127.0.0.1:8787/ws`,
`WXT_AWS_API_URL=http://127.0.0.1:8787` and `WXT_AWS_TOKEN=<token>` (the same token). Comma-separate several origins.
Every client (the extension, curl, tests) must send the token: `Authorization: Bearer <token>`, or for a WebSocket the
`base64UrlBearerAuthorization.<base64url token>` subprotocol the extension uses. It is never read from the query string,
and an `Origin` header never authenticates on its own (the dev extension's id is public): `EXTENSION_ORIGIN` is only the
browser check that a web page can't reach the server. `npm start` / `npm run live` mint a fresh 24-byte token each run and
build it into the extension (`WXT_AWS_TOKEN`). A token you set yourself must be at least 32 characters.

## How the contract is implemented

| Contract | Implementation |
| --- | --- |
| `task.submit` | Concierge (Bedrock) picks the agent and plan → `agent.message` ×2 → `task.plan` → ~4 s walk → the agent's tool loop. Each real AWS call is wrapped in `agent.state working/idle` and advances a `task.step` → `task.done` with XP (15, +5 per AWS write, 3 if it failed). |
| `chat.ask` | The district's agent (keyword-matched, as in the mock) streams a Bedrock answer as `chat.answer` deltas, then `done:true`. |
| `deploy.approve` / `deploy.reject` | The player's answer to a `deploy.preview` raised by an agent's write (v2). |
| `page.classify` | Lookout (Bedrock vision on the uploaded screenshot, or URL/title) → `page.classified` with valid service ids only. |
| `POST /screenshots` | Returns a **single-use, signed upload URL** on this server (a local stand-in for a presigned S3 PUT). Images are kept in memory for 10 minutes. |
| `GET/PUT /progress` | `server/.data/progress.json`; the newest `updatedAt` wins. |
| `GET /me/export` (v2.17) | A JSON download of what the server keeps about the player: progress, the account link as metadata (never the ExternalId or role ARN) and their presence and leaderboard rows. `DELETE /me` removes it all. Locally there's no account link, so `account` is absent. |
| `account.link` / `account.verify` / `account.unlink` (v2.17) | **Hosted only** (`src/accounts/link.ts`, `src/tenants.ts`): a CloudFormation quick-create link for `infra/player-role/player-role.yaml` (v5, with `ConnectsPlayer` and optional `AllowFixes`), a verify that assumes the role (refused more than 24 h after the link), and a disconnect that forgets the link (no MFA). Three polls in a row refused by STS, the first at least 5 minutes old (`REFUSAL_WINDOW_MS`), mark a link broken and stop polling. The local server answers that it uses your profile, so there is nothing to link or disconnect. Player guide: [`docs/connect-aws-account.md`](../docs/connect-aws-account.md). |
| `resource.remove` (v2.17) | Takes down one game-built instance, table or bucket with no model, through the same ActionService path as an agent's write: policy, the gate, a `deploy.preview`, the player's approval. |
| `city.inventory` zones / regionStatus (v2.5) | `src/state/inventory.ts`: `ec2:DescribeAvailabilityZones` (zone type availability-zone) for the home Region and every Region with resources, and `ec2:DescribeRegions {AllRegions}`, each cached 24 h (a Region that can't be read is left out and retried after an hour). |
| `bill.enable` → `city.bill` (v2.5) | `src/state/bill.ts`: `ce:GetCostAndUsage` (us-east-1), month to date, UnblendedCost by SERVICE and REGION, mapped to landmarks by `shared/ce-services.json`. **Off by default** (each request costs $0.01): read when turned on, then at most once a day per player; the switch and the last read are cached in the player's store (`server/.data/bill.json` locally, `USER#<sub>`/`BILL` in DynamoDB hosted). Errors become one sentence (`unavailable`). |
| Live console changes | The poller reads EC2, security groups, DynamoDB, S3, Lambda, RDS and API Gateway every 10 s. Changes become `agent.message` from that landmark's agent, with a short lesson. IAM-denied services are reported by `iam`, and expired credentials as `error`. |

"Agent animation = real AWS activity": `agent.state working` is only sent around real calls (the AWS SDK
or Bedrock) made for that agent, never for background polling.

## What agents can do (guardrails)

Tools are per agent: **ec2** can launch (`t4g.nano`/`t4g.micro` only), stop and start instances;
**dynamodb** can create `city-*` tables; **s3** can create `aws-city-<account>-*` buckets. Every agent can
`describe_resource`, and the others explain.

- Writes only touch resources the game created: tag `managed-by=aws-city` (tables need the tag, not just the name).
- Limits: 3 live instances, 5 tables, 3 buckets. Writes are serialised, and just-created resources count before AWS lists them.
- **Every write asks the player first** (contract v2): the agent's tool call becomes a `deploy.preview` in the city's Deploy tab, and runs only after `deploy.approve` (`src/contract/approvals.ts`). Policy is checked before asking and again after approval. Terminate/delete are therefore possible, but only with an explicit approval. Requests time out after 5 minutes, and closing the socket rejects them. With no approval channel every write is refused and only reads run. Hosted, approving a write (and applying a fix) also needs a session that signed in after the player's authenticator was turned on (MFA step-up).
- **A deterministic gate** (`src/guard/`) sits on every client that holds credentials, local ones too: it refuses, before signing, any command it doesn't know, any request outside the home Region (the AZ and Region lists and Cost Explorer excepted), any write not shaped exactly as the server sends it, and any write without a single-use grant for that command and target. It stops mistakes in server code; the player role (hosted) and IAM are the outer wall.
- An optional second opinion, Jev (`src/agents/jev.ts`, [`docs/jev.md`](../docs/jev.md)), is on only when `TYPESAFE_API_KEY` is set; it can only make an approval stricter.
- zod validation on every tool call and WebSocket frame. Extra fields are rejected; region and instance types are fixed.
- The local server listens on loopback only (config refuses a token-mode server on any other host), checks the Host header (DNS-rebinding guard), and checks the Origin allowlist. It also enforces body and upload size limits, caps connections, tasks (2) and chat/classify requests (3) per socket, and never crashes on client resets.
- Known limitation: if a socket closes mid-task, that task's remaining events are dropped (the frontend shows it as still running).

## Commands

```bash
npm start        # run (tsx)
npm test         # unit tests, no AWS calls (they include the frontend contract assertions)
npm run build    # type-check (tsc)
npm run build:bundle   # esbuild → dist/main.js, what the Docker image runs
```

| Env var | Default | |
| --- | --- | --- |
| `AWS_CITY_PROFILE` | `workshop` | AWS CLI profile |
| `AWS_CITY_REGION` | `us-west-2` | |
| `PORT` | `8787` | |
| `EXTENSION_ORIGIN` | unset | extension origin(s) the browser check accepts (every request still needs the token) |
| `AWS_CITY_TOKEN` | random per start | required by every client; 32+ characters; fix it to keep the same token across restarts |
| `AWS_CITY_MODEL` | `us.anthropic.claude-opus-5-5` | Bedrock inference profile (the launcher sets the Region's own: `eu.`, `au.`, or `in.` with Opus 5 / Sonnet 5; see `infra/lib/models.ts`) |
| `AWS_CITY_FALLBACK_MODEL` | `us.anthropic.claude-sonnet-5-5` | retried once if the main model refuses |
| `AWS_CITY_LIGHT_MODEL` | the fallback model | chat answers and page classification |
| `AWS_CITY_AGENT_ENGINE` | `strands` | `classic` keeps the hand-written tool loop for landmark agents (the citizens always run on Strands) |
| `AWS_CITY_ALLOW_FIXES` | `false` locally, `true` hosted | let the citizens apply approved fixes; the profile isn't role-scoped, so it's off locally (`npm run live -- --allow-fixes` sets it) |
| `TYPESAFE_API_KEY` | unset | turns the optional Jev second opinion on |

Connecting an account of your own to the hosted game, or running locally against yours, is covered in
[`docs/connect-aws-account.md`](../docs/connect-aws-account.md).

### Workshop credentials

Workshop Studio keys expire after a few hours. The city then gets an `error` event, and writes are blocked
until you paste fresh keys. The server re-reads the profile every minute, so no restart is needed:

```bash
aws configure set aws_access_key_id     <KEY>    --profile workshop
aws configure set aws_secret_access_key <SECRET> --profile workshop
aws configure set aws_session_token     <TOKEN>  --profile workshop
```

### Bedrock route

In the workshop account, Bedrock's Messages-API endpoint (`bedrock-mantle`) only served Haiku 4.5. The Claude models
are reachable through `bedrock-runtime` inference profiles (InvokeModel), so `src/agents/llm.ts` uses
`AnthropicBedrock` from `@anthropic-ai/bedrock-sdk`. Calls never force `tool_choice`.

## Layout

```
src/world.ts              re-exports the frontend's contract, taxonomy and places
src/contract/             orchestrator (task/chat/lookout), approvals, aws-feed (console → messages), uploads, progress
src/agents/               actions (allowlist → tools), policy, service (serialised writes), executor (AWS SDK),
                          runner (tool loop), llm (Bedrock), personas (built from places.ts), care/findings/fixes
                          (City care), jev (optional second opinion)
src/guard/                the deterministic gate: rules, grants, the SDK middleware
src/citizens/             the Strands citizens
src/accounts/             link (setup link, verify), mfa (step-up)
src/state/                poller (AWS reads), diff, model, inventory (the account mirror, AZs, Regions), bill (Cost Explorer), flow (CloudWatch)
src/store/                local files or DynamoDB (progress, account links, social, MFA)
src/tenants.ts            one city per player: link, verify, unlink, resource.remove, export, delete
src/news, knowledge, workshops, translate   AWS status feeds, the docs MCP client, workshop checks, short lessons
src/http.ts               REST + WebSocket, auth, guards
```
