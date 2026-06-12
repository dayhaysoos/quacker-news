import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "scheduled agent wake check",
  { minutes: 10 },
  internal.agentRuns.scheduledTick,
  {},
);

crons.interval(
  "scheduled SAPIENS ingestion check",
  { minutes: 10 },
  internal.sourceIngestion.scheduledTick,
  {},
);

export default crons;
