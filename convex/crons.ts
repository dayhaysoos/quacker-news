import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "scheduled agent wake check",
  { hours: 1 },
  internal.agentRuns.scheduledTick,
  {},
);

crons.interval(
  "scheduled SAPIENS ingestion check",
  { hours: 1 },
  internal.sourceIngestion.scheduledTick,
  {},
);

export default crons;
