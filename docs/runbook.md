# Production runbook

Architecture (default, no custom domain): the extension → **CloudFront** (edge WAF, HTTPS) → VPC origin →
**internal** ALB → ECS Fargate (`server/`, ARM64 Graviton; 1 task in staging, ≥2 in prod) → DynamoDB
(`aws-city-<env>`, customer-managed KMS key, PITR + daily AWS Backup), S3 (screenshots, 1-day expiry),
Amazon Bedrock (Claude), the AWS Knowledge MCP server (docs), and each player's own AWS account through
`AWSCityPlayerRole-<region>` (`AWSCityPlayerRole-staging-<region>` for staging). With a custom domain, a **public HTTPS ALB** with its own regional WAF replaces
CloudFront. Everything is defined in `infra/` (CDK, cdk-nag AwsSolutions clean); the Well-Architected
evidence is in `docs/well-architected.md`.

## First deploy (once per AWS account)

1. **Prerequisites** (yours): an AWS account with admin access for the first deploy; Claude Opus 5.5 and
   Sonnet 5.5 invocable on Bedrock in the region (Opus 5 and Sonnet 5 in India, which has no 5.5 profile:
   `infra/lib/models.ts` `GEO_MODELS`). The server calls them through a geo cross-Region inference profile
   whose prefix follows the deploy Region (`us.` for US and Canada, `eu.`, `au.` for Sydney/Melbourne, `in.` for
   Mumbai/Hyderabad; there is no `apac.` profile for these models), so only those Regions are accepted; synth and the
   wizard refuse any other (`infra/lib/models.ts`, from the Bedrock model cards' "Geo inference details"). (Serverless
   models are enabled on first call; Anthropic needs a
   one-time use-case form from the Bedrock **Model catalog**, plus `aws-marketplace:Subscribe` and a payment
   method: https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html). (No Docker: the server image is built in AWS CodeBuild during the deploy.) Optional: a Route 53 hosted zone (custom domain);
   a Google OAuth client (Google Cloud Console → Credentials → OAuth client, type *Web*, redirect URI
   `https://<cognitoDomainPrefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse`); the Chrome Web Store
   item id (upload a draft once to get it); for prod, a verified SES sender (`sesFromEmail`). Without one,
   Cognito sends sign-up and password-reset emails itself, about 50 a day for the whole account, and
   `cdk synth`/`deploy -c env=prod` print a warning (it's not an error, so CI works before SES is set up). Set it
   before launch.
2. Run **`npm run setup`** at the repo root. The wizard asks a few questions, writes `aws-city.config.json`
   (gitignored; it overrides the defaults in `infra/cdk.json`), stores the Google secret in Secrets Manager
   (`aws-city/google-oauth`), bootstraps CDK, deploys and builds the extension. `--dry-run` changes nothing in AWS
   (it still writes `aws-city.config.json`);
   `--yes --env staging` reuses saved answers (CI). **Prod requires an alarm email** (alarms and the budget
   cut-off notify it).
3. **Scope the CDK bootstrap roles** (recommended before CI deploys prod). By default `cdk bootstrap` gives
   the CloudFormation execution role `AdministratorAccess`, and the GitHub deploy role can reach it. Re-run
   bootstrap with a policy limited to the services in `infra/` (ECS, EC2/VPC, ELB, CloudFront, WAF, Cognito,
   DynamoDB, S3, KMS, Backup, Budgets, SSM, SNS, CloudWatch/Logs, IAM for the stack's own roles) and a
   permissions boundary:
   `npx cdk bootstrap aws://<acct>/<region> --cloudformation-execution-policies arn:aws:iam::<acct>:policy/AWSCityCdkExecution --custom-permissions-boundary AWSCityBoundary`
   The deploy role only assumes the default-qualifier roles (`cdk-hnb659fds-*`, `infra/lib/ci-stack.ts`).
4. The wizard's GitHub question is pre-filled from this clone's `origin` and asks you to confirm the repo: only that
   repo's `staging` and `prod` environments can assume the deploy role. GitHub → Settings → Environments: create
   `staging` and `prod` (prod: required reviewers). Set variables
   `AWS_DEPLOY_ROLE_ARN` (the `AWSCityGitHubDeploy` role from the CI stack) and `AWS_REGION`, and on `prod`
   also `WXT_AWS_WS_URL`, `WXT_AWS_API_URL`, `WXT_COGNITO_DOMAIN`, `WXT_COGNITO_CLIENT_ID` (stack outputs).
   From then on: merge to `main` → CI → staging deploys the exact commit CI tested; the staging run's summary
   shows the **prod `cdk diff`**; a reviewer approves → prod.
5. One-time account settings CDK doesn't manage:
   - **Amazon Inspector** ECR scanning for the CDK assets repository: `aws inspector2 enable --resource-types ECR`.
   - **Cost allocation tags**: activate `app` and `env` in Billing → Cost allocation tags (from the management
     account in an AWS Organization). **The budget filter only works once they are active:** each environment's budget
     counts its own resources (`app=aws-city` and `env=<env>`) plus all spend with no `app` tag, and until activation no
     cost carries the tags, so both budgets count the whole account. Tags take up to 24 hours to appear and another 24
     to apply, and aren't retroactive. Claude on Bedrock always counts in both budgets of a shared account: the server
     calls system geo inference profiles, which can't be tagged, and the cut-off is there for that spend
     (`infra/lib/budget-stack.ts`). If you also activate them as **IAM principal** tags (they appear after the task
     role's first Bedrock call), Cost Explorer can split Bedrock spend by environment too.
6. Release the extension: bump `version` in `package.json`, tag `v<that version>` → the `release` workflow attaches the
   zips → upload them in the Chrome Web Store dashboard (the same zip goes to Edge Add-ons) with
   `docs/store-listing.md` and `docs/privacy-policy.md`. The workflow stops if the tag isn't `v` + the package version,
   if a `WXT_*` variable is missing (a store build never falls back to the demo: `wxt.config.ts`), or if a built
   manifest has another version or a `key` (`scripts/release-check.mjs`).

## Kill switch / budget

- **Manual, instant (~30 s):** `aws ssm put-parameter --name /aws-city/<env>/ai-enabled --value false --overwrite`
  (players see "the city's AI is resting"; everything else works). Turn back on with `--value true`.
- **Automatic:** at 100% of the monthly budget (what it counts: *Cost allocation tags* above), AWS Budgets attaches `AWSCityDenyBedrock-<env>` to
  `AWSCityTaskRole-<env>`. This exists even without an alarm email (Budgets notifies an SNS topic). You're
  warned earlier at 50%, 80% and when the month is *forecast* to overrun. Re-enable after review:
  `aws iam detach-role-policy --role-name AWSCityTaskRole-<env> --policy-arn arn:aws:iam::<acct>:policy/AWSCityDenyBedrock-<env>`
  and reset the budget action in the Budgets console.
- Per-player daily cap: `dailyModelCalls` (redeploy); global daily cap: `globalDailyModelCalls`. The Console
  Copilot also has a per-player 60-calls-per-10-minutes budget.

## Alarms (SNS → alarmEmail)

| Alarm | Look at |
|---|---|
| Http5xx | ECS service events, the server log group (JSON lines; `level=error`, each with a `ref` players can quote). A deploy that trips it is **rolled back automatically**. |
| Unhealthy / TasksBelowMinimum | ECS service events (crash loop? capacity?), `UnhandledRejections` metric |
| LoggedErrors | 20+ `level=error` log lines in 5 minutes, three times running (a metric filter on the server log group; WebSocket failures too, which Http5xx never sees). Search the log group for `{ $.level = "error" }`; each line's `ref` is what players quote |
| UnhandledRejections | Any promise nobody handled (the server logs it and keeps serving): a bug. The log line `unhandled rejection` names the error |
| ModelThrottled | Bedrock 429s after retries: raise the Bedrock quota (Service Quotas) or lower `globalDailyModelCalls` |
| TableThrottled | DynamoDB throttling on the player table (on-demand: usually a hot key or a burst) |
| GlobalCap / ModelCallSpike | Dashboard `aws-city-<env>`; consider the kill switch |
| QuotaRejections | Normal at scale; raise `dailyModelCalls` if players are unhappy |

Metrics in the `AWSCity` namespace also include `InputTokens`, `OutputTokens`, `CacheReadTokens` and
`Refusals` (what the Bedrock bill is made of, and whether prompt caching works). The dashboard `aws-city-<env>` graphs
them with errors (`LoggedErrors`, `UnhandledRejections`) and model throttles.

## Security events

- **WAF logs:** CloudWatch Logs group `aws-waf-logs-aws-city-<env>[-edge]` (edge logs are in us-east-1).
  Tokens are redacted (`authorization`, `sec-websocket-protocol`).
- **Risky sign-ins (prod):** Cognito threat protection blocks high-risk sign-ins and leaked passwords and asks
  for MFA on medium risk. Cognito console → User pool → Threat protection shows the events.
- **A player says someone used their account:** disable the user (`aws cognito-idp admin-disable-user`), then
  `admin-user-global-sign-out`. Their sockets close within the token's lifetime (≤ 1 hour, sooner when idle).
  They should also **Disconnect** in the game (⋯ → Account → Your AWS account: it forgets the link record at once) and delete
  the `AWSCity` stack in their own AWS account, which removes our access. Only the player can remove that role: the
  stack lives in their account.

## Deploys and restarts

`/health` answers `{ "status": "ok", "version": "<server package.json version>", "contract": "<CONTRACT_VERSION>" }` (the
startup log line carries both too), so `curl https://<api>/health` tells which build is live. Rolling deploys are safe: a
stopping task fails `/health` (503, `"status": "draining"`), tells players "the city is updating", waits up
to 100 s for running agent turns, then closes sockets with 1012; the extension reconnects with jitter to a
healthy task. The circuit breaker and the 5xx deployment alarm roll back a bad image automatically.

## Restore player data

Two layers: **PITR** (any second in the last 35 days) and **AWS Backup** (a daily recovery point, each kept
35 days; the plan is in `infra/lib/data-stack.ts`). Nothing older than 35 days exists, by design: the privacy
policy promises that a deleted player is gone from every copy within 35 days, so don't add longer retention
without updating `docs/privacy-policy.md`.

**Once, after deploying the 35-day plan over the old one** (which kept monthly points a year): changing a plan
does not shorten recovery points that already exist. List them and cap each at 35 days (a point already older
than that is deleted):

```
aws backup list-recovery-points-by-backup-vault --backup-vault-name <vault> --query "RecoveryPoints[].RecoveryPointArn" --output text
aws backup update-recovery-point-lifecycle --backup-vault-name <vault> --recovery-point-arn <arn> --lifecycle DeleteAfterDays=35
```

1. Restore to a **new** table at a time before the incident:
   `aws dynamodb restore-table-to-point-in-time --source-table-name aws-city-<env> --target-table-name aws-city-<env>-restored --restore-date-time <ISO-8601 time>`
   (or `--use-latest-restorable-time`; or from a recovery point in the AWS Backup console).
2. Wait until `aws dynamodb describe-table --table-name aws-city-<env>-restored` shows `ACTIVE`.
3. Check a few players' items (`USER#<sub>` / `PROGRESS`), then copy them back into the live table with a
   script. (Pointing the service at the restored table means changing `tableName` in
   `infra/lib/data-stack.ts`, which replaces the table resource: prefer copying items back.)
4. Restores don't copy PITR, deletion protection or the backup selection: turn them on if the restored
   table becomes the live one.

Screenshots in S3 expire after a day and aren't backed up; that's by design.

## Player support

- **"It says turn on an authenticator first":** linking an AWS account, approving a change and applying a fix need TOTP
  MFA (agents can change that account). Deploy tab → *Set up an authenticator*; after enrolling the extension ends every
  session and the player signs in again with the code. Google sign-ins are exempt (MFA is at Google). Turn the check off
  only for testing: `REQUIRE_MFA_FOR_LINK=false`.
- **"Sign out, then sign in again with your app's code":** the player has TOTP on, but this session started before the
  server first saw it on (`server/src/accounts/mfa.ts` keeps that time and accepts only an access token whose `auth_time`
  is at or after it). Signing out and in fixes it. Nothing to do on the server.
- **Lost authenticator:** `aws cognito-idp admin-set-user-mfa-preference --user-pool-id <pool> --username <user> --software-token-mfa-settings Enabled=false`
  after verifying who they are by email.
- **"Can't link my account":** they must create the stack from the link in the *same* region, then paste the
  12-digit account id. The role is `AWSCityPlayerRole-<region>`
  (`AWSCityPlayerRole-staging-<region>` on staging); its trust is fixed to our account. A setup link is good for 24 hours
  for *Verify* ("Your setup link is more than a day old": they press *Get a new setup link*; the stack they already made
  keeps working, since the ExternalId doesn't change). A stack that fails with `iam:CreateRole` or CloudFormation denied
  is an account (workshop accounts, some Organizations) that can't create roles: nothing we can change. The player's
  steps and these messages are in `docs/connect-aws-account.md`.
- **"Was the stack deleted? Link again, or disconnect.":** STS refused the player's role on three polls in a row while
  their city was open (`BROKEN_AFTER` in `server/src/tenants.ts`), so the server stopped reading their account and marked
  the link record broken (`brokenAt`). It is not a revocation of anything and there's nothing to repair on our side: the
  record stays until the player links again (a new setup link, same ExternalId, then *Verify*), disconnects, or deletes
  their account. A restart doesn't retry a broken link.
- **A player wants to disconnect:** ⋯ → Account → Your AWS account → *Disconnect* (no MFA; the link record, with its
  ExternalId, is deleted and polling stops). It leaves the `AWSCity` stack and anything the city built in their account:
  the game tells them to take builds down first (Deploy → My builds) and then delete the stack in CloudFormation.
- **"Download my data":** ⋯ → Account → *Download my data* is `GET /me/export` (JSON: progress, the account link as
  metadata without the ExternalId or role ARN, their presence and leaderboard rows); `410` for a deleted player.
- **Delete a player:** they can do it themselves (⋯ → Account → Delete my account…, or Deploy → Your data; it is
  `DELETE /me`): every table item (the account link record included), their screenshots and their Cognito user are
  removed, and their open tabs are disconnected. It doesn't touch their own AWS account: the `AWSCity` stack and anything
  the city built there are theirs to remove (the confirmation warns them).

## Destroy and redeploy

`npm run setup -- --destroy --env <env>` (`cdk destroy --all -c env=<env> --force`) removes the stacks but, by design,
**keeps what holds player data or identity** (`RemovalPolicy.RETAIN`, checked in the synthesized prod templates):

| Kept | Where |
|---|---|
| The player table `aws-city-<env>` (deletion protection on) and its KMS key | `infra/lib/data-stack.ts` |
| The AWS Backup vault `AWSCity<env>DataTableBackupVault<hash>` and its recovery points | `infra/lib/data-stack.ts` |
| The Cognito user pool `aws-city-<env>` (**prod only**, with deletion protection; staging's pool is destroyed) | `infra/lib/auth-stack.ts` |
| The task role `AWSCityTaskRole-<env>` | `infra/lib/service-stack.ts` |
| The screenshot, template and log buckets (generated names) | `data-stack.ts`, `service-stack.ts` |

The KMS **alias** (`alias/aws-city-<env>-table`) is *not* kept: it has no retain policy, so the key survives without its
alias (the table still works) and a redeploy makes a new key with that alias.

What this means:

- **A redeploy with the same names fails:** the stacks try to create a table named `aws-city-<env>`, a role named
  `AWSCityTaskRole-<env>` and a backup vault with the same generated name, and they already exist.
- **Never "fix" that by letting a new user pool be created.** A new pool issues new user ids (`sub`), and every player's
  progress is stored under `USER#<sub>`, so all of it would be orphaned and every player would start from nothing. Their
  account link, ExternalId and MFA state sit under the same `sub`.
- So **destroying prod is effectively permanent** unless the kept resources are adopted back into the new stacks
  (`cdk import`, or CloudFormation resource import). Not verified here: whether each of these resource types can be
  imported (the table is an `AWS::DynamoDB::GlobalTable`). Check CloudFormation's import support and rehearse on staging
  first. The alternative is to delete the retained table and pool on purpose and accept that every player's data is gone
  (then say so on your privacy page).
- Staging is easier: its pool is destroyed, so only the table, role and vault block a redeploy, and its players start
  again anyway (new `sub`s) unless you adopt the old table.
- The retained task role keeps its permissions, including assuming players' `AWSCityPlayerRole-<region>`. With no tasks
  running nobody can use it, but if you are decommissioning rather than redeploying, delete it yourself.

To see what was kept:

```
aws dynamodb describe-table --table-name aws-city-<env> --query "Table.[TableStatus,DeletionProtectionEnabled,ItemCount]"
aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='aws-city-<env>'].[Id,Name]"
aws kms list-keys     # then: aws kms describe-key --key-id <id> --query KeyMetadata.Description
aws iam get-role --role-name AWSCityTaskRole-<env> --query Role.Arn
aws backup list-backup-vaults --query "BackupVaultList[?contains(BackupVaultName,'<env>')].BackupVaultName"
aws s3 ls
```

A destroy doesn't touch players' own AWS accounts: their `AWSCityPlayerRole` keeps trusting our account until they delete
their `AWSCity` stack.

## Local development (unchanged)

`npm run live` (your AWS profile, token mode, files): see README "3 · Develop against real AWS locally".
