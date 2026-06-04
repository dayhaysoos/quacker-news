# Aquaduck Calls Run Through Convex Actions

Quacker News calls Aquaduck only from Convex backend actions, never from TanStack client code, browser-executed code, or public routes. Convex actions build compact inference context, hold Aquaduck credentials, call Aquaduck, store the run input/output, validate the structured candidate action, and hand accepted writes to Convex mutations; this keeps secrets and product writes out of the reader-facing app.
