import {one,type SQL} from './db.js';
import {ModelError} from './auth.js';
import type {Action} from './model.js';

export async function startActivity(sql:SQL,action:Extract<Action,{kind:'start_activity'}>,topicId:string,userId:string){
  if(await one(sql,"SELECT id FROM games WHERE topic_id=$1 AND status='active'",[topicId]))throw new ModelError('activity_already_active');
  const actor=await one(sql,'SELECT name FROM members WHERE user_id=$1',[userId]);
  const players=[{id:userId,name:actor?.name || 'Учасник'}];
  const state={title:action.title,rules:action.rules,summary:action.summary,players,scores:{[userId]:0},turn:0,segments:[],open_join:true};
  await sql.query("INSERT INTO games(kind,state,topic_id) VALUES('freeform',$1,$2)",[JSON.stringify(state),topicId]);
  return '';
}
export async function activityTurn(sql:SQL,action:Extract<Action,{kind:'activity_turn'}>,topicId:string,userId:string){
  const game=await one(sql,"SELECT * FROM games WHERE topic_id=$1 AND status='active' FOR UPDATE",[topicId]);
  if(!game||game.kind!=='freeform')throw new ModelError('no_freeform_activity');
  const s=game.state;
  const ids=[...new Set([userId,...(action.score_changes || []).map(x=>x.user_id)])];
  for(const id of ids){
    const member=await one(sql,'SELECT name FROM members WHERE user_id=$1 AND active=true',[id]);
    if(!member)throw new ModelError('activity_unknown_participant');
    if(!s.players.some((p:{id:string})=>p.id===id)){if(id!==userId)throw new ModelError('activity_participant_not_joined');s.players.push({id,name:member.name});}
    s.scores[id] ||= 0;
  }
  for(const change of action.score_changes || [])s.scores[change.user_id]+=change.delta;
  s.summary=action.summary;if(action.rules)s.rules=action.rules;s.turn++;
  await sql.query('UPDATE games SET state=$1,status=$2,updated_at=now() WHERE id=$3',[JSON.stringify(s),action.finished?'completed':'active',game.id]);
  return '';
}
