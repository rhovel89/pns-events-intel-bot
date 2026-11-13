# Optional Wasteland King Discord delivery

This worker extends the **existing PNS Events Intel bot process**. It does not create another Discord bot, Railway service, Supabase project, Edge Function, or scheduled workflow.

## Before enabling

1. Review and merge the WK database proposal only after the State site owner approves it and a non-production acceptance run is complete.
2. Review and merge the bot integration PR.
3. Confirm that the existing bot service's current plan and remaining allowance can absorb the small additional polling load. Do not upgrade or add paid resources.
4. Confirm the bot has permission to view and send messages in the chosen State WK channel.

## Optional environment variables

Configure these only in the existing bot service's secret/environment settings after the database RPCs exist:

| Variable | Value |
| --- | --- |
| `WK_SUPABASE_URL` | The existing SleepySwallows Supabase project URL |
| `WK_SUPABASE_SERVICE_ROLE_KEY` | The project's service-role secret; never put it in browser code, Git, or chat |
| `WK_DISCORD_CHANNEL_ID` | The single State WK announcement channel ID |

The worker reuses the existing `DISCORD_TOKEN`. It is completely inert unless all three `WK_*` variables are present.

## Runtime behavior

- Checks the private outbox immediately after bot startup, then every five minutes.
- Queues the 30-minute and 5-minute shift reminders before claiming work.
- Claims up to ten rows using the server-side row-locking claim RPC.
- Sends only to the configured channel and suppresses all Discord mentions.
- Records successful message IDs and failed deliveries for bounded retry/backoff.
- Uses a single-process in-flight guard so scheduled ticks cannot overlap.

Delivery is at-least-once. A process crash after Discord accepts a message but before the database records success can result in a duplicate. Stale claims are recovered by the database lease logic.

## Safe enable/disable

- Leave all three variables unset to keep WK delivery disabled.
- To disable later, remove the three optional `WK_*` variables and restart the existing bot service.
- Never paste the service-role key or Discord bot token into ChatGPT, issue comments, screenshots, or repository files.

No environment variables have been configured and no live bot deployment has been performed by this PR.
