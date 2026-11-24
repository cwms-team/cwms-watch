// 抓取單一業者在縣市 CWMS 公開頁（Get_AVGR.aspx）上的即時監測值。
// 流程：GET 頁面 → 以下拉選單 postback 選定業者 → 用 DevExpress callback 逐頁翻完。
// 不需任何外部套件（Node 20+）。

import https from 'node:https';

const UA ='Mozilla/5.0 (compatible; CWMS-Watch/1.0; +https://github.com/)';
const SELECT_NAME = 'ctl00$ContentPlaceHolder1$DDL_CNO';
const GRID_NAME = 'ctl00$ContentPlaceHolder1$GridView';

export const COLUMNS = ['cno', 'company', 'location', 'item', 'date', 'time', 'value', 'standard', 'unit', 'status', 'type', 'illegal'];

export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function parseHiddenInputs(html) {
  const out = {};
  for (const m of html.matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/\bname="([^"]*)"/) || [])[1];
    if (!name) continue;
    const value = (tag.match(/\bvalue="([^"]*)"/) || [, ''])[1];
    out[name] = decodeEntities(value);
  }
  return out;
}

export function parseOptions(html) {
  const sel = html.match(/<select\b[^>]*name="[^"]*DDL_CNO"[^>]*>([\s\S]*?)<\/select>/i);
  if (!sel) return [];
  const ops = [];
  for (const m of sel[1].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)) {
    const cno = decodeEntities(m[1]).trim();
    if (!/^[A-Z]\w{6,}$/.test(cno)) continue; // 略過「請選擇要監看的對象」
    ops.push({ cno, name: decodeEntities(m[2]).trim() });
  }
  return ops;
}

export function parseRows(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr\b[^>]*id="[^"]*GridView_DXDataRow\d+"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<span\b[^>]*_CountValue"[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((c) => decodeEntities(c[1].replace(/<[^>]+>/g, '')).trim());
    if (cells.length < COLUMNS.length) continue;
    const row = {};
    COLUMNS.forEach((k, i) => { row[k] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

export function parsePager(html) {
  const m = html.match(/Page \d+ of (\d+) \((\d+) items\)/);
  return m ? { pages: +m[1], items: +m[2] } : null;
}

export function parseCallbackState(html) {
  const m = html.match(/'callbackState':'([^']*)'/);
  return m ? m[1] : null;
}

// DevExpress callback 回應格式：<len>|<eventvalidation>/*DX*/({'id':0,'result':{...,'html':'<escaped>'}})
export function parseCallbackHtml(text) {
  const m = text.match(/'html':'([\s\S]*)'\}\}\)\s*$/);
  if (!m) return null;
  return m[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
    if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { r: '\r', n: '\n', t: '\t' }[c] ?? c;
  });
}

// 台灣政府網站常缺中繼憑證（瀏覽器會自動補、Node 不會）。
// 遇到這類憑證錯誤時，該主機改用「不驗證憑證」模式；只用於讀取公開資料。
const TLS_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_UNTRUSTED']);
const insecureHosts = new Set();

function describeError(e) {
  const code = e?.code || e?.cause?.code;
  const msg = e?.message || String(e);
  return code && !msg.includes(code) ? `${msg} (${code})` : msg;
}

function httpRequest(url, { method, headers, body, timeoutMs, insecure }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, rejectUnauthorized: !insecure, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`逾時 ${timeoutMs / 1000} 秒`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class Session {
  constructor(url, { timeoutMs = 20000 } = {}) {
    this.url = url;
    this.host = new URL(url).host;
    this.cookies = new Map();
    this.timeoutMs = timeoutMs;
  }
  async request(form) {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9', Accept: 'text/html,*/*' };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const body = form ? new URLSearchParams(form).toString() : undefined;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const opts = { method: body ? 'POST' : 'GET', headers, body, timeoutMs: this.timeoutMs };
    let res;
    try {
      res = await httpRequest(this.url, { ...opts, insecure: insecureHosts.has(this.host) });
    } catch (e) {
      if (!insecureHosts.has(this.host) && TLS_CODES.has(e.code)) {
        console.warn(`[${this.host}] 憑證驗證失敗（${e.code}），改用相容模式`);
        insecureHosts.add(this.host);
        res = await httpRequest(this.url, { ...opts, insecure: true });
      } else {
        throw new Error(describeError(e));
      }
    }
    for (const c of [].concat(res.headers['set-cookie'] ?? [])) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res.text;
  }
}

/** 取得下拉選單中的所有業者（縣市清單）。 */
export async function fetchOperators(url) {
  const s = new Session(url);
  const html = await s.request();
  const ops = parseOptions(html);
  if (!ops.length) throw new Error('找不到業者下拉選單');
  return ops;
}

/** 取得單一業者全部監測紀錄（自動翻頁）。 */
export async function fetchOperatorRows(url, cno, { pageDelayMs = 150 } = {}) {
  const s = new Session(url);
  const first = await s.request();
  if (!/DDL_CNO/.test(first)) throw new Error('來源頁面格式不符');
  const hidden = parseHiddenInputs(first);

  const html = await s.request({ ...hidden, __EVENTTARGET: SELECT_NAME, __EVENTARGUMENT: '', [SELECT_NAME]: cno });
  let rows = parseRows(html);
  const pager = parsePager(html);
  if (!rows.length && !pager) {
    return { rows: [], items: 0, noData: /No data to display/i.test(html) };
  }

  const pages = pager?.pages ?? 1;
  if (pages > 1) {
    const hidden2 = parseHiddenInputs(html);
    const state = parseCallbackState(html);
    for (let n = 1; n < pages; n++) {
      if (pageDelayMs) await new Promise((r) => setTimeout(r, pageDelayMs));
      const body = {
        ...hidden2,
        [SELECT_NAME]: cno,
        __CALLBACKID: GRID_NAME,
        __CALLBACKPARAM: `c0:KV|2;[];CT|2;{};GB|20;12|PAGERONCLICK3|PN${n};`,
      };
      if (state) body[GRID_NAME] = JSON.stringify({ keys: [], callbackState: state, groupLevelState: {}, selection: '', toolbar: '{}' });
      const text = await s.request(body);
      const pageHtml = parseCallbackHtml(text);
      if (pageHtml == null) throw new Error(`第 ${n + 1} 頁回應格式不符`);
      rows = rows.concat(parseRows(pageHtml));
    }
  }
  // 確認抓到的是這家業者（避免 session 串到別家）
  rows = rows.filter((r) => r.cno === cno);
  if (pager && rows.length < pager.items) {
    throw new Error(`只取得 ${rows.length}/${pager.items} 筆`);
  }
  return { rows, items: pager?.items ?? rows.length, noData: rows.length === 0 };
}
