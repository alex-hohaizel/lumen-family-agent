// Read-only checks: never consumes getUpdates, changes bindings, or sends group messages.
import { loadConfig } from './config.js';
import { Telegram } from './telegram.js';
import { ChatGPTAuth, models, ModelError } from './auth.js';
import { OpenAIModel } from './model.js';
import { Postgres, state } from './db.js';
import { ChatRegistry } from './registry.js';
import { errorCode } from './engine.js';

const config = await loadConfig();
const checks: { stage: string; ok: boolean; detail: string }[] = [];
let db: Postgres | undefined;
let group: Awaited<ReturnType<typeof state>> | undefined;
const telegram = new Telegram(config.token);

async function check(stage: string, operation: () => Promise<string>) {
  try { checks.push({ stage, ok: true, detail: await operation() }); }
  catch (e) { checks.push({ stage, ok: false, detail: errorCode(e) }); }
}

await check('Telegram token', async () => {
  if (!config.token) throw new ModelError('telegram_token_missing');
  const me = await telegram.call<{ username: string }>('getMe');
  if (me.username.toLowerCase() !== 'lumen_family_agent') throw new ModelError('unexpected_telegram_bot');
  return `@${me.username}`;
});
await check('Long polling', async () => {
  if (!config.token) throw new ModelError('telegram_token_missing');
  const info = await telegram.call<{ url: string }>('getWebhookInfo');
  if (info.url) throw new ModelError('existing_webhook_remove_explicitly');
  return 'no webhook conflict';
});
await check('Database and group', async () => {
  if (!config.databaseUrl) throw new ModelError('database_url_missing');
  db = new Postgres(config.databaseUrl);const registry=new ChatRegistry(db);
  const chats=await registry.list();const selected=process.env.LUMEN_SMOKE_CHAT_ID?chats.find(c=>c.chat_id===process.env.LUMEN_SMOKE_CHAT_ID):chats[0];
  if(!selected)return 'database ready; no group connected yet';
  group=await state(registry.database(selected));
  if(group.paused)throw new ModelError('group_memory_paused');
  const chat = await telegram.call<{ type: string }>('getChat', { chat_id: group.chat_id });
  if (!['group', 'supergroup'].includes(chat.type)) throw new ModelError('unexpected_chat_type');
  return `connected groups: ${chats.length}; scoped memory, mention-only replies`;
});
await check('ChatGPT model response', async () => {
  const selected = group?.model || config.model;
  if (!selected) throw new ModelError('model_not_selected');
  const auth = new ChatGPTAuth(config.runtimeDir);
  const catalog = await models(config, auth);
  if (!catalog.some((x: { id: string }) => x.id === selected)) throw new ModelError('selected_model_unavailable');
  const answer = await new OpenAIModel({ ...config, model: selected }, auth).text(
    [{ role: 'user', content: 'Відповідай коротко українською: Люмен на зв’язку.' }],
    'Технічна перевірка з’єднання. Не використовуй особисті дані.'
  );
  if (!answer.trim()) throw new ModelError('model_empty_response');
  return `${selected}; completed response`;
});
await db?.close();
console.log(JSON.stringify({ checks, live_group_dialogue_verified: false, next: 'Send a real message to Lumen in the bound group and check its answer.' }, null, 2));
if (checks.some(x => !x.ok)) process.exitCode = 1;
