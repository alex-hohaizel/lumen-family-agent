import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { one, type Database,type SQL } from './db.js';
import {bindIngress,validIngressScopes} from './ingress-context.js';
import type { Update } from './telegram.js';
import {topicKey} from './topic-scope.js';
export function ingressFailureKind(error:any){return error?.name==='ZodError'||error instanceof SyntaxError||['ingress_payload_invalid','ingress_ciphertext_invalid','ingress_scope_requires_review'].includes(error?.code)?'validation':'infrastructure';}
// Ingress can contain a credential submitted in DM. Persist ciphertext only.
export class TransportQueue {
    private key?: Buffer;
    constructor(private db: Database, private runtimeDir: string, private receive: (update: Update) => Promise<void>,private scopes?:(update:Update,sql:SQL)=>Promise<string[]>) { }
    async init() {
        await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
        const path = resolve(this.runtimeDir, 'transport-queue.key');
        try {
            this.key = await readFile(path);
        }
        catch (e: any) {
            if (e.code !== 'ENOENT')
                throw e;
            try {
                await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
            }
            catch (e: any) {
                if (e.code !== 'EEXIST')
                    throw e;
            }
            this.key = await readFile(path);
        }
        if (this.key.length !== 32)
            throw new Error('transport_key_invalid');
        await this.db.query("CREATE TABLE IF NOT EXISTS public.lumen_ingress(update_id bigint PRIMARY KEY,ciphertext text,status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now())");
        await this.db.query("ALTER TABLE public.lumen_ingress ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT ''");
        await this.db.query("ALTER TABLE public.lumen_ingress ADD COLUMN IF NOT EXISTS manual_retries integer NOT NULL DEFAULT 0");await this.db.query("ALTER TABLE public.lumen_ingress ADD COLUMN IF NOT EXISTS last_error text");
        await this.db.query("ALTER TABLE public.lumen_ingress ADD COLUMN IF NOT EXISTS error_kind text");
        await this.db.query("ALTER TABLE public.lumen_ingress ADD COLUMN IF NOT EXISTS context_version integer NOT NULL DEFAULT 0");
        await this.db.query("UPDATE public.lumen_ingress SET status='pending' WHERE status='processing'");
    }
    async enqueue(update: Update) {
        if (!this.key)
            throw new Error('transport_not_ready');
        const clean={...update};delete (clean as any).lumen_ingress_at;delete (clean as any).lumen_ingress_scopes;
        // A single read snapshot binds a private purpose and its timestamp. An
        // erase between clock capture and purpose lookup cannot change the
        // target to an ordinary personal conversation.
        const context=await this.db.tx(async sql=>{
            await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const clock=await one(sql,'SELECT clock_timestamp()::text AS enqueued_at');
            const m=clean.message||clean.edited_message||clean.callback_query?.message;
            const fallback=m?.chat.id||clean.message_reaction?.chat.id||clean.my_chat_member?.chat.id;
            return {enqueuedAt:String(clock!.enqueued_at),scopes:validIngressScopes(this.scopes?await this.scopes(clean,sql):fallback?[String(fallback)]:[])};
        });
        (clean as any).lumen_ingress_at=context.enqueuedAt;(clean as any).lumen_ingress_scopes=context.scopes;
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(String(update.update_id)));
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(clean)), cipher.final()]);
        const value = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
        const m = update.message || update.edited_message || update.callback_query?.message;
        const actor = update.callback_query?.from || m?.from;
        const lane = createHash('sha256').update(String(m?.chat.id || update.my_chat_member?.chat.id || update.poll_answer?.poll_id || 'transport') + ':' + String(actor?.id || 'service') + ':' + topicKey(m||{})).digest('hex');
        await this.db.tx(async (sql) => { await one(sql,'SELECT id FROM public.lumen_transport_state WHERE id=1 FOR UPDATE');const pressure=await one(sql,"SELECT count(*) AS n,COALESCE(sum(octet_length(ciphertext)),0) AS bytes FROM public.lumen_ingress WHERE ciphertext IS NOT NULL");if(Number(pressure!.n)>=5000||Number(pressure!.bytes)>32*1024*1024)throw new Error('ingress_backpressure_recovery_required');await sql.query('INSERT INTO public.lumen_ingress(update_id,ciphertext,lane,created_at,context_version) VALUES($1,$2,$3,$4,1) ON CONFLICT DO NOTHING', [update.update_id, value, lane,context.enqueuedAt]); await sql.query('UPDATE public.lumen_transport_state SET poll_offset=GREATEST(poll_offset,$1),last_poll_at=now() WHERE id=1', [update.update_id + 1]); });
    }
    async next() {
        const row = await this.db.tx(async (sql) => {
            await one(sql, 'SELECT id FROM public.lumen_transport_state WHERE id=1 FOR UPDATE');
            const r = await one(sql, "SELECT *,created_at::text AS ingress_enqueued_at FROM public.lumen_ingress WHERE status='pending' AND available_at<=now() AND NOT EXISTS(SELECT 1 FROM public.lumen_ingress active WHERE active.status='processing' AND active.lane=lumen_ingress.lane) ORDER BY update_id LIMIT 1 FOR UPDATE SKIP LOCKED");
            if (!r)
                return;
            await sql.query("UPDATE public.lumen_ingress SET status='processing',attempts=attempts+1 WHERE update_id=$1", [r.update_id]);
            return r;
        });
        if (!row)
            return false;
        try {
            let update:Update;
            try{const bytes = Buffer.from(row.ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key!, bytes.subarray(0, 12));
             decipher.setAAD(Buffer.from(String(row.update_id)));decipher.setAuthTag(bytes.subarray(12, 28));
             update=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
             if(!update||update.update_id!==Number(row.update_id))throw Error('payload');
            }catch{throw Object.assign(Error('ingress_payload_invalid'),{code:'ingress_payload_invalid'});}
            // The persisted enqueue time survives repair/retry and cannot be supplied by Telegram.
            let scopes:unknown=(update as any).lumen_ingress_scopes;
            if(Number(row.context_version)!==1){
                const m=update.message||update.edited_message||update.callback_query?.message;
                const group=m?.chat.type!=='private'&&m?.chat.id||update.message_reaction?.chat.id||update.my_chat_member?.chat.id;
                if(!group)throw Object.assign(Error('ingress_scope_requires_review'),{code:'ingress_scope_requires_review'});
                scopes=[String(group)];
            }
            bindIngress(update,String(row.ingress_enqueued_at),scopes);
            await this.receive(update);
            await this.db.query("UPDATE public.lumen_ingress SET status='done',ciphertext=NULL WHERE update_id=$1", [row.update_id]);
        }
        catch(e:any) {
            console.error(JSON.stringify({ event: 'ingress_retry', update_id: Number(row.update_id), attempt: Number(row.attempts) + 1 }));
            const kind=ingressFailureKind(e);
            await this.db.query("UPDATE public.lumen_ingress SET status=$1,available_at=now()+interval '5 seconds',last_error=$3,error_kind=$4 WHERE update_id=$2", [kind==='validation'||row.attempts >= 4 ? 'repair' : 'pending', row.update_id,/^[a-z_0-9]{1,80}$/.test(e?.code||'')?e.code:'processing_failed',kind]);
        }
        await this.db.query("DELETE FROM public.lumen_ingress WHERE status IN ('done','discarded') AND created_at<now()-interval '7 days'");
        return true;
    }
}
