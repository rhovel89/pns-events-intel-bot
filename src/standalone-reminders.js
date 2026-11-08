"use strict";
const { randomUUID }=require("node:crypto");
const { EmbedBuilder }=require("discord.js");
const { clean }=require("./reminder-options");
const CLAIM_LEASE=120000;
const MAX_BATCH=5;
const ms=minutes=>minutes*60000;

async function create(pool,{guildId,channelId,message,runAt,offsets,createdBy},now=Date.now()) {
  if (!guildId || !channelId || !createdBy) throw new Error("Missing alliance, channel or creator.");
  if (typeof message!=="string" || !message.trim() || message.trim().length>1500)
    throw new Error("Reminder message must contain 1 to 1500 characters.");
  if (!Number.isSafeInteger(runAt) || runAt<now-1000 || runAt>now+365*24*60*60*1000)
    throw new Error("Reminder time must be now or within the next 365 days.");
  const chosen=clean(offsets);
  if (!chosen.length) throw new Error("Select at least one delivery time.");
  const db=await pool.connect();
  try {
    await db.query("BEGIN");
    const result=await db.query(`INSERT INTO standalone_reminders
      (guild_id,channel_id,message,run_at_ts,offsets,created_by,created_ts)
      VALUES ($1,$2,$3,$4,$5::int[],$6,$7) RETURNING id`,
      [guildId,channelId,message.trim(),runAt,chosen,createdBy,now]);
    const id=result.rows[0].id;
    let count=0;
    for(const offset of chosen){
      const due=runAt-ms(offset);
      if (due<now-1000) continue; // A warning in the past is not sent late.
      await db.query(`INSERT INTO standalone_reminder_deliveries (reminder_id,minutes_before,due_ts)
        VALUES ($1,$2,$3) ON CONFLICT (reminder_id,minutes_before) DO NOTHING`,[id,offset,Math.max(now,due)]);
      count++;
    }
    if(!count) throw new Error("All selected delivery times are in the past.");
    await db.query("COMMIT");
    return {id,count,offsets:chosen};
  } catch(e){await db.query("ROLLBACK").catch(()=>{});throw e} finally{db.release()}
}

async function edit(pool,guildId,id,patch,now=Date.now()) {
  if (!guildId || !Number.isSafeInteger(id) || id<1) throw new Error("Invalid reminder ID.");
  if (patch.message===undefined && patch.runAt===undefined && patch.offsets===undefined)
    throw new Error("Select a message, time or reminder interval to edit.");
  const db=await pool.connect();
  try {
    await db.query("BEGIN");
    const found=await db.query(`SELECT * FROM standalone_reminders WHERE guild_id=$1 AND id=$2
      AND status='active' FOR UPDATE`,[guildId,id]);
    if (!found.rowCount) {await db.query("ROLLBACK");return {updated:false,count:0};}
    const old=found.rows[0];
    const message=patch.message===undefined?old.message:patch.message;
    const runAt=patch.runAt===undefined?Number(old.run_at_ts):patch.runAt;
    const offsets=patch.offsets===undefined?clean(old.offsets.map(Number)):clean(patch.offsets);
    if (typeof message!=="string" || !message.trim() || message.trim().length>1500)
      throw new Error("Reminder message must contain 1 to 1500 characters.");
    if (!Number.isSafeInteger(runAt) || runAt<now-1000 || runAt>now+365*24*60*60*1000)
      throw new Error("Reminder time must be now or within the next 365 days.");
    if (!offsets.length) throw new Error("Select at least one delivery time.");
    await db.query(`UPDATE standalone_reminders SET message=$3,run_at_ts=$4,offsets=$5::int[],updated_ts=$6
      WHERE guild_id=$1 AND id=$2`,[guildId,id,message.trim(),runAt,offsets,now]);
    // Preserve sent receipts. Pending jobs can be safely replaced in the same DB transaction.
    await db.query(`DELETE FROM standalone_reminder_deliveries
      WHERE reminder_id=$1 AND sent_at IS NULL`,[id]);
    let count=0;
    for (const offset of offsets){
      const due=runAt-ms(offset);
      if (due<now-1000) continue;
      const inserted=await db.query(`INSERT INTO standalone_reminder_deliveries
        (reminder_id,minutes_before,due_ts) VALUES ($1,$2,$3)
        ON CONFLICT (reminder_id,minutes_before) DO NOTHING RETURNING id`,[id,offset,Math.max(due,now)]);
      count+=inserted.rowCount;
    }
    if (!count) throw new Error("No future delivery times remain; already-sent notices are not reissued.");
    await db.query("COMMIT");
    return {updated:true,count,runAt};
  }catch(e){await db.query("ROLLBACK").catch(()=>{});throw e}finally{db.release()}
}

async function list(pool,guildId){
  const result=await pool.query(`SELECT id,message,channel_id,run_at_ts,offsets,created_by
    FROM standalone_reminders WHERE guild_id=$1 AND status='active' AND run_at_ts >= $2
    ORDER BY run_at_ts,id LIMIT 25`,[guildId,Date.now()]);
  return result.rows;
}
async function cancel(pool,guildId,id){
  const result=await pool.query(`UPDATE standalone_reminders SET status='cancelled',updated_ts=$3
    WHERE guild_id=$1 AND id=$2 AND status='active' RETURNING id`,[guildId,id,Date.now()]);
  return result.rowCount===1;
}
async function tick(pool,fetchChannel,logger=console,now=Date.now()){
  const token=randomUUID();
  const result=await pool.query(`WITH due AS (
    SELECT d.id FROM standalone_reminder_deliveries d
    JOIN standalone_reminders r ON r.id=d.reminder_id
    WHERE r.status='active' AND d.sent_at IS NULL AND d.due_ts<=$1
      AND (d.next_attempt_ts IS NULL OR d.next_attempt_ts<=$1)
      AND (d.claim_until IS NULL OR d.claim_until<=$1)
    ORDER BY d.due_ts,d.id FOR UPDATE OF d SKIP LOCKED LIMIT ${MAX_BATCH})
    UPDATE standalone_reminder_deliveries d SET claim_token=$2,claim_until=$3,attempts=d.attempts+1
    FROM due WHERE d.id=due.id RETURNING d.id,d.due_ts,d.minutes_before,d.attempts`,[now,token,now+CLAIM_LEASE]);
  let sent=0;
  for(const delivery of result.rows){
    try {
      const fresh=await pool.query(`SELECT r.guild_id,r.channel_id,r.message,r.run_at_ts,r.status,
        d.minutes_before,d.sent_at FROM standalone_reminder_deliveries d
        JOIN standalone_reminders r ON r.id=d.reminder_id WHERE d.id=$1 AND d.claim_token=$2`,[delivery.id,token]);
      if (!fresh.rowCount || fresh.rows[0].status!=='active' || fresh.rows[0].sent_at!=null) continue;
      const item=fresh.rows[0];
      const ch=await fetchChannel(item.guild_id,item.channel_id);
      if(!ch || ch.guildId!==item.guild_id || ch.isDMBased?.() || typeof ch.send!=="function")
        throw new Error("Alliance reminder channel unavailable.");
      const label=Number(item.minutes_before)===0?"Now":`${item.minutes_before} minute(s) before`;
      const embed=new EmbedBuilder().setTitle(`🔔 Alliance Reminder — ${label}`)
        .setDescription(item.message)
        .addFields({name:"Scheduled for",value:`<t:${Math.floor(Number(item.run_at_ts)/1000)}:F>`});
      const msg=await ch.send({embeds:[embed],allowedMentions:{parse:[]}});
      await pool.query(`UPDATE standalone_reminder_deliveries SET sent_at=$3,sent_message_id=$4,
        claim_token=NULL,claim_until=NULL,next_attempt_ts=NULL,last_error=NULL
        WHERE id=$1 AND claim_token=$2`,[delivery.id,token,Date.now(),msg?.id||null]);
      sent++;
    }catch(err){
      const attempt=Math.max(1,Number(delivery.attempts)||1);
      const backoff=Math.min(600000,30000*2**Math.min(attempt-1,5));
      logger.warn?.(`Standalone reminder delivery #${delivery.id} failed: ${err.message||err}`);
      await pool.query(`UPDATE standalone_reminder_deliveries SET claim_token=NULL,claim_until=NULL,
        next_attempt_ts=$3,last_error=$4 WHERE id=$1 AND claim_token=$2`,
        [delivery.id,token,now+backoff,String(err.message||err).slice(0,300)]).catch(e=>logger.error?.(e));
    }
  }
  return {claimed:result.rows.length,sent};
}
module.exports={create,edit,list,cancel,tick};
