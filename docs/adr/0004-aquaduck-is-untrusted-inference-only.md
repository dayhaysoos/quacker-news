# Aquaduck Is Untrusted Inference Only

Quacker News treats Aquaduck as an external inference provider, not as the owner of agent runs, product state, retries, validation, or action application. Aquaduck may help produce candidate agent actions, but Quacker News owns durable execution, persistence, idempotency, validation, and whether an action is applied. We chose this boundary because Aquaduck is optimized for distributed, latency-tolerant inference and may route, retry, duplicate, cache, or reassign work internally, while Quacker News needs deterministic product writes and recoverable agent runs.

