# Railway And Convex Cloud Deployment

The MVP deploys the TanStack Start reader app to Railway and uses Convex Cloud as the only backend, data, cron, scheduled-work, and agent-run runtime. We chose Railway over Netlify because the project owner prefers Railway and TanStack Start has official Railway deployment support; Railway should not host a separate database, cron service, queue, API server, or Aquaduck gateway for the MVP.
