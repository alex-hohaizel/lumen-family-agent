import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';

export const ConfigSchema = z.object({
  token: z.string().default(''), ownerId: z.string().regex(/^\d*$/).default(''),
  databaseUrl: z.string().default(''), authMode: z.enum(['chatgpt', 'api']).default('chatgpt'),
  model: z.string().default(''), apiKey: z.string().default(''), pairCodeHash: z.string().default(''),
  imageModel: z.string().default(''), transcribeModel: z.string().default(''),
  webSearch: z.boolean().default(false), timezone: z.string().default('Europe/Kyiv'),
  quietStart: z.number().int().min(0).max(23).default(23),
  quietEnd: z.number().int().min(0).max(23).default(9),
  dailyTurnLimit:z.number().int().min(0).default(0),
  agentSteps:z.number().int().min(2).max(12).default(8),browserEnabled:z.boolean().default(true),
  runtimeDir: z.string().default(resolve('runtime')), healthPort: z.number().int().default(8080)
});
export type Config = z.infer<typeof ConfigSchema>;
export async function atomicJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export async function loadConfig(): Promise<Config> {
  const env = process.env;
  const runtimeDir = resolve(env.RUNTIME_DIR || 'runtime');
  let file: Record<string, unknown> = {};
  try { file = JSON.parse(await readFile(resolve(runtimeDir, 'config.json'), 'utf8')); }
  catch (e: any) { if (e.code !== 'ENOENT') throw new Error('Пошкоджений runtime/config.json'); }
  const override: Record<string, unknown> = { runtimeDir };
  for (const [key, val] of Object.entries({
    token: env.TELEGRAM_BOT_TOKEN, ownerId: env.OWNER_TELEGRAM_ID,
    databaseUrl: env.DATABASE_URL, authMode: env.AUTH_MODE, model: env.OPENAI_MODEL,
    apiKey: env.OPENAI_API_KEY, imageModel: env.IMAGE_MODEL, transcribeModel: env.TRANSCRIBE_MODEL,
    timezone: env.TIMEZONE
  })) if (val) override[key] = val;
  if (env.ENABLE_WEB_SEARCH) override.webSearch = env.ENABLE_WEB_SEARCH === 'true';
  if (env.ENABLE_BROWSER) override.browserEnabled=env.ENABLE_BROWSER==='true';
  if (env.AGENT_MAX_STEPS) override.agentSteps=Number(env.AGENT_MAX_STEPS);
  if (env.QUIET_START) override.quietStart = Number(env.QUIET_START);
  if (env.QUIET_END) override.quietEnd = Number(env.QUIET_END);
  if (env.HEALTH_PORT || env.PORT) override.healthPort = Number(env.HEALTH_PORT || env.PORT);
  if (env.LUMEN_DAILY_TURN_LIMIT) override.dailyTurnLimit=Number(env.LUMEN_DAILY_TURN_LIMIT);
  if (env.LUMEN_PAIRING_CODE) override.pairCodeHash=createHash('sha256').update(env.LUMEN_PAIRING_CODE).digest('hex');
  const config = ConfigSchema.parse({ ...file, ...override });
  new Intl.DateTimeFormat('uk', { timeZone: config.timezone });
  return config;
}
export function requireRuntime(c: Config) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(c.token)) throw new Error('Спочатку налаштуйте Telegram-токен: npm run setup');
  if (!c.databaseUrl) throw new Error('Не задано DATABASE_URL');
}
