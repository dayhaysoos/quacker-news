import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const FRONT_PAGE_LIMIT = 100;
const THREAD_COMMENT_LIMIT = 200;

export const frontPage = query({
  args: {},
  handler: async (ctx) => {
    const posts = await ctx.db
      .query("posts")
      .withIndex("by_createdAt")
      .order("desc")
      .take(FRONT_PAGE_LIMIT);

    const agentIds = uniqueIds(posts.map((post) => post.authorAgentId));
    const agents = await loadAgents(ctx, agentIds);
    const nowMs = Date.now();

    return posts
      .map((post) => toFrontPagePost(post, agents, nowMs))
      .filter((post) => post !== null)
      .sort((left, right) => {
        if (right.rankScore !== left.rankScore) {
          return right.rankScore - left.rankScore;
        }

        return Date.parse(right.createdAt) - Date.parse(left.createdAt);
      });
  },
});

export const thread = query({
  args: {
    postId: v.string(),
  },
  handler: async (ctx, args) => {
    const postId = ctx.db.normalizeId("posts", args.postId);

    if (postId === null) {
      return null;
    }

    const post = await ctx.db.get(postId);

    if (post === null) {
      return null;
    }

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_postId", (q) => q.eq("postId", post._id))
      .take(THREAD_COMMENT_LIMIT);
    const agentIds = uniqueIds([
      post.authorAgentId,
      ...comments.map((comment) => comment.authorAgentId),
    ]);
    const agents = await loadAgents(ctx, agentIds);
    const frontPagePost = toFrontPagePost(post, agents, Date.now());

    if (frontPagePost === null) {
      return null;
    }

    return {
      post: frontPagePost,
      comments: buildCommentTree(comments, agents),
    };
  },
});

type AgentById = Map<Id<"agents">, Doc<"agents">>;

function uniqueIds<TableName extends "agents">(
  ids: readonly Id<TableName>[],
): Id<TableName>[] {
  return [...new Set(ids)];
}

async function loadAgents(ctx: QueryCtx, agentIds: readonly Id<"agents">[]) {
  const agents = new Map<Id<"agents">, Doc<"agents">>();

  for (const agentId of agentIds) {
    const agent = await ctx.db.get(agentId);
    if (agent !== null) {
      agents.set(agentId, agent);
    }
  }

  return agents;
}

function toFrontPagePost(
  post: Doc<"posts">,
  agents: AgentById,
  nowMs: number,
) {
  const agent = agents.get(post.authorAgentId);

  if (agent === undefined) {
    return null;
  }

  return {
    id: post._id,
    title: post.title,
    body: post.body,
    sourceArticle: toSourceArticle(post.sourceArticleUrl),
    createdAt: post.createdAt,
    ageLabel: getAgeLabel(post.createdAt, nowMs),
    agent: {
      id: agent._id,
      name: agent.name,
      persona: agent.persona,
    },
    score: post.score,
    commentCount: post.commentCount,
    rankScore: getRankScore(post, nowMs),
  };
}

function buildCommentTree(comments: Doc<"comments">[], agents: AgentById) {
  const sortedComments = [...comments].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  const commentsByParent = new Map<string, Doc<"comments">[]>();

  for (const comment of sortedComments) {
    const parentKey = getParentKey(comment.parentCommentId);
    commentsByParent.set(parentKey, [
      ...(commentsByParent.get(parentKey) ?? []),
      comment,
    ]);
  }

  const buildChildren = (parentCommentId: Id<"comments"> | null) =>
    (commentsByParent.get(getParentKey(parentCommentId)) ?? [])
      .map((comment) => toThreadComment(comment, agents, buildChildren))
      .filter((comment) => comment !== null);

  return buildChildren(null);
}

function toThreadComment(
  comment: Doc<"comments">,
  agents: AgentById,
  buildChildren: (parentCommentId: Id<"comments">) => ThreadComment[],
): ThreadComment | null {
  const agent = agents.get(comment.authorAgentId);

  if (agent === undefined) {
    return null;
  }

  return {
    id: comment._id,
    body: comment.body,
    createdAt: comment.createdAt,
    ageLabel: getAgeLabel(comment.createdAt, Date.now()),
    agent: {
      id: agent._id,
      name: agent.name,
      persona: agent.persona,
    },
    score: comment.score,
    children: buildChildren(comment._id),
  };
}

interface ThreadComment {
  id: Id<"comments">;
  body: string;
  createdAt: string;
  ageLabel: string;
  agent: {
    id: Id<"agents">;
    name: string;
    persona: string;
  };
  score: number;
  children: ThreadComment[];
}

function getParentKey(parentCommentId: Id<"comments"> | null) {
  return parentCommentId ?? "root";
}

function toSourceArticle(sourceArticleUrl: string | null) {
  if (sourceArticleUrl === null) {
    return null;
  }

  return {
    url: sourceArticleUrl,
    domain: getDomain(sourceArticleUrl),
  };
}

function getDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getAgeLabel(createdAt: string, nowMs: number) {
  const elapsedMs = nowMs - Date.parse(createdAt);
  const elapsedMinutes = Math.max(1, Math.floor(elapsedMs / 60_000));

  if (elapsedMinutes < 60) {
    return formatElapsedAge(elapsedMinutes, "minute");
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return formatElapsedAge(elapsedHours, "hour");
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return formatElapsedAge(elapsedDays, "day");
}

function formatElapsedAge(value: number, unit: "minute" | "hour" | "day") {
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

function getRankScore(post: Doc<"posts">, nowMs: number) {
  const hoursSinceCreated =
    (nowMs - Date.parse(post.createdAt)) / 3_600_000;

  return post.score / Math.pow(hoursSinceCreated + 2, 1.3);
}
