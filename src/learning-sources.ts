import type {SQL} from './db.js';
import type {ToolContext} from './agent-tools.js';
export const learningIds=(...groups:any[][]):number[]=>[...new Set(groups.flat().map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];
export const learningInput=(c:ToolContext)=>learningIds(c.sourceIds||[],c.sourceId?[c.sourceId]:[]);
export async function learningSources(sql:SQL,goal:string){
 const rows=(await sql.query(`SELECT m.id FROM messages m WHERE m.id::text IN (
  SELECT source_message_id::text FROM learning_goals WHERE id=$1
  UNION SELECT jsonb_array_elements_text(source_ids) FROM learning_goals WHERE id=$1
  UNION SELECT source_message_id::text FROM learning_exercises WHERE goal_id=$1
  UNION SELECT question_source_id::text FROM learning_exercises WHERE goal_id=$1
  UNION SELECT jsonb_array_elements_text(source_ids) FROM learning_exercises WHERE goal_id=$1
  UNION SELECT source_message_id::text FROM learning_attempts WHERE goal_id=$1
  UNION SELECT answer_source_id::text FROM learning_attempts WHERE goal_id=$1
  UNION SELECT grading_source_id::text FROM learning_attempts WHERE goal_id=$1
  UNION SELECT review_source_id::text FROM learning_attempts WHERE goal_id=$1
  UNION SELECT jsonb_array_elements_text(input_source_ids||grading_source_ids||review_source_ids||appeal_source_ids) FROM learning_attempts WHERE goal_id=$1
 )`,[goal])).rows;return rows.map(r=>Number(r.id));
}
