import { docsBlock, type Knowledge, neutralise } from '../knowledge/mcp.js';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Llm } from '../agents/llm.js';
import { pick, say } from '../agents/once.js';
import { agentSystemPrompt, CONCIERGE_PROMPT, lookoutPrompt } from '../agents/personas.js';
import { type AgentRunner, outcomeMessage, snapshotForModel, type ToolCallReport } from '../agents/runner.js';
import { type ActionName, actionsForAgent, AWS_API, READ_ONLY } from '../agents/actions.js';
import { parseCommand } from '../agents/commands.js';
import type { ActionService, ApprovalRequest } from '../agents/service.js';
import type { Approvals } from './approvals.js';
import type { WorldSnapshot } from '../state/model.js';
import {
  type ChatAsk,
  type DistrictId,
  districtById,
  matchText,
  type PageClassify,
  type PageContext,
  placeFor,
  type ServerEvent,
  SERVICES,
  serviceById,
  servicesIn,
  type TaskSubmit,
} from '../world.js';
import type { UploadStore } from './uploads.js';
import { publicError } from '../log.js';
import { isCommit } from '../../../src/console/risk.js';

export type Emit = (event: ServerEvent) => void;

const SERVICE_IDS = SERVICES.map((s) => s.id) as [string, ...string[]];
const XP = { task: 15, perWrite: 5, attempted: 3, classify: 3 } as const;

/**
 * The landmark agent's words to act on: the player's request (first, unchanged), then the concierge's plan as fenced data
 * (<concierge_plan>), so the agent does what the city just showed the player it would. A small model left with only
 * "Store my holiday photos cheaply" answered with advice and made no change (21 Nov 2026).
 *
 * The plan is model text, and the concierge reads page context (a console page's title can carry anyone's words), so it
 * never becomes instructions: it's neutralised, fenced, and a step that destroys something stays only when the player's
 * own words ask for one (planForAgent). The agent acts on what the player asked; every change still waits for their Approve.
 */
export const withPlan = (prompt: string, steps: readonly string[]) => {
  const plan = planForAgent(prompt, steps);
  return plan.length
    ? `${prompt}\n\n<concierge_plan>\n${plan.map((s, i) => `${i + 1}. ${neutralise(s)}`).join('\n')}\n</concierge_plan>\nDo what the player's own words ask. If that changes AWS, use your tools now (each change waits for the player's Approve), then explain briefly.`
    : prompt;
};

/** The leading verb of a plan step, lower-case letters only. */
const leadingVerb = (step: string) => (step.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
const DESTROYS = /^(delete|terminate|demolish|remove|stop|detach|revoke|disable|destroy|drop|empty|purge)$/;
const ASKS_TO_DESTROY = /\b(delete|terminate|demolish|remove|stop|detach|revoke|disable|destroy|drop|empty|purge|tear down|teardown|clean up)\b/i;
/** The plan the agent sees: steps that destroy something only when the player's own words ask for it. */
export const planForAgent = (prompt: string, steps: readonly string[]) =>
  ASKS_TO_DESTROY.test(prompt) ? [...steps] : steps.filter((s) => !DESTROYS.test(leadingVerb(s)));

/**
 * A plan step that changes AWS (the concierge puts those first, one action each: "Create a bucket named X", "Launch a
 * t4g.nano"): its leading verb commits a change (risk.ts isCommit) or removes something. Explanations ("Explain…",
 * "Show…") don't.
 */
const REMOVES = /^(delete|terminate|demolish|remove|make|build|put|turn)$/;
export const isActionStep = (step: string) => {
  const verb = leadingVerb(step);
  return isCommit(verb) || REMOVES.test(verb);
};

/**
 * The one change a plain request asks for, when the agent it went to owns that action ("Create a bucket called
 * holiday-123" at the S3 Warehouse). Read from the player's own words only: never page context, never the plan.
 */
export const directRequest = (agentId: string, prompt: string) => {
  const command = parseCommand(prompt);
  return command && actionsForAgent(agentId).includes(command.name) ? command : undefined;
};

const PLAN_TOOL = {
  name: 'plan_task',
  description: 'Pick the landmark agent for this request and write the plan it will follow.',
  input_schema: {
    type: 'object' as const,
    properties: {
      agentId: { type: 'string', enum: SERVICE_IDS, description: 'Service id of the agent that handles the request.' },
      steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, description: 'Short, friendly steps in order.' },
      reply: { type: 'string', description: 'One sentence to the player, e.g. "Sounds like a job for Eddie at the EC2 Factory!"' },
    },
    required: ['agentId', 'steps', 'reply'],
    additionalProperties: false,
  },
};
const Plan = z.object({ agentId: z.enum(SERVICE_IDS), steps: z.array(z.string().min(1).max(160)).min(1).max(5), reply: z.string().max(300) });

const REPORT_TOOL = {
  name: 'report_page',
  description: 'Report which AWS services the page is about.',
  input_schema: {
    type: 'object' as const,
    properties: {
      serviceIds: { type: 'array', items: { type: 'string', enum: SERVICE_IDS }, maxItems: 4 },
      summary: { type: 'string', description: 'One or two beginner-friendly sentences.' },
    },
    required: ['serviceIds', 'summary'],
    additionalProperties: false,
  },
};
const Report = z.object({ serviceIds: z.array(z.string()).max(4), summary: z.string().max(600) });

/** The page the player is on: any site's URL and title, so untrusted; wrapped and stripped of tag characters. */
const describeContext = (c: PageContext) => {
  const lines = [c.url && `url: ${neutralise(c.url)}`, c.title && `title: ${neutralise(c.title)}`, c.serviceId && `serviceId matched by the frontend: ${neutralise(c.serviceId)}`].filter(Boolean);
  return lines.length ? `<page_context>\n${lines.join('\n')}\n</page_context>` : '';
};

const toolInput = <T>(msg: Anthropic.Message, name: string, schema: z.ZodType<T>): T | undefined => {
  const block = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === name);
  const parsed = block ? schema.safeParse(block.input) : undefined;
  return parsed?.success ? parsed.data : undefined;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A screenshot's MIME type as the Converse image format (the Lookout uploads PNG or JPEG). */
const IMAGE_FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;
const imageFormat = (contentType: string | undefined) =>
  contentType && contentType in IMAGE_FORMATS ? IMAGE_FORMATS[contentType as keyof typeof IMAGE_FORMATS] : undefined;

/**
 * Implements the frontend contract (docs/backend-contract.md) on top of the agent runner.
 * Rule from the contract: every real AWS call made for an agent is wrapped in agent.state working → idle.
 */
export const createOrchestrator = (deps: {
  llm: Llm;
  runner: AgentRunner;
  snapshot: () => Promise<WorldSnapshot>;
  uploads: Pick<UploadStore, 'get'>;
  /** AWS documentation for grounded answers (the Knowledge MCP server); optional. */
  knowledge?: Knowledge;
  /** Whose screenshots this orchestrator may read (the signed-in player; 'local' for the local server). */
  owner?: string;
  /**
   * The tenant's ActionService (the same one the agents' tools use): a plain request the agent's turn didn't act on
   * goes through it, with the same policy, approval card and MFA. Omitted = no fallback.
   */
  actions?: Pick<ActionService, 'submit' | 'describe'>;
  /** Time the agent gets to walk to its landmark before work starts (mock uses ~4.5 s). */
  walkMs?: number;
  paceMs?: number;
}) => {
  const walkMs = deps.walkMs ?? 4000;
  const paceMs = deps.paceMs ?? 600;

  /** agent.state working → fn → idle, even when fn throws. */
  const working = async <T>(emit: Emit, agentId: string, service: string, detail: string, fn: () => Promise<T>): Promise<T> => {
    emit({ type: 'agent.state', agentId, state: 'working', service, detail });
    try {
      return await fn();
    } finally {
      emit({ type: 'agent.state', agentId, state: 'idle' });
    }
  };

  const plan = async (cmd: Omit<TaskSubmit, 'action'>) => {
    const snapshot = await deps.snapshot();
    const request = `<city_snapshot>${snapshotForModel(snapshot)}</city_snapshot>\n${describeContext(cmd.context)}\n\nPlayer request: ${cmd.prompt}`;
    const parsed =
      deps.llm.family === 'converse'
        ? // Amazon Nova (Converse) on Strands Agents: one tool call that records the plan.
          await pick(deps.llm, {
            system: CONCIERGE_PROMPT,
            prompt: `${request}\n\nCall ${PLAN_TOOL.name} with your plan.`,
            tool: { name: PLAN_TOOL.name, description: PLAN_TOOL.description, schema: Plan },
            model: { maxTokens: 4000 },
          })
        : toolInput(
            await deps.llm.create({
              max_tokens: 16000,
              // Routing a request is a quick decision: low effort keeps thinking (and cost) small.
              output_config: { effort: 'low' },
              system: CONCIERGE_PROMPT,
              tools: [PLAN_TOOL],
              messages: [{ role: 'user', content: request }],
            }),
            PLAN_TOOL.name,
            Plan,
          );
    if (parsed) return parsed;
    // The model answered without the tool: fall back to the frontend's own keyword routing.
    const agentId = matchText(cmd.prompt) ?? cmd.context.serviceId ?? 'bedrock';
    return { agentId, steps: ['Taking a look at your request'], reply: `Sounds like a job for ${placeFor(agentId)?.agentName ?? agentId}!` };
  };

  /** `signal`: aborted when the socket that asked closes, so the agent stops making model calls for nobody. */
  const submitTask = async (cmd: Omit<TaskSubmit, 'action'>, emit: Emit, approvals?: Approvals, signal?: AbortSignal) => {
    const { taskId } = cmd;
    try {
      const p = await working(emit, 'concierge', 'bedrock', 'InvokeModel — routing your request', () => plan(cmd));
      if (signal?.aborted) return;
      const agentId = serviceById(p.agentId) ? p.agentId : 'bedrock';
      const place = placeFor(agentId)?.place ?? serviceById(agentId)?.name ?? agentId;

      emit({ type: 'agent.message', from: 'concierge', to: 'user', text: p.reply });
      emit({ type: 'agent.message', from: 'concierge', to: agentId, text: `New request: “${cmd.prompt.slice(0, 60)}”` });
      const steps = [`Heading to ${place}`, ...p.steps];
      emit({ type: 'task.plan', taskId, agentId, targetServiceId: agentId, steps });
      emit({ type: 'task.step', taskId, index: 0, text: steps[0]!, status: 'running' });
      await sleep(walkMs);
      emit({ type: 'task.step', taskId, index: 0, text: `Arrived at ${place}`, status: 'done' });

      let index = 1;
      const last = steps.length - 1;
      const approve = approvals ? (req: ApprovalRequest) => approvals.request(taskId, req, emit) : undefined;
      const onToolStart = ({ name, api, summary }: { name: string; api: string; summary: string }) => {
        // A change ticks the plan step that makes it: explanation steps before that one walk through as done first, so
        // "Explain buckets", "Create a bucket" never ticks the explanation and calls the real change "not done".
        // Only for a write: a read (describe_resource, a docs search) never moves the plan on.
        const write = Object.hasOwn(AWS_API, name) && !READ_ONLY.has(name as ActionName);
        const at = write ? steps.findIndex((s, i) => i >= index && isActionStep(s)) : -1;
        for (; at > index; index++) {
          emit({ type: 'task.step', taskId, index, text: steps[index]!, status: 'running' });
          emit({ type: 'task.step', taskId, index, text: steps[index]!, status: 'done' });
        }
        emit({ type: 'task.step', taskId, index: Math.min(index, last), text: steps[Math.min(index, last)]!, status: 'running' });
        emit({ type: 'agent.state', agentId, state: 'working', service: api.split(':')[0], detail: `${api.split(':')[1] ?? api} — ${summary}` });
      };
      const onToolEnd = (call: ToolCallReport) => {
        approvals?.reportResult(taskId, call, emit);
        emit({ type: 'agent.state', agentId, state: 'idle' });
        const i = Math.min(index, last);
        const ok = call.outcome === 'done';
        emit({ type: 'task.step', taskId, index: i, text: ok ? steps[i]! : `${steps[i]} — ${call.message}`, status: ok ? 'done' : 'failed' });
        index++;
      };
      const result = await deps.runner.turn(agentId, withPlan(cmd.prompt, p.steps), {
        onModelCall: (phase) =>
          emit(phase === 'start' ? { type: 'agent.state', agentId, state: 'working', service: 'bedrock', detail: 'InvokeModel — thinking' } : { type: 'agent.state', agentId, state: 'idle' }),
        onToolStart,
        approve,
        onToolEnd,
        onText: (text) => emit({ type: 'agent.message', from: agentId, to: 'user', text }),
        signal,
      });
      if (signal?.aborted) return;

      // A plain request ("Create a bucket called holiday-123") the agent's turn made no tool call for: a small model
      // sometimes says "I'll build it now" and doesn't (seen live, 21 Nov 2026). The server submits exactly what the
      // player typed through the same ActionService and approval card (policy, MFA and the recent sign-in all apply).
      // Never after a refusal, and never from page context or the plan: only the player's own words.
      const toolCalls = [...result.toolCalls];
      let reply = result.reply;
      const direct = !result.refused && !toolCalls.length && approve && deps.actions ? directRequest(agentId, cmd.prompt) : undefined;
      if (direct && approve && deps.actions) {
        onToolStart({ name: direct.name, api: AWS_API[direct.name], summary: deps.actions.describe(direct.name, direct.input) });
        // Said when the card is really shown (policy is checked first: a refused change says why instead).
        const outcome = await deps.actions.submit(direct.name, direct.input, {
          approve: (req) => {
            emit({ type: 'agent.message', from: agentId, to: 'user', text: `I'll do exactly what you asked: ${req.summary}. It waits for your Approve.` });
            return approve(req);
          },
        });
        const call: ToolCallReport = { name: direct.name, input: direct.input, outcome: outcome.status, message: outcomeMessage(outcome) };
        toolCalls.push(call);
        onToolEnd(call);
        reply = call.message;
        if (signal?.aborted) return;
      }

      let ok = !result.refused && toolCalls.every((c) => c.outcome === 'done');
      if (ok) {
        // The steps the agent's tool calls didn't cover: explanations walk through as done, but a step that changes AWS
        // was not done (no tool call made it), and says so, never a ✓ (seen live 21 Nov: "Create a bucket" ticked, nothing
        // created). A task with such a step didn't do what it planned.
        for (; index <= last; index++) {
          emit({ type: 'task.step', taskId, index, text: steps[index]!, status: 'running' });
          await sleep(paceMs);
          if (isActionStep(steps[index]!)) {
            emit({ type: 'task.step', taskId, index, text: `${steps[index]} — not done: no change was made`, status: 'failed' });
            ok = false;
          } else emit({ type: 'task.step', taskId, index, text: steps[index]!, status: 'done' });
        }
      }
      if (result.refused) emit({ type: 'agent.message', from: agentId, to: 'user', text: result.reply });

      const writes = toolCalls.filter((c) => c.outcome === 'done' && c.name !== 'describe_resource' && c.name !== 'review_architecture').length;
      emit({
        type: 'task.done',
        taskId,
        ok,
        result: (reply || (ok ? 'Done.' : 'That did not work out.')).slice(0, 400),
        xp: [{ serviceId: agentId, amount: ok ? XP.task + XP.perWrite * writes : XP.attempted }],
        ...(result.sources?.length ? { sources: result.sources } : {}),
      });
    } catch (err) {
      emit({ type: 'error', message: `Task failed: ${publicError('task failed', err, { taskId })}`, taskId });
    }
  };

  const ask = async (cmd: Omit<ChatAsk, 'action'>, emit: Emit) => {
    const { requestId, districtId } = cmd;
    const district = districtById(districtId);
    if (!district) return emit({ type: 'error', message: `Unknown district "${districtId}"`, requestId });
    const inDistrict = servicesIn(districtId as DistrictId);
    // An "Explain it back" for a side job names its own service (src/state/explain.ts framedJobExplain): that building's
    // agent answers, not whichever service the player's answer happens to mention.
    const tagged = /^Explain it back\b[^]*?\(service: ([a-z0-9-]{1,40})\)/.exec(cmd.question)?.[1];
    const matched = (tagged && inDistrict.some((s) => s.id === tagged) ? tagged : undefined) ?? matchText(cmd.question);
    const svc = inDistrict.find((s) => s.id === matched) ?? inDistrict[0] ?? SERVICES[0]!;
    const agentId = svc.id;

    emit({ type: 'agent.state', agentId: 'bedrock', state: 'working', service: 'bedrock', detail: 'InvokeModelWithResponseStream' });
    emit({ type: 'agent.state', agentId, state: 'working', service: 'bedrock', detail: 'Answering your question' });
    let sent = false;
    try {
      const [snapshot, docs] = await Promise.all([deps.snapshot(), deps.knowledge?.search(`${svc.name} ${cmd.question}`, 3) ?? []]);
      const system = `${agentSystemPrompt(agentId)}\n\nYou are answering a question at ${district.hq}. Reply in plain text (no markdown headings), under 120 words.`;
      const question = `${docsBlock(docs)}<city_snapshot>${snapshotForModel(snapshot)}</city_snapshot>\n${describeContext(cmd.context)}\n\nQuestion: ${cmd.question}`;
      const onText = (delta: string) => {
        sent = true;
        emit({ type: 'chat.answer', requestId, districtId, agentId, delta, done: false });
      };
      const refused =
        deps.llm.family === 'converse'
          ? // Amazon Nova (Converse) on Strands Agents, on the light model, streamed.
            (await say(deps.llm, { system, prompt: question, model: { light: true, maxTokens: 1500 }, onText })).refused
          : (
              await deps.llm.stream(
                {
                  max_tokens: 16000,
                  output_config: { effort: 'low' }, // a short spoken answer
                  system,
                  messages: [{ role: 'user', content: question }],
                },
                onText,
              )
            ).stop_reason === 'refusal';
      if (!sent) {
        const text = refused ? "Sorry, I can't answer that one." : 'Hmm, I have nothing to add.';
        emit({ type: 'chat.answer', requestId, districtId, agentId, delta: text, done: false });
      }
      const sources = docs.map(({ title, url }) => ({ title, url }));
      emit({ type: 'chat.answer', requestId, districtId, agentId, delta: '', done: true, ...(sources.length ? { sources } : {}) });
    } catch (err) {
      emit({ type: 'chat.answer', requestId, districtId, agentId, delta: '', done: true });
      emit({ type: 'error', message: `Chat failed: ${publicError('chat failed', err, { requestId })}`, requestId });
    } finally {
      emit({ type: 'agent.state', agentId: 'bedrock', state: 'idle' });
      emit({ type: 'agent.state', agentId, state: 'idle' });
    }
  };

  const classifyPage = async (cmd: Omit<PageClassify, 'action'>, emit: Emit) => {
    const { requestId, context } = cmd;
    const image = context.screenshotKey ? await deps.uploads.get(context.screenshotKey, deps.owner ?? 'local') : undefined;
    if (!image && !context.url && !context.title) {
      return emit({ type: 'error', message: 'page.classify needs a screenshotKey (uploaded) or a url/title', requestId });
    }
    try {
      const report = await working(emit, 'lookout', 'bedrock', image ? 'InvokeModel (vision) on screenshot' : 'InvokeModel on page title', async () => {
        const ask = `${describeContext(context) || 'No URL or title.'}\n\nWhat is this page about?`;
        if (deps.llm.family === 'converse') {
          // Amazon Nova (Converse) or a local model on Strands Agents: the screenshot as an image block when there is one
          // and the model reads images (a text-only local model gets the page's address and title), then the text.
          const format = deps.llm.sees ? imageFormat(image?.contentType) : undefined;
          return pick(deps.llm, {
            system: lookoutPrompt,
            prompt: [...(image && format ? [{ image: { format, source: { bytes: new Uint8Array(image.bytes) } } }] : []), { text: `${ask}\n\nCall ${REPORT_TOOL.name}.` }],
            tool: { name: REPORT_TOOL.name, description: REPORT_TOOL.description, schema: Report },
            model: { light: true, maxTokens: 1000 },
          });
        }
        const content: Anthropic.ContentBlockParam[] = [];
        if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.contentType, data: image.bytes.toString('base64') } });
        content.push({ type: 'text', text: ask });
        const msg = await deps.llm.create(
          { max_tokens: 16000, output_config: { effort: 'low' }, system: lookoutPrompt, tools: [REPORT_TOOL], messages: [{ role: 'user', content }] },
          { light: true },
        );
        return toolInput(msg, REPORT_TOOL.name, Report);
      });

      const fallback = context.serviceId ?? matchText(`${context.title ?? ''} ${context.url ?? ''}`);
      const serviceIds = (report?.serviceIds ?? (fallback ? [fallback] : [])).filter((id) => serviceById(id));
      const summary =
        report?.summary ??
        (serviceIds[0] ? `This page is about ${serviceById(serviceIds[0])?.name}.` : "I don't see AWS on this page, but the city's agents can still answer questions about it.");
      emit({ type: 'page.classified', requestId, url: context.url, serviceIds, summary });
      emit({ type: 'agent.message', from: 'lookout', to: serviceIds[0] ?? 'concierge', text: summary });
    } catch (err) {
      emit({ type: 'error', message: `Lookout failed: ${publicError('lookout failed', err, { requestId })}`, requestId });
    }
  };

  return { submitTask, ask, classifyPage, xp: XP };
};

export type Orchestrator = ReturnType<typeof createOrchestrator>;
