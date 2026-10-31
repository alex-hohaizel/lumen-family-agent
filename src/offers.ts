import {openInteraction,queueInteraction} from './interactions.js';
import type {Plan} from './model.js';
import type {ToolContext} from './agent-tools.js';
import {one,type SQL} from './db.js';
import {ToolError} from './safe-http.js';
import {recordProvenance} from './provenance.js';

const independentOfferKinds=new Set(['personalize','set_preference','remember','remind','cancel_reminder','schedule','schedule_decision']);
/** A proposed action cannot become executable by also appearing in actions.
 * Apply this before tool execution and action authorization, including every replan.
 */
export function prepareOfferPlan(plan:Plan):Plan {
  return plan.offer?{...plan,actions:plan.actions.filter(a=>independentOfferKinds.has(a.kind))}:plan;
}

export async function publishOffer(sql:SQL,offer:NonNullable<Plan['offer']>,c:ToolContext,preflight:(name:string,args:unknown)=>unknown,capabilities:{images?:boolean}={}) {
  const action={...offer.action};
  if(action.kind==='image'&&!capabilities.images)throw new ToolError('offer_capability_not_supported');
  if(action.kind==='start_activity'&&action.director_state){try{const value=JSON.parse(action.director_state);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();}catch{throw new ToolError('activity_director_state_invalid');}}
  if(['forget','pause_memory','set_character','select_model','set_mode','set_preference','set_proactivity','personalize'].includes(action.kind))throw new ToolError('offer_capability_not_supported');
  if(action.kind==='tool') {
    let args:unknown;try{args=JSON.parse(action.arguments);}catch{throw new ToolError('invalid_tool_arguments');}
    action.arguments=JSON.stringify(preflight(action.name,args));
  }
  if(action.kind==='start_game'&&action.game==='custom'&&!await one(sql,'SELECT id FROM rules WHERE lower(title)=lower($1)',[action.title||'']))throw new ToolError('offer_rules_missing');
  if(!['start_game','start_activity','poll','quiz','image','tool'].includes(action.kind))throw new ToolError('offer_capability_not_supported');
  const introduction=[offer.reason,offer.value,offer.scale,'Перший крок: '+offer.first_step].join('\n\n');
  const v=await openInteraction(sql,{title:offer.title,kind:'activity',scope:offer.scope,participant_ids:offer.participant_ids,policy:'all',question:offer.scope==='personal'?'Робимо це?':'Хто долучається до цієї активності?',goal:offer.value.slice(0,350)},c,{launch:action,autoAccept:false});
  if(!v.reused)await sql.query("UPDATE interactions SET spec=spec||$1::jsonb WHERE id=$2",[JSON.stringify({introduction,launch_reply:offer.first_step,launch_actions:[action],offered_by_lumen:true}),v.id]);
  await sql.query("INSERT INTO conversation_goals(id,actor_id,topic_id,goal,status,audience,revision,source_message_id,expires_at) VALUES($1,$2,$3,$4,'offered',$5,$6,$7,$8) ON CONFLICT DO NOTHING",[v.id,c.actorId,c.topicId,offer.title,offer.scope==='personal'?'personal':'group',c.revision,c.sourceId||null,v.expires_at]);
  await recordProvenance(sql,'goal',v.id,[...(c.sourceIds||[]),...(c.sourceId?[c.sourceId]:[])]);
  await queueInteraction(sql,v.id);
  return v;
}
