/** General is the absent/zero Bot API thread. Positive historical IDs retain
 * their identity: never merge stored scopes or infer rights from a topic name.
 * Telegram Bot API server: Client::get_forum_topic_id / is_topic_message.
 */
export function topicKey(message:{message_thread_id?:unknown}){
  const value=message.message_thread_id;
  if(value===undefined||value===0)return '0';
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw Object.assign(new Error('Invalid topic identifier'),{code:'telegram_topic_invalid'});
  return String(value);
}
export function transportThread(value:unknown):number|undefined{
  if(value===undefined||value===0||value==='0')return undefined;
  const thread=typeof value==='string'&&/^[1-9]\d*$/.test(value)?Number(value):value;
  if(typeof thread!=='number'||!Number.isSafeInteger(thread)||thread<1)throw Object.assign(new Error('Invalid topic identifier'),{code:'telegram_topic_invalid'});
  return thread;
}
