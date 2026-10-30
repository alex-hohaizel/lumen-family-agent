import { one, type Database } from './db.js';
import type {OutcomeFact} from './outcomes.js';
import {stableId} from './operations.js';
import {digest} from './evolution-core.js';
import {parseMediaAudioIntent,resolveMediaAudioExpectation,verifiedOriginalAudio,type MediaAudioExpectation} from './media-expectation.js';

const idValue=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(value);
const terminalMedia=new Set(['repair','stale','failed','cancelled','canceled']);
export function taskVerificationMessage(proof:{missing:string[];waiting:string[]}){
    const reasons=proof.missing.join(' ');
    if(/media_audio_expectation/.test(reasons))return 'Поки не можу підтвердити умови звучання цього ролика. Потрібно перевірити актуальне прохання й матеріали.';
    if(/media_original_audio/.test(reasons))return 'Оригінальний звук цього ролика поки не підтверджено. Потрібно перевірити вибрані фрагменти й зібрати версію зі збереженим звуком.';
    if(/media_audio_unwanted/.test(reasons))return 'У ролику залишилася музика, хоча ти попросив без неї. Потрібно зібрати варіант без музичної доріжки.';
    if(/media_audio/.test(reasons))return 'Потрібна музика в ролику ще не підтверджена. Треба додати наданий трек і зібрати новий варіант.';
    if(/media_delivery_uncertain/.test(reasons))return 'Ролик підготовлено, але надсилання поки не підтверджене. Спершу потрібно перевірити, чи файл уже прийшов; автоматично повторювати його не буду.';
    if(/media_output_uncertain/.test(reasons))return 'Поки не можу підтвердити результат монтажу. Потрібно перевірити стан роботи перед новим запуском.';
    if(/media_delivery_failed/.test(reasons))return 'Ролик підготовлено, але надіслати його не вдалося. Можна повторити надсилання готового файла.';
    if(/media_.*cancelled/.test(reasons))return 'Монтаж зупинено. Результат цього запуску не надіслано.';
    if(/media_.*stale/.test(reasons))return 'Матеріали змінилися, тому цей варіант ролика вже неактуальний. Потрібно зібрати його заново з поточних файлів.';
    if(/media_.*failed/.test(reasons))return 'З роликом поки не вийшло. Перевір матеріали й попроси повторити монтаж.';
    if(/media_delivery/.test(reasons))return 'Ролик підготовлено, але надіслати його не вдалося. Можна повторити надсилання готового файла.';
    if(/media_/.test(reasons))return 'Поки не можу підтвердити готовий ролик. Потрібно перевірити матеріали та результат монтажу.';
    if(/document_delivery/.test(reasons))return 'Надсилання документа не підтверджене. Потрібно перевірити, чи файл уже створено й отримано.';
    if(/provider_confirmation/.test(reasons))return 'Сервіс ще не підтвердив виконання дії. Потрібно перевірити її стан; автоматично повторювати її не буду.';
    if(/research/.test(reasons))return 'Поки бракує перевірених джерел для висновку. Надішли потрібне джерело або попроси продовжити пошук.';
    return 'Поки не можу підтвердити завершення завдання. Потрібні додаткові дані або перевірка результату.';
}
export function evidenceCheckedResearch(result:any){
    if(result?.status!=='evidence_checked'||!Array.isArray(result.claims)||!result.claims.length||!Array.isArray(result.sources))return false;
    return result.claims.every((claim:any)=>typeof claim.claim==='string'&&claim.claim.trim()&&['fact','inference'].includes(claim.kind)&&Array.isArray(claim.evidence)&&claim.evidence.length&&claim.evidence.every((e:any)=>typeof e.excerpt==='string'&&e.excerpt.trim()&&Number.isInteger(e.locator?.character_offset)&&e.locator.character_offset>=0&&result.sources.some((s:any)=>s.url===e.url&&/^[a-f0-9]{64}$/.test(s.content_sha256)&&s.content_sha256===e.content_sha256)));
}
export function taskCompletionCriteria(input:{title:string;goal:string;criteria?:string[];requestText?:string}):string[]{
    const required=new Set(input.criteria?.length?input.criteria:['response']);
    const media=/(?<![\p{L}])(?:ролик[ауи]?|відео(?:ролик[ауи]?)?|фільм[ау]?|видео(?:ролик[аи]?)?|фильм[аы]?|video|clip|movie|montage)(?![\p{L}])/iu;
    const create=/(?<![\p{L}])(?:зроби|зробити|створи|створити|збери|зібрати|змонтуй|змонтувати|підготуй|підготувати|згенеруй|згенерувати|сделай|сделать|создай|создать|собери|собрать|смонтируй|подготовь|make|create|build|assemble|produce|render|export)(?![\p{L}])/iu;
    const expects=(text:string)=>text.replace(/```[\s\S]*?```|«[^»]*»|[“"][^”"\n]*[”"]|`[^`\n]*`/g,'').split(/[.!?;,\n]+/u).flatMap(part=>part.split(/\s+(?:і|й|та|а також)\s+(?=(?:зроби|створи|збери|змонтуй|підготуй|згенеруй|поясни|розкажи|знайди|порадь)(?![\p{L}]))/iu)).some(part=>{
        const mediaTarget=media.exec(part);if(!mediaTarget)return false;
        const verb=create.exec(part);if(!verb)return false;
        const informational=/(?:поясн|розкаж|порівня|проаналіз|підсум|перевір|обговор|порад|знайди|дослід|розбер|исслед|объясн|расскаж|сравн|проанализ|посовет|найди|explain|describe|analy[sz]e|compare|review|summari[sz]e|recommend|research|find|how\s+to|як\s+(?:зробити|створити|зібрати|змонтувати)|как\s+(?:сделать|создать|собрать))/iu.exec(part);
        if(informational&&informational.index<verb.index)return false;
        if(/(?:пояснення|аналіз|порівняння|дослідження|огляд|підсумок|explanation|analysis|comparison|review|research)/iu.test(part.slice(0,mediaTarget.index)))return false;
        if(/(?:документ|pdf|docx|xlsx|картинк[ауи]|зображенн[яю]|малюнок|image|picture|document).{0,35}(?:про|щодо|для|about|for|із|з).{0,60}(?:ролик|відео|видео|video|clip|movie)/iu.test(part.slice(verb.index)))return false;
        if(/(?:^|\s)(?:не|not|don't|do not)\s*$/iu.test(part.slice(0,verb.index)))return false;
        return !/(?:план|сценарій|іде[яюї]|опис|інструкці|текст|поради|storyboard|script|plan|outline|caption|description).{0,35}(?:ролик|відео|видео|video|clip|movie)/iu.test(part.slice(verb.index));
    });
    if(expects(input.goal)||expects(input.requestText||'')||expects(input.title)||required.has('media_audio')||required.has('media_silent'))required.add('media');
    if(required.has('media')){
        const sourceMode=parseMediaAudioIntent(input.requestText||''),priorMode=required.has('media_silent')?'silent':required.has('media_audio')?'required':'unspecified',goalMode=parseMediaAudioIntent(input.goal);
        const mode=sourceMode!=='unspecified'?sourceMode:priorMode!=='unspecified'?priorMode:goalMode;
        if(mode==='required'){required.add('media_audio');required.delete('media_silent');}
        else if(mode==='silent'){required.add('media_silent');required.delete('media_audio');}
    }
    return [...required];
}
export async function verifyTask(db: Database, job: any, text: string) {
    const runs = (await db.query("SELECT id,tool,arguments,result FROM tool_runs WHERE task_id=$1 AND status='succeeded' AND goal_version=$2 ORDER BY id", [job.id, job.goal_version || 1])).rows;
    const receipts = (await db.query('SELECT kind,proof FROM result_receipts WHERE task_id=$1 AND actor_id=$2 AND goal_version=$3', [job.id, job.actor_id, job.goal_version || 1])).rows;
    const source=job.source_message_id?await one(db,"SELECT body FROM messages WHERE id=$1 AND user_id=$2 AND role='user'",[job.source_message_id,job.actor_id]):undefined;
    const required = new Set<string>(taskCompletionCriteria({title:String(job.title||''),goal:String(job.goal||''),criteria:job.criteria,requestText:Number(job.goal_version||1)>1?undefined:source?.body}));
    if (runs.some(r => ['artifact.create', 'document.create', 'media.speak'].includes(r.tool)))required.add('document');
    if (runs.some(r => r.tool === 'browser.commit') || /забронював|заброньовано|оплатив|оплачено|лист надіслав|надіслав лист/iu.test(text))required.add('external');
    // The successful export call is the causal edge from this task/goal to a media job.
    // List/status calls and an unrelated person's export are never completion proof.
    const mediaRuns=[...new Map(runs.filter(r=>r.tool==='studio.manage'&&['preview','export'].includes(r.arguments?.operation)).map(r=>[String(r.arguments?.id||r.result?.resource_id||r.id),r])).values()];
    if(mediaRuns.length)required.add('media');
    const missing: string[] = [], waiting: string[] = [],outcomes:OutcomeFact[]=[],media_results:{job_id:string;resource_id:string;output_id:string;title:string;delivered:boolean}[]=[];
    let audioExpectation:MediaAudioExpectation|undefined;
    if(required.has('media')){try{audioExpectation=await resolveMediaAudioExpectation(db,{actorId:String(job.actor_id),topicId:String(job.topic_id),revision:Number(job.revision),sourceId:job.source_message_id?Number(job.source_message_id):undefined,taskId:String(job.id),goalVersion:Number(job.goal_version||1),audience:job.audience});}catch{missing.push('media_audio_expectation');}}
    const audioRequired=required.has('media_audio')||audioExpectation?.mode==='required',audioSilent=required.has('media_silent')||audioExpectation?.mode==='silent';
    for (const kind of required) {
        if (kind === 'response') {if (!text.trim())missing.push('response');}
        else if (kind === 'research') {if (!runs.some(r => r.tool==='research.query'&&evidenceCheckedResearch(r.result)))missing.push('research_evidence');}
        else if (kind === 'calculation') {if (!runs.some(r => r.tool === 'code.run' && r.result !== null))missing.push('calculation_result');}
        else if (kind === 'document') {
            const artifacts = runs.filter(r => ['artifact.create', 'document.create', 'media.speak'].includes(r.tool));
            if (!artifacts.length)missing.push('document');
            for (const r of artifacts) {
                const a = await one(db, 'SELECT a.id,o.status FROM agent_artifacts a LEFT JOIN outbox o ON o.dedup_key=\'artifact:\'||a.id::text WHERE a.id=$1 AND a.actor_id=$2', [r.result?.id, job.actor_id]);
                if (!a || ['failed', 'uncertain'].includes(a.status))missing.push('document_delivery');
                else if (a.status !== 'sent')waiting.push('document_delivery');
            }
        }
        else if (kind === 'media') {
            if(!mediaRuns.length)missing.push('media_output');
            for(const run of mediaRuns){
                if(!idValue(run.result?.id)){missing.push('media_job');continue;}
                const media=await one(db,'SELECT * FROM media_jobs WHERE id=$1 AND actor_id=$2 AND topic_id=$3 AND revision=$4',[run.result.id,job.actor_id,job.topic_id,job.revision]);
                if(!media||job.audience==='private'&&media.audience!=='private'||media.task_id&&String(media.task_id)!==String(job.id)||media.goal_version&&Number(media.goal_version)!==Number(job.goal_version||1)||run.arguments?.id&&String(media.resource_id)!==String(run.arguments.id)||run.result?.resource_id&&String(media.resource_id)!==String(run.result.resource_id)||run.result?.version&&Number(media.resource_version)!==Number(run.result.version)){missing.push('media_job');continue;}
                if(terminalMedia.has(media.status)){missing.push('media_output_'+(media.status==='canceled'?'cancelled':media.status==='repair'?'failed':media.status));continue;}
                if(['uncertain','unconfirmed'].includes(media.status)){missing.push('media_output_uncertain');continue;}
                if(media.status!=='ready'){waiting.push('media_output');continue;}
                const sources=await one(db,"SELECT EXISTS(SELECT 1 FROM media_job_inputs i LEFT JOIN media_assets a ON a.id=i.asset_id WHERE i.job_id=$1 AND (a.id IS NULL OR a.status<>'available' OR a.version<>i.asset_version OR a.audience='private' AND (a.owner_id<>$2 OR $3<>'private'))) AS invalid",[media.id,job.actor_id,media.audience]);
                const project=await one(db,'SELECT version FROM studio_projects WHERE id=$1',[media.resource_id]);
                if(sources?.invalid||!project||Number(project.version)!==Number(media.resource_version)){missing.push('media_output_stale');continue;}
                const verified=media.verification;
                if(media.stage!=='verified'||!verified?.video?.decoded||!idValue(media.output_id)||(media.manifest?.require_audio||run.arguments?.require_audio)&&(!verified.audio?.decoded||!verified.audio?.non_silent)){missing.push('media_output');continue;}
                if(media.manifest?.audio_source==='original'&&audioExpectation?.audio_source!=='original'){missing.push('media_audio_expectation');continue;}
                if(audioRequired){
                    if(audioExpectation?.audio_source==='original'){
                        const inputs=(await db.query("SELECT a.id,a.version,a.mime,a.sha256,a.status FROM media_job_inputs i JOIN media_assets a ON a.id=i.asset_id WHERE i.job_id=$1 AND a.version=i.asset_version AND a.status='available' AND (a.audience='group' OR a.owner_id=$2 AND $3='private')",[media.id,job.actor_id,media.audience])).rows;
                        if(digest(media.manifest)!==media.manifest_hash||!verifiedOriginalAudio(media.manifest,verified,inputs.map(asset=>({id:String(asset.id),version:Number(asset.version),mime:String(asset.mime),sha256:String(asset.sha256),status:String(asset.status)})))){missing.push('media_original_audio');continue;}
                    }else{
                        const track=media.manifest?.soundtrack;
                        const trackInput=track?.asset_id?await one(db,"SELECT a.id FROM media_job_inputs i JOIN media_assets a ON a.id=i.asset_id WHERE i.job_id=$1 AND i.asset_id=$2 AND i.asset_version=$3 AND a.version=i.asset_version AND a.status='available' AND (a.mime LIKE 'audio/%' OR a.mime='video/mp4')",[media.id,track.asset_id,track.asset_version]):undefined;
                        if(!verified.audio?.decoded||!verified.audio?.non_silent||verified.has_soundtrack!==true||!trackInput){missing.push('media_audio');continue;}
                    }
                }
                if(audioSilent&&(verified.has_soundtrack===true||verified.has_original_audio===true)){missing.push('media_audio_unwanted');continue;}
                const output=await one(db,"SELECT id,title,mime,version,sha256,bytes,audience,topic_id,owner_id FROM media_assets WHERE id=$1 AND status='available'",[media.output_id]);
                if(!output||output.id!==stableId('render-output:'+media.id)||output.mime!=='video/mp4'||String(output.owner_id)!==String(job.actor_id)||String(output.topic_id)!==String(job.topic_id)||output.audience!==media.audience){missing.push('media_output');continue;}
                if(audioExpectation?.audio_source==='original'&&(verified.output_sha256!==output.sha256||!Number.isSafeInteger(verified.output_bytes)||verified.output_bytes!==Number(output.bytes))){missing.push('media_original_audio');continue;}
                // Read the publication belonging to this exact output/version. A text receipt is insufficient.
                const publication=await one(db,'SELECT id,status,manifest,receipts FROM media_publications WHERE id=$1 AND asset_id=$2 AND actor_id=$3',[stableId('render-publication:'+media.id),output.id,job.actor_id]);
                if(!publication){waiting.push('media_delivery');continue;}
                if(publication.manifest?.id!==output.id||Number(publication.manifest?.version)!==Number(output.version)||publication.manifest?.sha256!==output.sha256||publication.manifest?.audience!==output.audience){missing.push('media_delivery');continue;}
                if(['uncertain','unconfirmed'].includes(publication.status)){missing.push('media_delivery_uncertain');continue;}
                if(['revoked','stale','cleared'].includes(publication.status)){missing.push('media_output_stale');continue;}
                if(['failed','cancelled','repair'].includes(publication.status)){missing.push('media_delivery_failed');continue;}
                const outbound=await one(db,"SELECT telegram_id,status,body,audience,revision,actor_id FROM outbox WHERE kind='media_asset' AND body->>'mediaJobId'=$1 AND body->>'publicationId'=$2 ORDER BY id DESC LIMIT 1",[media.id,publication.id]);
                if(outbound?.status==='uncertain'){missing.push('media_delivery_uncertain');continue;}
                if(outbound&&['failed','cleared'].includes(outbound.status)){missing.push('media_delivery_failed');continue;}
                const delivered=(!media.task_id||outbound?.body?.taskId===job.id)&&(!media.goal_version||Number(outbound?.body?.goalVersion)===Number(job.goal_version||1))&&outbound?.status==='sent'&&Number(outbound.telegram_id)>0&&outbound.body?.id===output.id&&Number(outbound.body?.version)===Number(output.version)&&outbound.body?.sha256===output.sha256&&String(outbound.actor_id)===String(job.actor_id)&&Number(outbound.revision)===Number(job.revision)&&String(outbound.body?.scopeTopicId??(media.audience==='private'?undefined:outbound.body?.threadId||0))===String(job.topic_id)&&outbound.audience===media.audience&&publication.status==='delivered'&&Array.isArray(publication.receipts)&&publication.receipts.some((receipt:any)=>receipt.provider==='telegram'&&String(receipt.scope_topic_id??(media.audience==='private'?undefined:outbound.body?.threadId||0))===String(job.topic_id)&&(!receipt.actor_id||String(receipt.actor_id)===String(job.actor_id))&&(!receipt.audience||receipt.audience===media.audience)&&(!receipt.task_id||String(receipt.task_id)===String(job.id))&&(!receipt.goal_version||Number(receipt.goal_version)===Number(job.goal_version||1))&&Array.isArray(receipt.message_ids)&&receipt.message_ids.some((id:unknown)=>Number.isSafeInteger(id)&&Number(id)===Number(outbound.telegram_id))&&(!(media.audience==='private'?job.actor_id:job.chatId)||String(receipt.chat_id)===String(media.audience==='private'?job.actor_id:job.chatId)));
                if(!delivered){waiting.push('media_delivery');continue;}
                outcomes.push({capability:'studio.delivery',scope:'studio.manage:'+String(run.arguments?.operation||'')+':'+String(run.arguments?.id||run.result.id),status:'observed',reference:output.id,confirmed:'delivery',targetKind:'file',fileKinds:['video'],targets:[output.id,output.title]});
                outcomes.push({capability:'studio.output',status:'observed',reference:output.id,confirmed:'completion',targetKind:'file',fileKinds:['video'],targets:[output.id,output.title]});
                media_results.push({job_id:media.id,resource_id:media.resource_id,output_id:output.id,title:output.title,delivered:true});
            }
        }
        else if (kind === 'external') {if (!receipts.some(r => r.kind === 'external' && r.proof?.service_status === 'confirmed' && r.proof?.reference && r.proof?.source_run_id))missing.push('provider_confirmation');}
    }
    return { ok: missing.length === 0 && waiting.length === 0, missing:[...new Set(missing)], waiting:[...new Set(waiting)],outcomes,media_results, verified_tools: runs.map(r => ({ id: r.id, tool: r.tool })), checked_at: new Date().toISOString() };
}
