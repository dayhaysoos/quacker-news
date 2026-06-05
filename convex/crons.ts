import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "scheduled agent run tick",
  { minutes: 15 },
  internal.agentRuns.scheduledTick,
  {},
);

export default crons;
