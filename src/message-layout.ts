import {formatText,validEntities} from './text-document.js';
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
        let boundary=0;for(const p of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(rest)){const next=p.index+p.segment.length;if(next>end)break;boundary=next;}if(!boundary)throw Error('text_grapheme_too_large');end=boundary;
        pages.push(rest.slice(0, end));
        rest = rest.slice(end);
    }
    if (rest)
        pages.push(rest);
    return pages;
}
export const basicFormatting=formatText;
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
    if(!body.trim()&&card?.summary)body=card.summary;
    if (card&&(!context.interactive||context.fullRequested)) {
        body = [body.includes(card.title)?undefined:card.title,body,context.fullRequested&&card.summary&&!body.includes(card.summary)?card.summary:undefined,card.facts?.filter(x=>!body.includes(x)).map(x=>'• '+x).join('\n'),card.question&&!body.includes(card.question)?card.question:undefined].filter(Boolean).join('\n\n');
    }
    if (presentation?.choices?.length && keyboard)
        body += '\n\n' + presentation.choices.map((x, i) => `${i + 1}. ${x}`).join('\n');
    const formatted = basicFormatting(body);
    body = formatted.text;
    let details = card?.details || context.extraDetails || '', main = body;
    let keys: InlineKeyboard | undefined = keyboard ? { inline_keyboard: keyboard.inline_keyboard.map(row => [...row]) } : undefined;
    if(context.fullRequested&&details&&!body.includes(details))main=[body,details].join('\n\n');
    if(context.decisionFacts&&!main.includes(context.decisionFacts))main=[context.decisionFacts,main].filter(Boolean).join('\n\n');
    if (details) {
        const id = stableId('panel:' + context.key + ':' + createHash('sha256').update(details).digest('hex'));
        await sql.query('INSERT INTO message_panels(id,actor_id,audience,topic_id,pages,revision,source_message_id,output_language,action_id,provenance_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,2) ON CONFLICT DO NOTHING', [id, context.actorId, context.audience || 'group', context.topicId, JSON.stringify((()=>{const d=formatText(details);let start=0;return textPages(d.text).map(text=>{const end=start+text.length,entities=d.entities.filter(e=>e.offset<end&&e.offset+e.length>start).map(e=>({...e,offset:Math.max(e.offset,start)-start,length:Math.min(e.offset+e.length,end)-Math.max(e.offset,start)}));start=end;return {text,entities};});})()), context.revision, context.sourceId || null,context.outputLanguage||null,context.actionId||null]);
        await recordProvenance(sql, 'panel', id, [...(context.sourceIds || []), ...(context.sourceId ? [context.sourceId] : [])]);
        keys ||= { inline_keyboard: [] };
        keys.inline_keyboard.push([{ text: 'Докладніше', callback_data: `lp:${id}:0` }]);
    }
    const entities = [...textEntities(main, presentation?.formatting), ...basicFormatting(main).entities];
    if (card?.title && main.startsWith(card.title))
        entities.push({ type: 'bold', offset: 0, length: card.title.length });
    if (formatted.entities.length && main === body)
        entities.push(...formatted.entities);
    return { text: main, entities: validEntities(main,entities), replyMarkup: keys };
}
