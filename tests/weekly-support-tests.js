"use strict";
// Standalone acceptance tests; do not require Discord credentials or DB access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const src = path.join(root, "src");
// Stub the existing support-message module so no discord.js client is needed.
const supportPath = require.resolve(path.join(src, "support.js"));
require.cache[supportPath] = { id: supportPath, filename: supportPath, loaded: true,
  exports: { supportMessage: () => ({
    embeds: [{ title: "Help Keep SleepySwallow Alive!", description: "Every feature remains free. Donations are optional." }],
    components: [{ components: [{ url: "https://ko-fi.com/sleepyswallow" }] }],
    allowedMentions: { parse: [] }
  }) } };
const weekly = require(path.join(src, "weekly-support.js"));

class FakePool {
  constructor() { this.rows = new Map(); this.calls = []; }
  async query(sql, values = []) {
    this.calls.push([sql, values]);
    if (sql.includes("SELECT enabled, channel_id")) {
      const r = this.rows.get(values[0]); return { rows: r ? [{ ...r }] : [] };
    }
    if (sql.includes("INSERT INTO guild_support_reminders")) {
      const [guild, second, third] = values;
      if (sql.includes("VALUES ($1, TRUE")) {
        const old = this.rows.get(guild) || {};
        this.rows.set(guild, { ...old, enabled: true, channel_id: second, next_due_ts: third });
      } else {
        const old = this.rows.get(guild) || {};
        this.rows.set(guild, { ...old, enabled: false, next_due_ts: null });
      }
      return { rowCount: 1 };
    }
    if (sql.includes("WITH eligible AS")) {
      const [now, next] = values;
      const ready = [...this.rows.entries()].filter(([,v]) => v.enabled && v.channel_id && v.next_due_ts <= now).slice(0,20);
      for (const [id,v] of ready) this.rows.set(id,{...v,next_due_ts:next,last_attempt_ts:now});
      return { rows: ready.map(([id,v]) => ({ guild_id: id, channel_id: v.channel_id })) };
    }
    if (sql.includes("SET last_sent_ts")) {
      const [id, sent, message, expected] = values;
      const old = this.rows.get(id);
      if (old.last_attempt_ts === expected) this.rows.set(id,{...old,last_sent_ts:sent,last_message_id:message});
      return { rowCount: 1 };
    }
    throw Error("Unexpected SQL: " + sql.slice(0,120));
  }
}

async function main() {
  let passed = 0;
  const check = async (name, test) => { await test(); passed++; console.log(`PASS: ${name}`); };
  const dbText = fs.readFileSync(path.join(src, "db.js"), "utf8");
  const commandsText = fs.readFileSync(path.join(src, "register-commands.js"), "utf8");
  const indexText = fs.readFileSync(path.join(src, "index.js"), "utf8");
  const moduleText = fs.readFileSync(path.join(src, "weekly-support.js"), "utf8");

  await check("Settings default OFF and no automatic channel selection", async () => {
    const pool = new FakePool();
    assert.equal((await weekly.settings(pool,"alpha")).enabled, false);
    assert.match(dbText, /enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  });
  await check("Enable requires chosen channel and schedules first post seven days later", async () => {
    const p = new FakePool(); const start = 1_800_000_000_000;
    await assert.rejects(() => weekly.enable(p,"alpha",null,start));
    assert.equal(await weekly.enable(p,"alpha","chan-a",start), start+weekly.WEEK_MS);
    assert.equal((await weekly.settings(p,"alpha")).channel_id,"chan-a");
  });
  await check("No announcement before seven-day due date", async () => {
    const p = new FakePool(); const sent = []; const t = 1_800_000_000_000;
    await weekly.enable(p,"alpha","chan-a",t);
    const r = await weekly.weeklySupportTick(p,async()=>({guildId:"alpha",send:m=>sent.push(m)}),console,t+weekly.WEEK_MS-1);
    assert.equal(r.claimed,0); assert.equal(sent.length,0);
  });
  await check("At most one announcement per seven days across repeated scheduler ticks", async () => {
    const p = new FakePool(); const msgs = []; const t=1_800_000_000_000;
    await weekly.enable(p,"alpha","chan-a",t);
    const channel={guildId:"alpha",isDMBased:()=>false,send:async m=>{msgs.push(m);return {id:"m1"};}};
    const fetch=async()=>channel;
    await weekly.weeklySupportTick(p,fetch,console,t+weekly.WEEK_MS);
    await weekly.weeklySupportTick(p,fetch,console,t+weekly.WEEK_MS+50);
    assert.equal(msgs.length,1);
    assert.equal(p.rows.get("alpha").last_message_id,"m1");
    await weekly.weeklySupportTick(p,fetch,console,t+2*weekly.WEEK_MS);
    assert.equal(msgs.length,2);
  });
  await check("Disabled guild sends nothing; re-enable starts new seven-day window", async () => {
    const p = new FakePool(); const sent=[]; const t=1_800_000_000_000;
    await weekly.enable(p,"alpha","chan-a",t);
    await weekly.disable(p,"alpha",t+1000);
    await weekly.weeklySupportTick(p,async()=>({guildId:"alpha",send:x=>sent.push(x)}),console,t+weekly.WEEK_MS);
    assert.equal(sent.length,0);
    await weekly.enable(p,"alpha","chan-a",t+weekly.WEEK_MS);
    assert.equal(p.rows.get("alpha").next_due_ts,t+2*weekly.WEEK_MS);
  });
  await check("Guild-isolated sending and rejects wrong-guild or DM channels", async () => {
    const p = new FakePool(); const sent=[];const t=1_800_000_000_000;
    await weekly.enable(p,"alpha","chan-a",t);
    await weekly.enable(p,"beta","chan-b",t);
    await weekly.weeklySupportTick(p,async(id)=>id==="alpha"?{guildId:"beta",send:async()=>sent.push("bad")}:{guildId:id,isDMBased:()=>true,send:async()=>sent.push("DM")},{warn:()=>{},error:()=>{}},t+weekly.WEEK_MS);
    assert.equal(sent.length,0);
  });
  await check("No retries on send failure, preventing duplicate donation posts", async () => {
    const p = new FakePool();const t=1_800_000_000_000;let attempts=0;
    await weekly.enable(p,"alpha","chan-a",t);
    const fetch=async()=>({guildId:"alpha",send:async()=>{attempts++;throw Error("discord unavailable")}});
    const log={error:()=>{}};
    await weekly.weeklySupportTick(p,fetch,log,t+weekly.WEEK_MS);
    await weekly.weeklySupportTick(p,fetch,log,t+weekly.WEEK_MS+30_000);
    assert.equal(attempts,1);
  });
  await check("Announcements have no mentions and only link to the approved Ko-fi page", async () => {
    const msg=weekly.announcementMessage();
    assert.deepEqual(msg.allowedMentions,{parse:[],users:[],roles:[]});
    assert.equal(msg.components[0].components[0].url,"https://ko-fi.com/sleepyswallow");
    assert.match(msg.embeds[0].description,/free/i);
  });
  await check("Atomic PostgreSQL claim uses row locking and due-date reservation", async () => {
    assert.match(moduleText,/FOR UPDATE SKIP LOCKED/);
    assert.match(moduleText,/SET next_due_ts=\$2, last_attempt_ts=\$1/);
    assert.doesNotMatch(moduleText,/\.send\(.*@everyone/);
  });
  await check("Admin-only command controls and explicit permissions guard", async () => {
    assert.match(commandsText,/setName\("support-reminders"\)/);
    assert.match(indexText,/if \(sub === "support-reminders"\) \{\s*if \(requireManageGuild\(interaction\)\) return/);
    assert.match(indexText,/PermissionsBitField.Flags.SendMessages/);
    assert.match(indexText,/PermissionsBitField.Flags.EmbedLinks/);
    assert.match(indexText,/if \(!channel\) return interaction.reply/);
  });
  await check("No personal DMs or external payments; existing commands remain", async () => {
    assert.match(indexText,/if \(sub === "support"\)/);
    assert.match(indexText,/if \(sub === "calendar"\)/);
    assert.match(indexText,/recurringTick/);
    assert.doesNotMatch(moduleText,/user\.send|members\.fetch|stripe|paymentIntent/i);
  });
  console.log(`RESULT: ${passed}/11 weekly-support tests passed.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
