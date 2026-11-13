"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWkOutboxDispatcher } = require("../src/wk-outbox-dispatcher");

function setup({ claimed = [], sendError = null, configured = true } = {}) {
  const calls = [];
  const sent = [];
  const env = configured
    ? { WK_SUPABASE_URL: "https://example.supabase.co", WK_SUPABASE_SERVICE_ROLE_KEY: "test-secret", WK_DISCORD_CHANNEL_ID: "123" }
    : {};
  const channel = {
    isTextBased: () => true,
    send: async payload => {
      sent.push(payload);
      if (sendError) throw sendError;
      return { id: "discord-message-1" };
    }
  };
  const client = { channels: { fetch: async id => { assert.equal(id, "123"); return channel; } } };
  const fetchImpl = async (url, options) => {
    const name = url.split("/").pop();
    const body = JSON.parse(options.body || "{}");
    calls.push({ name, body, authorization: options.headers.authorization });
    let result = null;
    if (name === "pns_wk_claim_discord_notifications_v1") result = claimed;
    return { ok: true, json: async () => result };
  };
  return { dispatcher: createWkOutboxDispatcher({ client, env, fetchImpl, logger: { error() {} } }), calls, sent };
}

test("disabled unless all free-existing-infrastructure secrets are explicitly configured", async () => {
  const { dispatcher, calls } = setup({ configured: false });
  assert.deepEqual(await dispatcher.dispatch(), { disabled: true, claimed: 0, delivered: 0, failed: 0 });
  assert.equal(calls.length, 0);
});

test("queues reminders, claims work, posts to the configured channel and suppresses mentions", async () => {
  const { dispatcher, calls, sent } = setup({ claimed: [{ id: "n1", payload: { content: "@everyone WK plan" }, attempt_count: 1 }] });
  assert.deepEqual(await dispatcher.dispatch(), { claimed: 1, delivered: 1, failed: 0 });
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(calls[0].name, "pns_wk_queue_shift_reminders_v1");
  assert.equal(calls[1].name, "pns_wk_claim_discord_notifications_v1");
  assert.equal(calls[2].name, "pns_wk_finish_discord_notification_v1");
  assert.equal(calls[2].body.p_success, true);
  assert.equal(calls[2].body.p_discord_message_id, "discord-message-1");
  assert.ok(calls.every(x => x.authorization === "Bearer test-secret"));
});

test("records Discord send failures for bounded retry handling", async () => {
  const { dispatcher, calls } = setup({ claimed: [{ id: "n2", payload: { content: "WK update" } }], sendError: new Error("Discord unavailable") });
  assert.deepEqual(await dispatcher.dispatch(), { claimed: 1, delivered: 0, failed: 1 });
  const finish = calls.at(-1);
  assert.equal(finish.name, "pns_wk_finish_discord_notification_v1");
  assert.equal(finish.body.p_success, false);
  assert.match(finish.body.p_error, /Discord unavailable/);
});
