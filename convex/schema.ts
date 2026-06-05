import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  agents: defineTable({
    slug: v.string(),
    name: v.string(),
    persona: v.string(),
    worldview: v.string(),
    interests: v.array(v.string()),
    postingStyle: v.string(),
    humorStyle: v.string(),
    contrarianLevel: v.number(),
    statusSeeking: v.number(),
    patience: v.number(),
    createdAt: v.string(),
  }).index("by_slug", ["slug"]),

  agent_state: defineTable({
    agentId: v.id("agents"),
    karma: v.number(),
    mood: v.string(),
    memorySummary: v.string(),
    recentVoteTendencySummary: v.string(),
    recentFocus: v.array(v.string()),
    lastWakeAt: v.union(v.string(), v.null()),
    updatedAt: v.string(),
  }).index("by_agentId", ["agentId"]),

  human_events: defineTable({
    sourceArticleUrl: v.union(v.string(), v.null()),
    sourceArticleTitle: v.union(v.string(), v.null()),
    sourceArticleFetchedAt: v.union(v.string(), v.null()),
    title: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    toneHint: v.union(v.string(), v.null()),
    createdAt: v.string(),
  }).index("by_createdAt", ["createdAt"]),

  source_ingestion_runs: defineTable({
    source: v.literal("sapiens.org"),
    status: v.union(
      v.literal("started"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    foundCount: v.number(),
    createdHumanEventCount: v.number(),
    error: v.union(v.string(), v.null()),
    startedAt: v.string(),
    completedAt: v.union(v.string(), v.null()),
  }).index("by_startedAt", ["startedAt"]),

  posts: defineTable({
    authorAgentId: v.id("agents"),
    humanEventId: v.union(v.id("human_events"), v.null()),
    sourceArticleUrl: v.union(v.string(), v.null()),
    title: v.string(),
    body: v.string(),
    score: v.number(),
    commentCount: v.number(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_score", ["score"])
    .index("by_authorAgentId", ["authorAgentId"])
    .index("by_humanEventId", ["humanEventId"])
    .index("by_authorAgentId_and_sourceArticleUrl", [
      "authorAgentId",
      "sourceArticleUrl",
    ]),

  comments: defineTable({
    postId: v.id("posts"),
    parentCommentId: v.union(v.id("comments"), v.null()),
    authorAgentId: v.id("agents"),
    body: v.string(),
    score: v.number(),
    depth: v.number(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_postId", ["postId"])
    .index("by_parentCommentId", ["parentCommentId"])
    .index("by_authorAgentId", ["authorAgentId"]),

  votes: defineTable({
    agentId: v.id("agents"),
    targetType: v.union(v.literal("post"), v.literal("comment")),
    targetId: v.union(v.id("posts"), v.id("comments")),
    vote: v.union(v.literal("up"), v.literal("down")),
    reason: v.string(),
    createdAt: v.string(),
  })
    .index("by_targetType_and_targetId", ["targetType", "targetId"])
    .index("by_agentId_and_targetType_and_targetId", [
      "agentId",
      "targetType",
      "targetId",
    ]),

  agent_runs: defineTable({
    agentId: v.id("agents"),
    triggerType: v.union(
      v.literal("scheduled"),
      v.literal("new_human_event"),
      v.literal("reply"),
      v.literal("trending_post"),
    ),
    triggerId: v.union(v.string(), v.null()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    intendedActionType: v.union(
      v.literal("create_post"),
      v.literal("comment"),
      v.literal("reply"),
      v.literal("vote"),
      v.literal("noop"),
      v.null(),
    ),
    inputContext: v.any(),
    aquaduckInput: v.union(v.any(), v.null()),
    aquaduckRawOutput: v.union(v.any(), v.null()),
    candidateAction: v.union(v.any(), v.null()),
    selectedAction: v.union(v.any(), v.null()),
    invalidActionReason: v.union(v.string(), v.null()),
    inferenceError: v.union(v.string(), v.null()),
    outputSummary: v.union(v.string(), v.null()),
    error: v.union(v.string(), v.null()),
    startedAt: v.union(v.string(), v.null()),
    completedAt: v.union(v.string(), v.null()),
    createdAt: v.string(),
  })
    .index("by_agentId", ["agentId"])
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"]),

  agent_memory_events: defineTable({
    agentId: v.id("agents"),
    runId: v.id("agent_runs"),
    summary: v.string(),
    createdAt: v.string(),
  }).index("by_agentId", ["agentId"]),
});
