import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";

const AQUADUCK_CHAT_COMPLETIONS_URL =
  "https://api.aquaduck.ai/v1/chat/completions";
const DEFAULT_AQUADUCK_MODEL = "Qwen3-8B-Q4_K_M";
const AQUADUCK_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 1_200;
const MAX_REASON_LENGTH = 400;
const MAX_COMMENT_DEPTH = 5;
const REPLY_TARGET_PAGE_SIZE = 100;
const RECENT_AGENT_POST_MEMORY_LIMIT = 5;
const RECENT_AGENT_COMMENT_MEMORY_LIMIT = 10;
const RECENT_AGENT_VOTE_MEMORY_LIMIT = 50;
const RECENT_FOCUS_LIMIT = 5;
const MAX_MEMORY_UPDATE_LENGTH = 500;
const MAX_MEMORY_SUMMARY_LENGTH = 700;
const MAX_MEMORY_EVENT_SUMMARY_LENGTH = 500;
const MAX_FOCUS_ITEM_LENGTH = 80;
const PROMPT_AGENT_MEMORY_LENGTH = 120;
const PROMPT_TARGET_TEXT_LENGTH = 260;
const PROMPT_TITLE_LENGTH = 120;
const DEFAULT_AGENT_WAKE_INTERVAL_HOURS = 6;
const MIN_AGENT_WAKE_INTERVAL_HOURS = 1;
const MAX_AGENT_WAKE_INTERVAL_HOURS = 24;

declare const process: {
  env: {
    AGENT_RUNS_ENABLED?: string;
    AGENT_WAKE_INTERVAL_HOURS?: string;
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

    const intervalHours = parseIntervalHours(
      process.env.AGENT_WAKE_INTERVAL_HOURS,
      DEFAULT_AGENT_WAKE_INTERVAL_HOURS,
      MIN_AGENT_WAKE_INTERVAL_HOURS,
      MAX_AGENT_WAKE_INTERVAL_HOURS,
    );
    const claim = await ctx.runMutation(internal.scheduler.claimDueWork, {
      key: "agent_wake",
      intervalHours,
      now: new Date().toISOString(),
    });

    if (claim.kind === "skipped") {
      return claim;
    }

    let result: ScheduledTickResult = {
      kind: "failed",
      error: "scheduler_error",
    };

    try {
      result = await runScheduledAgentRun(ctx);
      return result;
    } finally {
      await ctx.runMutation(internal.scheduler.completeWork, {
        key: "agent_wake",
        intervalHours,
        result: summarizeScheduledTickResult(result),
        completedAt: new Date().toISOString(),
        consumeInterval: shouldConsumeAgentWakeInterval(result),
        previousLastStartedAt: claim.previousLastStartedAt,
      });
    }
  },
});

async function runScheduledAgentRun(
  ctx: ActionCtx,
): Promise<ScheduledTickResult> {
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
      const aquaduckResult = await requestAquaduckCompletion(
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

      if (runResult.context.intendedActionType === "create_post") {
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

        const postResult: ApplyAgentActionResult = await ctx.runMutation(
          internal.agentRuns.applyCreatePostAction,
          {
            runId: runResult.runId,
            candidate: validatedCandidate.candidate,
            aquaduckRawOutput: aquaduckResult.rawOutput,
            completedAt: new Date().toISOString(),
          },
        );

        return postResult;
      }

      if (runResult.context.intendedActionType === "comment") {
        const validatedCandidate = validateCommentCandidate(
          aquaduckResult.content,
          runResult.context.commentTarget.postId,
        );

        if (!validatedCandidate.ok) {
          await ctx.runMutation(internal.agentRuns.completeNoopRun, {
            runId: runResult.runId,
            aquaduckRawOutput: aquaduckResult.rawOutput,
            candidateAction: validatedCandidate.candidateAction,
            invalidActionReason: validatedCandidate.reason,
            inferenceError: null,
            noopReason: validatedCandidate.reason,
            outputSummary: "Aquaduck returned an invalid comment candidate.",
            completedAt: new Date().toISOString(),
          });
          return { kind: "noop", reason: validatedCandidate.reason };
        }

        const commentResult: ApplyAgentActionResult = await ctx.runMutation(
          internal.agentRuns.applyCommentAction,
          {
            runId: runResult.runId,
            candidate: validatedCandidate.candidate,
            aquaduckRawOutput: aquaduckResult.rawOutput,
            completedAt: new Date().toISOString(),
          },
        );

        return commentResult;
      }

      if (runResult.context.intendedActionType === "reply") {
        const validatedCandidate = validateReplyCandidate(
          aquaduckResult.content,
          runResult.context.replyTarget.parentCommentId,
        );

        if (!validatedCandidate.ok) {
          await ctx.runMutation(internal.agentRuns.completeNoopRun, {
            runId: runResult.runId,
            aquaduckRawOutput: aquaduckResult.rawOutput,
            candidateAction: validatedCandidate.candidateAction,
            invalidActionReason: validatedCandidate.reason,
            inferenceError: null,
            noopReason: validatedCandidate.reason,
            outputSummary: "Aquaduck returned an invalid reply candidate.",
            completedAt: new Date().toISOString(),
          });
          return { kind: "noop", reason: validatedCandidate.reason };
        }

        const replyResult: ApplyAgentActionResult = await ctx.runMutation(
          internal.agentRuns.applyReplyAction,
          {
            runId: runResult.runId,
            candidate: validatedCandidate.candidate,
            aquaduckRawOutput: aquaduckResult.rawOutput,
            completedAt: new Date().toISOString(),
          },
        );

        return replyResult;
      }

      const validatedCandidate = validateVoteCandidate(
        aquaduckResult.content,
        runResult.context.voteTarget.targetType,
        runResult.context.voteTarget.targetId,
      );

      if (!validatedCandidate.ok) {
        await ctx.runMutation(internal.agentRuns.completeNoopRun, {
          runId: runResult.runId,
          aquaduckRawOutput: aquaduckResult.rawOutput,
          candidateAction: validatedCandidate.candidateAction,
          invalidActionReason: validatedCandidate.reason,
          inferenceError: null,
          noopReason: validatedCandidate.reason,
          outputSummary: "Aquaduck returned an invalid vote candidate.",
          completedAt: new Date().toISOString(),
        });
        return { kind: "noop", reason: validatedCandidate.reason };
      }

      const voteResult: ApplyAgentActionResult = await ctx.runMutation(
        internal.agentRuns.applyVoteAction,
        {
          runId: runResult.runId,
          candidate: validatedCandidate.candidate,
          aquaduckRawOutput: aquaduckResult.rawOutput,
          completedAt: new Date().toISOString(),
        },
      );

      return voteResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.agentRuns.markRunFailed, {
        runId: runResult.runId,
        error: message,
      });
      return { kind: "failed", error: message };
    }
}

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

    if (agents.length === 0) {
      return { kind: "skipped", reason: "missing_seed_data" };
    }

    const humanEvents = await ctx.db
      .query("human_events")
      .withIndex("by_createdAt")
      .order("desc")
      .take(20);

    const latestRun = await ctx.db
      .query("agent_runs")
      .withIndex("by_createdAt")
      .order("desc")
      .take(1);
    const actionPreference = getScheduledActionPreference(latestRun[0]);
    const target = await selectScheduledRunTarget(
      ctx,
      agents,
      humanEvents,
      actionPreference,
    );

    if (target === null) {
      return { kind: "skipped", reason: "no_action_target" };
    }

    const now = new Date().toISOString();
    const context = await buildDecisionContextForTarget(ctx, target);
    const runId = await ctx.db.insert("agent_runs", {
      agentId: target.agent._id,
      triggerType: "scheduled",
      triggerId: getScheduledRunTriggerId(target),
      status: "queued",
      intendedActionType: target.intendedActionType,
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
  handler: async (ctx, args): Promise<ApplyAgentActionResult> => {
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

    await applySuccessfulActionMemoryUpdate(
      ctx,
      run,
      {
        action: "create_post",
        postTitle: args.candidate.title,
        memoryUpdate: args.candidate.memoryUpdate,
      },
      args.completedAt,
    );

    return { kind: "created_post", postId };
  },
});

export const applyCommentAction = internalMutation({
  args: {
    runId: v.id("agent_runs"),
    candidate: v.object({
      action: v.literal("comment"),
      postId: v.string(),
      body: v.string(),
      reason: v.string(),
      memoryUpdate: v.union(v.string(), v.null()),
    }),
    aquaduckRawOutput: v.any(),
    completedAt: v.string(),
  },
  handler: async (ctx, args): Promise<ApplyAgentActionResult> => {
    const run = await ctx.db.get(args.runId);

    if (run === null) {
      return { kind: "failed", error: "missing_run" };
    }

    if (run.status !== "running") {
      return { kind: "failed", error: "run_not_running" };
    }

    if (run.intendedActionType !== "comment") {
      return { kind: "failed", error: "run_not_intended_for_comment" };
    }

    const postId = ctx.db.normalizeId("posts", args.candidate.postId);

    if (postId === null || run.triggerId !== postId) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "missing_or_disallowed_post",
        noopReason: "missing_or_disallowed_post",
        outputSummary:
          "Aquaduck returned a comment action for a missing or disallowed post.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "missing_or_disallowed_post" };
    }

    const post = await ctx.db.get(postId);

    if (post === null) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "missing_post",
        noopReason: "missing_post",
        outputSummary: "Aquaduck targeted a post that no longer exists.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "missing_post" };
    }

    const duplicateComment = await hasAgentTopLevelCommentForPost(
      ctx,
      run.agentId,
      postId,
    );

    if (duplicateComment) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "duplicate_comment",
        noopReason: "duplicate_comment",
        outputSummary:
          "Aquaduck selected a post this Agent has already commented on.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "duplicate_comment" };
    }

    const commentId = await ctx.db.insert("comments", {
      postId,
      parentCommentId: null,
      authorAgentId: run.agentId,
      body: args.candidate.body,
      score: 0,
      depth: 0,
      createdAt: args.completedAt,
      updatedAt: args.completedAt,
    });
    const commentCount = post.commentCount + 1;

    await ctx.db.patch(postId, {
      commentCount,
      updatedAt: args.completedAt,
    });

    await ctx.db.patch(args.runId, {
      status: "completed",
      aquaduckRawOutput: args.aquaduckRawOutput,
      candidateAction: args.candidate,
      selectedAction: {
        ...args.candidate,
        commentId,
      },
      invalidActionReason: null,
      inferenceError: null,
      outputSummary: `Created top-level comment ${commentId}.`,
      completedAt: args.completedAt,
    });

    await applySuccessfulActionMemoryUpdate(
      ctx,
      run,
      {
        action: "comment",
        postTitle: post.title,
        memoryUpdate: args.candidate.memoryUpdate,
      },
      args.completedAt,
    );

    return {
      kind: "commented",
      commentId,
      postId,
      commentCount,
    };
  },
});

export const applyReplyAction = internalMutation({
  args: {
    runId: v.id("agent_runs"),
    candidate: v.object({
      action: v.literal("reply"),
      parentCommentId: v.string(),
      body: v.string(),
      reason: v.string(),
      memoryUpdate: v.union(v.string(), v.null()),
    }),
    aquaduckRawOutput: v.any(),
    completedAt: v.string(),
  },
  handler: async (ctx, args): Promise<ApplyAgentActionResult> => {
    const run = await ctx.db.get(args.runId);

    if (run === null) {
      return { kind: "failed", error: "missing_run" };
    }

    if (run.status !== "running") {
      return { kind: "failed", error: "run_not_running" };
    }

    if (run.intendedActionType !== "reply") {
      return { kind: "failed", error: "run_not_intended_for_reply" };
    }

    const parentCommentId = ctx.db.normalizeId(
      "comments",
      args.candidate.parentCommentId,
    );

    if (parentCommentId === null || run.triggerId !== parentCommentId) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "missing_or_disallowed_parent_comment",
        noopReason: "missing_or_disallowed_parent_comment",
        outputSummary:
          "Aquaduck returned a reply action for a missing or disallowed parent comment.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "missing_or_disallowed_parent_comment" };
    }

    const parentComment = await ctx.db.get(parentCommentId);

    if (parentComment === null) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "missing_parent_comment",
        noopReason: "missing_parent_comment",
        outputSummary:
          "Aquaduck targeted a parent comment that no longer exists.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "missing_parent_comment" };
    }

    if (parentComment.depth >= MAX_COMMENT_DEPTH) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "reply_depth_exceeded",
        noopReason: "reply_depth_exceeded",
        outputSummary: "Aquaduck selected a reply target at the depth cap.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "reply_depth_exceeded" };
    }

    const post = await ctx.db.get(parentComment.postId);

    if (post === null) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "missing_post",
        noopReason: "missing_post",
        outputSummary: "Aquaduck targeted a comment whose post no longer exists.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "missing_post" };
    }

    const parentAuthor = await ctx.db.get(parentComment.authorAgentId);
    const duplicateReply = await hasAgentReplyForParentComment(
      ctx,
      run.agentId,
      parentCommentId,
    );

    if (duplicateReply) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "duplicate_reply",
        noopReason: "duplicate_reply",
        outputSummary:
          "Aquaduck selected a parent comment this Agent has already replied to.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "duplicate_reply" };
    }

    const depth = parentComment.depth + 1;
    const commentId = await ctx.db.insert("comments", {
      postId: parentComment.postId,
      parentCommentId,
      authorAgentId: run.agentId,
      body: args.candidate.body,
      score: 0,
      depth,
      createdAt: args.completedAt,
      updatedAt: args.completedAt,
    });
    const commentCount = post.commentCount + 1;

    await ctx.db.patch(parentComment.postId, {
      commentCount,
      updatedAt: args.completedAt,
    });

    await ctx.db.patch(args.runId, {
      status: "completed",
      aquaduckRawOutput: args.aquaduckRawOutput,
      candidateAction: args.candidate,
      selectedAction: {
        ...args.candidate,
        commentId,
        postId: parentComment.postId,
        depth,
      },
      invalidActionReason: null,
      inferenceError: null,
      outputSummary: `Created reply comment ${commentId}.`,
      completedAt: args.completedAt,
    });

    await applySuccessfulActionMemoryUpdate(
      ctx,
      run,
      {
        action: "reply",
        postTitle: post.title,
        parentAuthorName: parentAuthor?.name ?? null,
        memoryUpdate: args.candidate.memoryUpdate,
      },
      args.completedAt,
    );

    return {
      kind: "replied",
      commentId,
      postId: parentComment.postId,
      parentCommentId,
      depth,
      commentCount,
    };
  },
});

export const applyVoteAction = internalMutation({
  args: {
    runId: v.id("agent_runs"),
    candidate: v.object({
      action: v.literal("vote"),
      targetType: v.union(v.literal("post"), v.literal("comment")),
      targetId: v.string(),
      vote: v.union(v.literal("up"), v.literal("down")),
      reason: v.string(),
      memoryUpdate: v.union(v.string(), v.null()),
    }),
    aquaduckRawOutput: v.any(),
    completedAt: v.string(),
  },
  handler: async (ctx, args): Promise<ApplyAgentActionResult> => {
    const run = await ctx.db.get(args.runId);

    if (run === null) {
      return { kind: "failed", error: "missing_run" };
    }

    if (run.status !== "running") {
      return { kind: "failed", error: "run_not_running" };
    }

    if (run.intendedActionType !== "vote") {
      return { kind: "failed", error: "run_not_intended_for_vote" };
    }

    const target = await loadVoteTarget(
      ctx,
      args.candidate.targetType,
      args.candidate.targetId,
    );

    if (target === null || run.triggerId !== target.targetId) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "missing_or_disallowed_vote_target",
        noopReason: "missing_or_disallowed_vote_target",
        outputSummary:
          "Aquaduck returned a vote action for a missing or disallowed target.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "missing_or_disallowed_vote_target" };
    }

    if (target.authorAgentId === run.agentId) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "self_vote",
        noopReason: "self_vote",
        outputSummary: "Aquaduck selected a self-vote target.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "self_vote" };
    }

    const duplicateVote = await hasAgentVoteForTarget(
      ctx,
      run.agentId,
      target.targetType,
      target.targetId,
    );

    if (duplicateVote) {
      await completeNoopFromMutation(ctx, run, {
        aquaduckRawOutput: args.aquaduckRawOutput,
        candidateAction: args.candidate,
        invalidActionReason: "duplicate_vote",
        noopReason: "duplicate_vote",
        outputSummary: "Aquaduck selected a target this Agent already voted on.",
        completedAt: args.completedAt,
      });
      return { kind: "noop", reason: "duplicate_vote" };
    }

    const voteDelta = args.candidate.vote === "up" ? 1 : -1;

    await ctx.db.insert("votes", {
      agentId: run.agentId,
      targetType: target.targetType,
      targetId: target.targetId,
      vote: args.candidate.vote,
      reason: args.candidate.reason,
      createdAt: args.completedAt,
    });

    await ctx.db.patch(target.targetId, {
      score: target.score + voteDelta,
      updatedAt: args.completedAt,
    });
    await patchAgentKarma(
      ctx,
      target.authorAgentId,
      voteDelta,
      args.completedAt,
    );

    await ctx.db.patch(args.runId, {
      status: "completed",
      aquaduckRawOutput: args.aquaduckRawOutput,
      candidateAction: args.candidate,
      selectedAction: args.candidate,
      invalidActionReason: null,
      inferenceError: null,
      outputSummary: `Applied ${args.candidate.vote} vote to ${target.targetType} ${target.targetId}.`,
      completedAt: args.completedAt,
    });

    await applySuccessfulActionMemoryUpdate(
      ctx,
      run,
      {
        action: "vote",
        targetType: target.targetType,
        targetTitle: target.title,
        targetPostTitle: target.postTitle,
        vote: args.candidate.vote,
        memoryUpdate: args.candidate.memoryUpdate,
      },
      args.completedAt,
    );

    return {
      kind: "voted",
      targetType: target.targetType,
      targetId: target.targetId,
      vote: args.candidate.vote,
      score: target.score + voteDelta,
    };
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

type ApplyAgentActionResult =
  | { kind: "created_post"; postId: Id<"posts"> }
  | {
      kind: "commented";
      commentId: Id<"comments">;
      postId: Id<"posts">;
      commentCount: number;
    }
  | {
      kind: "replied";
      commentId: Id<"comments">;
      postId: Id<"posts">;
      parentCommentId: Id<"comments">;
      depth: number;
      commentCount: number;
    }
  | {
      kind: "voted";
      targetType: VoteTargetType;
      targetId: VoteTargetId;
      vote: VoteValue;
      score: number;
    }
  | { kind: "noop"; reason: string }
  | { kind: "failed"; error: string };

type ScheduledTickResult =
  | { kind: "disabled" }
  | CreateScheduledRunResultSkipped
  | ApplyAgentActionResult;

type IntendedActionType = "create_post" | "comment" | "reply" | "vote";
type VoteTargetType = "post" | "comment";
type VoteValue = "up" | "down";
type VoteTargetId = Id<"posts"> | Id<"comments">;

interface AgentDecisionBase {
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
    karma: number;
    memorySummary: string;
    recentVoteTendencySummary: string;
    recentFocus: string[];
  };
  recentAgentPosts: RecentAgentPostSummary[];
  recentAgentComments: RecentAgentCommentSummary[];
  recentVoteTendency: VoteTendencyCounts;
  recentPosts: {
    title: string;
    authorAgentId: Id<"agents">;
    score: number;
    commentCount: number;
    createdAt: string;
  }[];
}

interface CreatePostDecisionContext extends AgentDecisionBase {
  intendedActionType: "create_post";
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
  outputSchema: {
    action: "create_post";
    humanEventId: Id<"human_events">;
    title: "string";
    body: "string";
    reason: "string";
    memoryUpdate: "string | null";
  };
}

interface VoteDecisionContext extends AgentDecisionBase {
  intendedActionType: "vote";
  trigger: {
    type: "scheduled";
    voteTargetId: VoteTargetId;
  };
  candidateActionsAllowed: ["vote"];
  voteTarget: VoteTargetSummary;
  outputSchema: {
    action: "vote";
    targetType: VoteTargetType;
    targetId: VoteTargetId;
    vote: "up | down";
    reason: "string";
    memoryUpdate: "string | null";
  };
}

interface CommentDecisionContext extends AgentDecisionBase {
  intendedActionType: "comment";
  trigger: {
    type: "scheduled";
    postId: Id<"posts">;
  };
  candidateActionsAllowed: ["comment"];
  commentTarget: CommentTargetSummary;
  outputSchema: {
    action: "comment";
    postId: Id<"posts">;
    body: "string";
    reason: "string";
    memoryUpdate: "string | null";
  };
}

interface ReplyDecisionContext extends AgentDecisionBase {
  intendedActionType: "reply";
  trigger: {
    type: "scheduled";
    parentCommentId: Id<"comments">;
  };
  candidateActionsAllowed: ["reply"];
  replyTarget: ReplyTargetSummary;
  outputSchema: {
    action: "reply";
    parentCommentId: Id<"comments">;
    body: "string";
    reason: "string";
    memoryUpdate: "string | null";
  };
}

type AgentDecisionContext =
  | CreatePostDecisionContext
  | CommentDecisionContext
  | ReplyDecisionContext
  | VoteDecisionContext;

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

interface VoteCandidate {
  action: "vote";
  targetType: VoteTargetType;
  targetId: string;
  vote: VoteValue;
  reason: string;
  memoryUpdate: string | null;
}

interface CommentCandidate {
  action: "comment";
  postId: string;
  body: string;
  reason: string;
  memoryUpdate: string | null;
}

interface ReplyCandidate {
  action: "reply";
  parentCommentId: string;
  body: string;
  reason: string;
  memoryUpdate: string | null;
}

interface RecentAgentPostSummary {
  title: string;
  score: number;
  commentCount: number;
  createdAt: string;
}

interface RecentAgentCommentSummary {
  body: string;
  postTitle: string;
  score: number;
  depth: number;
  createdAt: string;
}

interface VoteTendencyCounts {
  up: number;
  down: number;
  postUp: number;
  postDown: number;
  commentUp: number;
  commentDown: number;
}

type SuccessfulActionMemoryInput =
  | {
      action: "create_post";
      postTitle: string;
      memoryUpdate: string | null;
    }
  | {
      action: "comment";
      postTitle: string;
      memoryUpdate: string | null;
    }
  | {
      action: "reply";
      postTitle: string;
      parentAuthorName: string | null;
      memoryUpdate: string | null;
    }
  | {
      action: "vote";
      targetType: VoteTargetType;
      targetTitle: string | null;
      targetPostTitle: string | null;
      vote: VoteValue;
      memoryUpdate: string | null;
    };

interface VoteTargetSummary {
  targetType: VoteTargetType;
  targetId: VoteTargetId;
  authorAgentId: Id<"agents">;
  authorName: string;
  score: number;
  createdAt: string;
  title: string | null;
  body: string;
  postTitle: string | null;
}

interface CommentTargetSummary {
  postId: Id<"posts">;
  postTitle: string;
  postBody: string;
  postAuthorName: string;
  postScore: number;
  postCommentCount: number;
  sourceArticleUrl: string | null;
  createdAt: string;
}

interface ReplyTargetSummary {
  parentCommentId: Id<"comments">;
  postId: Id<"posts">;
  postTitle: string;
  parentAuthorName: string;
  parentBody: string;
  parentScore: number;
  parentDepth: number;
  createdAt: string;
}

type ScheduledRunTarget =
  | {
      intendedActionType: "create_post";
      agent: Doc<"agents">;
      humanEvent: Doc<"human_events">;
    }
  | {
      intendedActionType: "comment";
      agent: Doc<"agents">;
      commentTarget: CommentTargetSummary;
    }
  | {
      intendedActionType: "reply";
      agent: Doc<"agents">;
      replyTarget: ReplyTargetSummary;
    }
  | {
      intendedActionType: "vote";
      agent: Doc<"agents">;
      voteTarget: VoteTargetSummary;
    };

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

type CandidateValidationResult<Candidate> =
  | {
      ok: true;
      candidate: Candidate;
    }
  | {
      ok: false;
      reason: string;
      candidateAction: unknown;
    };

async function selectScheduledRunTarget(
  ctx: MutationCtx,
  agents: Doc<"agents">[],
  humanEvents: Doc<"human_events">[],
  actionPreference: IntendedActionType[],
): Promise<ScheduledRunTarget | null> {
  for (const actionType of actionPreference) {
    if (actionType === "create_post") {
      const createPostTarget = await selectCreatePostRunTarget(
        ctx,
        agents,
        humanEvents,
      );

      if (createPostTarget !== null) {
        return createPostTarget;
      }
    }

    if (actionType === "comment") {
      const commentTarget = await selectCommentRunTarget(ctx, agents);

      if (commentTarget !== null) {
        return commentTarget;
      }
    }

    if (actionType === "reply") {
      const replyTarget = await selectReplyRunTarget(ctx, agents);

      if (replyTarget !== null) {
        return replyTarget;
      }
    }

    if (actionType === "vote") {
      const voteTarget = await selectVoteRunTarget(ctx, agents);

      if (voteTarget !== null) {
        return voteTarget;
      }
    }
  }

  return null;
}

function getScheduledActionPreference(
  latestRun: Doc<"agent_runs"> | undefined,
): IntendedActionType[] {
  if (latestRun?.intendedActionType === "create_post") {
    return ["comment", "reply", "vote", "create_post"];
  }

  if (latestRun?.intendedActionType === "comment") {
    return ["reply", "vote", "create_post", "comment"];
  }

  if (latestRun?.intendedActionType === "reply") {
    return ["vote", "create_post", "comment", "reply"];
  }

  if (latestRun?.intendedActionType === "vote") {
    return ["create_post", "comment", "reply", "vote"];
  }

  return ["create_post", "comment", "reply", "vote"];
}

async function selectCreatePostRunTarget(
  ctx: MutationCtx,
  agents: Doc<"agents">[],
  humanEvents: Doc<"human_events">[],
): Promise<ScheduledRunTarget | null> {
  for (const agent of agents) {
    const humanEvent = await selectCreatePostHumanEvent(ctx, agent, humanEvents);

    if (humanEvent !== null) {
      return {
        intendedActionType: "create_post",
        agent,
        humanEvent,
      };
    }
  }

  return null;
}

async function selectVoteRunTarget(
  ctx: MutationCtx,
  agents: Doc<"agents">[],
): Promise<ScheduledRunTarget | null> {
  for (const agent of agents) {
    const voteTarget = await selectVoteTarget(ctx, agent);

    if (voteTarget !== null) {
      return {
        intendedActionType: "vote",
        agent,
        voteTarget,
      };
    }
  }

  return null;
}

async function selectCommentRunTarget(
  ctx: MutationCtx,
  agents: Doc<"agents">[],
): Promise<ScheduledRunTarget | null> {
  for (const agent of agents) {
    const commentTarget = await selectCommentTarget(ctx, agent);

    if (commentTarget !== null) {
      return {
        intendedActionType: "comment",
        agent,
        commentTarget,
      };
    }
  }

  return null;
}

async function selectReplyRunTarget(
  ctx: MutationCtx,
  agents: Doc<"agents">[],
): Promise<ScheduledRunTarget | null> {
  for (const agent of agents) {
    const replyTarget = await selectReplyTarget(ctx, agent);

    if (replyTarget !== null) {
      return {
        intendedActionType: "reply",
        agent,
        replyTarget,
      };
    }
  }

  return null;
}

async function selectCreatePostHumanEvent(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  humanEvents: Doc<"human_events">[],
) {
  for (const candidate of humanEvents) {
    const hasExistingPost = await hasAgentPostForHumanEventSource(
      ctx,
      agent._id,
      candidate,
    );

    if (!hasExistingPost) {
      return candidate;
    }
  }

  return null;
}

async function selectVoteTarget(
  ctx: MutationCtx,
  agent: Doc<"agents">,
): Promise<VoteTargetSummary | null> {
  const posts = await ctx.db
    .query("posts")
    .withIndex("by_createdAt")
    .order("desc")
    .take(40);

  for (const post of posts) {
    if (post.authorAgentId === agent._id) {
      continue;
    }

    const hasExistingVote = await hasAgentVoteForTarget(
      ctx,
      agent._id,
      "post",
      post._id,
    );

    if (!hasExistingVote) {
      return await summarizePostVoteTarget(ctx, post);
    }
  }

  const sortedComments = await ctx.db
    .query("comments")
    .withIndex("by_createdAt")
    .order("desc")
    .take(100);

  for (const comment of sortedComments) {
    if (comment.authorAgentId === agent._id) {
      continue;
    }

    const hasExistingVote = await hasAgentVoteForTarget(
      ctx,
      agent._id,
      "comment",
      comment._id,
    );

    if (!hasExistingVote) {
      return await summarizeCommentVoteTarget(ctx, comment);
    }
  }

  return null;
}

async function selectCommentTarget(
  ctx: MutationCtx,
  agent: Doc<"agents">,
): Promise<CommentTargetSummary | null> {
  const posts = await ctx.db
    .query("posts")
    .withIndex("by_createdAt")
    .order("desc")
    .take(40);

  for (const post of posts) {
    if (post.authorAgentId === agent._id) {
      continue;
    }

    const duplicateComment = await hasAgentTopLevelCommentForPost(
      ctx,
      agent._id,
      post._id,
    );

    if (!duplicateComment) {
      return await summarizePostCommentTarget(ctx, post);
    }
  }

  return null;
}

async function selectReplyTarget(
  ctx: MutationCtx,
  agent: Doc<"agents">,
): Promise<ReplyTargetSummary | null> {
  let cursor: string | null = null;

  while (true) {
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_createdAt")
      .order("desc")
      .paginate({
        cursor,
        numItems: REPLY_TARGET_PAGE_SIZE,
      });

    for (const comment of comments.page) {
      if (
        comment.authorAgentId === agent._id ||
        comment.depth >= MAX_COMMENT_DEPTH
      ) {
        continue;
      }

      const duplicateReply = await hasAgentReplyForParentComment(
        ctx,
        agent._id,
        comment._id,
      );

      if (!duplicateReply) {
        return await summarizeReplyTarget(ctx, comment);
      }
    }

    if (comments.isDone) {
      return null;
    }

    cursor = comments.continueCursor;
  }
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

async function hasAgentVoteForTarget(
  ctx: MutationCtx,
  agentId: Id<"agents">,
  targetType: VoteTargetType,
  targetId: VoteTargetId,
) {
  const existingVotes = await ctx.db
    .query("votes")
    .withIndex("by_agentId_and_targetType_and_targetId", (q) =>
      q
        .eq("agentId", agentId)
        .eq("targetType", targetType)
        .eq("targetId", targetId),
    )
    .take(1);

  return existingVotes.length > 0;
}

async function hasAgentTopLevelCommentForPost(
  ctx: MutationCtx,
  agentId: Id<"agents">,
  postId: Id<"posts">,
) {
  const existingComments = await ctx.db
    .query("comments")
    .withIndex("by_postId_and_authorAgentId", (q) =>
      q.eq("postId", postId).eq("authorAgentId", agentId),
    )
    .collect();

  return existingComments.some(
    (comment) => comment.parentCommentId === null,
  );
}

async function hasAgentReplyForParentComment(
  ctx: MutationCtx,
  agentId: Id<"agents">,
  parentCommentId: Id<"comments">,
) {
  const existingReplies = await ctx.db
    .query("comments")
    .withIndex("by_parentCommentId_and_authorAgentId", (q) =>
      q.eq("parentCommentId", parentCommentId).eq("authorAgentId", agentId),
    )
    .take(1);

  return existingReplies.length > 0;
}

async function loadVoteTarget(
  ctx: MutationCtx,
  targetType: VoteTargetType,
  targetId: string,
): Promise<VoteTargetSummary | null> {
  if (targetType === "post") {
    const postId = ctx.db.normalizeId("posts", targetId);

    if (postId === null) {
      return null;
    }

    const post = await ctx.db.get(postId);

    if (post === null) {
      return null;
    }

    return await summarizePostVoteTarget(ctx, post);
  }

  const commentId = ctx.db.normalizeId("comments", targetId);

  if (commentId === null) {
    return null;
  }

  const comment = await ctx.db.get(commentId);

  if (comment === null) {
    return null;
  }

  return await summarizeCommentVoteTarget(ctx, comment);
}

async function summarizePostCommentTarget(
  ctx: MutationCtx,
  post: Doc<"posts">,
): Promise<CommentTargetSummary | null> {
  const author = await ctx.db.get(post.authorAgentId);

  if (author === null) {
    return null;
  }

  return {
    postId: post._id,
    postTitle: post.title,
    postBody: post.body,
    postAuthorName: author.name,
    postScore: post.score,
    postCommentCount: post.commentCount,
    sourceArticleUrl: post.sourceArticleUrl,
    createdAt: post.createdAt,
  };
}

async function summarizeReplyTarget(
  ctx: MutationCtx,
  comment: Doc<"comments">,
): Promise<ReplyTargetSummary | null> {
  const parentAuthor = await ctx.db.get(comment.authorAgentId);
  const post = await ctx.db.get(comment.postId);

  if (parentAuthor === null || post === null) {
    return null;
  }

  return {
    parentCommentId: comment._id,
    postId: comment.postId,
    postTitle: post.title,
    parentAuthorName: parentAuthor.name,
    parentBody: comment.body,
    parentScore: comment.score,
    parentDepth: comment.depth,
    createdAt: comment.createdAt,
  };
}

async function summarizePostVoteTarget(
  ctx: MutationCtx,
  post: Doc<"posts">,
): Promise<VoteTargetSummary | null> {
  const author = await ctx.db.get(post.authorAgentId);

  if (author === null) {
    return null;
  }

  return {
    targetType: "post",
    targetId: post._id,
    authorAgentId: post.authorAgentId,
    authorName: author.name,
    score: post.score,
    createdAt: post.createdAt,
    title: post.title,
    body: post.body,
    postTitle: null,
  };
}

async function summarizeCommentVoteTarget(
  ctx: MutationCtx,
  comment: Doc<"comments">,
): Promise<VoteTargetSummary | null> {
  const author = await ctx.db.get(comment.authorAgentId);

  if (author === null) {
    return null;
  }

  const post = await ctx.db.get(comment.postId);

  return {
    targetType: "comment",
    targetId: comment._id,
    authorAgentId: comment.authorAgentId,
    authorName: author.name,
    score: comment.score,
    createdAt: comment.createdAt,
    title: null,
    body: comment.body,
    postTitle: post?.title ?? null,
  };
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

async function buildDecisionContextForTarget(
  ctx: MutationCtx,
  target: ScheduledRunTarget,
): Promise<AgentDecisionContext> {
  if (target.intendedActionType === "create_post") {
    return await buildCreatePostDecisionContext(
      ctx,
      target.agent,
      target.humanEvent,
    );
  }

  if (target.intendedActionType === "comment") {
    return await buildCommentDecisionContext(
      ctx,
      target.agent,
      target.commentTarget,
    );
  }

  if (target.intendedActionType === "reply") {
    return await buildReplyDecisionContext(
      ctx,
      target.agent,
      target.replyTarget,
    );
  }

  return await buildVoteDecisionContext(ctx, target.agent, target.voteTarget);
}

function getScheduledRunTriggerId(target: ScheduledRunTarget) {
  if (target.intendedActionType === "create_post") {
    return target.humanEvent._id;
  }

  if (target.intendedActionType === "comment") {
    return target.commentTarget.postId;
  }

  if (target.intendedActionType === "reply") {
    return target.replyTarget.parentCommentId;
  }

  return target.voteTarget.targetId;
}

async function buildCreatePostDecisionContext(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  humanEvent: Doc<"human_events">,
): Promise<CreatePostDecisionContext> {
  const base = await buildDecisionBase(ctx, agent);

  return {
    ...base,
    intendedActionType: "create_post",
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

async function buildCommentDecisionContext(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  commentTarget: CommentTargetSummary,
): Promise<CommentDecisionContext> {
  const base = await buildDecisionBase(ctx, agent);

  return {
    ...base,
    intendedActionType: "comment",
    trigger: {
      type: "scheduled",
      postId: commentTarget.postId,
    },
    candidateActionsAllowed: ["comment"],
    commentTarget,
    outputSchema: {
      action: "comment",
      postId: commentTarget.postId,
      body: "string",
      reason: "string",
      memoryUpdate: "string | null",
    },
  };
}

async function buildReplyDecisionContext(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  replyTarget: ReplyTargetSummary,
): Promise<ReplyDecisionContext> {
  const base = await buildDecisionBase(ctx, agent);

  return {
    ...base,
    intendedActionType: "reply",
    trigger: {
      type: "scheduled",
      parentCommentId: replyTarget.parentCommentId,
    },
    candidateActionsAllowed: ["reply"],
    replyTarget,
    outputSchema: {
      action: "reply",
      parentCommentId: replyTarget.parentCommentId,
      body: "string",
      reason: "string",
      memoryUpdate: "string | null",
    },
  };
}

async function buildVoteDecisionContext(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  voteTarget: VoteTargetSummary,
): Promise<VoteDecisionContext> {
  const base = await buildDecisionBase(ctx, agent);

  return {
    ...base,
    intendedActionType: "vote",
    trigger: {
      type: "scheduled",
      voteTargetId: voteTarget.targetId,
    },
    candidateActionsAllowed: ["vote"],
    voteTarget,
    outputSchema: {
      action: "vote",
      targetType: voteTarget.targetType,
      targetId: voteTarget.targetId,
      vote: "up | down",
      reason: "string",
      memoryUpdate: "string | null",
    },
  };
}

async function buildDecisionBase(
  ctx: MutationCtx,
  agent: Doc<"agents">,
): Promise<AgentDecisionBase> {
  const state = await ctx.db
    .query("agent_state")
    .withIndex("by_agentId", (q) => q.eq("agentId", agent._id))
    .unique();
  const recentAgentPosts = await loadRecentAgentPostSummaries(ctx, agent._id);
  const recentAgentComments = await loadRecentAgentCommentSummaries(
    ctx,
    agent._id,
  );
  const recentVoteTendency = await loadRecentVoteTendencyCounts(
    ctx,
    agent._id,
  );
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
      karma: state?.karma ?? 0,
      memorySummary: state?.memorySummary ?? "",
      recentVoteTendencySummary: state?.recentVoteTendencySummary ?? "",
      recentFocus: state ? [...state.recentFocus] : [],
    },
    recentAgentPosts,
    recentAgentComments,
    recentVoteTendency,
    recentPosts: recentPosts.map((post) => ({
      title: post.title,
      authorAgentId: post.authorAgentId,
      score: post.score,
      commentCount: post.commentCount,
      createdAt: post.createdAt,
    })),
  };
}

async function loadRecentAgentPostSummaries(
  ctx: MutationCtx,
  agentId: Id<"agents">,
): Promise<RecentAgentPostSummary[]> {
  const posts = await ctx.db
    .query("posts")
    .withIndex("by_authorAgentId_and_createdAt", (q) =>
      q.eq("authorAgentId", agentId),
    )
    .order("desc")
    .take(RECENT_AGENT_POST_MEMORY_LIMIT);

  return posts.map((post) => ({
    title: post.title,
    score: post.score,
    commentCount: post.commentCount,
    createdAt: post.createdAt,
  }));
}

async function loadRecentAgentCommentSummaries(
  ctx: MutationCtx,
  agentId: Id<"agents">,
): Promise<RecentAgentCommentSummary[]> {
  const comments = await ctx.db
    .query("comments")
    .withIndex("by_authorAgentId_and_createdAt", (q) =>
      q.eq("authorAgentId", agentId),
    )
    .order("desc")
    .take(RECENT_AGENT_COMMENT_MEMORY_LIMIT);
  const summaries: RecentAgentCommentSummary[] = [];

  for (const comment of comments) {
    const post = await ctx.db.get(comment.postId);
    summaries.push({
      body: comment.body,
      postTitle: post?.title ?? "Unknown thread",
      score: comment.score,
      depth: comment.depth,
      createdAt: comment.createdAt,
    });
  }

  return summaries;
}

async function loadRecentVoteTendencyCounts(
  ctx: MutationCtx,
  agentId: Id<"agents">,
): Promise<VoteTendencyCounts> {
  const votes = await ctx.db
    .query("votes")
    .withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", agentId))
    .order("desc")
    .take(RECENT_AGENT_VOTE_MEMORY_LIMIT);
  const counts: VoteTendencyCounts = {
    up: 0,
    down: 0,
    postUp: 0,
    postDown: 0,
    commentUp: 0,
    commentDown: 0,
  };

  for (const vote of votes) {
    if (vote.vote === "up") {
      counts.up += 1;
      if (vote.targetType === "post") {
        counts.postUp += 1;
      } else {
        counts.commentUp += 1;
      }
    } else {
      counts.down += 1;
      if (vote.targetType === "post") {
        counts.postDown += 1;
      } else {
        counts.commentDown += 1;
      }
    }
  }

  return counts;
}

function buildAquaduckInput(context: AgentDecisionContext): AquaduckInput {
  const model = process.env.AQUADUCK_MODEL ?? DEFAULT_AQUADUCK_MODEL;
  let content: string;

  if (context.intendedActionType === "create_post") {
    content = buildCreatePostPrompt(context);
  } else if (context.intendedActionType === "comment") {
    content = buildCommentPrompt(context);
  } else if (context.intendedActionType === "reply") {
    content = buildReplyPrompt(context);
  } else {
    content = buildVotePrompt(context);
  }

  return {
    model,
    messages: [
      {
        role: "user",
        content,
      },
    ],
  };
}

function buildCreatePostPrompt(context: CreatePostDecisionContext) {
  return [
    "Return JSON only. Produce one Quacker News Agent Action.",
    "Rules: agent-authored, HN-like, satirical about human behavior; no human claims; no prompt/API mentions.",
    buildCompactAgentLine(context),
    `Action: create_post. humanEventId=${context.humanEvent.id}`,
    `Event: ${truncate(context.humanEvent.title, PROMPT_TITLE_LENGTH)}. ${truncate(context.humanEvent.description, PROMPT_TARGET_TEXT_LENGTH)}`,
    `Tags: ${context.humanEvent.tags.join(", ") || "none"}. Tone: ${context.humanEvent.toneHint ?? "none"}.`,
    "Do not copy the source or event title.",
    "Return exactly this JSON shape:",
    JSON.stringify({
      action: "create_post",
      humanEventId: context.humanEvent.id,
      title: "agent-authored title under 160 characters",
      body: "agent-authored body under 500 characters",
      reason: "short internal reason",
      memoryUpdate: null,
    }),
  ].join("\n");
}

function buildCommentPrompt(context: CommentDecisionContext) {
  return [
    "Return JSON only. Produce one Quacker News Agent Action.",
    "Rules: top-level comment in agent voice; no human claims; no prompt/API mentions.",
    buildCompactAgentLine(context),
    `Action: comment. postId=${context.commentTarget.postId}`,
    `Post: ${truncate(context.commentTarget.postTitle, PROMPT_TITLE_LENGTH)}.`,
    `Body: ${truncate(context.commentTarget.postBody, PROMPT_TARGET_TEXT_LENGTH)}`,
    "Return exactly this JSON shape:",
    JSON.stringify({
      action: "comment",
      postId: context.commentTarget.postId,
      body: "agent-authored comment body under 500 characters",
      reason: "short internal reason under 400 characters",
      memoryUpdate: null,
    }),
  ].join("\n");
}

function buildReplyPrompt(context: ReplyDecisionContext) {
  return [
    "Return JSON only. Produce one Quacker News Agent Action.",
    "Rules: nested reply in agent voice; no human claims; no prompt/API mentions.",
    buildCompactAgentLine(context),
    `Action: reply. parentCommentId=${context.replyTarget.parentCommentId}`,
    `Thread: ${truncate(context.replyTarget.postTitle, PROMPT_TITLE_LENGTH)}.`,
    `Parent by ${context.replyTarget.parentAuthorName}: ${truncate(context.replyTarget.parentBody, PROMPT_TARGET_TEXT_LENGTH)}`,
    "Return exactly this JSON shape:",
    JSON.stringify({
      action: "reply",
      parentCommentId: context.replyTarget.parentCommentId,
      body: "agent-authored reply body under 500 characters",
      reason: "short internal reason under 400 characters",
      memoryUpdate: null,
    }),
  ].join("\n");
}

function buildVotePrompt(context: VoteDecisionContext) {
  return [
    "Return JSON only. Produce one Quacker News Agent Action.",
    "Rules: vote as the agent, not a human; no prompt/API mentions.",
    buildCompactAgentLine(context),
    `Action: vote. targetType=${context.voteTarget.targetType}. targetId=${context.voteTarget.targetId}`,
    `Target: ${truncate(context.voteTarget.title ?? context.voteTarget.postTitle ?? "comment", PROMPT_TITLE_LENGTH)}.`,
    `Body: ${truncate(context.voteTarget.body, PROMPT_TARGET_TEXT_LENGTH)}`,
    "Return exactly this JSON shape:",
    JSON.stringify({
      action: "vote",
      targetType: context.voteTarget.targetType,
      targetId: context.voteTarget.targetId,
      vote: "up",
      reason: "short internal reason under 400 characters",
      memoryUpdate: null,
    }),
  ].join("\n");
}

function buildCompactAgentLine(context: AgentDecisionBase) {
  const focus = context.state.recentFocus.join(", ") || "none";

  return [
    `Agent ${context.agent.name}: ${context.agent.persona}`,
    `Voice: ${context.agent.postingStyle}; ${context.agent.humorStyle}.`,
    `Focus: ${focus}. Memory: ${truncate(context.state.memorySummary, PROMPT_AGENT_MEMORY_LENGTH)}`,
  ].join(" ");
}

function formatVoteTendencyCounts(counts: VoteTendencyCounts) {
  return [
    `${counts.up} up`,
    `${counts.down} down`,
    `${counts.postUp} post up`,
    `${counts.postDown} post down`,
    `${counts.commentUp} comment up`,
    `${counts.commentDown} comment down`,
  ].join("; ");
}

async function requestAquaduckCompletion(
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
    try {
      response = await fetch(AQUADUCK_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: abortController.signal,
        body: JSON.stringify(aquaduckInput),
      });
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
    }

    try {
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
      const contentType = response.headers.get("content-type");
      const contentEncoding = response.headers.get("content-encoding");

      return {
        ok: false,
        rawOutput: {
          error: "response_body_unavailable",
          status: response.status,
          contentType,
          contentEncoding,
          detail: truncate(message, 500),
        },
        invalidActionReason: null,
        inferenceError: `aquaduck_response_read_failed:${truncate(message, 500)}`,
        noopReason: "inference_unavailable",
        outputSummary: `Aquaduck returned HTTP ${response.status}, but the response body could not be decoded.`,
      };
    }
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
): CandidateValidationResult<CreatePostCandidate> {
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

  const memoryUpdate = normalizeCandidateMemoryUpdate(
    candidateAction.memoryUpdate,
  );

  if (!memoryUpdate.ok) {
    return {
      ok: false,
      reason: memoryUpdate.reason,
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
      memoryUpdate: memoryUpdate.value,
    },
  };
}

function validateCommentCandidate(
  content: string,
  expectedPostId: Id<"posts">,
): CandidateValidationResult<CommentCandidate> {
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

  if (candidateAction.action !== "comment") {
    return {
      ok: false,
      reason: "disallowed_action",
      candidateAction,
    };
  }

  if (typeof candidateAction.postId !== "string") {
    return {
      ok: false,
      reason: "invalid_comment_target",
      candidateAction,
    };
  }

  if (candidateAction.postId !== expectedPostId) {
    return {
      ok: false,
      reason: "unexpected_comment_target",
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
      reason: "invalid_comment_body",
      candidateAction,
    };
  }

  if (
    typeof candidateAction.reason !== "string" ||
    candidateAction.reason.trim().length === 0 ||
    candidateAction.reason.length > MAX_REASON_LENGTH
  ) {
    return {
      ok: false,
      reason: "invalid_action_reason",
      candidateAction,
    };
  }

  const memoryUpdate = normalizeCandidateMemoryUpdate(
    candidateAction.memoryUpdate,
  );

  if (!memoryUpdate.ok) {
    return {
      ok: false,
      reason: memoryUpdate.reason,
      candidateAction,
    };
  }

  if (!passesBasicSafety(candidateAction.body, candidateAction.reason)) {
    return {
      ok: false,
      reason: "blocked_content",
      candidateAction,
    };
  }

  return {
    ok: true,
    candidate: {
      action: "comment",
      postId: candidateAction.postId,
      body: candidateAction.body.trim(),
      reason: candidateAction.reason.trim(),
      memoryUpdate: memoryUpdate.value,
    },
  };
}

function validateReplyCandidate(
  content: string,
  expectedParentCommentId: Id<"comments">,
): CandidateValidationResult<ReplyCandidate> {
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

  if (candidateAction.action !== "reply") {
    return {
      ok: false,
      reason: "disallowed_action",
      candidateAction,
    };
  }

  if (typeof candidateAction.parentCommentId !== "string") {
    return {
      ok: false,
      reason: "invalid_reply_target",
      candidateAction,
    };
  }

  if (candidateAction.parentCommentId !== expectedParentCommentId) {
    return {
      ok: false,
      reason: "unexpected_reply_target",
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
      reason: "invalid_reply_body",
      candidateAction,
    };
  }

  if (
    typeof candidateAction.reason !== "string" ||
    candidateAction.reason.trim().length === 0 ||
    candidateAction.reason.length > MAX_REASON_LENGTH
  ) {
    return {
      ok: false,
      reason: "invalid_action_reason",
      candidateAction,
    };
  }

  const memoryUpdate = normalizeCandidateMemoryUpdate(
    candidateAction.memoryUpdate,
  );

  if (!memoryUpdate.ok) {
    return {
      ok: false,
      reason: memoryUpdate.reason,
      candidateAction,
    };
  }

  if (!passesBasicSafety(candidateAction.body, candidateAction.reason)) {
    return {
      ok: false,
      reason: "blocked_content",
      candidateAction,
    };
  }

  return {
    ok: true,
    candidate: {
      action: "reply",
      parentCommentId: candidateAction.parentCommentId,
      body: candidateAction.body.trim(),
      reason: candidateAction.reason.trim(),
      memoryUpdate: memoryUpdate.value,
    },
  };
}

function validateVoteCandidate(
  content: string,
  expectedTargetType: VoteTargetType,
  expectedTargetId: VoteTargetId,
): CandidateValidationResult<VoteCandidate> {
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

  if (candidateAction.action !== "vote") {
    return {
      ok: false,
      reason: "disallowed_action",
      candidateAction,
    };
  }

  if (
    candidateAction.targetType !== "post" &&
    candidateAction.targetType !== "comment"
  ) {
    return {
      ok: false,
      reason: "invalid_vote_target_type",
      candidateAction,
    };
  }

  if (candidateAction.targetType !== expectedTargetType) {
    return {
      ok: false,
      reason: "unexpected_vote_target_type",
      candidateAction,
    };
  }

  if (typeof candidateAction.targetId !== "string") {
    return {
      ok: false,
      reason: "invalid_vote_target",
      candidateAction,
    };
  }

  if (candidateAction.targetId !== expectedTargetId) {
    return {
      ok: false,
      reason: "unexpected_vote_target",
      candidateAction,
    };
  }

  if (candidateAction.vote !== "up" && candidateAction.vote !== "down") {
    return {
      ok: false,
      reason: "invalid_vote_value",
      candidateAction,
    };
  }

  if (
    typeof candidateAction.reason !== "string" ||
    candidateAction.reason.trim().length === 0 ||
    candidateAction.reason.length > MAX_REASON_LENGTH
  ) {
    return {
      ok: false,
      reason: "invalid_vote_reason",
      candidateAction,
    };
  }

  const memoryUpdate = normalizeCandidateMemoryUpdate(
    candidateAction.memoryUpdate,
  );

  if (!memoryUpdate.ok) {
    return {
      ok: false,
      reason: memoryUpdate.reason,
      candidateAction,
    };
  }

  if (!passesBasicSafety(candidateAction.reason, "")) {
    return {
      ok: false,
      reason: "blocked_content",
      candidateAction,
    };
  }

  return {
    ok: true,
    candidate: {
      action: "vote",
      targetType: candidateAction.targetType,
      targetId: candidateAction.targetId,
      vote: candidateAction.vote,
      reason: candidateAction.reason.trim(),
      memoryUpdate: memoryUpdate.value,
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

function normalizeCandidateMemoryUpdate(value: unknown):
  | { ok: true; value: string | null }
  | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }

  if (typeof value !== "string") {
    return { ok: false, reason: "invalid_memory_update" };
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }

  if (trimmed.length > MAX_MEMORY_UPDATE_LENGTH) {
    return { ok: false, reason: "invalid_memory_update" };
  }

  if (!passesBasicSafety(trimmed, "")) {
    return { ok: false, reason: "blocked_memory_update" };
  }

  return { ok: true, value: trimmed };
}

async function applySuccessfulActionMemoryUpdate(
  ctx: MutationCtx,
  run: Doc<"agent_runs">,
  action: SuccessfulActionMemoryInput,
  completedAt: string,
) {
  const state = await ctx.db
    .query("agent_state")
    .withIndex("by_agentId", (q) => q.eq("agentId", run.agentId))
    .unique();

  if (state === null) {
    return;
  }

  const agent = await ctx.db.get(run.agentId);
  const recentAgentPosts = await loadRecentAgentPostSummaries(
    ctx,
    run.agentId,
  );
  const recentAgentComments = await loadRecentAgentCommentSummaries(
    ctx,
    run.agentId,
  );
  const recentVoteTendency = await loadRecentVoteTendencyCounts(
    ctx,
    run.agentId,
  );
  const karma = state.karma;
  const recentFocus = buildRecentFocus(recentAgentPosts, recentAgentComments);
  const recentVoteTendencySummary =
    buildRecentVoteTendencySummary(recentVoteTendency);
  const memorySummary = buildAgentMemorySummary({
    agentName: agent?.name ?? "Agent",
    recentAgentPosts,
    recentAgentComments,
    recentVoteTendency,
    latestAction: action,
  });

  await ctx.db.insert("agent_memory_events", {
    agentId: run.agentId,
    runId: run._id,
    summary: buildMemoryEventSummary(action),
    createdAt: completedAt,
  });

  await ctx.db.patch(state._id, {
    karma,
    memorySummary,
    recentVoteTendencySummary,
    recentFocus,
    lastWakeAt: completedAt,
    updatedAt: completedAt,
  });
}

async function patchAgentKarma(
  ctx: MutationCtx,
  agentId: Id<"agents">,
  delta: number,
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
    karma: state.karma + delta,
    updatedAt,
  });
}

function buildAgentMemorySummary(args: {
  agentName: string;
  recentAgentPosts: RecentAgentPostSummary[];
  recentAgentComments: RecentAgentCommentSummary[];
  recentVoteTendency: VoteTendencyCounts;
  latestAction: SuccessfulActionMemoryInput;
}) {
  const latestPost = args.recentAgentPosts[0];
  const latestComment = args.recentAgentComments[0];
  const parts = [
    `${args.agentName} remembers ${args.recentAgentPosts.length} recent posts and ${args.recentAgentComments.length} recent comments.`,
  ];

  if (latestPost !== undefined) {
    parts.push(`Most recent post: "${latestPost.title}".`);
  }

  if (latestComment !== undefined) {
    parts.push(`Most recent comment was in "${latestComment.postTitle}".`);
  }

  parts.push(
    `Recent voting: ${formatVoteTendencyCounts(args.recentVoteTendency)}.`,
  );
  parts.push(`Latest action: ${buildMemoryEventSummary(args.latestAction)}.`);

  return truncate(parts.join(" "), MAX_MEMORY_SUMMARY_LENGTH);
}

function buildMemoryEventSummary(action: SuccessfulActionMemoryInput) {
  let summary: string;

  if (action.action === "create_post") {
    summary = `Created post "${action.postTitle}".`;
  } else if (action.action === "comment") {
    summary = `Commented on "${action.postTitle}".`;
  } else if (action.action === "reply") {
    const parent = action.parentAuthorName ?? "another Agent";
    summary = `Replied to ${parent} in "${action.postTitle}".`;
  } else {
    const title =
      action.targetTitle ?? action.targetPostTitle ?? `${action.targetType}`;
    summary = `Cast a ${action.vote} vote on ${action.targetType} "${title}".`;
  }

  if (action.memoryUpdate !== null) {
    summary = `${summary} Self-note: ${action.memoryUpdate}`;
  }

  return truncate(summary, MAX_MEMORY_EVENT_SUMMARY_LENGTH);
}

function buildRecentVoteTendencySummary(counts: VoteTendencyCounts) {
  const total = counts.up + counts.down;

  if (total === 0) {
    return "No recent votes.";
  }

  const direction =
    counts.up >= counts.down ? "leans upvoting" : "leans downvoting";
  const target =
    counts.postUp + counts.postDown >= counts.commentUp + counts.commentDown
      ? "posts"
      : "comments";

  return `${direction}; most recent votes focus on ${target} (${formatVoteTendencyCounts(counts)}).`;
}

function buildRecentFocus(
  posts: RecentAgentPostSummary[],
  comments: RecentAgentCommentSummary[],
) {
  const focus: string[] = [];

  for (const post of posts) {
    pushUniqueFocus(focus, post.title);
  }

  for (const comment of comments) {
    pushUniqueFocus(focus, comment.postTitle);
  }

  return focus.slice(0, RECENT_FOCUS_LIMIT);
}

function pushUniqueFocus(focus: string[], value: string) {
  const trimmed = truncate(value.trim(), MAX_FOCUS_ITEM_LENGTH);

  if (trimmed.length === 0 || focus.includes(trimmed)) {
    return;
  }

  focus.push(trimmed);
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

function parseIntervalHours(
  rawValue: string | undefined,
  defaultValue: number,
  minValue: number,
  maxValue: number,
) {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.min(maxValue, Math.max(minValue, Math.floor(parsed)));
}

function summarizeScheduledTickResult(result: ScheduledTickResult) {
  if (result.kind === "skipped") {
    return `skipped:${result.reason}`;
  }

  if (result.kind === "noop") {
    return `noop:${result.reason}`;
  }

  if (result.kind === "failed") {
    return `failed:${result.error}`;
  }

  return result.kind;
}

function shouldConsumeAgentWakeInterval(result: ScheduledTickResult) {
  return result.kind !== "skipped" || result.reason !== "active_run_exists";
}
