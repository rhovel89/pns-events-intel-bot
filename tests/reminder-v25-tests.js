'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {clean,readChoices,offsetsFromRow,OPTION_NAMES}=require(path.resolve('src/reminder-options.js'));
const fake=(map={})=>({getBoolean:name=>Object.hasOwn(map,name)?map[name]:null});
let n=0;
function check(name,fn){fn();n++;console.log('PASS:',name)}
check('All six choices supported including at event time',()=>assert.deepEqual(clean([0,5,15,30,45,60]),[60,45,30,15,5,0]));
check('Duplicate interval choices removed',()=>assert.deepEqual(clean([15,15,0]),[15,0]));
check('Legacy default retained for omitted choices',()=>assert.deepEqual(readChoices(fake()),[60,15,5]));
check('Explicit selection replaces default',()=>assert.deepEqual(readChoices(fake({alert_45:true,alert_5:true})),[45,5]));
check('Explicitly false choices mean none',()=>assert.deepEqual(readChoices(fake({alert_60:false})),[]));
check('Standalone default at-time only',()=>assert.deepEqual(readChoices(fake(),[0]),[0]));
check('Old database event fallback remains legacy',()=>assert.deepEqual(offsetsFromRow(null),[60,15,5]));
check('Persisted zero-length choices retain no reminders',()=>assert.deepEqual(offsetsFromRow([]),[]));
check('Invalid or negative offsets rejected',()=>{assert.throws(()=>clean([-5]));assert.throws(()=>clean([10]));assert.throws(()=>clean([NaN]))});
check('Six Discord boolean choice options available',()=>assert.equal(OPTION_NAMES.length,6));
console.log(`RESULT: ${n}/${n} reminder-choice checks passed.`);
