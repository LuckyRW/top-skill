/**
 * A minimal .xlsx writer: one sheet, strings and numbers, no styles.
 *
 * An .xlsx is a zip of a few XML files. The zip is written uncompressed
 * ("stored"), which every spreadsheet app reads, so no library is bundled.
 */

export type Cell = string | number | null | undefined;

const esc = (s: string) => s
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
	// XML 1.0 forbids most control characters
	// eslint-disable-next-line no-control-regex
	.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** Column letters for a 0-based index: 0 -> A, 26 -> AA. */
export const column = (i: number): string => {
	let s = '';
	for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
	return s;
};

const sheetXml = (rows: Cell[][]): string => {
	const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
		const ref = `${column(c)}${r + 1}`;
		if (cell === null || cell === undefined || cell === '') return '';
		if (typeof cell === 'number') return Number.isFinite(cell) ? `<c r="${ref}"><v>${cell}</v></c>` : '';
		return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
	}).join('')}</row>`).join('');
	return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
		+ '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
		+ '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
		+ `<sheetData>${body}</sheetData></worksheet>`;
};

const files = (sheetName: string, rows: Cell[][]): [string, string][] => [
	['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
		+ '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
		+ '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
		+ '<Default Extension="xml" ContentType="application/xml"/>'
		+ '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
		+ '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
		+ '</Types>'],
	['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
		+ '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
		+ '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
		+ '</Relationships>'],
	['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
		+ '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
		+ `<sheets><sheet name="${esc(sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
	['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
		+ '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
		+ '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
		+ '</Relationships>'],
	['xl/worksheets/sheet1.xml', sheetXml(rows)],
];

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
const crc32 = (data: Uint8Array): number => {
	let c = 0xffffffff;
	for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

/** An uncompressed zip of `entries`. */
export const zip = (entries: [string, Uint8Array][]): Uint8Array<ArrayBuffer> => {
	const enc = new TextEncoder();
	const local: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const nameBytes = enc.encode(name);
		const crc = crc32(data);
		const head = new DataView(new ArrayBuffer(30));
		head.setUint32(0, 0x04034b50, true);
		head.setUint16(4, 20, true);
		head.setUint16(6, 0x0800, true); // UTF-8 names
		head.setUint16(8, 0, true); // stored
		head.setUint16(12, 0x21, true); // 1980-01-01
		head.setUint32(14, crc, true);
		head.setUint32(18, data.length, true);
		head.setUint32(22, data.length, true);
		head.setUint16(26, nameBytes.length, true);
		local.push(new Uint8Array(head.buffer), nameBytes, data);

		const dir = new DataView(new ArrayBuffer(46));
		dir.setUint32(0, 0x02014b50, true);
		dir.setUint16(4, 20, true);
		dir.setUint16(6, 20, true);
		dir.setUint16(8, 0x0800, true);
		dir.setUint16(14, 0x21, true);
		dir.setUint32(16, crc, true);
		dir.setUint32(20, data.length, true);
		dir.setUint32(24, data.length, true);
		dir.setUint16(28, nameBytes.length, true);
		dir.setUint32(42, offset, true);
		central.push(new Uint8Array(dir.buffer), nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const dirSize = central.reduce((n, p) => n + p.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, dirSize, true);
	end.setUint32(16, offset, true);
	const parts = [...local, ...central, new Uint8Array(end.buffer)];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
};

/** A one-sheet workbook; the first row is the header and stays frozen. */
export const workbook = (sheetName: string, rows: Cell[][]): Uint8Array<ArrayBuffer> => {
	const enc = new TextEncoder();
	return zip(files(sheetName, rows).map(([name, text]) => [name, enc.encode(text)]));
};
