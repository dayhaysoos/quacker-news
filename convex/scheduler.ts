import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const STALE_RUNNING_LOCK_MS = 2 * 60 * 60 * 1_000;

export const claimDueWork = internalMutation({
  args: {
    key: v.union(
      v.literal("agent_wake"),
      v.literal("sapiens_ingestion"),
    ),
    intervalHours: v.number(),
    now: v.string(),
  },
  handler: async (ctx, args): Promise<ClaimDueWorkResult> => {
    const state = await ctx.db
      .query("scheduler_state")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const nowMs = Date.parse(args.now);
    let staleRunningLock = false;

    if (state !== null && state.status === "running") {
      const startedMs =
        state.lastStartedAt === null ? 0 : Date.parse(state.lastStartedAt);
      const staleLock =
        Number.isNaN(startedMs) || nowMs - startedMs > STALE_RUNNING_LOCK_MS;

      if (!staleLock) {
        return { kind: "skipped", reason: "scheduler_lock_active" };
      }

      staleRunningLock = true;
    }

    if (state !== null && state.lastStartedAt !== null) {
      const lastStartedMs = Date.parse(state.lastStartedAt);
      const intervalMs = args.intervalHours * 60 * 60 * 1_000;

      if (!Number.isNaN(lastStartedMs) && nowMs - lastStartedMs < intervalMs) {
        await ctx.db.patch(state._id, {
          status: staleRunningLock ? "idle" : state.status,
          lastSkippedAt: args.now,
          intervalHours: args.intervalHours,
          updatedAt: args.now,
        });

        return {
          kind: "skipped",
          reason: "scheduler_interval_not_elapsed",
        };
      }
    }

    if (state === null) {
      await ctx.db.insert("scheduler_state", {
        key: args.key,
        status: "running",
        lastStartedAt: args.now,
        lastCompletedAt: null,
        lastSkippedAt: null,
        lastResult: null,
        intervalHours: args.intervalHours,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.patch(state._id, {
        status: "running",
        lastStartedAt: args.now,
        intervalHours: args.intervalHours,
        updatedAt: args.now,
      });
    }

    return {
      kind: "claimed",
      previousLastStartedAt: state?.lastStartedAt ?? null,
    };
  },
});

export const completeWork = internalMutation({
  args: {
    key: v.union(
      v.literal("agent_wake"),
      v.literal("sapiens_ingestion"),
    ),
    intervalHours: v.number(),
    result: v.string(),
    completedAt: v.string(),
    consumeInterval: v.boolean(),
    previousLastStartedAt: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("scheduler_state")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();

    if (state === null) {
      await ctx.db.insert("scheduler_state", {
        key: args.key,
        status: "idle",
        lastStartedAt: args.consumeInterval
          ? args.completedAt
          : args.previousLastStartedAt,
        lastCompletedAt: args.completedAt,
        lastSkippedAt: null,
        lastResult: args.result,
        intervalHours: args.intervalHours,
        updatedAt: args.completedAt,
      });

      return null;
    }

    await ctx.db.patch(state._id, {
      status: "idle",
      lastStartedAt: args.consumeInterval
        ? state.lastStartedAt
        : args.previousLastStartedAt,
      lastCompletedAt: args.completedAt,
      lastResult: args.result,
      intervalHours: args.intervalHours,
      updatedAt: args.completedAt,
    });

    return null;
  },
});

type ClaimDueWorkResult =
  | { kind: "claimed"; previousLastStartedAt: string | null }
  | { kind: "skipped"; reason: string };
