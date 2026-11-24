# Connect your AWS account

AWS City works fully without an AWS account. Connecting one is optional: it lets the city **mirror your real
resources**, lets the citizens **spot real issues**, and lets agents **build small things for real** after you approve
each one. This guide is for players on the hosted game. The last section is for running AWS City on your own computer
against your own account.

In the demo there is nothing to connect: "Use the practice account" pretends (in your city's own Region), and nothing
real is created. "How real accounts connect" rehearses the steps below with a practice setup link that opens nothing;
like the real one, it allows small fixes only if you tick the box.

## What connecting does, and what it doesn't

Connecting means creating **one IAM role** in your account with a CloudFormation stack named `AWSCity`. The role is called
`AWSCityPlayerRole-<Region>` and its permissions are written in
[`infra/player-role/player-role.yaml`](../infra/player-role/player-role.yaml) (version 5). The Deploy tab lists what
the role can do before you create it, and **See the exact permissions** opens the template your setup link uses. You
never give AWS City a password or an access key. It only ever holds short-lived credentials (up to an hour) for that role.

**Who can use the role.** Only AWS City's own service role, in AWS City's own account, and only together with the
ExternalId that ties the role to your AWS City sign-in, so another player can't point the city at your account. The
ExternalId isn't a password (AWS doesn't treat it as a secret), so the game shows it under Details. The trusted account
and role are fixed in the published template, so a setup link can't be edited to trust anybody else.

**What it can read** (in the Region you pick, unless it says "account-wide"):

- EC2 instances, security groups and their rules, volumes, machine images, and whether EBS encryption is on by default.
- DynamoDB table names and settings, their tags, and whether point-in-time recovery is on.
- S3: the list of your buckets (S3 lists buckets account-wide) and each bucket's Block Public Access setting.
- Lambda function names, RDS database instances, API Gateway HTTP API names.
- CloudTrail trails and their status, and the resource list (Resource Explorer and the tagging API) so the city can mirror
  your account.
- Account-wide: the list of all your buckets (S3 lists buckets account-wide), your Availability Zone names and IDs in
  every Region, and which Regions are turned on, so the world map shows your real one.
- Account-wide: your **month-to-date bill** (Cost Explorer: totals by service and Region, no invoices or payment
  details). IAM can't see the game's switch, so the role allows this read at any time; AWS City's server reads it only
  after you turn the bill on, at most once a day.
- In the Region you pick: a few **request counts** from CloudWatch for live traffic. Again the role allows the read, and
  the server makes it only after you turn live traffic on.

It has no permission to read what is *inside* your buckets or tables, your logs, your secrets or your invoices.

**What it can build and change.** Only things the game made:

- EC2 `t4g.nano` or `t4g.micro` instances (IMDSv2 required, an encrypted disk, Amazon-owned images only), tagged
  `managed-by=aws-city`. It can stop, start and terminate only instances carrying that tag.
- DynamoDB tables named `city-*`, tagged `managed-by=aws-city`, and delete only tagged ones.
- S3 buckets named `aws-city-<your account id>-*` (the name is what makes a bucket the city's: the role checks the name,
  not a tag).
- At most 3 live houses (instances), 5 tables and 3 buckets at a time (`server/src/agents/policy.ts`).

**What it can never do:** touch IAM, change billing, or pass roles. Nothing in the role allows it.

**Small fixes are separate and off unless you ask.** If you tick **Allow small fixes** (the Deploy tab lists what it
adds under **What small fixes allow**) the role may also, in the Region you pick:

- turn on S3 Block Public Access on **any** bucket (`s3:PutBucketPublicAccessBlock`),
- remove an inbound rule from **any** security group (`ec2:RevokeSecurityGroupIngress`),
- turn on DynamoDB point-in-time recovery on **any** table (`dynamodb:UpdateContinuousBackups`),
- require IMDSv2 on an instance (`ec2:ModifyInstanceMetadataOptions`),
- turn on EBS encryption by default (`ec2:EnableEbsEncryptionByDefault`).

IAM holds the last two to tightening (`HttpTokens` must be `required`; there's no permission to turn EBS encryption by
default off). It can't for the first three: the same permissions could also turn Block Public Access or backups off, or
remove any rule. AWS City's server holds those to tightening: it only turns them on, and only removes the SSH/RDP rules
you approved. Each fix is shown to you first and runs only after you approve it. You undo a fix yourself in the AWS
console.

**One caveat the template spells out.** DynamoDB can't limit "tag a table" to new tables, so the role could in principle
tag an existing table named `city-*` and then delete it. Only AWS City's server can use the role, and it never does that.

**Every change needs your approval, with MFA.** An agent's write becomes a preview in the Deploy tab and runs only after
you press **Approve** (it expires after 5 minutes with no answer, and nothing changes). On the hosted game you also need
an authenticator app (TOTP) turned on to link an account, to approve a change and to apply a fix. A new preview puts
the focus on its title, never on **Approve**, so a stray Enter or Space approves nothing. Some previews ask you to type
the resource's name first: every take-down (terminate, delete), a fix on something the city didn't build, and any write
the optional second-opinion check flagged. Google sign-ins are exempt from the app because MFA is at Google.

**A safety gate sits in front of AWS.** Besides the role, the server checks every call to your account before it signs
it: only the commands it knows, only the Region you picked (the Availability Zone and Region lists, and Cost Explorer,
are the exceptions), writes shaped exactly as the server sends them, and a single-use permission naming the command and
the exact target. It stops mistakes in the city's own code. The role is the outer wall.

**The bill and live traffic are opt-in.** Both start off. **Show my bill** reads Cost Explorer at most once a day (AWS
charges $0.01 a read). **Show live traffic** reads CloudWatch at most every 5 minutes while the city is open (about a
cent a day). Both switches are on the Region's card, and either can be turned off again with **Hide**.

## Connect it, step by step (hosted game)

You need: to be signed in, an AWS sign-in that may **create IAM roles and CloudFormation stacks** (workshop and some
company accounts can't: see Troubleshooting), and an authenticator app.

1. **Open the account card.** Tap **⋯ → Account → 🔗 Connect your AWS account**, or the "Your AWS account" row in your
   To-do list. Both open the Deploy tab with the steps unfolded.
2. **Turn on an authenticator** if the card asks ("Protect your account first" → **Set up an authenticator**). Add the key
   to your app, enter a code, then **sign in again** with the code: turning it on ends every session, and a sign-in from
   before it doesn't count. If the city didn't hear about your authenticator in time (the game says so), it may ask you to
   sign in once more.
3. **Pick a Region and press Get my setup link.** The Region is where the role is made, where the city builds, and where
   it checks for issues. A few reads cover the whole account: your bucket list, every Region's Availability Zones and
   which Regions are on, and (once you turn it on) your bill.
   Only AWS's standard Regions are listed (GovCloud and China can't link). An opt-in Region must be turned on in your
   account first. It starts on the Region you asked for last, your linked one, or your city's.
4. **Decide on small fixes.** Tick **Allow small fixes (you still approve each one)** now if you want them (**What small
   fixes allow** lists them). Ticking it makes a new setup link.
5. **Check who the link is for.** The card says "The stack page will say ConnectsPlayer: ...". That is your public
   Mayor name, or your email masked (like `a***@e***.com`), or "Player " plus 8 characters of your sign-in id. On the
   CloudFormation page the `ConnectsPlayer` parameter must match. **If it isn't you, don't create the stack:** someone
   else's link would let their city into your account.
6. **Press Open CloudFormation.** Then, in the console:
   - Sign in to the AWS account you want to connect, with the same Region picked in the Region menu.
   - Leave the ExternalId as filled in (it's hidden). Check `ConnectsPlayer` and `AllowFixes`.
   - Tick **I acknowledge that AWS CloudFormation might create IAM resources with custom names.** The role has a fixed
     name, so CloudFormation asks.
   - Press **Create stack** and wait for **CREATE_COMPLETE** (about a minute).
7. **Come back and type your 12-digit account number**, then press **Verify.** (The role's ARN works too.) The server
   assumes the role, checks it really is the AWSCity role in that account, asks AWS (a check that changes nothing)
   whether fixes are allowed, and saves the link. The card then shows "✓ Linked", the Region, and whether small fixes
   are on.

A setup link works for **one day**. If you're slow, press **Get a new setup link**: the stack you already made keeps
working, because the ExternalId stays the same.

### Allow small fixes later

The card shows "Small fixes: off" with **Turn small fixes on**. In CloudFormation open the `AWSCity` stack → **Update** →
**Use existing template** → **Next** → set `AllowFixes` to `true` (keep the ExternalId) → tick the IAM acknowledgement →
**Update**. When it says `UPDATE_COMPLETE` press **Check again** in the game: it asks the role again whether it allows
fixes, and changes nothing. City care also says up front when fixes are off, so you aren't asked to approve something
that can't run.

### Disconnect and reconnect

**Disconnect** stops AWS City reading or changing your account at once. It keeps the setup (your AWSCity role and its
ExternalId), so **🔁 Reconnect** brings it back with one press and no change in AWS. To remove AWS City for good, delete
the `AWSCity` stack in CloudFormation as well.

### Let the city change things you made (on or off)

Off by default: the agents look at everything in your account but change only what the city built. The card's **Let the
city change things you made: Off · Turn on** shows how to turn it on, in your own AWS account (the city can't turn it on
itself): in CloudFormation open the `AWSCity` stack → **Update** → **Use existing template** (or, on a role older than v6,
**Replace existing template** with the address shown) → **Next** → set `AllowCleanup` to `true` (keep the ExternalId) →
tick the IAM acknowledgement → **Update**. When it says `UPDATE_COMPLETE` press **I've updated the stack** in the game.

On, the agents may also stop, start or terminate servers, and delete empty buckets, that you made yourself in that
Region (only buckets your account owns). Every removal asks you to type its name or ID, then your MFA code and Approve,
exactly as for what the city built. Nothing ever reads what's in a bucket, and tables stay the city's own. Turn it off
the same way (`AllowCleanup` = `false`).

### Update your role (v3 → v5 and so on)

When a newer role exists the card shows **Update your AWS City role (vN → v5)** (N is the version you installed from the
game's link: the game can't read your stack for its version). Your link and ExternalId stay the same.

1. In the game, press **Get the ConnectsPlayer name to type.** It makes a fresh setup link with the same ExternalId and
   shows the name, with a **Copy the name** button.
2. In CloudFormation open the `AWSCity` stack (the card has an **Open the AWSCity stack** button for your Region).
3. Press **Update** → **Replace existing template** → **Amazon S3 URL**, and paste the template address from the card
   (**Copy the template address**).
4. **Next.** Set `ConnectsPlayer` to the name you copied and keep the ExternalId as it is. (Version 5 added this
   parameter, so older stacks don't have a value yet.)
5. **Next**, tick the IAM acknowledgement, press **Update** (or Submit).
6. When it says `UPDATE_COMPLETE`, press **I've updated the stack** in the game. It gets a fresh link and verifies, so
   the game records the new version. Press it only after the update: the game takes your word for the version.

Players who linked before the game recorded versions (contract v2.17) don't see the update offer, because the game
doesn't know which version they have.

## Disconnect

**⋯ → Account → Your AWS account → Disconnect → Yes, disconnect.** (It needs no MFA: taking access away is always allowed.)

- The server forgets the link at once: the account id, the role ARN and the ExternalId. It stops reading and building
  in your account, and every tab you have open updates.
- **It does not delete anything in your account.** What the city built stays, and **keeps billing**. Take it down
  first: Deploy → **My builds → Take it down** (an instance, table or bucket; anything else is removed in the AWS console).
  That asks for your approval like any change.
- **The `AWSCity` stack stays** until you delete it. To remove the role too: CloudFormation → Stacks → `AWSCity` →
  **Delete**. The game shows this right after disconnecting, with a button that opens the stacks page.

Order that never strands anything: take down what the city built, press Disconnect, then delete the stack. Once the
stack is gone the city can't remove anything for you.

To switch to another Region or account, use **Use another Region or account** instead: it starts the steps again, and
your current link keeps working until the new one is verified.

### If you delete the stack first

Nothing tells AWS City. Its next reads of your account are refused by AWS. After **failed reads in a row for about 5 minutes**
(only while your city is open) the city stops reading your account and the
card says "Was the stack deleted? Link again, or disconnect." Nothing else changes: no lessons, no findings are marked
resolved, and a server restart doesn't retry it. For up to an hour after you delete the stack, the role's last session
(it lasts up to an hour) may still be in use: AWS then refuses the city service by service, so some districts may show
as locked before the card says the link is broken. The link record stays until you act:

- **Link again** makes a new setup link in the same Region with the same ExternalId. Make the stack again and Verify.
- **Disconnect** forgets the link.

## Your data

- **Download my data:** **⋯ → Account → Download my data** (also Deploy → Your data). It saves
  `aws-city-my-data-<date>.json` on your device: your progress, your account link as metadata (status, Region, account
  id, when it was linked, when your last setup link was made, role version, whether fixes are on, when it broke), your
  live-city and leaderboard rows, your bill switch and cached bill, your recent AI request counts, the day of your first
  AI request and when the service first saw your authenticator on. It never contains the ExternalId or the role ARN.
  Nothing else is fetched or uploaded. You can download it once a minute.
- **Delete my account:** **⋯ → Account → Delete my account…** (also Deploy → Your data), after a confirmation. It deletes
  everything we store about you, including the link record and your sign-in, and it can't be undone. It does **not**
  touch your AWS account: take down what the city built first (the confirmation warns you if anything is left), and delete
  the `AWSCity` stack yourself.

The privacy policy for the service you signed in to has the full list of what is stored and for how long.

## Troubleshooting

| What you see | What it means and what to do |
| --- | --- |
| The stack fails with `CREATE_FAILED` or rolls back, mentioning `iam:CreateRole` or CloudFormation being denied | The account (or your sign-in, or an AWS Organizations policy) doesn't allow creating roles or stacks. Workshop Studio accounts deny both. Use your own account, or one where you may create IAM roles. In the meantime the rest of the game, including the demo's practice account, works without one. |
| "I couldn't use the AWSCity role in 123456789012 (us-west-2). Is the stack finished, in that region, and made from your latest setup link?" | Wait for `CREATE_COMPLETE`. Make sure the console Region is the one you picked in the game. If you made the stack from an old or different link, press **Get a new setup link** (same ExternalId) and use that. Also check the account number is the one the stack is in. |
| An Organizations service control policy (SCP) denies the Region | The city can't read or build there and Verify may fail. Pick a Region your organisation allows (**Change the Region**), or ask your administrator. The role only works in the Region it was made in. |
| "Your setup link is more than a day old, so I won't use it." | Press **Get a new setup link**, then **Verify** again. A stack you already made keeps working. |
| "Paste your 12-digit AWS account id (or the RoleArn from the AWSCity stack)." | Type the 12 digits only, with no spaces. |
| "That role isn't the AWSCity player role." or "That's the city's own account." | You typed another role or account. Use the account the stack is in. |
| "Turn on an authenticator app first" | Set one up in the Deploy tab (**Set up an authenticator**), then sign in again with its code. |
| "Your authenticator app is on, but this sign-in started before it was. Sign out, then sign in again with your app's code." | Sign out and sign back in, entering the app's code. A sign-in from before the authenticator doesn't count for linking, approving or fixing. |
| "Your AWS account link changed meanwhile. Try again." (after **Check again**) | The link was disconnected or made again (on another device, perhaps) while the city was asking. Nothing was written. Look at the card, then press **Check again** once more if it's still linked. |
| `ConnectsPlayer` on the stack page isn't you | Close the page and don't create the stack. Get your own link in the game. |
| The Region isn't in the list | Only AWS's standard (commercial) Regions can link. GovCloud and China can't. |
| "Small fixes: off", and no Fix button | The stack was made without `AllowFixes`. See "Allow small fixes later". |
| A preview vanished | It expired after 5 minutes with no answer. Nothing changed. Ask again. |
| "The city already has 3 game-built houses" (or tables, buckets) | The city's limits are 3 houses, 5 tables and 3 buckets. Take one down first. |
| "Was the stack deleted? Link again, or disconnect." | See "If you delete the stack first". |

## Run it locally against your own account

You can run the whole thing on your own computer with your own AWS profile. There is no sign-in, no role to install and
no stack: the local server uses your profile directly. (Hosted players get the role and MFA described above. Local mode
is for developers, so the permissions are those of your profile.)

```bash
npm run live                                              # profile and Region from last time, else defaults
npm run live -- --profile me --region eu-west-1           # pick them
npm run live -- --allow-fixes                             # let the citizens apply fixes you approve
npm run live -- --browser firefox                         # chrome, edge, brave, firefox, safari or cft
```

Keep the `--` before the flags. `npm start` and pick "Real AWS" does the same with questions.

- **The profile.** `--profile`, else the one that worked last time, then `AWS_CITY_PROFILE`, `aws-city`, `workshop`,
  `default`. Sign in with `aws login`, `aws configure sso` or keys. The server re-reads the profile every minute, so
  refreshed keys need no restart.
- **The Region and its Claude models.** `--region` (default last time's, else `us-west-2`). It's both the Region the city
  reads and where Claude runs through a Bedrock geo inference profile, so only Regions with one work: the US and Canada
  (`us.`), Europe (`eu.`), Sydney and Melbourne (`au.`), Mumbai and Hyderabad (`in.`). The launcher says which if you pick
  another. The models are Claude Opus 5.5 and Sonnet 5.5, or Opus 5 and Sonnet 5 in India (`infra/lib/models.ts`).
  Anthropic needs a one-time use-case form from the Bedrock Model catalog in your account, and the first call needs
  `aws-marketplace:Subscribe` and a payment method.
- **Fixes.** Off locally unless you pass `--allow-fixes` (the launcher sets `AWS_CITY_ALLOW_FIXES=true`), because your
  profile isn't scoped like the hosted role. Each fix is still shown and approved, and the safety gate still applies.
- **The token.** Each run mints a one-off token and builds it into that run's extension (`WXT_AWS_TOKEN`). The server
  accepts nothing without it: an `Authorization: Bearer <token>` header, or the WebSocket subprotocol the extension uses,
  never the query string. The browser's `Origin` is only a check that a web page can't reach the server, not a sign-in.
  The server listens on `127.0.0.1` only. To pin the token yourself, set `AWS_CITY_TOKEN` (32 characters or more).
- **No MFA, no Disconnect.** The one local player has no sign-in to protect, and there is no link to remove: the card
  game doesn't offer Disconnect. Your data stays in `server/.data/`.

More on the local server is in [`server/README.md`](../server/README.md).
