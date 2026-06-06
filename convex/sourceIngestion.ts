import { XMLParser } from "fast-xml-parser";
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

const SAPIENS_FEED_URL = "https://www.sapiens.org/feed/";
const SAPIENS_SOURCE = "sapiens.org";
const SAPIENS_REQUEST_TIMEOUT_MS = 15_000;
const MAX_FEED_ITEMS_PER_RUN = 20;
const MAX_TITLE_LENGTH = 180;
const MAX_EXCERPT_LENGTH = 700;
const MAX_CATEGORY_COUNT = 8;
const MAX_CATEGORY_LENGTH = 60;
const DEFAULT_SAPIENS_INGESTION_INTERVAL_HOURS = 6;
const MIN_SAPIENS_INGESTION_INTERVAL_HOURS = 1;
const MAX_SAPIENS_INGESTION_INTERVAL_HOURS = 24;

declare const process: {
  env: {
    SAPIENS_INGESTION_ENABLED?: string;
    SAPIENS_INGESTION_INTERVAL_HOURS?: string;
    SAPIENS_FEED_URL?: string;
  };
};

export const scheduledTick = internalAction({
  args: {},
  handler: async (ctx): Promise<SapiensIngestionTickResult> => {
    if (process.env.SAPIENS_INGESTION_ENABLED !== "true") {
      return { kind: "disabled" };
    }

    const intervalHours = parseIntervalHours(
      process.env.SAPIENS_INGESTION_INTERVAL_HOURS,
      DEFAULT_SAPIENS_INGESTION_INTERVAL_HOURS,
      MIN_SAPIENS_INGESTION_INTERVAL_HOURS,
      MAX_SAPIENS_INGESTION_INTERVAL_HOURS,
    );
    const claim = await ctx.runMutation(internal.scheduler.claimDueWork, {
      key: "sapiens_ingestion",
      intervalHours,
      now: new Date().toISOString(),
    });

    if (claim.kind === "skipped") {
      return claim;
    }

    let result: SapiensIngestionTickResult = {
      kind: "failed",
      error: "scheduler_error",
    };

    try {
      result = await runSapiensIngestion(ctx);
      return result;
    } finally {
      await ctx.runMutation(internal.scheduler.completeWork, {
        key: "sapiens_ingestion",
        intervalHours,
        result: summarizeSapiensIngestionTickResult(result),
        completedAt: new Date().toISOString(),
        consumeInterval: true,
        previousLastStartedAt: claim.previousLastStartedAt,
      });
    }
  },
});

export const startRun = internalMutation({
  args: {
    startedAt: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("source_ingestion_runs", {
      source: SAPIENS_SOURCE,
      status: "started",
      foundCount: 0,
      createdHumanEventCount: 0,
      error: null,
      startedAt: args.startedAt,
      completedAt: null,
    });
  },
});

export const storeFetchedArticles = internalMutation({
  args: {
    runId: v.id("source_ingestion_runs"),
    articles: v.array(
      v.object({
        url: v.string(),
        title: v.string(),
        excerpt: v.string(),
        author: v.union(v.string(), v.null()),
        publishedAt: v.union(v.string(), v.null()),
        fetchedAt: v.string(),
        categories: v.array(v.string()),
        guid: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<StoreFetchedArticlesResult> => {
    let createdSourceArticleCount = 0;
    let createdHumanEventCount = 0;
    let skippedDuplicateCount = 0;

    for (const article of args.articles) {
      const existingSourceArticle = await ctx.db
        .query("source_articles")
        .withIndex("by_url", (q) => q.eq("url", article.url))
        .take(1);
      const sourceArticleId =
        existingSourceArticle[0]?._id ??
        (await ctx.db.insert("source_articles", {
          source: SAPIENS_SOURCE,
          url: article.url,
          title: article.title,
          excerpt: article.excerpt,
          author: article.author,
          publishedAt: article.publishedAt,
          fetchedAt: article.fetchedAt,
          categories: article.categories,
          guid: article.guid,
        }));

      if (existingSourceArticle.length > 0) {
        skippedDuplicateCount += 1;
      } else {
        createdSourceArticleCount += 1;
      }

      const existingHumanEvent = await ctx.db
        .query("human_events")
        .withIndex("by_sourceArticleUrl", (q) =>
          q.eq("sourceArticleUrl", article.url),
        )
        .take(1);

      if (existingHumanEvent.length > 0) {
        continue;
      }

      await ctx.db.insert("human_events", {
        sourceArticleId,
        sourceArticleUrl: article.url,
        sourceArticleTitle: article.title,
        sourceArticleFetchedAt: article.fetchedAt,
        title: article.title,
        description: article.excerpt,
        tags: article.categories,
        toneHint:
          "Discuss the broader human behavior, institution, ritual, incentive, or cultural pattern.",
        createdAt: article.fetchedAt,
      });
      createdHumanEventCount += 1;
    }

    return {
      foundCount: args.articles.length,
      createdSourceArticleCount,
      createdHumanEventCount,
      skippedDuplicateCount,
    };
  },
});

export const completeRun = internalMutation({
  args: {
    runId: v.id("source_ingestion_runs"),
    foundCount: v.number(),
    createdHumanEventCount: v.number(),
    completedAt: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "completed",
      foundCount: args.foundCount,
      createdHumanEventCount: args.createdHumanEventCount,
      error: null,
      completedAt: args.completedAt,
    });

    return null;
  },
});

export const failRun = internalMutation({
  args: {
    runId: v.id("source_ingestion_runs"),
    error: v.string(),
    completedAt: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: "failed",
      error: args.error,
      completedAt: args.completedAt,
    });

    return null;
  },
});

async function runSapiensIngestion(
  ctx: ActionCtx,
): Promise<SapiensIngestionTickResult> {
  const runId = await ctx.runMutation(internal.sourceIngestion.startRun, {
    startedAt: new Date().toISOString(),
  });

  try {
    const fetchedAt = new Date().toISOString();
    const feedText = await fetchSapiensFeed(
      process.env.SAPIENS_FEED_URL ?? SAPIENS_FEED_URL,
    );
    const articles = parseSapiensFeed(feedText, fetchedAt);
    const storeResult: StoreFetchedArticlesResult = await ctx.runMutation(
      internal.sourceIngestion.storeFetchedArticles,
      {
        runId,
        articles,
      },
    );

    await ctx.runMutation(internal.sourceIngestion.completeRun, {
      runId,
      foundCount: storeResult.foundCount,
      createdHumanEventCount: storeResult.createdHumanEventCount,
      completedAt: new Date().toISOString(),
    });

    return {
      kind: "completed",
      ...storeResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.sourceIngestion.failRun, {
      runId,
      error: message,
      completedAt: new Date().toISOString(),
    });

    return {
      kind: "failed",
      error: message,
    };
  }
}

async function fetchSapiensFeed(feedUrl: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    SAPIENS_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Quacker News MVP source ingestion",
      },
    });

    if (!response.ok) {
      throw new Error(`sapiens_http_${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseSapiensFeed(feedText: string, fetchedAt: string) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  });
  const parsed = parser.parse(feedText) as unknown;
  const channel = getNestedRecord(parsed, ["rss", "channel"]);
  const itemValue = channel?.item;
  const rawItems = Array.isArray(itemValue) ? itemValue : [itemValue];
  const articles: SapiensSourceArticleInput[] = [];

  for (const item of rawItems) {
    if (!isRecord(item)) {
      continue;
    }

    const article = parseSapiensFeedItem(item, fetchedAt);

    if (article !== null) {
      articles.push(article);
    }

    if (articles.length >= MAX_FEED_ITEMS_PER_RUN) {
      break;
    }
  }

  return articles;
}

function parseSapiensFeedItem(
  item: Record<string, unknown>,
  fetchedAt: string,
): SapiensSourceArticleInput | null {
  const rawUrl = getText(item.link);
  const url = normalizeSapiensUrl(rawUrl);
  const title = truncate(getText(item.title) ?? "", MAX_TITLE_LENGTH);

  if (url === null || title.length === 0) {
    return null;
  }

  const rawDescription = getText(item.description) ?? "";
  const excerpt = truncate(cleanExcerpt(rawDescription), MAX_EXCERPT_LENGTH);

  return {
    url,
    title,
    excerpt: excerpt.length > 0 ? excerpt : title,
    author: nullableNonEmptyText(item["dc:creator"]),
    publishedAt: parseOptionalDate(getText(item.pubDate)),
    fetchedAt,
    categories: normalizeCategories(item.category),
    guid: nullableNonEmptyText(item.guid),
  };
}

function normalizeSapiensUrl(rawUrl: string | null) {
  if (rawUrl === null) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^www\./, "");

    if (hostname !== "sapiens.org") {
      return null;
    }

    url.protocol = "https:";
    url.hostname = "www.sapiens.org";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function cleanExcerpt(rawHtml: string) {
  return decodeHtmlEntities(rawHtml)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/The post .* appeared first on SAPIENS\.?/i, "")
    .trim();
}

function normalizeCategories(value: unknown) {
  const rawCategories = Array.isArray(value) ? value : [value];
  const categories: string[] = [];

  for (const rawCategory of rawCategories) {
    const category = truncate(getText(rawCategory) ?? "", MAX_CATEGORY_LENGTH);

    if (category.length > 0 && !categories.includes(category)) {
      categories.push(category);
    }

    if (categories.length >= MAX_CATEGORY_COUNT) {
      break;
    }
  }

  return categories.length > 0 ? categories : ["SAPIENS"];
}

function parseOptionalDate(value: string | null) {
  if (value === null) {
    return null;
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function nullableNonEmptyText(value: unknown) {
  const text = getText(value);

  if (text === null || text.length === 0) {
    return null;
  }

  return text;
}

function getNestedRecord(value: unknown, path: string[]) {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }

    current = current[key];
  }

  return isRecord(current) ? current : null;
}

function getText(value: unknown): string | null {
  if (typeof value === "string") {
    return decodeHtmlEntities(value).trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (isRecord(value) && typeof value["#text"] === "string") {
    return decodeHtmlEntities(value["#text"]).trim();
  }

  return null;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
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

function summarizeSapiensIngestionTickResult(
  result: SapiensIngestionTickResult,
) {
  if (result.kind === "skipped") {
    return `skipped:${result.reason}`;
  }

  if (result.kind === "failed") {
    return `failed:${result.error}`;
  }

  if (result.kind === "completed") {
    return `completed:${result.createdHumanEventCount}`;
  }

  return result.kind;
}

function truncate(value: string, length: number) {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SapiensSourceArticleInput {
  url: string;
  title: string;
  excerpt: string;
  author: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  categories: string[];
  guid: string | null;
}

interface StoreFetchedArticlesResult {
  foundCount: number;
  createdSourceArticleCount: number;
  createdHumanEventCount: number;
  skippedDuplicateCount: number;
}

type SapiensIngestionTickResult =
  | { kind: "disabled" }
  | { kind: "skipped"; reason: string }
  | ({
      kind: "completed";
    } & StoreFetchedArticlesResult)
  | { kind: "failed"; error: string };
