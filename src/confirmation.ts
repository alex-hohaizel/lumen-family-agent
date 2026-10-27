import { ToolError } from './safe-http.js';
export function fieldAt(object: any, path: string) {
    if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){0,5}$/.test(path) || path.split('.').some(x => ['__proto__', 'constructor', 'prototype'].includes(x)))
        throw new ToolError('confirmation_field_path_invalid');
    return path.split('.').reduce((v, k) => v && Object.hasOwn(v, k) ? v[k] : undefined, object);
}
export function structuredToolResult(value: any) {
    if (value?.structuredContent)
        return value.structuredContent;
    for (const part of value?.content || [])
        if (part.type === 'text' && typeof part.text === 'string')
            try {
                const parsed = JSON.parse(part.text);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                    return parsed;
            }
            catch { }
    return value;
}
export function confirmContract(result: any, contract: any, expected: any, reference: string) {
    if (!contract?.status_path || !contract.reference_path || !contract.amount_minor_path || !contract.currency_path)
        return { confirmed: false, reason: 'provider_contract_not_configured' };
    const value = structuredToolResult(result);
    const checks = { status: fieldAt(value, contract.status_path) === contract.confirmed_status, reference: ['string', 'number'].includes(typeof fieldAt(value, contract.reference_path)) && String(fieldAt(value, contract.reference_path)) === reference, amount_minor: String(fieldAt(value, contract.amount_minor_path)) === String(expected.minor), currency: fieldAt(value, contract.currency_path) === expected.currency, start: !expected.start_at || Boolean(contract.start_path) && Date.parse(fieldAt(value, contract.start_path)) === Date.parse(expected.start_at), end: !expected.end_at || Boolean(contract.end_path) && Date.parse(fieldAt(value, contract.end_path)) === Date.parse(expected.end_at) };
    return { confirmed: Object.values(checks).every(Boolean), checks };
}
