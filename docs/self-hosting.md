# Run AWS City on your own AWS account

This guide takes you from a brand-new AWS account to your own hosted AWS City, the way we did it for real. It covers
every step a new account needs, including the ones that tripped us up. It works the same for one person or a whole
company.

**What you'll end up with:** the AWS City server running in *your* account (CloudFront, ECS Fargate, DynamoDB,
Cognito sign-in, and AI on Amazon Bedrock), and players signing in from the browser extension.

**Time:** about an hour, plus any waiting on AWS for a new account (step 7). **Cost while idle:** staging about $45–60
a month, prod about $60–85, plus the AI, which is pay-per-use. A monthly budget switches the AI off at your limit.

> Just want to play? You don't need any of this: `npm start` opens the demo, with no AWS account at all.

## 1. Create an AWS account

Sign up at [aws.amazon.com/free](https://aws.amazon.com/free/). If you're going to host AWS City, choose the **Paid
plan**. You still get the Free Tier credits.

Why it matters: AWS's [Free Tier terms](https://aws.amazon.com/free/terms/) say a Free plan account expires once its
credits are used up (or after six months), and is closed 90 days later unless you upgrade. Your hosted city would go
with it. If you upgrade, your remaining credits carry on paying your bills.

## 2. Turn on MFA for the root user

The email and password you signed up with are the account's **root user**, which can do anything. Protect it with
multi-factor authentication: account menu (top right) → **Security credentials** → **Assign MFA device**
([how](https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-virt-mfa-for-root.html)).

From now on, use root only for billing and account settings
([AWS's advice](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html)).

## 3. Upgrade to the Paid plan, as root

Skip this if you chose the Paid plan in step 1. Sign in **as root**, then open
[Billing → Upgrade plan](https://console.aws.amazon.com/billing/home?#/freetier/upgrade) and choose **Upgrade plan**.
You'll see "You upgraded your account successfully". Your remaining credits stay.

**If you see "An error occurred while processing your request":** you're probably signed in as an IAM user. Billing
pages are for root unless root has
[turned on IAM access to billing](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/control-access-billing.html).
Sign out, sign in as root and try again.

AWS takes a few minutes to switch on the extra services after an upgrade.

## 4. Create an admin user with MFA

This is the identity you'll use every day, instead of root.

1. Open **IAM** → **Users** → **Create user**. Pick a name such as `yourname-admin`.
2. Tick **Provide user access to the AWS Management Console** → **I want to create an IAM user** → set a password.
3. **Attach policies directly** → `AdministratorAccess` → **Create user**.
4. Note your **account ID** (12 digits, top right) and sign in at `https://<account-id>.signin.aws.amazon.com/console`
   with that username.
5. **IAM** → **Users** → your user → **Security credentials** → **Assign MFA device** → authenticator app.

([How to create an IAM user](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_create.html) ·
[MFA for IAM users](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_enable_virtual.html))

**For a company:** use [IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html)
for your people, and give AWS City its own AWS account. Note that a Free plan account that joins AWS Organizations is
upgraded to the Paid plan and stops earning or using Free Tier credits ([terms](https://aws.amazon.com/free/terms/)).

## 5. Sign in on your computer

Install [Git](https://git-scm.com/downloads), [Node.js 24](https://nodejs.org) and the
[AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) (version 2.32 or later). Then:

```bash
git clone https://github.com/salman-abdulrazaq-ali/aws-city.git && cd aws-city
aws login --profile aws-city
```

Pick your Region (for example `eu-west-2`, London) and sign in **as your admin user from step 4**, not root. If
`aws login` says the profile already uses root, answer **y** to switch it. To check, run
`aws sts get-caller-identity --profile aws-city`: the `Arn` must end in `user/<your admin name>`.

## 6. Choose the AI models

AWS City's agents run on [Strands Agents](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-frameworks/strands-agents.html)
with a model on Amazon Bedrock. You choose which one in step 8:

| | Amazon Nova (recommended) | Claude |
|---|---|---|
| What | [Amazon's own models](https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html): Nova Pro for the agents, Nova Lite for chat | Anthropic's Claude Opus and Sonnet |
| Before you start | Nothing extra | Submit Anthropic's one-time use-case form: Bedrock console → **Model catalog** → a Claude model ([how](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)) |
| Plan | Available on the Free and Paid plans ([aws.amazon.com/free](https://aws.amazon.com/free/)) | Needs the Paid plan (a paid AWS Marketplace offer) |
| Regions | Wherever Bedrock offers Nova on demand | US, Europe, Sydney/Melbourne and Mumbai/Hyderabad (geo inference profiles) |

## 7. A new account's Bedrock hold

A brand-new account can't call Bedrock straight away. `npm run setup` (and `npm run live`) checks this for you and
says which of these you've hit:

| What you see | What it means | What to do |
|---|---|---|
| "Your account is currently being verified" | AWS is still verifying the new account | Wait. AWS says it normally takes under 2 hours. |
| "Too many tokens per day", or every model at 0 in [Bedrock's quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html) | The account's AI quota hasn't been set yet | Wait a few hours after verification or an upgrade. If it stays at 0, open a support case (below). Service Quotas won't accept a request: the default is already higher than 0. |
| "… is not available for this account" | A paid Marketplace model (Claude) on the Free plan | Upgrade (step 3), or choose Amazon Nova. |
| "Model use case details have not been submitted" | Claude's use-case form | Submit it (step 6). |

**The support case** (free on any plan):
[Support Center → Create case](https://support.console.aws.amazon.com/support/home#/case/create) → **Service limit
increase** → Amazon Bedrock, your Region. You can paste:

> New account, on the Paid plan. Every Amazon Bedrock model in `<region>` has a quota of 0 tokens per day, so Converse
> calls to amazon.nova-pro-v1:0 and amazon.nova-lite-v1:0 fail with ThrottlingException ("Too many tokens per day").
> Please apply the default on-demand quotas for Amazon Nova Pro and Nova Lite. It's for a small educational app (a
> few users).

**You don't have to wait to host.** When the AI check fails, `npm run setup` offers to deploy the city with its AI
switched off. Sign-in, saving progress, linking an account, City care's findings and AWS status all work without it.
Once Bedrock answers, run `npm run setup` again and the AI switches on. `npm run setup -- --dry-run` checks everything
and changes nothing in AWS.

## 8. Deploy with `npm run setup`

```bash
npm install
npm run setup
```

The wizard uses the `aws-city` profile from step 5 by itself (or `AWS_PROFILE`, if you set one), and suggests that
profile's Region. It first checks your sign-in (it warns if it's root), your plan (it stops on the Free plan) and the AI
models. Then it asks a few questions:

| Question | Suggested answer |
|---|---|
| Environment | `staging` first, then `prod` |
| AI models | **Amazon Nova** |
| Region | Where you signed in, e.g. `eu-west-2` |
| Web address | **No domain** (free HTTPS from CloudFront) |
| Sign-in page name | Accept the suggestion |
| Google sign-in | Skip (email and password always work) |
| Alarm email | Your email |
| Monthly budget | 50 for staging (the AI switches off at 100%) |
| SES sender | Skip for staging |
| Allow the local build | Yes for staging |
| Chrome Web Store id | Leave empty |
| GitHub deploys | Skip |

It asks before every change to AWS, bootstraps CDK, deploys (15–25 minutes the first time), smoke-tests the live API,
and builds the extension. The answers are saved in `aws-city.config.json` (no secrets).

## 9. After the deploy

1. Open the email from **AWS Notifications** and click **Confirm subscription**, so alarms and budget alerts reach you.
2. In Chrome, open `chrome://extensions` → **Developer mode** → **Load unpacked** → pick `.output/chrome-mv3`.
3. In the city: **⋯ → Sign in to save your city** → sign up with your email → turn on MFA when asked.
4. **Link your AWS account:** follow the in-game link to create the small, read-mostly role in *the same Region*, then
   paste your 12-digit account ID.
5. Ask an agent something, and approve one change. Every change waits for your **Approve**.

## 10. Running it, and taking it down

- **Switch the AI off instantly** (about 30 seconds):
  `aws ssm put-parameter --name /aws-city/staging/ai-enabled --value false --overwrite`. Turn it back on with
  `--value true`. Everything else keeps working.
- Alarms, the budget cut-off and restores are in the [runbook](runbook.md).
- **Remove a deployment:** `npm run setup -- --destroy --env staging`. The table and buckets are kept so no player
  data is lost by accident; delete them in the console if you're sure.
