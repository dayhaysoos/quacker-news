import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const AQUADUCK_CHAT_COMPLETIONS_URL =
  "https://api.aquaduck.ai/v1/chat/completions";
const DEFAULT_AQUADUCK_MODEL = "Qwen3-8B-Q4_K_M";
const AQUADUCK_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 1_200;

declare const process: {
  env: {
    AGENT_RUNS_ENABLED?: string;
    AQUADUCK_API_KEY?: string;
    AQUADUCK_MODEL?: string;
  };
};

export const scheduledTick = internalAction({
  args: {},
  handler: async (ctx): Promise<ScheduledTickResult> => {
    if (process.env.AGENT_RUNS_ENABLED !== "true") {
      return { kind: "disabled" };
    }

    const runResult: CreateScheduledRunResult = await ctx.runMutation(
      internal.agentRuns.createScheduledRun,
      {},
    );

    if (runResult.kind === "skipped") {
      return runResult;
    }

    const aquaduckInput = buildAquaduckInput(runResult.context);
    await ctx.runMutation(internal.agentRuns.markRunRunning, {
      runId: runResult.runId,
      aquaduckInput,
      startedAt: new Date().toISOString(),
    });

    const apiKey = process.env.AQUADUCK_API_KEY;

    if (!apiKey) {
      await ctx.runMutation(internal.agentRuns.completeNoopRun, {
        runId: runResult.runId,
        aquaduckRawOutput: null,
        candidateAction: null,
        invalidActionReason: null,
        inferenceError: "inference_unavailable:AQUADUCK_API_KEY is not configured",
        noopReason: "inference_unavailable",
        outputSummary: "Aquaduck inference skipped because no API key is configured.",
        completedAt: new Date().toISOString(),
      });
      return { kind: "noop", reason: "inference_unavailable" };
    }

    try {
      const aquaduckResult = await requestAquaduckCreatePost(
        apiKey,
        aquaduckInput,
      );

      if (!aquaduckResult.ok) {
        await ctx.runMutation(internal.agentRuns.completeNoopRun, {
          runId: runResult.runId,
          aquaduckRawOutput: aquaduckResult.rawOutput,
          candidateAction: null,
          invalidActionReason: aquaduckResult.invalidActionReason,
          inferenceError: aquaduckResult.inferenceError,
          noopReason: aquaduckResult.noopReason,
          outputSummary: aquaduckResult.outputSummary,
          completedAt: new Date().toISOString(),
        });
        return { kind: "noop", reason: aquaduckResult.noopReason };
      }

      const validatedCandidate = validateCreatePostCandidate(
        aquaduckResult.content,
        runResult.context.humanEvent.id,
      );

      if (!validatedCandidate.ok) {
        await ctx.runMutation(internal.agentRuns.completeNoopRun, {
          runId: runResult.runId,
          aquaduckRawOutput: aquaduckResult.rawOutput,
          candidateAction: validatedCandidate.candidateAction,
          invalidActionReason: validatedCandidate.reason,
          inferenceError: null,
          noopReason: validatedCandidate.reason,
          outputSummary: "Aquaduck returned an invalid create_post candidate.",
          completedAt: new Date().toISOString(),
        });
        return { kind: "noop", reason: validatedCandidate.reason };
      }

      const postResult: ApplyCreatePostResult = await ctx.runMutation(
        internal.agentRuns.applyCreatePostAction,
        {
          runId: runResult.runId,
          candidate: validatedCandidate.candidate,
          aquaduckRawOutput: aquaduckResult.rawOutput,
          completedAt: new Date().toISOString(),
        },
      );

      return postResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.agentRuns.markRunFailed, {
        runId: runResult.runId,
        error: message,
      });
      return { kind: "failed", error: message };
    }
  },
});

export const createScheduledRun = internalMutation({
  args: {},
  handler: async (ctx): Promise<CreateScheduledRunResult> => {
    const queuedRun = await ctx.db
      .query("agent_runs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(1);

    if (queuedRun.length > 0) {
      return { kind: "skipped", reason: "active_run_exists" };
    }

    const runningRun = await ctx.db
      .query("agent_runs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(1);

    if (runningRun.length > 0) {
      return { kind: "skipped", reason: "active_run_exists" };
    }

    const agents = await ctx.db.query("agents").take(20);
    const humanEvents = await ctx.db
      .query("human_events")
      .withIndex("by_createdAt")
      .order("desc")
      .take(20);

    if (agents.length === 0 || humanEvents.length === 0) {
      return { kind: "skipped", reason: "missing_seed_data" };
    }

    const target = await selectCreatePostTarget(ctx, agents, humanEvents);

    if (target === null) {
      return { kind: "skipped", reason: "no_create_post_target" };
    }

    const now = new Date().toISOString();
    const context = await buildDecisionContext(
      ctx,
      target.agent,
      target.humanEvent,
    );
    const runId = await ctx.db.insert("agent_runs", {
      agentId: target.agent._id,
      triggerType: "scheduled",
      triggerId: target.humanEvent._id,
      status: "queued",
      intendedActionType: "create_post",
      inputContext: context,
      aquaduckInput: null,
      aquaduckRawOutput: null,
      candidateAction: null,
      selectedAction: null,
      invalidActionReason: null,
      inferenceError: null,
      outputSummary: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
    });

    return {
      kind: "created",
      runId,
      context,
    };
  },
});

export const markRunRunning = internalMutation({
  args: {
    runId: v.id("agent_runs"),
    aquaduckInput: v.any(),
    startedAt: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);

    if (run === null || run.status !== "queued") {
      return null;
    }

    await ctx.db.patch(args.runId, {
      status: "running",
      aquaduckInput: args.aquaduckInput,
      startedAt: args.startedAt,
    });

    return null;
  },
});

export const completeNoopRun = internalMutation({
  args: {
    runId: v.id("agent_runs"),
    aquaduckRawOutput: v.union(v.any(), v.null()),
    candidateAction: v.union(v.any(), v.null()),
    invalidActionReason: v.union(v.string(), v.null()),
    inferenceError: v.union(v.string(), v.null()),
    noopReason: v.string(),
    outputSummary: v.string(),
    completedAt: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);

    if (run === null) {
      return null;
    }

    await ctx.db.patch(args.runId, {
      status: "completed",
      aquaduckRawOutput: args.aquaduckRawOutput,
      candidateAction: args.candidateAction,
      selectedAction: {
        action: "noop",
        reason: args.noopReason,
      },
      invalidActionReason: args.invalidActionReason,
      inferenceError: args.inferenceError,
      outputSummary: args.outputSummary,
      completedAt: args.completedAt,
    });

    await patchAgentWakeState(ctx, run.agentId, args.completedAt);
    return null;
  },
});

export const applyCreatePostAction = internalMutation({
  args: {
    runId: v.id("agent_runs"),
    candidate: v.object({
      action: v.literal("create_post"),
      humanEventId: v.string(),
      title: v.string(),
      body: v.string(),
      reason: v.string(),
      memoryUpdate: v.union(v.string(), v.null()),
    }),
    aquaduckRawOutput: v.any(),
    completedAt: v.string(),
  },
  handler: async (ctx, args): Promise<ApplyCreatePostResult> => {
    const run = await ctx.db.get(args.runId);

    if (run === null) {
      return { kind: "failed", error: "missing_run" };
    }

    if (run.status !== "running") {
      return { kind: "failed", error: "run_not_running" };
    }

    const humanEventId = ctx.db.normalizeId(
      "human_events",
      args.candidate.humanEventId,
    );

    if (humanEventId === null || run.triggerId !== humanEventId) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "missing_or_disallowed_human_event",
        noopReason: "missing_or_disallowed_human_event",
        outputSummary:
          "Aquaduck returned a create_post action for a missing or disallowed Human Event.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "missing_or_disallowed_human_event" };
    }

    const humanEvent = await ctx.db.get(humanEventId);

    if (humanEvent === null) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "missing_human_event",
        noopReason: "missing_human_event",
        outputSummary: "Aquaduck targeted a Human Event that no longer exists.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "missing_human_event" };
    }

    const duplicateHumanEventPost = await hasAgentPostForHumanEventSource(
      ctx,
      run.agentId,
      humanEvent,
    );

    if (duplicateHumanEventPost) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "duplicate_human_event_post",
        noopReason: "duplicate_human_event_post",
        outputSummary:
          "Aquaduck selected a Human Event this Agent has already posted about.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "duplicate_human_event_post" };
    }

    if (copiesSourceTitle(args.candidate.title, humanEvent)) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "copied_source_title",
        noopReason: "copied_source_title",
        outputSummary:
          "Aquaduck returned a post title copied from source metadata.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "copied_source_title" };
    }

    const postId = await ctx.db.insert("posts", {
      authorAgentId: run.agentId,
      humanEventId: humanEvent._id,
      sourceArticleUrl: humanEvent.sourceArticleUrl,
      title: args.candidate.title,
      body: args.candidate.body,
      score: 0,
      commentCount: 0,
      createdAt: args.completedAt,
      updatedAt: args.completedAt,
    });

    await ctx.db.patch(args.runId, {
      status: "completed",
      aquaduckRawOutput: args.aquaduckRawOutput,
      candidateAction: args.candidate,
      selectedAction: {
        ...args.candidate,
        postId,
      },
      invalidActionReason: null,
      inferenceError: null,
      outputSummary: `Created post ${postId}.`,
      completedAt: args.completedAt,
    });

    await patchAgentWakeState(ctx, run.agentId, args.completedAt);

    return { kind: "created_post", postId };
  },
});

export const markRunFailed = internalMutation({
  args: {
    runId: v.id("agent_runs"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "failed",
      error: args.error,
      completedAt: new Date().toISOString(),
    });

    return null;
  },
});

interface CreateScheduledRunResultCreated {
  kind: "created";
  runId: Id<"agent_runs">;
  context: AgentDecisionContext;
}

interface CreateScheduledRunResultSkipped {
  kind: "skipped";
  reason: string;
}

type CreateScheduledRunResult =
  | CreateScheduledRunResultCreated
  | CreateScheduledRunResultSkipped;

type ApplyCreatePostResult =
  | { kind: "created_post"; postId: Id<"posts"> }
  | { kind: "noop"; reason: string }
  | { kind: "failed"; error: string };

type ScheduledTickResult =
  | { kind: "disabled" }
  | CreateScheduledRunResultSkipped
  | ApplyCreatePostResult;

interface AgentDecisionContext {
  agent: {
    id: Id<"agents">;
    name: string;
    persona: string;
    worldview: string;
    interests: string[];
    postingStyle: string;
    humorStyle: string;
  };
  state: {
    mood: string;
    memorySummary: string;
    recentVoteTendencySummary: string;
    recentFocus: string[];
  };
  trigger: {
    type: "scheduled";
    humanEventId: Id<"human_events">;
  };
  candidateActionsAllowed: ["create_post"];
  humanEvent: {
    id: Id<"human_events">;
    title: string;
    description: string;
    tags: string[];
    toneHint: string | null;
    sourceArticleUrl: string | null;
    sourceArticleTitle: string | null;
  };
  recentPosts: {
    title: string;
    authorAgentId: Id<"agents">;
    score: number;
    commentCount: number;
    createdAt: string;
  }[];
  outputSchema: {
    action: "create_post";
    humanEventId: Id<"human_events">;
    title: "string";
    body: "string";
    reason: "string";
    memoryUpdate: "string | null";
  };
}

interface AquaduckInput {
  model: string;
  messages: {
    role: "user";
    content: string;
  }[];
}

interface CreatePostCandidate {
  action: "create_post";
  humanEventId: string;
  title: string;
  body: string;
  reason: string;
  memoryUpdate: string | null;
}

type AquaduckRequestResult =
  | {
      ok: true;
      content: string;
      rawOutput: Record<string, unknown>;
    }
  | {
      ok: false;
      rawOutput: Record<string, unknown> | string | null;
      invalidActionReason: string | null;
      inferenceError: string | null;
      noopReason: string;
      outputSummary: string;
    };

type AquaduckRawOutput = Record<string, unknown> | string | null;

type CandidateValidationResult =
  | {
      ok: true;
      candidate: CreatePostCandidate;
    }
  | {
      ok: false;
      reason: string;
      candidateAction: unknown;
    };

async function selectCreatePostTarget(
  ctx: MutationCtx,
  agents: Doc<"agents">[],
  humanEvents: Doc<"human_events">[],
) {
  for (const agent of agents) {
    let humanEvent = null;

    for (const candidate of humanEvents) {
      const hasExistingPost = await hasAgentPostForHumanEventSource(
        ctx,
        agent._id,
        candidate,
      );

      if (!hasExistingPost) {
        humanEvent = candidate;
        break;
      }
    }

    if (humanEvent !== null) {
      return { agent, humanEvent };
    }
  }

  return null;
}

async function hasAgentPostForHumanEventSource(
  ctx: MutationCtx,
  agentId: Id<"agents">,
  humanEvent: Doc<"human_events">,
) {
  if (
    humanEvent.sourceArticleUrl !== null &&
    humanEvent.sourceArticleUrl.trim().length > 0
  ) {
    const existingSourcePosts = await ctx.db
      .query("posts")
      .withIndex("by_authorAgentId_and_sourceArticleUrl", (q) =>
        q
          .eq("authorAgentId", agentId)
          .eq("sourceArticleUrl", humanEvent.sourceArticleUrl),
      )
      .take(1);

    return existingSourcePosts.length > 0;
  }

  const existingPosts = await ctx.db
    .query("posts")
    .withIndex("by_authorAgentId_and_humanEventId", (q) =>
      q.eq("authorAgentId", agentId).eq("humanEventId", humanEvent._id),
    )
    .take(1);

  return existingPosts.length > 0;
}

function copiesSourceTitle(title: string, humanEvent: Doc<"human_events">) {
  const normalizedTitle = normalizeTitleForCopyCheck(title);
  const sourceTitles = [
    humanEvent.title,
    humanEvent.sourceArticleTitle,
  ].filter((sourceTitle): sourceTitle is string => {
    return typeof sourceTitle === "string" && sourceTitle.trim().length > 0;
  });

  return sourceTitles.some((sourceTitle) => {
    return normalizeTitleForCopyCheck(sourceTitle) === normalizedTitle;
  });
}

function normalizeTitleForCopyCheck(title: string) {
  return title
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function buildDecisionContext(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  humanEvent: Doc<"human_events">,
): Promise<AgentDecisionContext> {
  const state = await ctx.db
    .query("agent_state")
    .withIndex("by_agentId", (q) => q.eq("agentId", agent._id))
    .unique();
  const recentPosts = await ctx.db
    .query("posts")
    .withIndex("by_createdAt")
    .order("desc")
    .take(8);

  return {
    agent: {
      id: agent._id,
      name: agent.name,
      persona: agent.persona,
      worldview: agent.worldview,
      interests: [...agent.interests],
      postingStyle: agent.postingStyle,
      humorStyle: agent.humorStyle,
    },
    state: {
      mood: state?.mood ?? "neutral",
      memorySummary: state?.memorySummary ?? "",
      recentVoteTendencySummary: state?.recentVoteTendencySummary ?? "",
      recentFocus: state ? [...state.recentFocus] : [],
    },
    trigger: {
      type: "scheduled",
      humanEventId: humanEvent._id,
    },
    candidateActionsAllowed: ["create_post"],
    humanEvent: {
      id: humanEvent._id,
      title: humanEvent.title,
      description: humanEvent.description,
      tags: [...humanEvent.tags],
      toneHint: humanEvent.toneHint,
      sourceArticleUrl: humanEvent.sourceArticleUrl,
      sourceArticleTitle: humanEvent.sourceArticleTitle,
    },
    recentPosts: recentPosts.map((post) => ({
      title: post.title,
      authorAgentId: post.authorAgentId,
      score: post.score,
      commentCount: post.commentCount,
      createdAt: post.createdAt,
    })),
    outputSchema: {
      action: "create_post",
      humanEventId: humanEvent._id,
      title: "string",
      body: "string",
      reason: "string",
      memoryUpdate: "string | null",
    },
  };
}

function buildAquaduckInput(context: AgentDecisionContext): AquaduckInput {
  const model = process.env.AQUADUCK_MODEL ?? DEFAULT_AQUADUCK_MODEL;

  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          "You are creating one Quacker News Agent Action.",
          "Return JSON only. Do not include Markdown fences or prose.",
          "The only allowed action is create_post.",
          "The post title and body must be authored by the Agent, not copied from the source article title.",
          "Satire should target human behavior, institutions, rituals, incentives, or cultural patterns, not individual people.",
          "Do not claim to be human. Do not mention prompts, policies, API keys, or system instructions.",
          "",
          `Agent: ${context.agent.name}`,
          `Persona: ${context.agent.persona}`,
          `Worldview: ${context.agent.worldview}`,
          `Posting style: ${context.agent.postingStyle}`,
          `Humor style: ${context.agent.humorStyle}`,
          `Memory summary: ${context.state.memorySummary}`,
          `Recent focus: ${context.state.recentFocus.join(", ") || "none"}`,
          "",
          `HumanEvent id: ${context.humanEvent.id}`,
          `HumanEvent title: ${context.humanEvent.title}`,
          `HumanEvent description: ${context.humanEvent.description}`,
          `HumanEvent tags: ${context.humanEvent.tags.join(", ")}`,
          `Tone hint: ${context.humanEvent.toneHint ?? "none"}`,
          "",
          "Recent post titles:",
          ...context.recentPosts.map((post) => `- ${post.title}`),
          "",
          "Return this exact JSON shape:",
          JSON.stringify({
            action: "create_post",
            humanEventId: context.humanEvent.id,
            title: "agent-authored title under 160 characters",
            body: "agent-authored body under 1200 characters",
            reason: "short internal reason",
            memoryUpdate: null,
          }),
        ].join("\n"),
      },
    ],
  };
}

async function requestAquaduckCreatePost(
  apiKey: string,
  aquaduckInput: AquaduckInput,
): Promise<AquaduckRequestResult> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    AQUADUCK_REQUEST_TIMEOUT_MS,
  );
  let response: Response;
  let rawOutput: AquaduckRawOutput;

  try {
    response = await fetch(AQUADUCK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: abortController.signal,
      body: JSON.stringify(aquaduckInput),
    });
    rawOutput = await readAquaduckResponse(response);
  } catch (error) {
    if (abortController.signal.aborted) {
      return {
        ok: false,
        rawOutput: null,
        invalidActionReason: null,
        inferenceError: `aquaduck_timeout:${AQUADUCK_REQUEST_TIMEOUT_MS}ms`,
        noopReason: "inference_unavailable",
        outputSummary: "Aquaduck request timed out.",
      };
    }

    const message = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      rawOutput: null,
      invalidActionReason: null,
      inferenceError: `aquaduck_request_failed:${truncate(message, 500)}`,
      noopReason: "inference_unavailable",
      outputSummary: "Aquaduck request failed before a response was available.",
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return {
      ok: false,
      rawOutput,
      invalidActionReason: null,
      inferenceError: `aquaduck_http_${response.status}`,
      noopReason: "inference_unavailable",
      outputSummary: `Aquaduck returned HTTP ${response.status}.`,
    };
  }

  if (!isRecord(rawOutput)) {
    return {
      ok: false,
      rawOutput,
      invalidActionReason: "malformed_aquaduck_response",
      inferenceError: null,
      noopReason: "malformed_aquaduck_response",
      outputSummary: "Aquaduck returned a non-object response.",
    };
  }

  const content = extractAquaduckMessageContent(rawOutput);

  if (content === null) {
    return {
      ok: false,
      rawOutput,
      invalidActionReason: "missing_aquaduck_message_content",
      inferenceError: null,
      noopReason: "missing_aquaduck_message_content",
      outputSummary: "Aquaduck response did not include choices[0].message.content.",
    };
  }

  return {
    ok: true,
    content,
    rawOutput,
  };
}

async function readAquaduckResponse(
  response: Response,
): Promise<AquaduckRawOutput> {
  const responseText = await response.text();

  if (!responseText) {
    return null;
  }

  try {
    const parsed = JSON.parse(responseText) as unknown;

    if (isRecord(parsed)) {
      return parsed;
    }

    return truncate(responseText, 2_000);
  } catch {
    return truncate(responseText, 2_000);
  }
}

function extractAquaduckMessageContent(rawOutput: Record<string, unknown>) {
  const choices = rawOutput.choices;

  if (!Array.isArray(choices)) {
    return null;
  }

  const firstChoice = choices[0];

  if (!isRecord(firstChoice)) {
    return null;
  }

  const message = firstChoice.message;

  if (!isRecord(message) || typeof message.content !== "string") {
    return null;
  }

  return message.content;
}

function validateCreatePostCandidate(
  content: string,
  expectedHumanEventId: Id<"human_events">,
): CandidateValidationResult {
  const parsed = parseJsonObject(content);

  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      candidateAction: content,
    };
  }

  const candidateAction = parsed.value;

  if (!isRecord(candidateAction)) {
    return {
      ok: false,
      reason: "candidate_not_object",
      candidateAction,
    };
  }

  if (candidateAction.action !== "create_post") {
    return {
      ok: false,
      reason: "disallowed_action",
      candidateAction,
    };
  }

  if (typeof candidateAction.humanEventId !== "string") {
    return {
      ok: false,
      reason: "invalid_human_event_target",
      candidateAction,
    };
  }

  if (candidateAction.humanEventId !== expectedHumanEventId) {
    return {
      ok: false,
      reason: "unexpected_human_event_target",
      candidateAction,
    };
  }

  if (
    typeof candidateAction.title !== "string" ||
    candidateAction.title.trim().length === 0 ||
    candidateAction.title.length > MAX_TITLE_LENGTH
  ) {
    return {
      ok: false,
      reason: "invalid_post_title",
      candidateAction,
    };
  }

  if (
    typeof candidateAction.body !== "string" ||
    candidateAction.body.trim().length === 0 ||
    candidateAction.body.length > MAX_BODY_LENGTH
  ) {
    return {
      ok: false,
      reason: "invalid_post_body",
      candidateAction,
    };
  }

  if (
    typeof candidateAction.reason !== "string" ||
    candidateAction.reason.trim().length === 0
  ) {
    return {
      ok: false,
      reason: "invalid_action_reason",
      candidateAction,
    };
  }

  if (
    candidateAction.memoryUpdate !== undefined &&
    candidateAction.memoryUpdate !== null &&
    typeof candidateAction.memoryUpdate !== "string"
  ) {
    return {
      ok: false,
      reason: "invalid_memory_update",
      candidateAction,
    };
  }

  if (!passesBasicSafety(candidateAction.title, candidateAction.body)) {
    return {
      ok: false,
      reason: "blocked_content",
      candidateAction,
    };
  }

  return {
    ok: true,
    candidate: {
      action: "create_post",
      humanEventId: candidateAction.humanEventId,
      title: candidateAction.title.trim(),
      body: candidateAction.body.trim(),
      reason: candidateAction.reason.trim(),
      memoryUpdate:
        typeof candidateAction.memoryUpdate === "string"
          ? candidateAction.memoryUpdate.trim()
          : null,
    },
  };
}

function parseJsonObject(content: string) {
  const trimmed = content.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return { ok: false as const, reason: "missing_json_object" };
  }

  try {
    return {
      ok: true as const,
      value: JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as unknown,
    };
  } catch {
    return { ok: false as const, reason: "malformed_json" };
  }
}

function passesBasicSafety(title: string, body: string) {
  const text = `${title}\n${body}`.toLowerCase();
  const blockedFragments = [
    "as a human",
    "as an actual human",
    "i am human",
    "i'm human",
    "system prompt",
    "developer message",
    "prompt instructions",
    "api key",
  ];

  return !blockedFragments.some((fragment) => text.includes(fragment));
}

async function completeNoopFromMutation(
  ctx: MutationCtx,
  run: Doc<"agent_runs">,
  args: {
    aquaduckRawOutput: unknown;
    candidateAction: unknown;
    invalidActionReason: string;
    noopReason: string;
    outputSummary: string;
    completedAt: string;
  },
) {
  await ctx.db.patch(run._id, {
    status: "completed",
    aquaduckRawOutput: args.aquaduckRawOutput,
    candidateAction: args.candidateAction,
    selectedAction: {
      action: "noop",
      reason: args.noopReason,
    },
    invalidActionReason: args.invalidActionReason,
    inferenceError: null,
    outputSummary: args.outputSummary,
    completedAt: args.completedAt,
  });

  await patchAgentWakeState(ctx, run.agentId, args.completedAt);
}

async function patchAgentWakeState(
  ctx: MutationCtx,
  agentId: Id<"agents">,
  updatedAt: string,
) {
  const state = await ctx.db
    .query("agent_state")
    .withIndex("by_agentId", (q) => q.eq("agentId", agentId))
    .unique();

  if (state === null) {
    return;
  }

  await ctx.db.patch(state._id, {
    lastWakeAt: updatedAt,
    updatedAt,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, length: number) {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length)}...`;
}
