'use strict';
// Integration tests only against a NEW, disposable local QA database.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { initDb } = require('../src/db');
const w = require('../src/weekly-support');
const url = process.env.WEEKLY_QA_DATABASE_URL;
if (!url) { console.error('Set WEEKLY_QA_DATABASE_URL to your disposable localhost DB'); process.exit(2); }
const parsed = new URL(url);
if (!['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname) || parsed.pathname !== '/weekly_support_qa') {
  console.error('REFUSING: requires local host and database named weekly_support_qa'); process.exit(2);
}
const pool = new Pool({ connectionString: url, ssl: false, max: 5 });
const base = 1_800_000_000_000;
let checks = 0;
async function check(label, fn) { await fn(); checks++; console.log('PASS:',label); }
async function main() {
  await check('First initDb migration', async () => initDb(pool));
  await check('Second initDb is idempotent', async () => initDb(pool));
  await check('Table defaults to disabled, no channel', async () => {
    await pool.query("INSERT INTO guild_support_reminders(guild_id) VALUES('qa-default')");
    const r = await pool.query("SELECT enabled,channel_id,next_due_ts FROM guild_support_reminders WHERE guild_id='qa-default'");
    assert.equal(r.rows[0].enabled,false); assert.equal(r.rows[0].channel_id,null);
    assert.equal(r.rows[0].next_due_ts,null);
  });
  await check('Enable persists seven-day due date', async () => {
    const due=await w.enable(pool,'qa-alpha','qa-channel-a',base);
    assert.equal(due,base+w.WEEK_MS);
    const c=await w.settings(pool,'qa-alpha');
    assert.equal(c.channel_id,'qa-channel-a'); assert.equal(Number(c.next_due_ts),due);
  });
  let messages=[];
  const channels = async (guildId, channelId) => ({guildId,id:channelId, isDMBased:()=>false,
    send:async message=>{messages.push({guildId,channelId,message});return {id:`mock-${messages.length}`};}});
  await check('No early post', async () => {
    const r=await w.weeklySupportTick(pool,channels,console,base+w.WEEK_MS-1);
    assert.equal(r.claimed,0);assert.equal(messages.length,0);
  });
  await check('Concurrent claims send once (real PostgreSQL locks)', async () => {
    const now=base+w.WEEK_MS;
    const [a,b]=await Promise.all([w.weeklySupportTick(pool,channels,console,now),w.weeklySupportTick(pool,channels,console,now)]);
    assert.equal(a.sent+b.sent,1);assert.equal(messages.length,1);
    assert.equal(messages[0].guildId,'qa-alpha');
    assert.deepEqual(messages[0].message.allowedMentions,{parse:[],users:[],roles:[]});
    assert.equal(messages[0].message.components[0].components[0].data?.url || messages[0].message.components[0].components[0].url,'https://ko-fi.com/sleepyswallow');
  });
  await check('Repeated tick same week never reposts', async () => {
    await w.weeklySupportTick(pool,channels,console,base+w.WEEK_MS+3600000);
    assert.equal(messages.length,1);
  });
  await check('Different guild is isolated', async () => {
    await w.enable(pool,'qa-beta','qa-channel-b',base);
    const r=await w.weeklySupportTick(pool,channels,console,base+w.WEEK_MS+3600000);
    assert.equal(r.sent,1);assert.equal(messages[1].guildId,'qa-beta');
    assert.equal(messages[1].channelId,'qa-channel-b');
  });
  await check('Disabled server never sends', async () => {
    await w.disable(pool,'qa-beta',base+w.WEEK_MS);
    await w.weeklySupportTick(pool,channels,console,base+2*w.WEEK_MS);
    assert.equal(messages.filter(x=>x.guildId==='qa-beta').length,1);
  });
  await check('Failed Discord send advances due, no retry', async () => {
    await w.enable(pool,'qa-fail','qa-channel-fail',base);
    let attempts=0;
    const failing=async (guildId)=>({guildId,isDMBased:()=>false,send:async()=>{attempts++;throw Error('simulated failure');}});
    const logger={warn:()=>{},error:()=>{}};
    await w.weeklySupportTick(pool,failing,logger,base+w.WEEK_MS);
    await w.weeklySupportTick(pool,failing,logger,base+w.WEEK_MS+10);
    assert.equal(attempts,1);
    const s=await w.settings(pool,'qa-fail'); assert.equal(Number(s.next_due_ts),base+2*w.WEEK_MS);
  });
  console.log(`RESULT: ${checks}/${checks} real PostgreSQL integration checks passed.`);
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());
