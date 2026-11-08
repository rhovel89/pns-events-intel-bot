'use strict';
// REMINDER_V25_DATABASE_URL must be a disposable LOCAL database. No default; never use production.
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {initDb}=require('../src/db');
const standalone=require('../src/standalone-reminders');
const uri=process.env.REMINDER_V25_DATABASE_URL;
if(!uri || !/^(postgresql|postgres):\/\//.test(uri))throw new Error('Set REMINDER_V25_DATABASE_URL to a disposable local database.');
const url=new URL(uri);
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('QA must use localhost, never Railway.');
const pool=new Pool({connectionString:uri,ssl:false});
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS:',name)}
(async()=>{
 try{
  await check('Additive migration succeeds',async()=>{await initDb(pool)});
  await check('Migration is repeatable',async()=>{await initDb(pool)});
  const now=Date.now(),gid='v25-qa-guild',other='v25-qa-other';
  await pool.query('DELETE FROM standalone_reminders WHERE guild_id = ANY($1::text[])',[[gid,other]]);
  let id;
  await check('Standalone reminder creates independently of events',async()=>{
    const row=await standalone.create(pool,{guildId:gid,channelId:'v25-channel',message:'Shield check',runAt:now+120000,offsets:[0,5],createdBy:'tester'},now);
    id=row.id;assert.equal(row.count,1); // 5-minute warning lies in the past
    const r=await pool.query('SELECT * FROM standalone_reminders WHERE id=$1',[id]);assert.deepEqual(r.rows[0].offsets,[5,0]);
  });
  await check('Guild isolation in list',async()=>{
    assert((await standalone.list(pool,gid)).some(x=>Number(x.id)===Number(id)));
    assert(!(await standalone.list(pool,other)).some(x=>Number(x.id)===Number(id)));
  });
  await check('Cross-guild cancellation rejected',async()=>assert.equal(await standalone.cancel(pool,other,id),false));
  await check('Cross-guild editing rejected',async()=>{
    const result=await standalone.edit(pool,other,Number(id),{message:'Unauthorized'},now);
    assert.equal(result.updated,false);
  });
  await check('Edit updates unsent message while keeping schedule',async()=>{
    const result=await standalone.edit(pool,gid,Number(id),{message:'Updated shield check'},now);
    assert.equal(result.updated,true);assert.equal(result.count,1);
    const row=await pool.query('SELECT message FROM standalone_reminders WHERE id=$1',[id]);
    assert.equal(row.rows[0].message,'Updated shield check');
  });
  await check('No early deliveries',async()=>{
    const calls=[];const r=await standalone.tick(pool,async()=>({guildId:gid,send:async()=>{calls.push(1)}}),console,now);
    assert.equal(r.claimed,0);assert.equal(calls.length,0);
  });
  await check('Concurrent workers reserve delivery once',async()=>{
    const calls=[];const fetch=async() => ({guildId:gid,isDMBased:()=>false,send:async()=>{calls.push(1);return {id:'mock-discord-1'}}});
    const r=await Promise.all([standalone.tick(pool,fetch,console,now+120001),standalone.tick(pool,fetch,console,now+120001)]);
    assert.equal(calls.length,1);assert.equal(r.reduce((n,x)=>n+x.sent,0),1);
  });
  await check('Already-sent delivery cannot duplicate',async()=>{
    const fetch=async()=>{throw new Error('duplicate send!')};
    const r=await standalone.tick(pool,fetch,console,now+120002);assert.equal(r.claimed,0);
  });
  await check('Cancel suppresses upcoming standalone reminder',async()=>{
    assert.equal(await standalone.cancel(pool,gid,id),true);
    assert.equal(await standalone.cancel(pool,gid,id),false);
  });
  await check('Immediate delivery eligible now',async()=>{
    const q=await standalone.create(pool,{guildId:gid,channelId:'v25-channel',message:'Now message',runAt:now,offsets:[0],createdBy:'tester'},now);
    const rr=await pool.query('SELECT due_ts FROM standalone_reminder_deliveries WHERE reminder_id=$1',[q.id]);assert.equal(Number(rr.rows[0].due_ts),now);
  });
  console.log(`RESULT: ${passed}/${passed} real PostgreSQL V2.5 checks passed.`);
 }catch(e){console.error(e);process.exitCode=1}finally{await pool.end()}
})();
