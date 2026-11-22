# Jev: a second opinion on agents' AWS writes

AWS City can ask [TypeSafe's Jev](https://docs.typesafe.ai/api) to look at each AWS change an agent proposes before
the player is asked to approve it. It's off by default and only ever makes the city stricter. Code:
`server/src/agents/jev.ts`; proof: `cd server && npx vitest run test/jev.test.ts test/service.test.ts test/guard.test.ts`.

## What it does

The order for every agent write is unchanged, with one step added:

1. The action allowlist (zod schemas, `agents/actions.ts`) parses the model's tool call.
2. Policy (`checkAction`, `agents/policy.ts`) checks limits and ownership. A write it denies stops here: Jev never sees it.
3. **Jev** answers two questions about the write, and code turns the answers into a verdict:
   - **allow**: the player sees the ordinary preview (`deploy.preview`) and approves or rejects it.
   - **ask**: the player sees the preview with a "Safety check: …" line and must type the resource's name to approve
     (the preview's `confirmText`, contract v2.3; a destructive write always carries one, whatever Jev says). The server refuses an approval whose typed name doesn't match.
   - **block**: the write is refused with a plain sentence ("The city's safety check stopped this…"); the player isn't
     asked and nothing reaches AWS.
4. The player's approval (`deploy.approve`, with MFA step-up when hosted).
5. The deterministic gate (`server/src/guard/`) lets through exactly the approved request, once.

Reads never go to Jev. Jev can't allow anything that policy or the gate deny, skip the player's approval or answer it.

### The questions and the policy

- `intent` (`noul`, yes/no): "Does this AWS change do what the player asked for?", with explicit `true`/`false`
  criteria. It's asked only when the player's own request is known (an agent task's prompt).
- `risk` (`score`, three levels, lowest first): a harmless small game resource the player asked for; stops, deletes or
  costs money; destroys data, makes something public or touches what the player didn't mention.

The thresholds are applied in code, never by Jev (`verdictFor`):

| Verdict | Rule (defaults) | Override |
|---|---|---|
| block | intent < 0.2 | `AWS_CITY_JEV_BLOCK_BELOW` (0–1) |
| ask | intent < 0.6, or risk ≥ 1.2 | `AWS_CITY_JEV_ASK_BELOW` (0–1), `AWS_CITY_JEV_ASK_RISK` (0–2) |
| allow | otherwise | |

**It fails closed to ask.** A timeout (3 s), a non-2xx reply, a reply over 32 KB, a redirect, JSON that doesn't
match TypeSafe's documented response shape, or a missing answer all make the write "ask".

## What is sent to TypeSafe

One `POST https://api.typesafe.ai/v1/systemone` per write (fixed host, no redirects), with `Authorization: Bearer
<key>`. The body holds the pinned model name, the two questions above and a small state:

```json
{ "request": "please knock down my old test server",
  "action": "terminate_instance",
  "change": "Permanently terminate EC2 instance i-0abc0000000000001",
  "destructive": true }
```

- `request` is the player's own words for the task, cut to 500 characters, and only when known.
- `change` is the server's one-line summary of the validated action.
- 12-digit numbers (account ids, which bucket names contain) become `<account>` and ARNs become `<arn>`, in both
  fields.
- Nothing from AWS is sent: no tool output, resource listings, tags, names read from the account, ARNs or account ids.
  Instructions live in the questions, never in the state.

## Turning it on

Set `TYPESAFE_API_KEY` on the server (a key from console.typesafe.ai/keys). It works in local and hosted mode.

| Variable | Default | Notes |
|---|---|---|
| `TYPESAFE_API_KEY` | unset (off) | Presence turns Jev on. One printable token. Never logged. |
| `AWS_CITY_JEV_MODEL` | `jev-1.13.0` | Pinned, because aliases move on release. A reply from another model is used, and logged as a warning. |
| `AWS_CITY_JEV_BLOCK_BELOW` / `_ASK_BELOW` / `_ASK_RISK` | 0.2 / 0.6 / 1.2 | Startup fails on a value out of range, or block above ask. |

The startup log line shows `jev: <model>` or `jev: off`. The task needs HTTPS egress to `api.typesafe.ai`.

Hosted, the key reaches the ECS task only as a Secrets Manager secret, never a plain environment value:

1. Create the secret in the deployment's account and Region: `aws secretsmanager create-secret --name aws-city/jev
   --secret-string '{"apiKey":"<your key>"}'`.
2. Add `"jev": { "secretName": "aws-city/jev" }` to the environment's settings (`staging` or `prod` in
   `aws-city.config.json`, or `-c prod='{…}'`); `"model"` beside it pins a model other than the server's default.
3. Deploy (`npm run setup`, or the deploy workflow). Remove the `jev` block and deploy again to turn it off.

Each decision is logged once (`jev`): a decision id, the model that answered, the scores, the verdict, the latency and
the token usage. A failure is logged as a warning with its kind (`TimeoutError`, `status 503`, `schema`…). The state,
the player's words and the key are never logged.

## Cost

A request is about 1.2 KB (1.7 KB with the longest request text), a few hundred input tokens. At TypeSafe's listed
price (about $0.042 per million input tokens; output is free) that's about 2 cents per thousand writes. Check
TypeSafe's current pricing before relying on it. Each write also waits for Jev's answer (up to 3 s) before its preview
shows.

## Limits: why it may only tighten

Jev reads the state as data, but TypeSafe's own notes and an independent test show that text planted in the state can
move its answer (a "pre-approved" field lowered a block score). The player's request is free text, and an attacker who
can steer an agent might steer its words too. So Jev is never trusted to loosen anything: the allowlist, policy, the
player's approval and the gate decide what can happen; Jev can only add a typed confirmation or a refusal. Its
`confidence` is how concentrated its answer is, not the chance it's right, so the policy doesn't use it.
