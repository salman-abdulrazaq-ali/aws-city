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

An `aws login` sign-in expires after some hours. If it has expired, or you skipped this step, `npm run setup` notices.
It offers **Sign in with your browser**, runs `aws login` for you, and carries on from the same question.

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

**The hold is often Region by Region, and model by model.** For Amazon Nova, `npm run setup` then looks for a Region
where Nova answers (it tries us-west-2, us-east-1 and eu-central-1) and offers to run the city's AI there for now:
your data, sign-in and server stay in your Region, and only the agents' questions are processed in that one. If Lite
answers but Pro doesn't, the city runs on Nova Lite. Run setup again once your Region answers to move it back. On your
own computer, `npm run live -- --model nova --region us-west-2` does the same.

**On your own computer, the AI doesn't need Bedrock at all.** `npm run live -- --model local` runs the agents on a
model in Ollama on your computer (the launcher offers to install it and download the model once), and
`npm run live -- --model nova --local-fallback` tries Bedrock first and uses that model when Bedrock is held.

**The hosted city's AI can run on AWS without Bedrock.** When Bedrock is held, `npm run setup` offers to run the
agents on an open model (Qwen3 4B, Apache-2.0) on a private Fargate service in your VPC: Graviton CPUs, no GPU, and
only the city's server can reach it, so questions never leave your AWS account. The server's Strands Agents try
Bedrock first and this model next, so once Bedrock answers it carries on by itself.

| | Cost while it runs (eu-west-2) | Notes |
|---|---|---|
| On-demand | about $0.36 an hour (~$8.70 a day): 8 vCPU + 16 GB of Graviton Fargate | steady: use it for a live demo |
| Spot | usually well under half of that | AWS can stop it with two minutes' notice; ECS starts another |

It's slower than Bedrock (a CPU, not a GPU). Switch it on and off without a deploy: `npm run ai -- on`,
`npm run ai -- off`, `npm run ai -- status`. While it's off it costs nothing; the rest of the city keeps working.
A new account's GPU quota (EC2 G instances, SageMaker GPU endpoints) also starts at 0; ask for it in Service Quotas
if you want a faster self-hosted model later.

**You don't have to wait to host.** When no Region answers and you don't want the Fargate AI, `npm run setup` offers
to deploy the city with its AI switched off. Sign-in, saving progress, linking an account, City care's findings and AWS status all work without it.
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
| Google sign-in | Skip (email and password always work). If you add it, **Publish app** in Google's consent screen, or only the test users you list can use it |
| Alarm email | Your email |
| Monthly budget | 50 for staging (the AI switches off at 100%) |
| SES sender | Skip until SES has production access (a new account's SES only emails addresses you verify) |
| Allow the local build | **Yes** until your Chrome Web Store listing is live (otherwise nothing can sign in) |
| Chrome Web Store id | Leave empty |
| Firefox / Safari | Chrome and Edge always work. Answer **Yes** to let players use Firefox or Safari too (one question each) |
| GitHub deploys | Skip |

**Nothing changes in AWS while you answer.** At the end, a review screen lists every answer and every change it will
make (storing the Google secret, verifying an SES address, preparing CDK, the deploy). Choose **Deploy**, **Change an
answer** (the questions again, with your answers filled in) or **Cancel**. Then it asks before each change, deploys
(15–25 minutes the first time), smoke-tests the live API and builds the extension. Your answers are saved in
`aws-city.config.json` (no secrets).

**The deploy shows where it is.** Every minute a ⏳ line says what AWS is doing and for how long, so a quiet step
doesn't look stuck. The slow ones are the server's: after a code change AWS CodeBuild builds its image (3–6 minutes),
then ECS starts the new servers, checks they're healthy, lets the old ones finish their players' connections and
watches the error alarm for a few minutes (it rolls back by itself if errors show up). Players are on the new version
as soon as the old servers stop.

**Why us-east-1 when you chose another Region?** Without a custom domain, the city is served through CloudFront, which is
global, and AWS requires CloudFront's firewall (AWS WAF) to be created in us-east-1 (N. Virginia)
([AWS WAF docs](https://docs.aws.amazon.com/waf/latest/developerguide/how-aws-waf-works-resources.html)). Only that
firewall lives there. Your server, data and sign-in stay in your Region.

**Sign-up emails:** skip Amazon SES unless your account has SES production access. A new account's SES is in a
sandbox, where it emails only addresses you verify one by one, so other players couldn't sign up. Use an address on a
domain you own: a free address (outlook.com, gmail.com…) sent through SES is often filtered as spoofed.

## 9. After the deploy

1. Open the email from **AWS Notifications** and click **Confirm subscription**, so alarms and budget alerts reach you.
2. In Chrome, open `chrome://extensions` → **Developer mode** → **Load unpacked** → pick `.output/chrome-mv3`. (This
   works if you answered **Yes** to "Allow the local build"; otherwise only your Chrome Web Store build can sign in.)
3. In the city: **⋯ → Sign in to save your city** → sign up with your email → turn on MFA when asked.
4. **Link an AWS account** (the City tab's **Connect your AWS account** card, then Deploy's steps): scan the QR code
   with an authenticator app, **Get my setup link**, create the AWSCity stack in the Region the step names, then type
   the 12-digit account ID. Signed in to AWS in another browser? **Copy link** and open it there.
5. Ask an agent something, and approve one change. Every change waits for your **Approve**.

The **Server** and **Sign-in** addresses setup prints aren't web pages. The extension uses them. Opened in a browser,
the server only says what it is, and the sign-in address shows `Missing Authentication Token`. Both are normal. To check
the server, open `<Server>/health`: it shows `{"status":"ok"}`.

**Testing it yourself? Link a second AWS account.** AWS City refuses the account it runs in ("That's the city's own
account"), so its server can never act inside the account that holds everyone's data. Your players link their own
accounts; to try linking as the host, make a test account:
1. Signed in to your account: **AWS Organizations → AWS accounts → Add an AWS account → Create an AWS account**. Name
   it (e.g. "AWS City player test") and give it an email no AWS account uses yet (a plus-address works:
   `you+awscity-player@example.com`). Organizations makes a role, `OrganizationAccountAccessRole`, that your admin can
   switch into.
2. Switch into it: account menu (top right) → **Switch role** → the new account's ID and `OrganizationAccountAccessRole`.
   The top right now shows the new account's name.
3. Only then open (or paste) the city's setup link and click **Create stack**. Check the top right first: a stack made
   in your own account can't be linked.

## Change a setting later

Run `npm run setup` again. Every answer is filled in from last time: press Enter to keep one, or type a new one, then
**Deploy** from the review screen.

- **A new alarm email:** AWS emails the new address a confirmation link. Click it.
- **A new or no SES sender:** the new address gets a verification email. If an earlier run set up the old one and nothing
  uses it now, setup offers to remove it.
- **The Google secret:** answer **Yes** to "Replace it?" and paste the new one.
- **The AI**, once Bedrock answers: just run setup again. It checks Bedrock and switches the AI on.

Got something wrong before deploying? Choose **Change an answer** on the review screen, or press Ctrl-C: nothing in
AWS changes before you confirm.

## 10. Running it, and taking it down

- **Switch the AI off instantly** (about 30 seconds):
  `aws ssm put-parameter --name /cloud-city/staging/ai-enabled --value false --overwrite`. Turn it back on with
  `--value true`. Everything else keeps working.
- Alarms, the budget cut-off and restores are in the [runbook](runbook.md).
- **Remove a deployment:** `npm run setup -- --destroy --env staging`. The table and buckets are kept so no player
  data is lost by accident; delete them in the console if you're sure.
