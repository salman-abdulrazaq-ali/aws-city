# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

A Manifest V3 browser extension (Chrome, Edge, Firefox, Safari) built with WXT, React 19 and Phaser 4. The same app runs
in the browser's side panel (about 400 px wide, beside the AWS Console) and in a full tab (`/city.html`); Safari has no
side panel and uses the tab.

## Users

Two primary audiences, both confirmed:

- **AWS beginners and learners**: people new to the cloud, from teens to career-changers, learning what AWS services
  do and preparing for certifications such as AWS Certified Cloud Practitioner. They play in short daily sessions and
  start in the demo, which needs no account.
- **Builders with real AWS accounts**: developers who link their own account and use the city as a safe, visual
  companion to it: their real resources stand as buildings, agents explain and build things, and every change waits for
  their approval.

Other audiences seen in playtests (families, classroom instructors, privacy-minded parents) matter but are secondary.

## Product Purpose

AWS City teaches AWS by letting players live in it: an isometric city per AWS Region where every AWS service is a place
and its agent does that service's real job. Learning (cards, quests, puzzles, workshops, mini-games) grows the city,
building by building. With a linked account, the city mirrors the player's real resources and agents can make real
changes, each one approved by the player.

Success: a beginner understands what the services do and comes back day after day; a builder trusts the city enough to
link an account, because it never changes anything without them.

## Positioning

Each AWS service is a building whose agent does that service's real job, and the city grows from what the player
learns, not from time spent. The same city can mirror the player's own AWS account, with a deterministic safety layer
between the agents and AWS (a command allowlist, the player's approval, MFA step-up and a second opinion that only
tightens). It won 1st place at the North Hackathon at Northumbria University.

## Operating Context

- **Demo** (no account): the in-browser mock backend and a practice AWS Console inside the extension; nothing touches AWS.
- **Local server**: a developer runs the server against their own AWS profile (`npm run live`).
- **Hosted**: Cognito sign-in, one tenant per player, each player's own account through a role they install with
  CloudFormation (`AWSCityPlayerRole-<region>`).
- Beside the real AWS Console in the side panel: the Lookout (reads the page) and the Console Copilot (fills forms and
  hands every committing press back to the player).
- A daily rhythm: Today's shift, goals, streak-like City Lights, a daily Supply Drop.

## Capabilities and Constraints

- Tabs City · Learn · Jobs · Deploy, opened by an unlock ladder; Simple mode is the default and "Show everything" is a
  setting, never a separate product.
- Learning: spaced-repetition flashcards, quests ending in "Explain it back", architecture puzzles, a Drawing board,
  hands-on workshops in a practice terminal or AWS CloudShell, ten mini-games, City Clients side jobs, AWS North Hall talks.
- Real account: linking, approvals for every write, typed names for destructive changes, City care findings with
  opt-in fixes that only tighten, My builds with Take it down, Disconnect, data export and account deletion.
- Terminology: ⭐ stars are knowledge (they grow buildings and are never spent); 🪙 City Coins are what players spend
  (Decorate); players never see "XP".
- Constraints: the extension's content security policy; the 400 px side panel as a first-class surface; content is
  data in `shared/` with sources; one contract between the extension and the server (`src/backend/contract.ts`).
- Open decisions (not settled): an interface in languages other than English; tools for instructors; whether Google
  sign-ins stay exempt from MFA; which Regions the hosted version serves.

## Brand Commitments

- The name **AWS City** is fixed.
- The player character, Kai, always wears the team's gold jacket.
- The optional Amazon Air branding (the airport hub's name and the jets' "PRIME AIR" livery) sits behind one switch
  (`shared/brand.json`) and is off in store builds.
- Voice: plain words first, every AWS term tappable for its definition, the full detail behind "Tell me more".

## Evidence on Hand

- Screenshots in `docs/images/` (the terminal launcher, the city at night) and the README's description.
- The hackathon award (1st place, North Hackathon at Northumbria University).
- Every AWS fact in `shared/` cites an AWS documentation page.
- No user testimonials, usage numbers, pricing, customer names or press exist; future work must not invent them.

## Product Principles

1. **Real-account safety is never traded away.** Nothing changes in a player's AWS account without their approval, and
   every safety layer can only tighten.
2. **AWS facts are accurate and cited.** Content follows AWS documentation, and the practice terminal behaves like the
   real AWS CLI; a wrong fact is a bug.
3. **Fun first.** It should feel like a game people come back to, not homework; learning shows as the city growing.
4. **Simple by default, everything one switch away.** New players see one next step; nothing is deleted when hidden.

## Accessibility & Inclusion

The project targets WCAG 2.2 AA (the smoke test runs axe-core and fails on serious or critical issues). Every
mini-game plays from the keyboard and speaks through a live region; settings cover text size (125 %/150 %), high
contrast, an easy-read font, Games without a clock, sound captions and reduced motion.
