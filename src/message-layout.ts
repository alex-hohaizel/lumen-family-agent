import { createHash } from 'node:crypto';
import { stableId } from './operations.js';
import { recordProvenance } from './provenance.js';
import type { SQL } from './db.js';
import type { InlineKeyboard, TextEntity } from './telegram.js';
import type { Plan } from './model.js';
import { textEntities } from './presentation.js';
export function textPages(text: string, limit = 1800) {
    const pages: string[] = [];
    let rest = text;
    while (rest.length > limit) {
        let end = rest.lastIndexOf('\n\n', limit);
        if (end < limit / 3)
            end = rest.lastIndexOf(' ', limit);
        if (end < limit / 3)
            end = limit;
        if (/[\uD800-\uDBFF]/.test(rest[end - 1] || ''))
            end--;
        pages.push(rest.slice(0, end));
        rest = rest.slice(end);
    }
    if (rest)
        pages.push(rest);
    return pages;
}
export function basicFormatting(input: string) {
    let text = '', entities: TextEntity[] = [];
    let pos = 0;
    const regex = /\*\*([^*\n]+)\*\*|^#{1,3}\s+([^\n]+)/gm;
    for (const m of input.matchAll(regex)) {
        text += input.slice(pos, m.index);
        const value = m[1] || m[2] || '';
        entities.push({ type: 'bold', offset: text.length, length: value.length });
        text += value;
        pos = m.index! + m[0].length;
    }
    text += input.slice(pos);
    return { text, entities };
}
export async function layoutMessage(sql: SQL, input: string, presentation: Plan['presentation'], context: {
    actorId: string;
    topicId: string;
    revision: number;
    sourceId?: number;
    sourceIds?: number[];
    audience?: string;
    key: string;
    interactive?: boolean;
    extraDetails?: string;
    actionId?: string;
    outputLanguage?: string;
    fullRequested?: boolean;
    decisionFacts?: string;
}, keyboard?: InlineKeyboard) {
    let body = input;
    const card = presentation?.card;
    if (card&&!context.interactive&&!context.fullRequested) {
        body = [card.title, card.summary, card.facts?.length ? card.facts.map(x => '• ' + x).join('\n') : undefined, card.question].filter(Boolean).join('\n\n');
    }
    if (presentation?.choices?.length && keyboard)
        body += '\n\n' + presentation.choices.map((x, i) => `${i + 1}. ${x}`).join('\n');
    const formatted = basicFormatting(body);
    body = formatted.text;
    let details = card?.details || context.extraDetails || '', main = body;
    // A long fallback remains fully accessible; no option or paragraph is sliced away.
    if (body.length > 2400 && !card && !context.interactive && !context.fullRequested) {
        const paragraphs = body.split(/\n\s*\n/);
        const first = paragraphs[0] || '';
        const last = paragraphs.at(-1) || '';
        if (first.length <= 700 && paragraphs.length > 2) {
            main = [first, last !== first && last.length < 500 ? last : '', 'Повний текст — за кнопкою «Докладніше».'].filter(Boolean).join('\n\n');
            details = [body, details].filter(Boolean).join('\n\n');
        }
        else {
            const pages = textPages(body, 1100);
            main = pages[0] + '\n\nПовний текст — за кнопкою «Докладніше».';
            details = [body, details].filter(Boolean).join('\n\n');
        }
    }
    let keys: InlineKeyboard | undefined = keyboard ? { inline_keyboard: keyboard.inline_keyboard.map(row => [...row]) } : undefined;
    if(context.fullRequested&&card?.details&&!body.includes(card.details))main=[body,card.details].join('\n\n');
    if(context.decisionFacts&&!main.includes(context.decisionFacts))main=[context.decisionFacts,main].filter(Boolean).join('\n\n');
    if (details) {
        const id = stableId('panel:' + context.key + ':' + createHash('sha256').update(details).digest('hex'));
        await sql.query('INSERT INTO message_panels(id,actor_id,audience,topic_id,pages,revision,source_message_id,output_language,action_id,provenance_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,2) ON CONFLICT DO NOTHING', [id, context.actorId, context.audience || 'group', context.topicId, JSON.stringify(textPages(details)), context.revision, context.sourceId || null,context.outputLanguage||null,context.actionId||null]);
        await recordProvenance(sql, 'panel', id, [...(context.sourceIds || []), ...(context.sourceId ? [context.sourceId] : [])]);
        keys ||= { inline_keyboard: [] };
        keys.inline_keyboard.push([{ text: 'Докладніше', callback_data: `lp:${id}:0` }]);
    }
    const entities = [...textEntities(main, presentation?.formatting), ...basicFormatting(main).entities];
    if (card?.title && main.startsWith(card.title))
        entities.push({ type: 'bold', offset: 0, length: card.title.length });
    if (!card && formatted.entities.length && main === body)
        entities.push(...formatted.entities);
    return { text: main, entities: [...new Map(entities.map(e => [`${e.type}:${e.offset}:${e.length}`, e])).values()], replyMarkup: keys };
}
