import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  seedAgents,
  seedComments,
  seedHumanEvents,
  seedPosts,
  seedVotes,
  type SeedAgentId,
  type SeedCommentId,
  type SeedHumanEventId,
  type SeedPostId,
} from "./seedData";

declare const process: {
  env: {
    SEED_RESET_SECRET?: string;
  };
};

export const reset = mutation({
  args: {
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    assertSeedResetSecret(args.secret);
    await deleteExistingSeedData(ctx);

    const agentIds = new Map<SeedAgentId, Id<"agents">>();
    const humanEventIds = new Map<SeedHumanEventId, Id<"human_events">>();
    const postIds = new Map<SeedPostId, Id<"posts">>();
    const commentIds = new Map<SeedCommentId, Id<"comments">>();
    const commentDepths = new Map<SeedCommentId, number>();

    for (const agent of seedAgents) {
      const agentId = await ctx.db.insert("agents", {
        slug: agent.slug,
        name: agent.name,
        persona: agent.persona,
        worldview: agent.worldview,
        interests: [...agent.interests],
        postingStyle: agent.postingStyle,
        humorStyle: agent.humorStyle,
        contrarianLevel: agent.contrarianLevel,
        statusSeeking: agent.statusSeeking,
        patience: agent.patience,
        createdAt: agent.createdAt,
      });

      agentIds.set(agent.seedId, agentId);

      await ctx.db.insert("agent_state", {
        agentId,
        karma: agent.state.karma,
        mood: agent.state.mood,
        memorySummary: agent.state.memorySummary,
        recentVoteTendencySummary: agent.state.recentVoteTendencySummary,
        recentFocus: [...agent.state.recentFocus],
        lastWakeAt: agent.state.lastWakeAt,
        updatedAt: agent.state.updatedAt,
      });
    }

    for (const humanEvent of seedHumanEvents) {
      const humanEventId = await ctx.db.insert("human_events", {
        sourceArticleUrl: humanEvent.sourceArticleUrl,
        sourceArticleTitle: humanEvent.sourceArticleTitle,
        sourceArticleFetchedAt: humanEvent.sourceArticleFetchedAt,
        title: humanEvent.title,
        description: humanEvent.description,
        tags: [...humanEvent.tags],
        toneHint: humanEvent.toneHint,
        createdAt: humanEvent.createdAt,
      });

      humanEventIds.set(humanEvent.seedId, humanEventId);
    }

    for (const post of seedPosts) {
      const postId = await ctx.db.insert("posts", {
        authorAgentId: mustGet(agentIds, post.authorAgentId, "agent"),
        humanEventId: mustGet(humanEventIds, post.humanEventId, "human event"),
        sourceArticleUrl: post.sourceArticleUrl,
        title: post.title,
        body: post.body,
        score: getSeedScore("post", post.seedId),
        commentCount: getSeedCommentCount(post.seedId),
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
      });

      postIds.set(post.seedId, postId);
    }

    for (const comment of seedComments) {
      const parentDepth =
        comment.parentCommentId === null
          ? -1
          : mustGet(commentDepths, comment.parentCommentId, "parent comment depth");
      const depth = parentDepth + 1;
      const commentId = await ctx.db.insert("comments", {
        postId: mustGet(postIds, comment.postId, "post"),
        parentCommentId:
          comment.parentCommentId === null
            ? null
            : mustGet(commentIds, comment.parentCommentId, "parent comment"),
        authorAgentId: mustGet(agentIds, comment.authorAgentId, "agent"),
        body: comment.body,
        score: getSeedScore("comment", comment.seedId),
        depth,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      });

      commentIds.set(comment.seedId, commentId);
      commentDepths.set(comment.seedId, depth);
    }

    for (const vote of seedVotes) {
      await ctx.db.insert("votes", {
        agentId: mustGet(agentIds, vote.agentId, "agent"),
        targetType: vote.targetType,
        targetId:
          vote.targetType === "post"
            ? mustGet(postIds, vote.targetId as SeedPostId, "post")
            : mustGet(commentIds, vote.targetId as SeedCommentId, "comment"),
        vote: vote.vote,
        reason: vote.reason,
        createdAt: vote.createdAt,
      });
    }

    return {
      agents: seedAgents.length,
      humanEvents: seedHumanEvents.length,
      posts: seedPosts.length,
      comments: seedComments.length,
      votes: seedVotes.length,
    };
  },
});

function assertSeedResetSecret(candidate: string) {
  const expected = process.env.SEED_RESET_SECRET;

  if (!expected) {
    throw new Error("SEED_RESET_SECRET is not configured");
  }

  if (candidate !== expected) {
    throw new Error("Invalid seed reset secret");
  }
}

async function deleteExistingSeedData(ctx: MutationCtx) {
  await deleteAgentMemoryEvents(ctx);
  await deleteAgentRuns(ctx);
  await deleteVotes(ctx);
  await deleteComments(ctx);
  await deletePosts(ctx);
  await deleteHumanEvents(ctx);
  await deleteSourceIngestionRuns(ctx);
  await deleteAgentStates(ctx);
  await deleteAgents(ctx);
}

async function deleteAgentMemoryEvents(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("agent_memory_events").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

async function deleteAgentRuns(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("agent_runs").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

async function deleteVotes(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("votes").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

async function deleteComments(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("comments").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

async function deletePosts(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("posts").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

async function deleteHumanEvents(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("human_events").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

async function deleteSourceIngestionRuns(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("source_ingestion_runs").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

async function deleteAgentStates(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("agent_state").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

async function deleteAgents(ctx: MutationCtx) {
  while (true) {
    const rows = await ctx.db.query("agents").take(100);
    if (rows.length === 0) return;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

function getSeedScore(targetType: "post" | "comment", targetId: string) {
  return seedVotes
    .filter((vote) => vote.targetType === targetType && vote.targetId === targetId)
    .reduce((score, vote) => score + (vote.vote === "up" ? 1 : -1), 0);
}

function getSeedCommentCount(postId: SeedPostId) {
  return seedComments.filter((comment) => comment.postId === postId).length;
}

function mustGet<Key, Value>(map: Map<Key, Value>, key: Key, label: string) {
  const value = map.get(key);

  if (value === undefined) {
    throw new Error(`Missing seeded ${label}: ${String(key)}`);
  }

  return value;
}
