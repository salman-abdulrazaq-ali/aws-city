# AWS City — Privacy Policy

*Last updated: 21 November 2026*

> **For whoever runs this service.** AWS City is open-source software; each deployment is run by the person or
> organisation that deployed it. This file is a template: `npm run setup` asks for your name and contact email and
> writes a filled copy to `.output/privacy-policy-<env>.md`. Host that copy at a public URL and give the URL to each
> store listing (see `docs/store-listing.md`). If you fill it in by hand, replace every `{{PLACEHOLDER}}`. Before you
> publish, check it against what your deployment really does (a changed retention or log setting changes this page).
> If you don't set `TYPESAFE_API_KEY` (the Jev safety check, `docs/jev.md`), you may delete its paragraph under "What we
> process but don't keep". Delete this note from the published copy.

## In short (for parents and guardians)

- **The demo needs no account and sends nothing to us.** Only signing in to the hosted game collects anything.
- **What we keep when you sign in:** an email address (to sign in) and the game's progress. Only if the player turns
  them on: a link to their own AWS account, its monthly bill, and a place on the leaderboards under a two-word name
  the game picks (nobody types a name). Screenshots sent to the Lookout are deleted after a day.
- **What we never collect:** AWS passwords or access keys, what's typed into AWS console fields (the Copilot reads
  only their labels), or anything for ads. The maps are built in, so no map service learns where you play. We don't
  sell data or use it to train AI. Like most websites, our security logs record IP addresses for up to 90 days (see
  "Network and security logs").
- **The AI:** questions typed to the city's helpers go to an AI model on AWS that doesn't keep them or learn from them.
  Keys and email addresses are taken out first, but **please don't type names, addresses, phone numbers or school
  names**; each AI box says so.
- **Jev (only if this service turns it on):** before a change to a linked AWS account is offered for approval, the
  player's own words for it (up to 500 characters) and a one-line summary go to TypeSafe's Jev, which checks the change
  matches what was asked. It can only make the game stricter.
- **See or delete it:** ⋯ → Account → **Download my data** saves a copy; **Delete my account…** removes it at once
  (backups within 35 days). You can also write to {{CONTACT_EMAIL}}.
- **Children:** a child under 13 (or the age of digital consent where you live) shouldn't make an account. A parent
  can sign up and play with them, or they can play the demo. Write to {{CONTACT_EMAIL}} and we'll delete a child's
  account.

The full details follow.

## Who runs this service

The AWS City service you sign in to is run by **{{OPERATOR_NAME}}** ("we"), who decides why and how your data is used
(the "controller", in data-protection terms). The service runs in AWS in the **{{REGION}}** Region.

Contact for any privacy question, or to ask us to delete your data: **{{CONTACT_EMAIL}}**.

The extension and its demo mode work without an account and send nothing to us. The rest of this page is about the
hosted service you can sign in to.

AWS City is a learning game (a browser extension for Chrome, Edge, Firefox and Safari) that teaches Amazon Web Services. This page explains
what the game stores, why, and how to delete it. We don't sell data, show ads, or use your data to
train AI models.

## Children

AWS City is made for learners of all ages, but an account needs an email address, and we don't knowingly collect
personal information from a child under 13 (or the age of digital consent where you live, if higher). A child under
13 should not create an account: a parent or guardian can sign up and play with the child. The demo needs no account
and collects nothing. Signing in collects an **email address** (kept by Amazon Cognito) and your game progress, as
described below. A parent or guardian who believes a child has an account can write to {{CONTACT_EMAIL}} and we will
delete it.

## What we store

| Data | Why | Where / how long |
|---|---|---|
| Your account id from sign-in (a random Cognito id) and email address | So you can sign in and keep your city on any computer | Amazon Cognito, until you delete your account |
| Your city progress (buildings and their levels, ⭐ stars, 🪙 City Coins, cards, quests, settings) | To save your game | Amazon DynamoDB, until you delete your account |
| Your AWS account link: account id, role name, region (and a new one you asked for but haven't verified yet), a random setup code (ExternalId), when it was linked, when your last setup link was made and which role version it points at, the role version you installed from it, whether the role allows fixes, and when the role stopped working (if it did) | So agents can build in *your* AWS account after you approve | DynamoDB, until you disconnect or delete your account |
| Your linked AWS account's month-to-date cost totals, by service and Region (only if you turn the city's bill on; off by default) | So the city can show what your account costs this month | DynamoDB, replaced by the next read (at most once a day) and deleted when you delete your account |
| Request counts per minute from your linked AWS account's CloudWatch (load balancer, Lambda, API Gateway, DynamoDB writes), only if you turn live traffic on (off by default) | So the city's traffic can follow your real requests | In the server's memory only, replaced by the next read (at most every 5 minutes) and gone when you close the city |
| A public Mayor name (two words picked by the game, like "Kind Otter"; you never type it), only if you turn on **Show me on leaderboards** (off by default) | So other players can see you in the live city and on the weekly leaderboards | DynamoDB: your presence row expires 90 seconds after you close the city; leaderboard rows after 9 weeks. Turning the switch off removes both at once |
| Your best weekly mini-game scores and your city's rank points, only while that switch is on | The weekly leaderboards | DynamoDB, 9 weeks |
| A daily count of AI requests | To keep the free tier fair (a daily limit) | DynamoDB, expires after 2 days |
| The day of your first AI request | New players get a smaller daily limit for their first 3 days, so free sign-ups can't use up the service | DynamoDB, until you delete your account |
| When the service first saw your authenticator app turned on (only if you sign in with an email address and turn one on) | Only a sign-in after that time may link an AWS account or approve a change | DynamoDB, until you turn the authenticator off or delete your account |
| Screenshots you choose to send to the Lookout | So it can tell you what the page is about | Amazon S3, deleted automatically after 1 day |

**We never see or store your AWS password or access keys.** Agents act in your AWS account only
through the narrow `AWSCityPlayerRole` you install yourself, and only after you press **Approve** in
the game. You can remove that access at any time:

- **Disconnect** (in the game: **⋯ → Account → Your AWS account → Disconnect**) deletes the link record (account id,
  role ARN and ExternalId) at once and stops the city reading your account. It doesn't delete anything in your AWS
  account.
- **Deleting the `AWSCity` stack** in CloudFormation removes the role, and with it our access. It doesn't tell us. The
  city notices after three failed reads in a row (only while your city is open), stops reading your account and says
  so. The link record stays until you disconnect or delete your AWS City account.

Neither one deletes what the game built in your AWS account: take those down first (Deploy → My builds).

## What we process but don't keep

- **Your questions and requests** are sent to an AI model on Amazon Bedrock (Amazon Nova or Claude, whichever the
  city's host chose) to produce the agents' answers. Amazon Bedrock doesn't store them or use them to train models.
  They're processed in the AWS Region the host runs the AI in, usually the Region that stores your data; when a new
  account's Bedrock is still on hold there, it can be another one (the host's setup says which). While Bedrock is
  unavailable, a host can instead answer them with an open model (Qwen3) running on its own AWS servers in the
  Region that stores your data; nothing is kept after the answer. Before anything reaches a model, the server takes out
  anything that looks like an access key, secret key, session token or email address.
- **A safety check on changes (only if this service has it turned on):** before you're asked to approve a change an
  agent wants to make in your AWS account, your own words for that task (at most 500 characters, with AWS account ids
  and ARNs removed) and a one-line summary of the change are sent to TypeSafe's Jev service, which answers whether the
  change is what you asked for and, for something being removed, whether you asked to remove it and named it. The only
  thing read from your AWS account that's sent is the name (its Name tag) of a server the change would remove. A
  change with no words of yours behind it, such as Take it down in My builds, sends nothing. The check can only make
  the city stricter (you still approve every change).
- **AWS documentation search:** to ground an answer in AWS's own documentation, the server sends a short search
  (the service's name and your question, with keys and emails taken out) to AWS's public Knowledge MCP service
  (`knowledge-mcp.global.api.aws`), which is run by AWS outside the host's account. It doesn't include your
  account id, your name or your sign-in.
- **Names of the resources in your linked AWS account** (e.g. bucket and table names) are read so
  the city can draw them, and so are your account's Availability Zone names and IDs and which AWS Regions it has turned
  on. They're kept in the server's memory while you're playing, not saved.
- **Console Copilot:** when *you* start it on an AWS Console page, the extension reads the labels of
  the buttons and fields on that page (never their values, never password or secret fields) and
  sends them to the server so the agent can pick the next step. Account ids, access keys and email
  addresses are removed before anything leaves the page.
- **AWS's public status and news:** the server reads the public AWS Health Dashboard and AWS What's New feeds itself,
  once for all players. Nothing about you, your account or your city is sent to fetch them.
- **Maps:** the city's streets (from OpenStreetMap) are bundled with the extension. It makes no map requests, so no map
  service learns where you are or which city you're playing.
- **Server logs** record errors and counts, never your questions, page contents, tokens or keys;
  players appear only as a one-way hash. Each change asked for in your linked AWS account (made, refused or failed) is
  logged with its kind, Region and outcome; the resource it touches appears only as a one-way hash, never its name or
  your AWS account id. Logs are kept for 30 days.

## Network and security logs (your IP address)

Like most web services, the infrastructure in front of the server logs each request, including your **IP
address**. We use these logs only to keep the service secure and working (blocking abuse, investigating
incidents), not to track you.

| Log | What it contains | Kept for |
|---|---|---|
| Web firewall (AWS WAF) logs | Each request's IP address, country, URL and request headers (such as your browser's user agent), and whether it was allowed or blocked. Sign-in tokens are removed (`Authorization` and `Sec-WebSocket-Protocol` headers are redacted). | 30 days |
| Access logs (Amazon CloudFront, the load balancer, and the S3 buckets that hold screenshots and the setup template) | IP address, time, the address requested, the response, and the user agent | 90 days |
| Network flow logs (inside our AWS network) | Source and destination IP addresses and ports of connections, no contents | 30 days |

## Browser permissions

- `storage`: save your settings and sign-in on this computer.
- `tabs` / `activeTab`: know which AWS page you're on so the city can show that service, and let the
  Lookout take a screenshot when you ask (or, with auto-snap on, of AWS Console and docs pages only;
  other sites' addresses and titles are never sent).
- `identity`: sign in with Cognito / Google.
- `sidePanel`: show the city next to the page.
- Access to `*.console.aws.amazon.com`: the Console Copilot, only while you run it.
- Optional `<all_urls>`: asked for only if you use the Lookout on a page where `activeTab` isn't enough.

## Deleting your data

Other players never see your account id or email: the live city and leaderboards store you under a one-way scrambled
code, with only the Mayor name the game picked for you.

**Download.** In the game: **⋯ → Account → Download my data** (the Deploy tab's "Your data" card has it too). It saves one
JSON file on your device (`GET /me/export`) with everything in "What we store" that the service keeps (your email
address and sign-in id are in Amazon Cognito: write to us for those): your progress; your account link as metadata only
(status, Region and any Region you asked for, account id, when it was linked, when your last setup link was made and its
role version, the role version you installed, whether fixes are on, and when it stopped working: never the ExternalId or
the role ARN); your live-city and leaderboard rows; the bill switch and your cached bill; today's and yesterday's AI
request counts; the day of your first AI request; and when the service first saw your authenticator on. Nobody else's
rows are in it. Screenshots you sent to the Lookout aren't in it: they're kept for a day at most (see "What we store")
and you already have them. You can download it about once a minute.

**Delete.** In the game: **⋯ → Account → Delete my account…** (also Deploy → Your data), or write to {{CONTACT_EMAIL}}.
This deletes your progress, account link, cached bill, live-city presence, leaderboard scores, first AI day,
authenticator time and sign-in (`DELETE /me`) from the live database immediately; screenshots are deleted too (and
expire within a day anyway). One small record stays for a while: a deletion marker (`DELETED#<sign-in id>`) holding only
your random sign-in id and when the marker ends, so a sign-in token issued before the deletion (they last up to an hour)
can't save anything for you again. The service honours it for 2 hours; the database then removes it automatically,
usually within a few days, and it ages out of backups like the rest (see Backups). If you want your AWS
account to be left clean too, take down what the game built there first, then delete the `AWSCity` stack in your AWS
account's CloudFormation console to remove the role.

**Backups.** So that a fault can't wipe everyone's progress, the database keeps point-in-time recovery and a
daily backup. Both hold copies for at most **35 days**, so your deleted data is gone from every backup within
35 days of deletion. Backups are only used to restore the service after an incident. The network and security
logs above age out on their own schedule (30 or 90 days).

## Contact

Questions, deletion requests and concerns about children's data: {{CONTACT_EMAIL}} ({{OPERATOR_NAME}}). You can also open an issue at https://github.com/salman-abdulrazaq-ali/aws-city.
