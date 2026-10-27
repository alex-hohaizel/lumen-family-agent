import { randomUUID } from 'node:crypto';
import { one, state, queueText, type Database } from './db.js';
import { ConnectorVault } from './connector-vault.js';
import { outsideOperation } from './operations.js';
import { safeRequest, publicURL, ToolError, type HTTPRequest } from './safe-http.js';
import type { ToolContext } from './agent-tools.js';
import type { Telegram } from './telegram.js';
const json = (body: Buffer) => {
    try {
        return JSON.parse(body.toString());
    }
    catch {
        throw new ToolError('oauth_invalid_response');
    }
};
function endpoint(value: string, issuer: string) {
    const u = publicURL(value), origin = publicURL(issuer);
    if (u.protocol !== 'https:' || origin.protocol !== 'https:' || u.origin !== origin.origin)
        throw new ToolError('oauth_endpoint_origin_mismatch');
    return u.href;
}
export class OAuthDevices {
    private vault: ConnectorVault;
    constructor(private db: Database, private runtimeDir: string, private request: HTTPRequest = safeRequest) { this.vault = new ConnectorVault(db, runtimeDir); }
    async setup(a: any, c: ToolContext) {
        if (publicURL(a.endpoint).protocol !== 'https:' || publicURL(a.issuer).protocol !== 'https:')
            throw new ToolError('oauth_https_required');
        const id = randomUUID();
        await this.db.query('INSERT INTO oauth_setups(id,actor_id,name,endpoint,issuer,client_id,scopes,topic_id,revision,task_id,goal_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, c.actorId, a.name, a.endpoint, a.issuer, a.client_id, JSON.stringify(a.scopes), c.topicId, c.revision, c.taskId || null, c.goalVersion || 1]);
        return { id, private_setup_url: 'https://t.me/lumen_family_agent?start=oauth_' + id, status: 'awaiting_private_authorization', requested_scopes: a.scopes, provider_must_support_device_authorization: true };
    }
    async begin(id: string, user: string, tg: Telegram) {
        const row = await one(this.db, "SELECT * FROM oauth_setups WHERE id=$1 AND actor_id=$2 AND status='offered' AND created_at>now()-interval '15 minutes'", [id, user]);
        if (!row)
            return false;
        const live = await state(this.db);
        if (live.paused || live.memory_revision !== row.revision)
            return false;
        const issuer = publicURL(row.issuer);
        const metadataURL = issuer.origin + '/.well-known/oauth-authorization-server' + (issuer.pathname === '/' ? '' : issuer.pathname);
        const discovery = await this.request(metadataURL, { maxBytes: 200000, timeout: 15000 });
        if (discovery.status !== 200)
            throw new ToolError('oauth_metadata_unavailable');
        if (publicURL(discovery.url).protocol !== 'https:')
            throw new ToolError('oauth_https_required');
        const metadata = json(discovery.body);
        if (metadata.issuer && metadata.issuer.replace(/\/$/, '') !== issuer.href.replace(/\/$/, ''))
            throw new ToolError('oauth_issuer_mismatch');
        if (!metadata.device_authorization_endpoint || !metadata.token_endpoint)
            throw new ToolError('oauth_device_flow_not_supported');
        const deviceEndpoint = endpoint(metadata.device_authorization_endpoint, row.issuer), tokenEndpoint = endpoint(metadata.token_endpoint, row.issuer);
        const response = await this.request(deviceEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: row.client_id, scope: row.scopes.join(' ') }).toString(), maxBytes: 200000, redirects: 0 });
        if (response.status !== 200)
            throw new ToolError('oauth_device_start_failed');
        const data = json(response.body);
        if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 1800)
            throw new ToolError('oauth_device_response_invalid');
        const verification = publicURL(data.verification_uri);
        const aliases: Record<string, string[]> = { 'https://login.microsoftonline.com': ['https://microsoft.com', 'https://www.microsoft.com'], 'https://accounts.google.com': ['https://www.google.com'] };
        if (verification.protocol !== 'https:')
            throw new ToolError('oauth_https_required');
        if (verification.origin !== issuer.origin && !(aliases[issuer.origin] || []).includes(verification.origin))
            throw new ToolError('oauth_verification_origin_mismatch');
        const name = 'device_' + id.replaceAll('-', '');
        const saved = await this.db.tx(async (sql) => {
            const live = await state(sql, true);
            const active = await one(sql, "SELECT id FROM oauth_setups WHERE id=$1 AND actor_id=$2 AND status='offered'", [id, user]);
            if (live.paused || live.memory_revision !== row.revision || !active)
                return false;
            const vault = new ConnectorVault({ query: (q, a) => sql.query(q, a), tx: fn => fn(sql), close: async () => { } }, this.runtimeDir);
            await vault.put(user, name, data.device_code);
            await sql.query("UPDATE oauth_setups SET status='pending',device_credential=$1,token_endpoint=$2,interval_seconds=$3::integer,next_poll=now()+($3::integer*interval '1 second'),expires_at=now()+($4::integer*interval '1 second') WHERE id=$5", [name, tokenEndpoint, Math.max(5, Math.min(60, Number(data.interval) || 5)), data.expires_in, id]);
            return true;
        });
        if (!saved)
            return false;
        await tg.text(user, `Підключення «${row.name}»\nСервіс: ${issuer.origin}\nПотрібні права: ${row.scopes.join(', ')}\n\nВідкрий ${verification.href} та введи код ${data.user_code}. Увійди у свій акаунт і перевір запитані права. Пароль і коди входу боту не надсилай.\n\nТокени зберігатимуться зашифрованими окремо для твого акаунта й цієї групової задачі. Відключення: попроси «відключи ${row.name}». Якщо не погоджуєшся — не підтверджуй на сайті; запит сам завершиться.`);
        return true;
    }
    async tick() {
        const s = await state(this.db);
        if (s.paused)
            return false;
        const r = await one(this.db, "UPDATE oauth_setups SET next_poll=now()+(interval_seconds*interval '1 second') WHERE id=(SELECT id FROM oauth_setups WHERE status='pending' AND next_poll<=now() ORDER BY next_poll LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *");
        if (!r)
            return false;
        if (r.revision !== s.memory_revision || new Date(r.expires_at).getTime() <= Date.now()) {
            await this.db.query("UPDATE oauth_setups SET status='expired' WHERE id=$1", [r.id]);
            if (r.device_credential)
                await this.vault.remove(r.actor_id, r.device_credential);
            return true;
        }
        try {
            const device = await this.vault.get(r.actor_id, r.device_credential);
            const res = await this.request(r.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: r.client_id, device_code: device }).toString(), maxBytes: 200000, redirects: 0 });
            const value = json(res.body);
            if (value.error === 'authorization_pending')
                return true;
            if (value.error === 'slow_down') {
                await this.db.query('UPDATE oauth_setups SET interval_seconds=LEAST(60,interval_seconds+5),next_poll=now()+((interval_seconds+5)*interval \'1 second\') WHERE id=$1', [r.id]);
                return true;
            }
            if (res.status !== 200 || typeof value.access_token !== 'string' || String(value.token_type).toLowerCase() !== 'bearer')
                throw new ToolError('oauth_authorization_failed');
            await this.db.tx(async (sql) => {
                const latest = await state(sql, true);
                const active = await one(sql, "SELECT id FROM oauth_setups WHERE id=$1 AND status='pending'", [r.id]);
                if (latest.paused || latest.memory_revision !== r.revision || !active)
                    throw new ToolError('oauth_request_cancelled');
                const vault = new ConnectorVault({ query: (q, a) => sql.query(q, a), tx: fn => fn(sql), close: async () => { } }, this.runtimeDir);
                await vault.put(r.actor_id, r.name, value.access_token);
                if (value.refresh_token)
                    await vault.put(r.actor_id, 'refresh_' + r.name, value.refresh_token);
                const auth = { issuer: r.issuer, client_id: r.client_id, token_endpoint: r.token_endpoint, scopes: r.scopes, expires_at: new Date(Date.now() + Math.max(60, Number(value.expires_in) || 3600) * 1000).toISOString(), refresh_credential: value.refresh_token ? 'refresh_' + r.name : null };
                await sql.query("INSERT INTO tool_connections(id,owner_id,endpoint,credential_name,auth_metadata,health,verification_task_id,verification_goal_version) VALUES($1,$2,$3,$1,$4,'check_pending',$5,$6) ON CONFLICT(owner_id,id) DO UPDATE SET endpoint=excluded.endpoint,credential_name=excluded.credential_name,auth_metadata=excluded.auth_metadata,enabled=true,health='check_pending',trusted_read_tools='[]',confirmation_contract='{}',verification_task_id=excluded.verification_task_id,verification_goal_version=excluded.verification_goal_version", [r.name, r.actor_id, r.endpoint, JSON.stringify(auth), r.task_id || null, r.goal_version || 1]);
                await sql.query('DELETE FROM tool_grants WHERE actor_id=$1 AND connection_id=$2', [r.actor_id, r.name]);
                if (!value.refresh_token)
                    await vault.remove(r.actor_id, 'refresh_' + r.name);
                await sql.query("UPDATE oauth_setups SET status='completed' WHERE id=$1", [r.id]);
                await vault.remove(r.actor_id, r.device_credential);
                await queueText(sql, `Авторизацію «${r.name}» отримано. Перевіряю інструменти сервісу у фоновій черзі; результат надійде сюди. Пароль у бота не зберігається.`, latest.memory_revision, 'oauth-ready:' + r.id, false, { actorId: r.actor_id, audience: 'private' });
            });
        }
        catch {
            await this.db.query("UPDATE oauth_setups SET status='failed' WHERE id=$1", [r.id]);
            await this.vault.remove(r.actor_id, r.device_credential);
            await queueText(this.db, `Не завершив авторизацію «${r.name}». Перевір підтримку device flow, client ID та права на сайті сервісу; пароль боту не надсилай.`, s.memory_revision, 'oauth-failed:' + r.id, false, { actorId: r.actor_id, audience: 'private' });
        }
        return true;
    }
    async token(owner: string, connection: any) {
        const metadata = connection.auth_metadata;
        if (!metadata?.expires_at || Date.parse(metadata.expires_at) > Date.now() + 60000)
            return connection.credential_name ? this.vault.get(owner, connection.credential_name) : undefined;
        return outsideOperation(() => this.db.tx(async (sql) => {
            const vault = new ConnectorVault({ query: (q, a) => sql.query(q, a), tx: fn => fn(sql), close: async () => { } }, this.runtimeDir);
            const live = await one(sql, 'SELECT * FROM tool_connections WHERE owner_id=$1 AND id=$2 AND enabled=true FOR UPDATE', [owner, connection.id]);
            if (!live)
                throw new ToolError('connection_required');
            const auth = live.auth_metadata;
            if (Date.parse(auth.expires_at) > Date.now() + 60000)
                return vault.get(owner, live.credential_name);
            if (!auth.refresh_credential)
                throw new ToolError('connector_reauthorization_required');
            const refresh = await vault.get(owner, auth.refresh_credential);
            const res = await this.request(endpoint(auth.token_endpoint, auth.issuer), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: auth.client_id, refresh_token: refresh }).toString(), redirects: 0, maxBytes: 200000 });
            const value = json(res.body);
            if (res.status !== 200 || typeof value.access_token !== 'string' || String(value.token_type).toLowerCase() !== 'bearer')
                throw new ToolError('connector_reauthorization_required');
            await vault.put(owner, live.credential_name, value.access_token);
            if (value.refresh_token)
                await vault.put(owner, auth.refresh_credential, value.refresh_token);
            auth.expires_at = new Date(Date.now() + (Number(value.expires_in) || 3600) * 1000).toISOString();
            await sql.query('UPDATE tool_connections SET auth_metadata=$1 WHERE owner_id=$2 AND id=$3', [JSON.stringify(auth), owner, live.id]);
            return value.access_token;
        }));
    }
}
