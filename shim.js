// iPad / offline build: replaces the Python server. The page still calls /api/..., this file answers those calls
// in the browser (pdf.js renders + reads text, pdf-lib edits/exports, IndexedDB stores books + notes).
(() => {
'use strict';
const L = window.pdfjsLib, PL = window.PDFLib;
L.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

// ---- storage: books (meta+notes), blobs (the PDF bytes, kept apart so saving notes is cheap), kv, idx (page texts)
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('pdfnotes', 1);
  r.onupgradeneeded = () => ['books', 'blobs', 'kv', 'idx'].forEach(s => r.result.createObjectStore(s, s === 'books' ? {keyPath: 'name'} : undefined));
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const idb = async (store, mode, f) => {
  const db = await dbp;
  return new Promise((res, rej) => { const t = db.transaction(store, mode), r = f(t.objectStore(store)); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); });
};
const get = (s, k) => idb(s, 'readonly', o => o.get(k));
const put = (s, v, k) => idb(s, 'readwrite', o => o.put(v, k));
const del = (s, k) => idb(s, 'readwrite', o => o.delete(k));
const keys = s => idb(s, 'readonly', o => o.getAllKeys());
const every = s => idb(s, 'readonly', o => o.getAll());

// ---- the open book
let B = null;   // {rec, pdf, sizes, words: Map, urls: Map}
const saveRec = () => put('books', B.rec);
async function outline(pdf) {
  const out = [];
  const walk = async (items, l) => {
    for (const it of items || []) {
      let p = 1;
      try { let d = it.dest; if (typeof d === 'string') d = await pdf.getDestination(d); if (d) p = (await pdf.getPageIndex(d[0])) + 1; } catch (e) {}
      out.push([l, it.title || '', p]); await walk(it.items, l + 1);
    }
  };
  try { await walk(await pdf.getOutline(), 1); } catch (e) {}
  return out;
}
async function openRec(rec) {
  const blob = await get('blobs', rec.name);
  if (B) { try { B.pdf.destroy(); } catch (e) {} B.urls.forEach(u => URL.revokeObjectURL(u)); }
  const pdf = await L.getDocument({data: await blob.arrayBuffer()}).promise, sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) { const v = (await pdf.getPage(i)).getViewport({scale: 1}); sizes.push([v.width, v.height]); }
  B = {rec, pdf, sizes, words: new Map(), urls: new Map()};
  if (!rec.toc) { rec.toc = await outline(pdf); await saveRec(); }
}
async function state() {
  const books = (await keys('books')).sort(), prefs = (await get('kv', 'prefs')) || {};
  if (!B) return {open: false, books, prefs};
  const r = B.rec;
  return {open: true, name: r.name, pages: B.sizes.length, notes: r.notes, meta: r.meta, prefs, sizes: B.sizes, toc: r.toc, books, bak: !!r.bak};
}
function pickFile() {   // must run inside the tap that asked for it
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/pdf,.pdf';
    i.onchange = () => res(i.files[0] || null); i.oncancel = () => res(null); i.click();
  });
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 5000);
}
const dl = (text, name, type = 'text/plain') => download(new Blob([text], {type: type + ';charset=utf-8'}), name);
async function openFile(f) {
  if (!f) return;
  const name = f.name.replace(/[^\w.\- ()ऀ-ॿ]/g, '_');
  if (!(await get('books', name))) {
    await put('blobs', f, name);
    await put('books', {name, notes: [], meta: {}, toc: null, added: Date.now()});
  }
  await openRec(await get('books', name));
}

// ---- page images (JPEG blobs, rendered one at a time)
let chain = Promise.resolve();
function render(kind, i) {
  const key = kind + i;
  if (B.urls.has(key)) return Promise.resolve(B.urls.get(key));
  const b = B;
  const job = chain.then(async () => {
    const page = await b.pdf.getPage(i + 1), w = b.sizes[i][0];
    const vp = page.getViewport({scale: kind === 'thumb' ? 40 / 72 : Math.min(170 / 72, 2200 / w)});
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await page.render({canvasContext: x, viewport: vp, annotationMode: 0}).promise;
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .9));
    const u = URL.createObjectURL(blob); b.urls.set(key, u); c.width = c.height = 0;
    return u;
  });
  chain = job.catch(() => {});
  return job;
}
window.setImg = (img, kind, i) => { render(kind, +i).then(u => { img.src = u; }).catch(() => {}); };

// ---- words / text
async function words(i) {   // [x0,y0,x1,y1,line-id,word] normalised to the page
  if (B.words.has(i)) return B.words.get(i);
  const page = await B.pdf.getPage(i + 1), vp = page.getViewport({scale: 1}), tc = await page.getTextContent(), out = [];
  tc.items.forEach((it, k) => {
    if (!it.str || !it.str.trim()) return;
    const m = L.Util.transform(vp.transform, it.transform), fh = Math.hypot(m[2], m[3]), n = it.str.length;
    for (const w of it.str.matchAll(/\S+/g)) {
      const x0 = m[4] + it.width * w.index / n, x1 = m[4] + it.width * (w.index + w[0].length) / n;
      out.push([x0 / vp.width, (m[5] - fh * .85) / vp.height, x1 / vp.width, (m[5] + fh * .2) / vp.height, k, w[0]]);
    }
  });
  B.words.set(i, out); return out;
}
async function pageTexts(pdf) {
  const t = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    t.push(tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
  }
  return t;
}
async function textsOf(name) {
  let t = await get('idx', name);
  if (!t && B && B.rec.name === name) { t = await pageTexts(B.pdf); await put('idx', t, name); }
  return t || null;
}

// ---- search (same behaviour as the Mac version)
const WC = '[\\p{L}\\p{N}\\p{M}_]';
const termRes = (terms, cs, whole) => terms.map(t => {
  const p = t.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(whole ? `(?<!${WC})${p}(?!${WC})` : p, 'gu' + (cs ? '' : 'i'));
});
const sentStarts = txt => [0, ...[...txt.matchAll(/(?<=[.!?])\s+(?=[A-Z(\[])/g)].map(m => m.index + m[0].length)];
const bisectRight = (a, x) => { let l = 0, h = a.length; while (l < h) { const m = (l + h) >> 1; if (x < a[m]) h = m; else l = m + 1; } return l; };
async function search(q) {
  const terms = [...new Set((q.q || '').normalize('NFC').split(',').map(t => t.trim().replace(/^"|"$/g, '')))].filter(Boolean);
  const out = {book: [], notes: [], state: 'ready', unindexed: 0, terms, counts: terms.map(() => 0), pages: [], total: 0};
  if (!terms.length) return out;
  const cs = !!q.case, res = termRes(terms, cs, !!q.whole), needAll = q.mode === 'all';
  const targets = q.scope === 'book' ? (B ? [B.rec.name] : []) : await keys('books');
  for (const name of targets) {
    const t = await textsOf(name);
    if (!t) { out.unindexed++; continue; }
    for (let i = 0; i < t.length; i++) {
      const txt = t[i].split(/\s+/).filter(Boolean).join(' ');
      const pos = res.map(r => [...txt.matchAll(r)].map(m => m.index));
      if (!pos.some(p => p.length) || (needAll && !pos.every(p => p.length))) continue;
      pos.forEach((p, k) => { out.counts[k] += p.length; });
      if (B && name === B.rec.name) out.pages.push(i);
      out.total++;
      if (out.book.length >= 400) continue;
      const st = sentStarts(txt), seen = new Map();
      pos.forEach((ps, k) => ps.forEach(x => { const j = bisectRight(st, x) - 1; if (!seen.has(j)) seen.set(j, new Set()); seen.get(j).add(k); }));
      const sen = j => txt.slice(st[j], j + 1 < st.length ? st[j + 1] : txt.length).trim();
      [...seen.keys()].sort((a, b) => a - b).forEach(j => {
        const cur = sen(j), marks = [];
        res.forEach((r, k) => { for (const m of cur.matchAll(r)) marks.push([m.index, m.index + m[0].length, k]); });
        marks.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
        const prev = [], next = [];
        for (let x = Math.max(0, j - 2); x < j; x++) prev.push(sen(x));
        for (let x = j + 1; x < Math.min(st.length, j + 3); x++) next.push(sen(x));
        out.book.push({book: name, page: i, cur, marks, prev, next});
      });
    }
  }
  const low = terms.map(t => t.toLowerCase());
  for (const b of await library()) {
    if (q.scope === 'book' && B && b.book !== B.rec.name) continue;
    for (const n of b.notes) {
      const hay = (n.quote + ' ' + n.text + ' ' + n.tags.join(' ')).toLowerCase();
      if (needAll ? low.every(w => hay.includes(w)) : low.some(w => hay.includes(w))) out.notes.push({book: b.book, page: n.page, quote: n.quote, text: n.text});
    }
  }
  return out;
}
async function hits(q) {
  const ws = await words(q.page), terms = (q.terms || []).map(String);
  let txt = ''; const starts = [];
  ws.forEach(w => { starts.push(txt.length); txt += w[5] + ' '; });
  const out = [];
  termRes(terms, !!q.case, !!q.whole).forEach((r, k) => {
    for (const m of txt.matchAll(r)) {
      const lines = new Map();
      ws.slice(bisectRight(starts, m.index) - 1, bisectRight(starts, m.index + m[0].length - 1)).forEach(w => {
        const c = lines.get(w[4]);
        lines.set(w[4], c ? [Math.min(c[0], w[0]), Math.min(c[1], w[1]), Math.max(c[2], w[2]), Math.max(c[3], w[3])] : w.slice(0, 4));
      });
      lines.forEach(c => out.push([...c, k]));
    }
  });
  return {r: out};
}

// ---- library / meta
const META = ['title', 'author', 'year', 'journal', 'volume', 'pages', 'doi', 'citekey'];
function citekey(m, book) {
  if (m.citekey) return m.citekey;
  const last = (m.author || '').split(' and ')[0].split(',')[0].replace(/\W/g, '').toLowerCase();
  const word = ((m.title || '').toLowerCase().match(/[a-z]{4,}/) || [''])[0];
  return last + (m.year || '') + word || book.replace(/\.pdf$/i, '').replace(/\W+/g, '_').toLowerCase();
}
async function library() {
  return (await every('books')).sort((a, b) => a.name.localeCompare(b.name)).map(r => ({
    book: r.name, meta: r.meta || {}, key: citekey(r.meta || {}, r.name),
    notes: r.notes.filter(n => n.quote || n.text).map(n => ({id: n.id, page: n.page, quote: n.quote || '', text: n.text || '', tags: n.tags || [], hc: n.hc || '#e6a800', card: n.card}))}));
}
async function exportAll(md) {
  const bib = [], csl = [];
  for (const b of await library()) {
    const m = b.meta, k = b.key, au = (m.author || '').split(' and ').map(a => a.trim()).filter(Boolean);
    const f = {title: '{' + (m.title || b.book) + '}', author: au.join(' and '), year: m.year, journal: m.journal, volume: m.volume, pages: m.pages, doi: m.doi};
    bib.push(`@${m.journal ? 'article' : 'misc'}{${k},\n` + Object.entries(f).filter(([, v]) => v).map(([a, v]) => `  ${a} = {${v}},\n`).join('') + '}\n');
    const c = {id: k, type: m.journal ? 'article-journal' : 'document', title: m.title || b.book,
      author: au.map(a => ({family: a.split(',')[0].trim(), given: a.split(',').slice(1).join(',').trim()})),
      issued: /^\d+$/.test(m.year || '') ? {'date-parts': [[+m.year]]} : null, 'container-title': m.journal, volume: m.volume, page: m.pages, DOI: m.doi};
    csl.push(Object.fromEntries(Object.entries(c).filter(([, v]) => v)));
  }
  dl(md, 'notes_export.md', 'text/markdown'); dl(bib.join('\n'), 'library.bib');
  dl(JSON.stringify(csl, null, 1), 'library.json', 'application/json');
}

// ---- study log
async function studyStats() {
  const log = (await get('kv', 'study')) || [], days = {}, by = {}, iso = d => d.toISOString().slice(0, 10), today = new Date();
  log.forEach(r => { days[r.d] = (days[r.d] || 0) + r.secs; by[r.book] = (by[r.book] || 0) + r.secs; });
  const ago = n => iso(new Date(today.getTime() - n * 864e5));
  const week = [6, 5, 4, 3, 2, 1, 0].map(n => [ago(n), days[ago(n)] || 0]);
  let streak = 0, n = days[ago(0)] ? 0 : 1;
  while (days[ago(n)]) { streak++; n++; }
  return {today: days[ago(0)] || 0, week, streak, books: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 15)};
}

// ---- page edits (pdf-lib): delete / blank / insert pages, margin. One-level undo kept in rec.bak.
async function mutate(fn) {
  const r = B.rec, blob = await get('blobs', r.name);
  const doc = await PL.PDFDocument.load(await blob.arrayBuffer(), {ignoreEncryption: true});
  r.bak = {notes: JSON.parse(JSON.stringify(r.notes)), toc: r.toc};
  await put('blobs', blob, r.name + '\u0000bak');
  await fn(doc, r);
  await put('blobs', new Blob([await doc.save({useObjectStreams: true})], {type: 'application/pdf'}), r.name);
  await del('idx', r.name); await saveRec(); await openRec(r);
}
async function edit(q) {
  const i = +q.page;
  if (!B || !(i >= 0 && i < B.sizes.length)) return;
  let src = null;
  if (q.op === 'pdf') { const f = await pickFile(); if (!f) return; src = await PL.PDFDocument.load(await f.arrayBuffer(), {ignoreEncryption: true}); }
  if (q.op === 'delete' && B.sizes.length < 2) return;
  await mutate(async (doc, r) => {
    let k = 1;
    if (q.op === 'delete') {
      doc.removePage(i);
      r.toc = r.toc.filter(e => e[2] - 1 !== i).map(e => [e[0], e[1], e[2] - (e[2] - 1 > i)]);
      r.notes = r.notes.filter(n => n.page !== i); r.notes.forEach(n => { n.page -= n.page > i; });
      return;
    }
    if (q.op === 'blank') { const [w, h] = B.sizes[i]; doc.insertPage(i + 1, [w, h]); }
    else { const ps = await doc.copyPages(src, src.getPageIndices()); k = ps.length; ps.forEach((p, j) => doc.insertPage(i + 1 + j, p)); }
    r.notes.forEach(n => { n.page += k * (n.page > i); });
    r.toc = r.toc.map(e => [e[0], e[1], e[2] + k * (e[2] - 1 > i)]);
  });
}
async function margin(q) {
  const pct = Math.max(0, Math.min(300, +q.pct || 0)), pages = q.all ? B.sizes.map((_, i) => i) : [+q.page];
  await mutate(async (doc, r) => {
    const key = PL.PDFName.of('NotesBase');
    pages.forEach(i => {
      const pg = doc.getPage(i);
      if (pg.getRotation().angle) return;
      const c = pg.node.has(PL.PDFName.of('CropBox')) ? pg.getCropBox() : pg.getMediaBox(), mb = pg.getMediaBox();
      const old = c.width, saved = pg.node.get(key), base = saved && saved.asNumber ? saved.asNumber() : old, nw = base * (1 + pct / 100);
      if (Math.abs(nw - old) < .01) return;
      if (base === old && pct) pg.node.set(key, PL.PDFNumber.of(base));
      if (!pct) pg.node.delete(key);
      pg.setMediaBox(mb.x, mb.y, mb.width + nw - old, mb.height);
      if (pg.node.has(PL.PDFName.of('CropBox'))) pg.setCropBox(c.x, c.y, nw, c.height);
      const f = old / nw;
      r.notes.forEach(n => {
        if (n.page !== i) return;
        n.rect = [n.rect[0] * f, n.rect[1], n.rect[2] * f, n.rect[3]];
        if (n.hl) n.hl = n.hl.map(a => [a[0] * f, a[1], a[2] * f, a[3]]);
        (n.ink || []).forEach(k => { k.pts = k.pts.map(([x, y]) => [x * f, y]); });
      });
    });
  });
}
async function restore() {
  const r = B && B.rec;
  if (!r || !r.bak) return;
  await put('blobs', await get('blobs', r.name + '\u0000bak'), r.name);
  r.notes = r.bak.notes; r.toc = r.bak.toc; delete r.bak;
  await del('blobs', r.name + '\u0000bak'); await del('idx', r.name); await saveRec(); await openRec(r);
}

// ---- export: a flattened copy (highlights, drawings, pictures drawn onto the pages)
async function exportPdf() {
  const r = B.rec, doc = await PL.PDFDocument.load(await (await get('blobs', r.name)).arrayBuffer(), {ignoreEncryption: true});
  const rgbOf = h => { const v = parseInt(h.slice(1, 7), 16); return PL.rgb((v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255); };
  for (const n of r.notes) {
    if (n.page >= doc.getPageCount()) continue;
    const pg = doc.getPage(n.page), {width: W, height: H} = pg.getSize();
    const box = (a, o) => pg.drawRectangle({x: a[0] * W, y: H - a[3] * H, width: (a[2] - a[0]) * W, height: (a[3] - a[1]) * H, ...o});
    if (n.pic) {
      try {
        const m = /^data:image\/(\w+);base64,(.*)$/.exec(n.pic), bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
        const img = m[1] === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        pg.drawImage(img, {x: n.rect[0] * W, y: H - n.rect[3] * H, width: (n.rect[2] - n.rect[0]) * W, height: (n.rect[3] - n.rect[1]) * H});
      } catch (e) {}
    } else if (n.hl) n.hl.forEach(a => box(a, {color: rgbOf(n.hc || '#ffe14d'), opacity: .35}));
    else box(n.rect, {borderColor: PL.rgb(.9, .65, 0), borderWidth: 1});
    (n.ink || []).forEach(k => {
      for (let j = 1; j < k.pts.length; j++)
        pg.drawLine({start: {x: k.pts[j - 1][0] * W, y: H - k.pts[j - 1][1] * H}, end: {x: k.pts[j][0] * W, y: H - k.pts[j][1] * H},
          color: rgbOf(k.c || '#1a3fd0'), thickness: (k.w || 2.2) * W / 1000, opacity: k.o || 1, lineCap: 1});
    });
  }
  const out = r.name.replace(/\.pdf$/i, '') + '_notes.pdf';
  download(new Blob([await doc.save({useObjectStreams: true})], {type: 'application/pdf'}), out);
  return out;
}

// ---- routes
const speak = text => {
  try {
    speechSynthesis.cancel();
    if (!text.trim()) return;
    const u = new SpeechSynthesisUtterance(text.slice(0, 4000)); u.lang = /[ऀ-ॿ]/.test(text) ? 'hi-IN' : 'en-IN';
    speechSynthesis.speak(u);
  } catch (e) {}
};
const NA = 'not available in the iPad version yet';
const routes = {
  '/api/state': () => state(),
  '/api/job': () => ({running: false}),
  '/api/study': async (q, post) => {
    if (!post) return studyStats();
    if (+q.secs >= 1) {
      const log = (await get('kv', 'study')) || [];
      log.push({d: new Date().toISOString().slice(0, 10), book: String(q.book || '').slice(0, 200), secs: Math.round(q.secs)});
      await put('kv', log, 'study');
    }
    return {ok: true};
  },
  '/api/pick': async () => { await openFile(await pickFile()); return state(); },
  '/api/openbook': async q => { const r = await get('books', q.name || ''); if (r) await openRec(r); return state(); },
  '/api/notes': async q => { if (B) { B.rec.notes = q; await saveRec(); } return {ok: true, pdf: true}; },
  '/api/prefs': async q => { await put('kv', q, 'prefs'); return {ok: true}; },
  '/api/meta': async q => {
    const m = {}; META.forEach(k => { if (k in q) m[k] = String(q[k]).trim(); });
    m.citekey = citekey(m, B.rec.name); B.rec.meta = m; await saveRec(); return m;
  },
  '/api/doi': async q => {
    try {
      const doi = String(q.doi || '').trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/i, '');
      const m = (await (await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi))).json()).message, f = k => (m[k] || [''])[0];
      return {doi, title: f('title'), journal: f('container-title'), volume: m.volume || '', pages: m.page || '',
        year: String((((m.issued || {})['date-parts'] || [['']])[0] || [''])[0]),
        author: (m.author || []).map(a => `${a.family || ''}, ${a.given || ''}`.replace(/^, |, $/g, '')).join(' and ')};
    } catch (e) { return {error: String(e)}; }
  },
  '/api/library': () => library(),
  '/api/export_all': async q => { await exportAll(String(q.md || '')); return {out: 'your Downloads'}; },
  '/api/card': async q => {
    const r = await get('books', q.book);
    if (r) { r.notes.forEach(n => { if (n.id === q.id) n.card = q.card; }); await put('books', r); if (B && B.rec.name === q.book) B.rec.notes = r.notes; }
    return {ok: true};
  },
  '/api/anki': async q => { dl(String(q.cloze || ''), 'anki_cloze.txt'); dl(String(q.basic || ''), 'anki_basic.txt'); return {out: 'your Downloads'}; },
  '/api/say': q => { speak(String(q.text || '')); return {ok: true}; },
  '/api/search': q => search(q),
  '/api/hits': q => hits(q),
  '/api/edit': q => edit(q).then(state),
  '/api/margin': q => margin(q).then(state),
  '/api/restore': () => restore().then(state),
  '/api/bookmark': async q => {
    const toc = B.rec.toc, i = +q.index, p = +q.page + 1;
    if (q.op === 'add') toc.splice((k => k < 0 ? toc.length : k)(toc.findIndex(e => e[2] > p)), 0, [1, (String(q.title || '').trim() || 'Page ' + p).slice(0, 200), p]);
    else if (q.op === 'del' && i >= 0 && i < toc.length) toc.splice(i, 1);
    else if (q.op === 'rename' && toc[i] && String(q.title || '').trim()) toc[i][1] = String(q.title).trim().slice(0, 200);
    await saveRec(); return {toc};
  },
  '/api/export': async () => ({out: await exportPdf()}),
  '/api/picocr': () => ({text: ''}),
  '/api/ocr': () => ({error: 'OCR: ' + NA}),
  '/api/optimize': () => ({error: 'Optimize: ' + NA}),
  '/api/nup': () => ({error: 'n-up export: ' + NA}),
};
const realFetch = window.fetch.bind(window);
window.fetch = (u, o = {}) => {
  const url = typeof u === 'string' ? u : u.url, p = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const wm = /^\/api\/words\/(\d+)$/.exec(p);
  const h = wm ? () => words(+wm[1]) : routes[p];
  if (!h) return realFetch(u, o);
  let q = {}; try { q = o.body ? JSON.parse(o.body) : {}; } catch (e) {}
  return Promise.resolve(h(q, o.method === 'POST')).then(
    v => new Response(JSON.stringify(v), {headers: {'Content-Type': 'application/json'}}),
    e => new Response(JSON.stringify({error: String(e)}), {status: 500}));
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
