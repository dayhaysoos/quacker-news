import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { FrontPagePost, ThreadData } from "./read-model";

const convexUrl = import.meta.env.VITE_CONVEX_URL;

if (!convexUrl) {
  throw new Error("Missing VITE_CONVEX_URL");
}

const convex = new ConvexHttpClient(convexUrl);

export async function getFrontPagePosts(): Promise<FrontPagePost[]> {
  return await convex.query(api.posts.frontPage, {});
}

export async function getThread(postId: string): Promise<ThreadData | null> {
  return await convex.query(api.posts.thread, { postId });
}
