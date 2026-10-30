import {randomUUID} from 'node:crypto';
import {one, state, type Database, type SQL} from './db.js';
import {digest, sourceIds} from './evolution-core.js';
import {recordProvenance} from './provenance.js';
import {checkOperation} from './operations.js';
import {ToolError} from './safe-http.js';
import type {ToolContext} from './agent-tools.js';

export const MEDIA_PAYLOAD_LIMIT_BYTES = 48 * 1024 * 1024;
export const MEDIA_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export interface MediaSourceRef {
  attachment_id?: number;
  artifact_id?: string;
}
export type InspectionStatus = 'requested' | 'read' | 'partial' | 'unknown' | 'failed';
export interface InspectionSpec {
  kind: 'pdf_page' | 'pdf_request' | 'video_frame' | 'video_answer' | 'video_request';
  address: string;
  requested: Record<string, unknown>;
  decoderVersion: string;
  modelVersion?: string;
  promptVersion?: string;
  questionHash?: string;
}
export interface InspectionWrite {
  spec: InspectionSpec;
  status: InspectionStatus;
  coverage: Record<string, unknown>;
  payload?: unknown;
  errorCode?: string;
}
interface SourceSnapshot {
  namespace: string;
  sourceKind: 'attachment' | 'artifact';
  sourceRef: string;
  sourceMessageId: number | null;
  originalSourceIds: number[];
  sourceVersion: string;
  requestVersion: string;
}
export interface InspectionLease extends SourceSnapshot {
  ref: MediaSourceRef;
  context: ToolContext;
  sourceIds: number[];
  contentSha256: string;
}
export interface InspectionHit {
  id: string;
  status: InspectionStatus;
  coverage: Record<string, any>;
  payload: any;
}
interface InspectionOptions {
  payloadLimitBytes?: number;
  payloadTtlMs?: number;
  now?: () => number;
}

const ids = (values: number[]) => [...new Set(values.filter(x => Number.isSafeInteger(x) && x > 0))].sort((a, b) => a - b);

async function messageVersions(sql: SQL, sources: number[], lock: boolean) {
  if (!sources.length) return [];
  const rows = (await sql.query(
    `SELECT id,user_id,role,body,created_at,edited_at FROM messages WHERE id=ANY($1::bigint[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
    [sources]
  )).rows;
  if (rows.length !== sources.length) throw new ToolError('media_source_unavailable');
  return rows;
}

async function snapshot(sql: SQL, ref: MediaSourceRef, c: ToolContext, lock = false): Promise<SourceSnapshot> {
  checkOperation();
  if (Boolean(ref.attachment_id) === Boolean(ref.artifact_id)) throw new ToolError('one_known_input_required');
  const live = await state(sql, lock);
  if (live.paused || live.memory_revision !== c.revision) throw new ToolError('task_cancelled');
  const namespace = String(live.chat_id ?? c.chatId);
  if (Number(c.chatId) < 0 && namespace !== c.chatId) throw new ToolError('other_chat');
  const suffix = lock ? ' FOR SHARE' : '';
  let item: Record<string, any> | undefined;
  let originals: number[];
  let privateDelivery = false;
  if (ref.artifact_id) {
    item = await one(sql, `SELECT id,actor_id,revision,source_message_id,name,mime,encoding,content,created_at FROM agent_artifacts WHERE id=$1 AND actor_id=$2${suffix}`, [ref.artifact_id, c.actorId]);
    if (!item || item.revision !== c.revision) throw new ToolError('own_current_artifact_required');
    privateDelivery = Boolean(await one(sql, "SELECT id FROM outbox WHERE body->>'id'=$1 AND audience='private' LIMIT 1", [ref.artifact_id]));
    if (privateDelivery && c.audience !== 'private' && Number(c.chatId) < 0) throw new ToolError('private_input_cannot_widen_audience');
    originals = ids((await sql.query("SELECT source_message_id FROM provenance_edges WHERE derived_kind='artifact' AND derived_key=$1 ORDER BY source_message_id", [ref.artifact_id])).rows.map(row => Number(row.source_message_id)));
  } else {
    item = await one(sql, `SELECT id,revision,source_message_id,kind,file_id,file_unique_id,mime,metadata,created_at FROM attachments WHERE id=$1 AND revision=$2${suffix}`, [ref.attachment_id, c.revision]);
    if (!item) throw new ToolError('known_attachment_required');
    originals = [];
  }
  const sourceMessageId = item.source_message_id ? Number(item.source_message_id) : null;
  originals = ids([...originals, ...(sourceMessageId ? [sourceMessageId] : [])]);
  // Request dependencies are checked separately: a new question may reuse the same
  // original, while an edited/forgotten question may never commit a late result.
  const requestIds = ids(sourceIds(c));
  const originalVersions = await messageVersions(sql, originals, lock);
  const requestVersions = await messageVersions(sql, requestIds, lock);
  return {
    namespace,
    sourceKind: ref.artifact_id ? 'artifact' : 'attachment',
    sourceRef: String(ref.artifact_id ?? ref.attachment_id),
    sourceMessageId,
    originalSourceIds: originals,
    sourceVersion: digest({item, messages: originalVersions, privateDelivery}),
    requestVersion: digest(requestVersions)
  };
}

function cacheKey(lease: InspectionLease, spec: InspectionSpec) {
  return digest({
    namespace: lease.namespace, sourceKind: lease.sourceKind, sourceRef: lease.sourceRef,
    contentSha256: lease.contentSha256, sourceVersion: lease.sourceVersion,
    revision: lease.context.revision, actorId: lease.context.actorId,
    audience: lease.context.audience || 'group', kind: spec.kind, address: spec.address,
    decoderVersion: spec.decoderVersion, modelVersion: spec.modelVersion || '',
    promptVersion: spec.promptVersion || '', questionHash: spec.questionHash || ''
  });
}

/** Removes reproducible payloads only. Historical coverage and originals remain. */
export async function pruneMediaInspectionPayloads(
  sql: SQL, namespace?: string, maxBytes = MEDIA_PAYLOAD_LIMIT_BYTES, now = new Date()
) {
  await sql.query('DELETE FROM media_inspection_payloads WHERE expires_at<=$1', [now]);
  await sql.query(`DELETE FROM media_inspection_payloads WHERE inspection_id IN (
    SELECT inspection_id FROM (
      SELECT p.inspection_id,SUM(p.payload_bytes) OVER (
        PARTITION BY i.namespace ORDER BY p.last_used_at DESC,p.inspection_id
      ) AS running_bytes
      FROM media_inspection_payloads p JOIN media_inspections i ON i.id=p.inspection_id
      ${namespace === undefined ? '' : 'WHERE i.namespace=$2'}
    ) bounded WHERE running_bytes>$1
  )`, namespace === undefined ? [Math.max(0, maxBytes)] : [Math.max(0, maxBytes), namespace]);
}

export class MediaInspections {
  private readonly limit: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly db: Database, options: InspectionOptions = {}) {
    this.limit = Math.max(0, options.payloadLimitBytes ?? MEDIA_PAYLOAD_LIMIT_BYTES);
    this.ttl = Math.max(1, options.payloadTtlMs ?? MEDIA_PAYLOAD_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  /** Capture before inputBinary's download, then bind its actual bytes below. */
  async begin(ref: MediaSourceRef, c: ToolContext): Promise<InspectionLease> {
    const current = await snapshot(this.db, ref, c);
    return {
      ...current, ref: {...ref}, context: {...c, sourceIds: [...(c.sourceIds || [])]},
      sourceIds: ids([...current.originalSourceIds, ...sourceIds(c)]), contentSha256: ''
    };
  }

  async bind(lease: InspectionLease, bytes: Uint8Array, actualSourceIds: number[]) {
    if (digest(ids(actualSourceIds)) !== digest(lease.sourceIds)) throw new ToolError('media_source_changed');
    const bound = {...lease, contentSha256: digest(bytes)};
    await this.assertCurrent(bound);
    return bound;
  }

  private async verify(sql: SQL, lease: InspectionLease, lock: boolean) {
    checkOperation();
    if (!lease.contentSha256) throw new ToolError('media_content_not_bound');
    const current = await snapshot(sql, lease.ref, lease.context, lock);
    if (current.namespace !== lease.namespace || current.sourceVersion !== lease.sourceVersion || current.requestVersion !== lease.requestVersion)
      throw new ToolError('media_source_changed');
  }

  async assertCurrent(lease: InspectionLease) {
    await this.db.tx(sql => this.verify(sql, lease, true));
  }

  async lookup(lease: InspectionLease, specs: InspectionSpec[]): Promise<Map<string, InspectionHit>> {
    return this.db.tx(async sql => {
      await this.verify(sql, lease, true);
      const keys = specs.map(spec => cacheKey(lease, spec));
      if (!keys.length) return new Map();
      const rows = (await sql.query(`SELECT i.id,i.cache_key,i.status,i.coverage,p.payload
        FROM media_inspections i JOIN media_inspection_payloads p ON p.inspection_id=i.id
        WHERE i.cache_key=ANY($1::text[]) AND p.expires_at>$2`, [keys, new Date(this.now())])).rows;
      for (const row of rows) await recordProvenance(sql, 'media_inspection', row.id, lease.sourceIds);
      if (rows.length) await sql.query('UPDATE media_inspection_payloads SET last_used_at=$1 WHERE inspection_id=ANY($2::uuid[])', [new Date(this.now()), rows.map(row => row.id)]);
      return new Map(rows.map(row => [row.cache_key, {id: row.id, status: row.status, coverage: row.coverage, payload: row.payload}]));
    });
  }

  hit(hits: Map<string, InspectionHit>, lease: InspectionLease, spec: InspectionSpec) {
    return hits.get(cacheKey(lease, spec));
  }

  async store(lease: InspectionLease, writes: InspectionWrite[]) {
    await this.db.tx(async sql => {
      await this.verify(sql, lease, true);
      const now = new Date(this.now());
      for (const write of writes) {
        const spec = write.spec;
        const row = await one(sql, `INSERT INTO media_inspections(
          id,cache_key,namespace,source_kind,source_ref,attachment_id,artifact_id,source_message_id,request_source_id,
          source_ids,content_sha256,source_version,revision,actor_id,audience,topic_id,kind,address,requested,
          decoder_version,model_version,prompt_version,question_hash,status,coverage,error_code,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
        ON CONFLICT(cache_key) DO UPDATE SET status=excluded.status,coverage=excluded.coverage,
          error_code=excluded.error_code,updated_at=excluded.updated_at RETURNING id`, [
          randomUUID(), cacheKey(lease, spec), lease.namespace, lease.sourceKind, lease.sourceRef,
          lease.ref.attachment_id ?? null, lease.ref.artifact_id ?? null, lease.sourceMessageId,
          lease.context.sourceId ?? null, JSON.stringify(lease.sourceIds), lease.contentSha256,
          lease.sourceVersion, lease.context.revision, lease.context.actorId,
          lease.context.audience || 'group', lease.context.topicId, spec.kind, spec.address,
          JSON.stringify(spec.requested), spec.decoderVersion, spec.modelVersion || '', spec.promptVersion || '',
          spec.questionHash || '', write.status, JSON.stringify(write.coverage), write.errorCode || null, now
        ]);
        await recordProvenance(sql, 'media_inspection', row!.id, lease.sourceIds);
        if (write.payload !== undefined) {
          const payload = JSON.stringify(write.payload), size = Buffer.byteLength(payload);
          // An oversized derived result still has truthful metadata, but no cache.
          if (size <= this.limit) await sql.query(`INSERT INTO media_inspection_payloads(inspection_id,payload,payload_bytes,expires_at,last_used_at)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(inspection_id) DO UPDATE SET payload=excluded.payload,
            payload_bytes=excluded.payload_bytes,expires_at=excluded.expires_at,last_used_at=excluded.last_used_at`,
            [row!.id, payload, size, new Date(this.now() + this.ttl), now]);
          else await sql.query('DELETE FROM media_inspection_payloads WHERE inspection_id=$1', [row!.id]);
        }
      }
      await pruneMediaInspectionPayloads(sql, lease.namespace, this.limit, now);
    });
  }

  async coverage(lease: InspectionLease, limit = 100) {
    return this.db.tx(async sql => {
      await this.verify(sql, lease, true);
      await pruneMediaInspectionPayloads(sql, lease.namespace, this.limit, new Date(this.now()));
      const scope = [lease.namespace, lease.context.actorId, lease.context.audience || 'group', lease.context.revision,
        lease.sourceKind, lease.sourceRef, lease.contentSha256, lease.sourceVersion];
      const filter = 'i.namespace=$1 AND i.actor_id=$2 AND i.audience=$3 AND i.revision=$4 AND i.source_kind=$5 AND i.source_ref=$6 AND i.content_sha256=$7 AND i.source_version=$8';
      const counts = (await sql.query(`SELECT kind,status,count(*)::integer AS count FROM media_inspections i WHERE ${filter} GROUP BY kind,status`, scope)).rows;
      const items = (await sql.query(`SELECT i.id,i.kind,i.requested,i.status,i.coverage,i.error_code,
          i.decoder_version,i.model_version,i.prompt_version,i.updated_at,
          (p.inspection_id IS NOT NULL) AS payload_cached
        FROM media_inspections i LEFT JOIN media_inspection_payloads p ON p.inspection_id=i.id
        WHERE ${filter} ORDER BY i.updated_at DESC,i.id LIMIT $9`, [...scope, Math.min(200, Math.max(1, limit))])).rows;
      return {
        source: {kind: lease.sourceKind, ref: lease.sourceRef, sha256: lease.contentSha256, version: lease.sourceVersion},
        revision: lease.context.revision, audience: lease.context.audience || 'group', counts, items,
        source_message_ids: lease.sourceIds,
        notice: 'Лише огляди цього автора й цієї аудиторії для поточної версії джерела. unknown не означає прочитано; payload_cached=false означає, що для повторної відповіді дані треба відтворити.'
      };
    });
  }
}
