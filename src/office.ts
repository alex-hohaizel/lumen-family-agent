import { inflateRawSync } from 'node:zlib';
import { DOMParser } from 'linkedom';
import { ToolError } from './safe-http.js';
const xml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
function crc(bytes: Uint8Array) {
    let n = 0xffffffff;
    for (const b of bytes) {
        n ^= b;
        for (let i = 0; i < 8; i++)
            n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
}
export function zipFiles(files: Record<string, string | Buffer>) {
    let offset = 0;
    const locals: Buffer[] = [], central: Buffer[] = [];
    for (const [path, value] of Object.entries(files)) {
        const name = Buffer.from(path), data = Buffer.from(value), sum = crc(data), header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x800, 6);
        header.writeUInt32LE(sum, 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(name.length, 26);
        locals.push(header, name, data);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0x800, 8);
        entry.writeUInt32LE(sum, 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += header.length + name.length + data.length;
    }
    const entries = Object.keys(files).length, dir = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries, 8);
    end.writeUInt16LE(entries, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
}
export function unzipFiles(input: Uint8Array) {
    const data = Buffer.from(input);
    if (data.length > 8000000)
        throw new ToolError('office_too_large');
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--)
        if (data.readUInt32LE(i) === 0x06054b50) {
            end = i;
            break;
        }
    if (end < 0)
        throw new ToolError('office_zip_invalid');
    const entries = data.readUInt16LE(end + 10);
    if (entries > 300)
        throw new ToolError('office_zip_entry_limit');
    let at = data.readUInt32LE(end + 16), total = 0;
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < entries; i++) {
        if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50)
            throw new ToolError('office_zip_invalid');
        const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), size = data.readUInt32LE(at + 20), expected = data.readUInt32LE(at + 24), nameSize = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32), local = data.readUInt32LE(at + 42), name = data.subarray(at + 46, at + 46 + nameSize).toString();
        if (flags & 1 || !name || name.startsWith('/') || name.split('/').includes('..') || expected > 12000000 || size > 8000000 || local + 30 > data.length || ![0, 8].includes(method))
            throw new ToolError('office_zip_unsupported');
        total += expected;
        if (total > 20000000)
            throw new ToolError('office_zip_expansion_limit');
        if (data.readUInt32LE(local) !== 0x04034b50)
            throw new ToolError('office_zip_invalid');
        const begin = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
        if (begin + size > data.length)
            throw new ToolError('office_zip_invalid');
        const packed = data.subarray(begin, begin + size), value = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: 12000000 });
        if (value.length !== expected || crc(value) !== data.readUInt32LE(at + 16))
            throw new ToolError('office_zip_checksum');
        if (Object.hasOwn(files, name))
            throw new ToolError('office_duplicate_part');
        files[name] = value;
        at += 46 + nameSize + extra + comment;
    }
    return files;
}
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const relation = (type: string, target: string) => declaration + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;
export function wordDocument(title: string, paragraphs: string[]) { return zipFiles({ '[Content_Types].xml': declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', '_rels/.rels': relation('officeDocument', 'word/document.xml'), 'word/document.xml': declaration + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + [title, ...paragraphs].map((line, i) => `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:rPr>${i === 0 ? '<w:b/><w:sz w:val="32"/>' : '<w:sz w:val="22"/>'}</w:rPr><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>' }); }
function column(i: number) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26))
        s = String.fromCharCode(65 + (i - 1) % 26) + s;
    return s;
}
export function workbook(rows: (string | number | boolean | null)[][], name = 'Дані') {
    if (rows.length > 1000 || rows.some(r => r.length > 50))
        throw new ToolError('spreadsheet_size_limit');
    return zipFiles({ '[Content_Types].xml': declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', '_rels/.rels': relation('officeDocument', 'xl/workbook.xml'), 'xl/_rels/workbook.xml.rels': relation('worksheet', 'worksheets/sheet1.xml'), 'xl/workbook.xml': declaration + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(name.slice(0, 31).replace(/[\\/?*\[\]:]/g, ' '))}" sheetId="1" r:id="rId1"/></sheets></workbook>`, 'xl/worksheets/sheet1.xml': declaration + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="50" width="22" customWidth="1"/></cols><sheetData>' + rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => {
            const ref = column(j) + (i + 1);
            if (typeof v === 'number') {
                if (!Number.isFinite(v))
                    throw new ToolError('spreadsheet_nonfinite_number');
                return `<c r="${ref}" t="n"><v>${v}</v></c>`;
            }
            if (typeof v === 'boolean')
                return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
        }).join('')}</row>`).join('') + '</sheetData></worksheet>' });
}
export function officeText(bytes: Uint8Array, name: string) {
    const parts = unzipFiles(bytes);
    const parse = (b: Buffer) => {
        const text = b.toString();
        if (/<!DOCTYPE|<!ENTITY/i.test(text))
            throw new ToolError('office_entities_not_allowed');
        return new DOMParser().parseFromString(text, 'text/xml');
    };
    if (/\.docx$/i.test(name)) {
        if (!parts['word/document.xml'])
            throw new ToolError('office_document_part_required');
        const doc = parse(parts['word/document.xml']);
        return [...doc.getElementsByTagName('w:p')].map(p => [...p.getElementsByTagName('w:t')].map(x => x.textContent).join('')).join('\n').slice(0, 30000);
    }
    const shared = parts['xl/sharedStrings.xml'] ? [...parse(parts['xl/sharedStrings.xml']).getElementsByTagName('si')].map(x => x.textContent || '') : [];
    const pages = [];
    for (const [path, part] of Object.entries(parts).filter(([p]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).slice(0, 10)) {
        const sheet = parse(part);
        pages.push(`[Аркуш ${path}]\n` + [...sheet.getElementsByTagName('row')].slice(0, 1000).map(row => [...row.getElementsByTagName('c')].slice(0, 50).map(cell => { const v = cell.getElementsByTagName('v')[0]?.textContent || ''; return `${cell.getAttribute('r')}: ${cell.getAttribute('t') === 's' ? shared[Number(v)] || '' : cell.getAttribute('t') === 'inlineStr' ? cell.getElementsByTagName('t')[0]?.textContent || '' : v}${cell.getElementsByTagName('f').length ? ' [значення формули з файла; не перераховано]' : ''}`; }).join('\t')).join('\n'));
    }
    if (!pages.length)
        throw new ToolError('office_workbook_parts_required');
    return pages.join('\n\n').slice(0, 30000);
}
