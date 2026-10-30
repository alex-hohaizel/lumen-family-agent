export type ReplyLength = 'short' | 'balanced' | 'detailed';
export type Humor = 'off' | 'light';
export interface Preferences { length: ReplyLength; humor: Humor; }
export interface ConversationLine { id: string | number; user_id: string; body: string; created_at: Date | string; }

export const DEFAULT_PREFERENCES: Preferences = { length: 'balanced', humor: 'light' };

// A temporary conversation cue, never a diagnosis or a stored emotional profile.
export function seriousConversation(lines: Pick<ConversationLine, 'body'>[]) {
  return lines.slice(-6).some(x => /сварим|сварк|не смішно|без жарт|помер|похорон|лікарн|мені (?:дуже )?важко|дуже погано|не хочу (?:розмов|жарт)|без шут|мне (?:очень )?(?:тяжело|плохо)|умер|больниц|серь[её]зно|no jokes|hospital|bereave|i feel terrible/iu.test(x.body.replace(/^>.*$/gm,'').replace(/«[^»]*»|“[^”]*”/g,'').replace(/(?:помер|умер|здох)[лао]?\s+(?:мій\s+|мой\s+)?(?:телефон|ноутбук|акумулятор|батаре[яй]|сервер)|(?:телефон|ноутбук|акумулятор|сервер)\s+(?:помер|умер|здох)/giu,'')));
}

export function socialDecision(options: {
  gapMinutes?:number;now: number; sourceId: string | number; sinceBot: number;
  lastBotAt: Date | string | null; lastSocialAt: Date | string | null;
  lines: ConversationLine[];
}) {
  const { now, lines } = options;
  const recent = lines.filter(x => now - new Date(x.created_at).getTime() < 5 * 60000);
  if (!recent.length || String(recent.at(-1)!.id) !== String(options.sourceId)) return false;
  if (new Set(recent.map(x => x.user_id)).size < 2 || seriousConversation(recent)) return false;
  const slow = now - new Date(recent[0]!.created_at).getTime() >= 2 * 60000;
  const minimumMessages = slow ? 10 : 16;
  const minimumGap = Math.max(options.gapMinutes??0,slow?30:20)*60000;
  const lastAttempt = Math.max(...[options.lastBotAt, options.lastSocialAt].map(x => x ? new Date(x).getTime() : 0));
  return options.sinceBot >= minimumMessages && recent.length >= minimumMessages && now - lastAttempt >= minimumGap;
}

export function responseGuidance(preferences: Preferences, serious: boolean) {
  const length = {
    short: 'Зазвичай 1–3 короткі речення; деталі — на прохання.',
    balanced: 'Коротка природна відповідь; пояснення розгорни, коли задача цього потребує.',
    detailed: 'Пояснюй послідовно з конкретними прикладами, без повторів і зайвого вступу.'
  }[preferences.length];
  return `${length} ${preferences.humor === 'off' ? 'Зараз без жартів, підколів та іронії.' : serious ? 'Є можливий серйозний контекст. Перевір зміст, адресата й настрій розмови: згадка теми не доводить стан людини. Вибери тактовну подачу; гумор тільки за явної доречності.' : 'Легкий гумор лише якщо доречний.'} Поточне явне прохання про формат має пріоритет над збереженим стилем. Не роби висновків про характер чи почуття людини з цих налаштувань.`;
}
