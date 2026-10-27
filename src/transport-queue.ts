import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { one, type Database } from './db.js';
import type { Update } from './telegram.js';
// Ingress can contain a credential submitted in DM. Persist ciphertext only.
export class TransportQueue {
    private key?: Buffer;
    constructor(private db: Database, private runtimeDir: string, private receive: (update: Update) => Promise<void>) { }
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
        await this.db.query("UPDATE public.lumen_ingress SET status='pending' WHERE status='processing'");
    }
    async enqueue(update: Update) {
        if (!this.key)
            throw new Error('transport_not_ready');
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(String(update.update_id)));
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(update)), cipher.final()]);
        const value = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
        const m = update.message || update.edited_message || update.callback_query?.message;
        const actor = update.callback_query?.from || m?.from;
        const lane = createHash('sha256').update(String(m?.chat.id || update.my_chat_member?.chat.id || update.poll_answer?.poll_id || 'transport') + ':' + String(actor?.id || 'service') + ':' + String(m?.message_thread_id || 0)).digest('hex');
        await this.db.tx(async (sql) => { await sql.query('INSERT INTO public.lumen_ingress(update_id,ciphertext,lane) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [update.update_id, value, lane]); await sql.query('UPDATE public.lumen_transport_state SET poll_offset=GREATEST(poll_offset,$1),last_poll_at=now() WHERE id=1', [update.update_id + 1]); });
    }
    async next() {
        const row = await this.db.tx(async (sql) => {
            await one(sql, 'SELECT id FROM public.lumen_transport_state WHERE id=1 FOR UPDATE');
            const r = await one(sql, "SELECT * FROM public.lumen_ingress WHERE status='pending' AND available_at<=now() AND NOT EXISTS(SELECT 1 FROM public.lumen_ingress active WHERE active.status='processing' AND active.lane=lumen_ingress.lane) ORDER BY update_id LIMIT 1 FOR UPDATE SKIP LOCKED");
            if (!r)
                return;
            await sql.query("UPDATE public.lumen_ingress SET status='processing',attempts=attempts+1 WHERE update_id=$1", [r.update_id]);
            return r;
        });
        if (!row)
            return false;
        try {
            const bytes = Buffer.from(row.ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key!, bytes.subarray(0, 12));
            decipher.setAAD(Buffer.from(String(row.update_id)));
            decipher.setAuthTag(bytes.subarray(12, 28));
            const update = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
            await this.receive(update);
            await this.db.query("UPDATE public.lumen_ingress SET status='done',ciphertext=NULL WHERE update_id=$1", [row.update_id]);
        }
        catch {
            console.error(JSON.stringify({ event: 'ingress_retry', update_id: Number(row.update_id), attempt: Number(row.attempts) + 1 }));
            await this.db.query("UPDATE public.lumen_ingress SET status=$1,available_at=now()+interval '5 seconds',ciphertext=CASE WHEN $1='failed' THEN NULL ELSE ciphertext END WHERE update_id=$2", [row.attempts >= 4 ? 'failed' : 'pending', row.update_id]);
        }
        await this.db.query("DELETE FROM public.lumen_ingress WHERE status IN ('done','failed') AND created_at<now()-interval '7 days'");
        return true;
    }
}
