import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from './db.js';
const current = new AsyncLocalStorage<AbortController>();
const running = new WeakMap<Database, Map<string, Set<AbortController>>>();
const drains = new WeakMap<Database, Set<() => void>>();
const retained = new WeakMap<AbortController, Set<Database>>();
const active = new WeakSet<AbortController>();
function release(db: Database, key: string, controller: AbortController) {
    const group = running.get(db), jobs = group?.get(key);
    jobs?.delete(controller);
    if (!jobs?.size) group?.delete(key);
    if (!group?.size) {
        for (const done of drains.get(db) || []) done();
        drains.delete(db);
    }
}
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
    active.add(controller);
    try {
        return await current.run(controller, fn);
    }
    finally {
        active.delete(controller);
        release(db, key, controller);
        for (const target of retained.get(controller) || []) release(target, 'runtime_lease', controller);
        retained.delete(controller);
    }
}
// A group operation may temporarily use its owner's personal calendar runtime.
// Keep that runtime until the borrowing operation really finishes, including
// network waits between database calls.
export function retainOperation(db: Database) {
    const controller = current.getStore();
    if (!controller || !active.has(controller)) return;
    let targets = retained.get(controller);
    if (!targets) { targets = new Set(); retained.set(controller, targets); }
    if (targets.has(db)) return;
    targets.add(db);
    let group = running.get(db);
    if (!group) { group = new Map(); running.set(db, group); }
    let jobs = group.get('runtime_lease');
    if (!jobs) { jobs = new Set(); group.set('runtime_lease', jobs); }
    jobs.add(controller);
}
export function operationCount(db: Database) {
    let count = 0;
    for (const jobs of running.get(db)?.values() || []) count += jobs.size;
    return count;
}
export async function drainOperations(db: Database) {
    if (!operationCount(db)) return;
    await new Promise<void>(resolve => {
        let waiting = drains.get(db);
        if (!waiting) { waiting = new Set(); drains.set(db, waiting); }
        waiting.add(resolve);
    });
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
