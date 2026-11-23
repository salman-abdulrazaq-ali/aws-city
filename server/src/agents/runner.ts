import { docsBlock, type Knowledge } from '../knowledge/mcp.js';
import { serviceById, type DocSource } from '../world.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { WorldSnapshot } from '../state/model.js';
import { type ActionName, AWS_API, actionsForAgent, toolDefinitions } from './actions.js';
import type { Llm } from './llm.js';
import { agentSystemPrompt } from './personas.js';
import type { ActionService, Approve, SubmitOutcome } from './service.js';

export const MAX_TOOL_CALLS_PER_TURN = 5;
const MAX_HISTORY_MESSAGES = 40;

export interface ToolCallReport {
  name: string;
  input: unknown;
  outcome: SubmitOutcome['status'];
  message: string;
  /** The AWS resource the call made or changed (an instance id, a bucket or table name), when it ran. */
  resourceId?: string;
}

/** A tool call's report: the outcome in words, and the resource it touched. */
export const toolReport = (name: string, input: unknown, o: SubmitOutcome): ToolCallReport => {
  const resourceId = o.status === 'done' || o.status === 'failed' ? o.result.resourceId : undefined;
  return { name, input, outcome: o.status, message: outcomeMessage(o), ...(resourceId ? { resourceId } : {}) };
};

export interface TurnResult {
  agentId: string;
  reply: string;
  toolCalls: ToolCallReport[];
  refused: boolean;
  /** The turn stopped at its step or token budget (the reply is a stand-in). */
  limited?: boolean;
  /** AWS documentation pages the turn was grounded in. */
  sources?: DocSource[];
}

/** Callbacks that let the transport layer animate the turn as it happens. */
export interface TurnHooks {
  onModelCall?(phase: 'start' | 'end'): void;
  onText?(text: string): void;
  onToolStart?(call: { name: string; api: string; summary: string }): void;
  onToolEnd?(call: ToolCallReport): void;
  /** Ask the player before any write (contract v2). Omitted = legacy behaviour. */
  approve?: Approve;
  /** The player's own request for this turn (task.submit's prompt), for the writes' second opinion. Omitted when the text isn't theirs. */
  intent?: string;
  /** Aborted when the player's socket closes: no further model or tool calls for this turn. */
  signal?: AbortSignal;
}

/**
 * A compact, model-friendly view of the city (full meta is available through describe_resource).
 * Names and tags come from the AWS account (anyone with access can set them): < and > are JSON-escaped so a
 * name like "</city_snapshot>…" can't close the data wrapper.
 */
/**
 * What one snapshot may cost in a prompt. A player could fill their own account with long-named resources, and the
 * snapshot rides in every agent turn while quotas count calls, not tokens: unbounded, a few players could spend the
 * budget that switches the AI off for everyone (security review, 21 Nov). The city's own resources come first, the
 * rest are counted; describe_resource still reads any one in full.
 */
export const SNAPSHOT_MAX_RESOURCES = 100;
export const SNAPSHOT_MAX_NAME = 64;
export const SNAPSHOT_MAX_CHARS = 8_000;
const clip = (v: string | undefined, n: number) => (v !== undefined && v.length > n ? `${v.slice(0, n - 1)}…` : v);

/**
 * The city in a few lines, for a small CPU model (`llm.small`): what the game built, by id, kind, name and state (an
 * agent still needs an instance id to stop it), then a count of everything else per kind. Names are clipped and the
 * whole is JSON-escaped like the full snapshot, so it can't close its data wrapper.
 */
export const SUMMARY_MAX_BUILT = 20;
/** Servers, buckets and tables the player made themselves (the console, CloudShell), named so an agent can say it sees them. */
export const SUMMARY_MAX_OTHER_SERVERS = 10;
/** On their way out, so not worth naming: a terminated server (DescribeInstances keeps it an hour), a table being deleted. */
const LEAVING = new Set(['terminated', 'shutting-down', 'DELETING']);
const NAMED_KINDS = new Set(['instance', 'bucket', 'table']);
export const snapshotSummary = (s: WorldSnapshot) => {
  const built = s.resources.filter((r) => r.managedByGame);
  // Seen 22 Nov 2026: a server launched in the console was only counted, so Eddie said he couldn't see it; on 23 Nov the
  // same for a bucket made in the console and one made in CloudShell (Sally).
  const madeElsewhere = s.resources.filter((r) => !r.managedByGame && NAMED_KINDS.has(r.kind) && !LEAVING.has(r.state));
  const others: Record<string, number> = {};
  for (const r of s.resources) if (!r.managedByGame) others[r.kind] = (others[r.kind] ?? 0) + 1;
  return escapeTags(
    JSON.stringify({
      region: s.region,
      builtByTheCity: built.slice(0, SUMMARY_MAX_BUILT).map((r) => ({ id: clip(r.id, 64), kind: r.kind, name: clip(r.name, 40), state: r.state })),
      ...(built.length > SUMMARY_MAX_BUILT ? { moreBuilt: built.length - SUMMARY_MAX_BUILT } : {}),
      ...(madeElsewhere.length
        ? { notBuiltByTheCity: madeElsewhere.slice(0, SUMMARY_MAX_OTHER_SERVERS).map((r) => ({ id: clip(r.id, 64), kind: r.kind, name: clip(r.name, 40), state: r.state })) }
        : {}),
      otherResources: others,
    }),
  );
};

/** The city as a model reads it: the full snapshot, or the short summary for a small CPU model. */
export const cityFor = (llm: { small?: boolean }, s: WorldSnapshot) => (llm.small ? snapshotSummary(s) : snapshotForModel(s));

export const snapshotForModel = (s: WorldSnapshot) => {
  const all = [...s.resources].sort((a, b) => Number(b.managedByGame) - Number(a.managedByGame));
  const render = (n: number) =>
    escapeTags(JSON.stringify({
      region: s.region,
      credentials: s.credentials,
      services: s.services,
      resources: all.slice(0, n).map((r) => ({
        id: clip(r.id, 128),
        kind: r.kind,
        name: clip(r.name, SNAPSHOT_MAX_NAME),
        state: r.state,
        builtByGame: r.managedByGame,
        ...(r.kind === 'instance' ? { type: typeof r.meta.instanceType === 'string' ? clip(r.meta.instanceType, 32) : r.meta.instanceType } : {}),
      })),
      ...(all.length > n ? { moreResources: all.length - n } : {}),
    }));
  let keep = Math.min(all.length, SNAPSHOT_MAX_RESOURCES);
  let out = render(keep);
  while (out.length > SNAPSHOT_MAX_CHARS && keep > 0) {
    keep = Math.floor(keep * 0.7);
    out = render(keep);
  }
  return out;
};

/** Valid JSON, but no tag can be formed: \u003c / \u003e instead of < / >. */
export const escapeTags = (json: string) => json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

export const outcomeText = (o: SubmitOutcome): string => {
  switch (o.status) {
    case 'done':
      return JSON.stringify({ status: 'done', message: o.result.message, ...(o.result.data ? { data: o.result.data } : {}) });
    case 'failed':
      return JSON.stringify({ status: 'failed', message: o.result.message });
    case 'denied':
      return JSON.stringify({ status: 'denied_by_game_policy', reason: o.reason });
    case 'invalid':
      return JSON.stringify({ status: 'invalid_input', error: o.error });
  }
};

/** A write's submit options from the turn: the approval channel and, when known, the player's own words. */
export const submitOpts = (hooks: TurnHooks) => ({ approve: hooks.approve, ...(hooks.intent ? { intent: hooks.intent } : {}) });

export const outcomeMessage = (o: SubmitOutcome) =>
  o.status === 'done' || o.status === 'failed' ? o.result.message : o.status === 'denied' ? o.reason : o.error;

/** Answers any tool_use in a trailing assistant message that never got results (e.g. cut off at max_tokens). */
const closeDangling = (messages: Anthropic.MessageParam[]) => {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || typeof last.content === 'string') return;
  const orphans = last.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
  if (!orphans.length) return;
  messages.push({
    role: 'user',
    content: orphans.map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, is_error: true, content: 'Not executed: the turn ended before this tool call could run.' })),
  });
};

/** Agent layer: Claude decides, the ActionService parses/polices/executes, the result goes back to Claude. */
export const createAgentRunner = (deps: { llm: Llm; actions: ActionService; snapshot: () => Promise<WorldSnapshot>; knowledge?: Knowledge }): AgentRunner => {
  const histories = new Map<string, Anthropic.MessageParam[]>();
  // One turn at a time per agent (they share a conversation); later requests wait their turn.
  const queues = new Map<string, Promise<unknown>>();

  const turn = (agentId: string, playerText: string, hooks: TurnHooks = {}): Promise<TurnResult> => {
    const previous = queues.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => runTurn(agentId, playerText, hooks));
    queues.set(agentId, next.catch(() => undefined));
    return next;
  };

  const runTurn = async (agentId: string, playerText: string, hooks: TurnHooks): Promise<TurnResult> => {
    const allowed = new Set<string>(actionsForAgent(agentId));
    const tools = toolDefinitions([...allowed] as ActionName[]);
    let history = histories.get(agentId) ?? [];
    // Start a fresh conversation rather than editing old turns (keeps history append-only).
    if (history.length > MAX_HISTORY_MESSAGES) history = [];
    // Ground the turn in AWS documentation fetched up front: no extra model calls, so no extra quota.
    const [snapshot, docs] = await Promise.all([deps.snapshot(), deps.knowledge?.search(`${serviceById(agentId)?.name ?? agentId} ${playerText}`, 3) ?? []]);
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: 'user', content: `${docsBlock(docs)}<city_snapshot>${snapshotForModel(snapshot)}</city_snapshot>\n\nPlayer: ${playerText}` },
    ];
    const sources = docs.map(({ title, url }) => ({ title, url }));
    const toolCalls: ToolCallReport[] = [];
    const replyParts: string[] = [];

    try {
      for (let step = 0; step <= MAX_TOOL_CALLS_PER_TURN; step++) {
        if (hooks.signal?.aborted) break;
        const outOfBudget = toolCalls.length >= MAX_TOOL_CALLS_PER_TURN;
        hooks.onModelCall?.('start');
        let response: Anthropic.Message;
        try {
          response = await deps.llm.create({
            max_tokens: 16000,
            // Real AWS work: keep the depth set explicitly (Claude Opus 5.5 defaults to medium, Opus 5 to high).
            output_config: { effort: 'high' },
            // Prompt caching: the persona + tools are identical across a player's turns (cheaper, faster).
            system: [{ type: 'text', text: agentSystemPrompt(agentId), cache_control: { type: 'ephemeral' } }],
            tools,
            ...(outOfBudget ? { tool_choice: { type: 'none' as const } } : {}),
            messages,
          });
        } finally {
          hooks.onModelCall?.('end');
        }

        if (response.stop_reason === 'refusal') {
          // Drop the refused reply but keep what already happened this turn (actions that ran stay known).
          return { agentId, reply: "Sorry, I can't help with that one.", toolCalls, refused: true, sources: [] };
        }

        messages.push({ role: 'assistant', content: response.content });
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text) {
          replyParts.push(text);
          hooks.onText?.(text);
        }

        const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || uses.length === 0) break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of uses) {
          if (hooks.signal?.aborted) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Not executed: the player left.' });
            continue;
          }
          if (toolCalls.length >= MAX_TOOL_CALLS_PER_TURN) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Tool budget for this turn is used up. Summarise for the player instead.' });
            continue;
          }
          // Tools outside this agent's allowlist are rejected even if the model invents them.
          const known = allowed.has(use.name);
          hooks.onToolStart?.({ name: use.name, api: known ? AWS_API[use.name as ActionName] : use.name, summary: deps.actions.describe(use.name, use.input) });
          const outcome: SubmitOutcome = known
            ? await (hooks.approve ? deps.actions.submit(use.name, use.input, submitOpts(hooks)) : deps.actions.submit(use.name, use.input))
            : { status: 'invalid', error: `"${use.name}" isn't one of this agent's tools.` };
          const report = toolReport(use.name, use.input, outcome);
          toolCalls.push(report);
          hooks.onToolEnd?.(report);
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: outcome.status === 'invalid' || outcome.status === 'failed',
            content: outcomeText(outcome),
          });
        }
        // All results for one assistant turn go back in a single user message.
        messages.push({ role: 'user', content: results });
      }
      return { agentId, reply: replyParts.join('\n\n'), toolCalls, refused: false, sources };
    } finally {
      // Whatever happened (normal end, max_tokens mid tool call, refusal, an exception), leave a valid history:
      // every tool_use must be answered, or every later request for this agent would be rejected.
      closeDangling(messages);
      histories.set(agentId, messages);
    }
  };

  return { turn, reset: (agentId: string) => histories.delete(agentId) };
};

export interface AgentRunner {
  turn(agentId: string, playerText: string, hooks?: TurnHooks): Promise<TurnResult>;
  reset(agentId: string): unknown;
}
