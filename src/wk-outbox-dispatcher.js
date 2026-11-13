"use strict";

/**
 * Optional SleepySwallows WK notification worker.
 * Reuses the already-running PNS Discord client; no second bot process or host.
 * Configure WK_SUPABASE_URL, WK_SUPABASE_SERVICE_ROLE_KEY and
 * WK_DISCORD_CHANNEL_ID only after the WK migration is approved.
 */
function createWkOutboxDispatcher({ client, env = process.env, fetchImpl = global.fetch, logger = console }) {
  let running = false;

  async function rpc(name, body = {}) {
    const response = await fetchImpl(`${env.WK_SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: env.WK_SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.WK_SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${name} failed (${response.status})`);
    return result;
  }

  async function dispatch() {
    const { WK_SUPABASE_URL: url, WK_SUPABASE_SERVICE_ROLE_KEY: key, WK_DISCORD_CHANNEL_ID: channelId } = env;
    if (!url || !key || !channelId) return { disabled: true, claimed: 0, delivered: 0, failed: 0 };
    if (running) return { skipped: true, claimed: 0, delivered: 0, failed: 0 };

    running = true;
    let claimed = [];
    let delivered = 0;
    let failed = 0;
    try {
      await rpc("pns_wk_queue_shift_reminders_v1");
      claimed = await rpc("pns_wk_claim_discord_notifications_v1", { p_limit: 10 });
      if (!Array.isArray(claimed) || claimed.length === 0) {
        return { claimed: 0, delivered: 0, failed: 0 };
      }

      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) throw new Error("Configured WK channel is unavailable or not text-based");

      for (const item of claimed) {
        try {
          const content = String(item.payload?.content ?? "SleepySwallows WK update").slice(0, 1900);
          const message = await channel.send({ content, allowedMentions: { parse: [] } });
          await rpc("pns_wk_finish_discord_notification_v1", {
            p_notification_id: item.id,
            p_success: true,
            p_error: "",
            p_discord_message_id: String(message.id ?? "")
          });
          delivered++;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Delivery failed";
          try {
            await rpc("pns_wk_finish_discord_notification_v1", {
              p_notification_id: item.id,
              p_success: false,
              p_error: reason.slice(0, 500),
              p_discord_message_id: ""
            });
          } catch (finishError) {
            logger.error("WK notification failure could not be recorded:", finishError);
          }
          failed++;
        }
      }
      return { claimed: claimed.length, delivered, failed };
    } finally {
      running = false;
    }
  }

  return { dispatch };
}

module.exports = { createWkOutboxDispatcher };
