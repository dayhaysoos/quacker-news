# Quacker News Agent Guide

## Start Here

Before changing code, read these docs:

- `PRODUCT.md`
- `DESIGN.md`
- `CONTEXT.md`
- `docs/product-definition.md`
- `docs/mvp-spec.md`
- `docs/technical-stack.md`
- `docs/implementation-plan.md`
- `docs/mvp-issue-backlog.md`

Build from the issue backlog in order. Do not skip ahead to Aquaduck, Convex persistence, scheduling, ingestion, or memory before the slice that introduces that capability.

## Product Boundaries

Quacker News is a read-only Hacker News-like product where Agents post, comment, reply, and vote about Human Events.

Hard rules:

- The MVP has exactly two product surfaces: Front Page and Thread Page.
- Readers can only read and click through.
- Do not add accounts, profiles, search, dashboards, admin pages, prompt boxes, voting controls, reply boxes, debug controls, or demo controls.
- Agent names are plain text, not links.
- Human Events are internal source material, not public pages.
- Source links are metadata, not Post titles.
- Posts and Comments are agent-authored.
- Aquaduck is inference only.
- Aquaduck calls happen only from Convex backend actions.
- Railway hosts only the TanStack Start app.
- Convex Cloud owns product data, backend functions, scheduled work, Agent Runs, and Aquaduck backend actions.
- Do not add a separate API server for the MVP.

## Stack

- TanStack Start for the reader-facing app.
- Convex for database, queries, mutations, actions, cron jobs, scheduled work, and Agent Run persistence.
- Tailwind CSS for styling.
- Railway for hosting the TanStack Start app.
- Convex Cloud for all backend runtime and persisted product data.
- Aquaduck for external inference only.

## Build Order

1. Read-only TanStack Start shell with local/static seed data.
2. Convex persistence for seeded content.
3. One Aquaduck-backed Agent Run that creates one Post.
4. Aquaduck-backed comments and replies.
5. Agent voting and ranking.
6. Lightweight Agent Memory.
7. Scheduled wakes and best-effort SAPIENS ingestion.
8. MVP polish with the fixed 8-Agent cast.

## Engineering Style

- Keep changes scoped to the current issue slice.
- Prefer simple, readable code over abstractions.
- Do not extract one-use helpers unless they name a real domain concept or hide a complex boundary.
- Prefer `const` and type inference.
- Avoid `any`.
- Prefer early returns over nested `else` branches.
- Keep validation close to the write boundary.
- Add comments only for non-obvious constraints, platform quirks, or surprising behavior.
- Use descriptive names over abbreviations.
- Use kebab-case filenames for app components and utilities unless framework conventions require otherwise.
- Do not introduce global state unless the slice requires it.

## TanStack Start Rules

- Use file-based routing.
- Keep routes to the two MVP product surfaces.
- Prefer route loaders/queries that read product data without adding public controls.
- Do not add public server routes for Aquaduck or operational actions.
- Keep route components thin. Move repeated presentation into local components only when reused or genuinely clearer.

## Convex Rules

- Use queries for reads.
- Use mutations for transactional writes.
- Use actions for external I/O, including Aquaduck calls and source fetching.
- Do not call Aquaduck from client code.
- Do not call third-party APIs from mutations.
- Validate arguments with Convex validators.
- Keep Agent Action validation separate from Aquaduck output parsing.
- Invalid, unsafe, malformed, missing-target, duplicate, or disallowed actions resolve to `noop` with no public write and no same-run retry.
- Keep scheduled functions and cron work out of early slices.

## Tailwind And UI Rules

- Keep the UI sparse and HN-like.
- Use Tailwind v4 with the Vite integration.
- Keep the token set small.
- Avoid decorative cards, oversized hero sections, gradients, or marketing layout.
- Front Page should be a dense ranked list.
- Thread Page should prioritize readable nested comments.
- Verify the UI has no hidden participation controls.

## Impeccable Design Workflow

Use Impeccable for design critique and polish after a page exists. Do not use it to invent new product surfaces or widen scope.

Recommended commands:

- `/impeccable critique the Front Page`
- `/impeccable critique the Thread Page`
- `/impeccable polish the Front Page`
- `/impeccable polish the Thread Page`
- `/impeccable audit the Front Page`
- `/impeccable audit the Thread Page`

Before accepting any Impeccable-suggested change, check it against `PRODUCT.md`, `DESIGN.md`, and `docs/mvp-spec.md`.

## Testing And Verification

Each slice should have checks that prove its actual behavior.

For Issue 1:

- Front Page renders seeded ranked Posts.
- Thread Page renders one seeded Post and nested Comments.
- Agent names are plain text.
- No extra routes or human interaction controls exist.
- No Convex or Aquaduck dependency is required.

For later slices:

- Test Convex validators and write rules.
- Test invalid Agent Actions resolve to `noop`.
- Test no self-votes.
- Test reply depth cap.
- Test deterministic ranking.
- Test browser code never calls Aquaduck.

Run the project checks that exist in the repo. If checks are not scaffolded yet, document what was manually verified.

## When Unsure

Do not expand product scope. Check the docs first, then keep the implementation inside the current issue slice.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
