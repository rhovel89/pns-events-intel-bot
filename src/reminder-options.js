"use strict";
// EVENT_INTERVALS_V1: Valid choices are minutes before scheduled start.
const VALID = Object.freeze([60,45,30,15,5,0]);
const LEGACY = Object.freeze([60,15,5]);
const OPTION_NAMES = Object.freeze([[60,"alert_60"],[45,"alert_45"],[30,"alert_30"],[15,"alert_15"],[5,"alert_5"],[0,"alert_at_time"]]);
function clean(input) {
  if (!Array.isArray(input) || input.some(x => !Number.isInteger(x) || !VALID.includes(x)))
    throw new Error("Invalid reminder interval. Choices: 60,45,30,15,5,0 minutes.");
  return [...new Set(input)].sort((a,b)=>b-a);
}
function readChoices(options, fallback=LEGACY) {
  // Unspecified choices preserve legacy behavior. An explicit all-false selection disables reminders.
  const values=OPTION_NAMES.map(([minutes,name])=>[minutes,options.getBoolean(name)]);
  if (values.every(([,value])=>value===null || value===undefined)) return [...new Set(fallback)].sort((a,b)=>b-a);
  return clean(values.filter(([,value])=>value===true).map(([minutes])=>minutes));
}
function offsetsFromRow(value, legacy=LEGACY) {
  return value == null ? [...new Set(legacy)].sort((a,b)=>b-a) : clean(value.map(Number));
}
function addChoiceOptions(builder) {
  for (const [minutes,name] of OPTION_NAMES) {
    const label=minutes===0?"At scheduled time":`${minutes} minutes before`;
    builder.addBooleanOption(o=>o.setName(name).setDescription(`Send reminder ${label} (select true to include)`));
  }
  return builder;
}
module.exports={VALID,LEGACY,OPTION_NAMES,clean,readChoices,offsetsFromRow,addChoiceOptions};
