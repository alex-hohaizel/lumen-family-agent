import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from './db.js';
const current = new AsyncLocalStorage<AbortController>();
const running = new WeakMap<Database, Map<string, Set<AbortController>>>();
export async function runOperation<T>(db: Database, key: string, fn: () => Promise<T>) {
    let group = running.get(db);
    if (!group) {
        group = new Map();
        running.set(db, group);
    }
    let jobs = group.get(key);
    if (!jobs) {
        jobs = new Set();
        group.set(key, jobs);
    }
    const controller = new AbortController();
    jobs.add(controller);
    try {
        return await current.run(controller, fn);
    }
    finally {
        jobs.delete(controller);
        if (!jobs.size)
            group.delete(key);
    }
}
export function operationSignal(timeout?: number) { const signal = current.getStore()?.signal; return timeout ? signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) : signal; }
export function checkOperation() { operationSignal()?.throwIfAborted(); }
export function cancelOperations(db: Database, key?: string) {
    for (const [scope, jobs] of running.get(db) || [])
        if (!key || scope === key)
            for (const job of jobs)
                job.abort(new Error('operation_cancelled'));
}
export function stableId(key: string) { const bytes = createHash('sha256').update(key).digest().subarray(0, 16); bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128; const s = bytes.toString('hex'); return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-'); }
export function outsideOperation<T>(fn: () => Promise<T>) { return current.exit(fn); }
