# Production runbook

Architecture (default, no custom domain): the extension → **CloudFront** (edge WAF, HTTPS) → VPC origin →
**internal** ALB → ECS Fargate (`server/`, ARM64 Graviton; 1 task in staging, ≥2 in prod) → DynamoDB
(`aws-city-<env>`, customer-managed KMS key, PITR + daily AWS Backup), S3 (screenshots, 1-day expiry),
Amazon Bedrock (Claude), the AWS Knowledge MCP server (docs), and each player's own AWS account through
`AWSCityPlayerRole-<region>` (`AWSCityPlayerRole-staging-<region>` for staging). With a custom domain, a **public HTTPS ALB** with its own regional WAF replaces
CloudFront. Everything is defined in `infra/` (CDK, cdk-nag AwsSolutions clean); the Well-Architected
evidence is in `docs/well-architected.md`.

## First deploy (once per AWS account)

A new AWS account: start with [the step-by-step guide](self-hosting.md) (root MFA, the Paid plan, an admin user,
Amazon Nova or Claude, and a new account's Bedrock hold). This section is the operator's checklist.

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
4. GitHub → Settings → Environments: create `staging` and `prod` (prod: required reviewers). Set variables
   `AWS_DEPLOY_ROLE_ARN` (the `AWSCityGitHubDeploy` role from the CI stack) and `AWS_REGION`, and on `prod`
   also `WXT_AWS_WS_URL`, `WXT_AWS_API_URL`, `WXT_COGNITO_DOMAIN`, `WXT_COGNITO_CLIENT_ID` (stack outputs).
   From then on: merge to `main` → CI → staging deploys the exact commit CI tested; the staging run's summary
   shows the **prod `cdk diff`**; a reviewer approves → prod.
   Before turning this on (security review, 21 Nov 2026; not live while `githubRepo` is empty):
   - `staging` deploys only from protected branches (set 21 Nov). Staging and prod still share one deploy role that
     can reach every CDK bootstrap role, so also add a required reviewer on `staging`, or give each environment its
     own role (better: its own account). Check: `gh api repos/<owner>/<repo>/environments --jq '.environments[]|{name,protection_rules}'`.
   - The repo uses GitHub's immutable OIDC subject (`repo:<owner>@<id>/<repo>@<id>:…`); `ci-stack.ts`'s trust policy
     and setup's check expect `repo:<owner>/<repo>:…`, so the role would refuse GitHub until they match.
     Check: `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`.
   - Releases (`release.yml`) publish through the `prod` environment, which allows only `main`: add a `v*` tag rule
     to it (and a tag ruleset limiting who may push `v*`) before the first release.
5. One-time account settings CDK doesn't manage:
   - **Amazon Inspector** ECR scanning for the CDK assets repository: `aws inspector2 enable --resource-types ECR`.
   - **Cost allocation tags**: activate `env` and `app` in Billing → Cost allocation tags (lets you split
     staging and prod spend; the budgets currently count the whole account).
   - **The account's security baseline.** `<r>` is your deploy Region; run the Regional ones there and in `us-east-1`
     (CloudFront's firewall). Each "Check:" reads it back.
     - **GuardDuty** (threat detection; a 30-day free trial, then a few dollars a month for a small account):
       `aws guardduty create-detector --enable --region <r>`. Check: `aws guardduty list-detectors --region <r>`.
     - **CloudTrail**: one multi-Region trail with log file validation into its own bucket (Block Public Access on,
       TLS-only policy, a lifecycle rule; CloudTrail console → Create trail does all of it). The first copy of
       management events is free. Check: `aws cloudtrail get-trail-status --name <trail> --query IsLogging`.
     - **IAM Access Analyzer** (anything shared outside the account):
       `aws accessanalyzer create-analyzer --analyzer-name account-external-access --type ACCOUNT --region <r>`.
       Check: `aws accessanalyzer list-analyzers --region <r>`.
     - **EBS encryption by default**: `aws ec2 enable-ebs-encryption-by-default --region <r>`.
       Check: `aws ec2 get-ebs-encryption-by-default --region <r>`.
     - **Password policy** (for any IAM user with a console password):
       `aws iam update-account-password-policy --minimum-password-length 14 --require-symbols --require-numbers --require-uppercase-characters --require-lowercase-characters --password-reuse-prevention 24`.
       Check: `aws iam get-account-password-policy`.
     - **S3 Block Public Access for ACLs, account-wide:**
       `aws s3control put-public-access-block --account-id <acct> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false`.
       Only the ACL half: the Data stack's templates bucket serves the player role template and the Safari sign-in
       relay through a public bucket policy (`player-role/*`, `auth/*`), so blocking public policies would break
       linking an account. Check: `aws s3control get-public-access-block --account-id <acct>`, then open the
       player role template URL (the Data stack's `PlayerRoleTemplateUrl` output): it must still load.
       IAM Access Analyzer reports exactly that one public read (the templates bucket); any other finding is new. It
       isn't archived: an archive rule can't match on the action, so it would also hide a wider policy there.
   - **An AWS Organization with other accounts** (e.g. a second account for testing linking, `docs/self-hosting.md`
     step 9). Run these from the management account. Each one is reversible from there.
     - **No root user in member accounts:** `aws organizations enable-aws-service-access --service-principal iam.amazonaws.com`,
       `aws iam enable-organizations-root-credentials-management`, `aws iam enable-organizations-root-sessions`, then
       per member `aws sts assume-root --target-principal <member> --task-policy-arn arn=arn:aws:iam::aws:policy/root-task/IAMDeleteRootUserCredentials`
       and, with those credentials, delete any root password, access keys, certificates and MFA.
       Check: `aws iam list-organizations-features` lists RootCredentialsManagement and RootSessions.
     - **One trail for the organization:** allow `AWSLogs/<org-id>/*` writes in the trail bucket's policy (same
       `aws:SourceArn` condition), `aws organizations enable-aws-service-access --service-principal cloudtrail.amazonaws.com`,
       `aws cloudtrail update-trail --name <trail> --is-organization-trail`. Check: `aws cloudtrail describe-trails --query 'trailList[].IsOrganizationTrail'`.
     - **GuardDuty for every account:** in each Region you use, `aws guardduty enable-organization-admin-account --admin-account-id <mgmt>`,
       `aws guardduty create-members` for each member, `aws guardduty update-organization-configuration --auto-enable-organization-members ALL`.
       Check: `aws guardduty list-members --detector-id <id> --region <r>` shows each member Enabled.
     - **An organization analyzer:** `aws accessanalyzer create-analyzer --analyzer-name org-external-access --type ORGANIZATION --region <r>`.
     - **Members' account settings** (through `OrganizationAccountAccessRole`): S3 Block Public Access, all four
       settings on, and EBS encryption by default in each Region.
     - **Guardrails (an SCP on the root, `AWSCityGuardrails`; members only, never the management account):** members
       can't leave the organization; can't stop or delete CloudTrail, GuardDuty, Access Analyzer, Config, Security Hub
       or Inspector, or switch off S3 Block Public Access or EBS encryption; a member's root user can't act (central
       root sessions from the management account still can, `aws:AssumedRoot`); and only eu-west-2, us-west-2 and
       us-east-1 work (AWS's documented global-service exemptions). Validate first:
       `aws accessanalyzer validate-policy --policy-type SERVICE_CONTROL_POLICY --policy-document file://scp.json`.
       Check: from a member, a call in another Region (e.g. `ap-south-1`) is refused with "explicit deny in a service
       control policy", and the city still reads the linked account.
   - **Continuous checks** (a few dollars a month): AWS Config recording all resources into its own private bucket,
     Security Hub with AWS Foundational Security Best Practices only (`--no-enable-default-standards` then
     `batch-enable-standards`), and Amazon Inspector for ECR (`aws inspector2 enable --resource-types ECR`), which
     switches the registry to enhanced scanning (OS and npm packages, rescanned as new CVEs appear).
     Check: `aws securityhub get-enabled-standards`, `aws configservice describe-configuration-recorder-status`,
     `aws ecr get-registry-scanning-configuration` (ENHANCED).
6. Release the extension: tag `v1.2.3` → the `release` workflow attaches the zip → upload it in the Chrome
   Web Store dashboard with `docs/store-listing.md` and `docs/privacy-policy.md`.

## Kill switch / budget

- **Manual, instant (~30 s):** `aws ssm put-parameter --name /cloud-city/<env>/ai-enabled --value false --overwrite`
  (players see "the city's AI is resting"; everything else works). Turn back on with `--value true`.
- **Automatic:** at 100% of the monthly budget, AWS Budgets attaches `AWSCityDenyBedrock-<env>` to
  `AWSCityTaskRole-<env>`. This exists even without an alarm email (Budgets notifies an SNS topic). You're
  warned earlier at 50%, 80% and when the month is *forecast* to overrun. Re-enable after review:
  `aws iam detach-role-policy --role-name AWSCityTaskRole-<env> --policy-arn arn:aws:iam::<acct>:policy/AWSCityDenyBedrock-<env>`
  and reset the budget action in the Budgets console.
- Per-player daily cap: `dailyModelCalls` (redeploy); global daily cap: `globalDailyModelCalls`. The Console
  Copilot also has a per-player 60-calls-per-10-minutes budget.
- **The AI on Fargate** (`aiCpu`, when Bedrock is held): `npm run ai -- off` stops its task (no cost while off),
  `npm run ai -- on` starts it (2–4 minutes), `npm run ai -- status` shows it. It runs until you switch it off: the
  budget action only denies Bedrock, so watch the 50%/80% emails. The kill switch above still stops every model call,
  this one included. Its log group is `AWSCity-<env>-Service-AiLogs…`; `npm run setup` without it removes the service.

## Alarms (SNS → alarmEmail)

| Alarm | Look at |
|---|---|
| Http5xx | ECS service events, the server log group (JSON lines; `level=error`, each with a `ref` players can quote). A deploy that trips it is **rolled back automatically**. |
| Unhealthy / TasksBelowMinimum | ECS service events (crash loop? capacity?), `UnhandledRejections` metric |
| ModelThrottled | Bedrock 429s after retries: raise the Bedrock quota (Service Quotas) or lower `globalDailyModelCalls` |
| TableThrottled | DynamoDB throttling on the player table (on-demand: usually a hot key or a burst) |
| GlobalCap / ModelCallSpike | Dashboard `aws-city-<env>`; consider the kill switch |
| QuotaRejections | Normal at scale; raise `dailyModelCalls` if players are unhappy |

Metrics in the `AWSCity` namespace also include `InputTokens`, `OutputTokens`, `CacheReadTokens` and
`Refusals` (what the Bedrock bill is made of, and whether prompt caching works).

## Security events

- **WAF logs:** CloudWatch Logs group `aws-waf-logs-aws-city-<env>[-edge]` (edge logs are in us-east-1).
  Tokens are redacted (`authorization`, `sec-websocket-protocol`).
- **Risky sign-ins (prod):** Cognito threat protection blocks high-risk sign-ins and leaked passwords and asks
  for MFA on medium risk. Cognito console → User pool → Threat protection shows the events.
- **A player says someone used their account:** disable the user (`aws cognito-idp admin-disable-user`), then
  `admin-user-global-sign-out`. Their sockets close within the token's lifetime (≤ 1 hour, sooner when idle).
  They should also delete the `AWSCity` stack in their own AWS account, which removes our access.

## Deploys and restarts

Rolling deploys are safe: a stopping task fails `/health`, tells players "the city is updating", waits up
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

- **"It says turn on an authenticator first":** linking an AWS account needs TOTP MFA (agents can change that
  account). Deploy tab → *Set up an authenticator*. Players who signed up before this need to sign out and in
  once. Google sign-ins are exempt (MFA is at Google). There is no switch to turn this off in hosted mode.
- **"Sign in again to confirm this":** linking, approving a change and applying a fix need a sign-in from the last
  30 minutes (`STEP_UP_MAX_AGE_MS`, `server/src/accounts/mfa.ts`), so a stolen refresh token can't act on a
  player's AWS account. The *Sign in again* button asks for the password and authenticator code again.
- **Lost authenticator:** `aws cognito-idp admin-set-user-mfa-preference --user-pool-id <pool> --username <user> --software-token-mfa-settings Enabled=false`
  after verifying who they are by email.
- **"Can't link my account":** they must create the stack from the link in the *same* region, then paste the
  12-digit account id. The role is `AWSCityPlayerRole-<region>`
  (`AWSCityPlayerRole-staging-<region>` on staging); its trust is fixed to our account.
- **Delete a player:** they can do it themselves (Deploy → Delete my account = `DELETE /me`): every table item,
  their screenshots and their Cognito user are removed, and their open tabs are disconnected.

## Local development (unchanged)

`npm run live` (your AWS profile, token mode, files): see README "3 · Develop against real AWS locally".
