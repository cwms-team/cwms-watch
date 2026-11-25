// CWMS Watch 主程式：由 GitHub Actions 每 30 分鐘執行一次。
// 讀 config/watchlist.json → 抓五縣市公開資料 → 寫 data/*.json → 必要時發 Discord。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REGIONS } from './regions.mjs';
import { fetchOperators, fetchOperatorRows } from './cwms-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (f) => join(ROOT, f);

const DELAY_MINUTES = Number(process.env.DELAY_MINUTES || 180);   // 監測時間落後超過 3 小時
const WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const TRIGGER = process.env.TRIGGER_LABEL ? process.env.TRIGGER_LABEL
  : process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? 'manual'
  : process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : (process.env.GITHUB_EVENT_NAME || 'local');
const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_RUNS = 96;
// 分組執行：雲端（GitHub）跑大部分縣市，本機 runner 跑雲端連不到的縣市。
const RUN_NAME = (process.env.RUN_NAME || 'cloud').replace(/[^\w-]/g, '');
const ONLY = (process.env.ONLY_REGIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ACTIVE = ONLY.length ? REGIONS.filter((r) => ONLY.includes(r.key)) : REGIONS;
const D = (f) => `data/${RUN_NAME}/${f}`;

const NORMAL = '正常值';
const isNotifyStatus = (s) => /校正|故障/.test(s);   // 校正值、單元故障 → 通知

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(P(file), 'utf8')); } catch { return fallback; }
}
async function writeJson(file, data) {
  await mkdir(dirname(P(file)), { recursive: true });
  await writeFile(P(file), JSON.stringify(data, null, 1) + '\n');
}

/** 民國日期 1151124 + 時間 1335（台灣時間）→ epoch ms */
export function rocToEpoch(date, time) {
  const d = String(date).trim(), t = String(time).trim().padStart(4, '0');
  const m = d.match(/^(\d{2,3})(\d{2})(\d{2})$/);
  if (!m || !/^\d{4}$/.test(t)) return null;
  const y = +m[1] + 1911;
  return Date.UTC(y, +m[2] - 1, +m[3], +t.slice(0, 2) - 8, +t.slice(2));
}

async function withRetry(fn, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw err;
}

function evaluate(rows, now) {
  const details = [];
  let latest = null, maxDelay = 0;
  for (const r of rows) {
    const status = r.status.trim();
    const ts = rocToEpoch(r.date, r.time);
    if (ts && (latest === null || ts > latest)) latest = ts;
    const delayMinutes = ts ? Math.round((now - ts) / 60000) : null;
    const delayed = delayMinutes !== null && delayMinutes > DELAY_MINUTES;
    if (delayed) maxDelay = Math.max(maxDelay, delayMinutes);
    if (status !== NORMAL || delayed) {
      details.push({
        location: r.location, item: r.item.trim(), date: r.date, time: r.time,
        value: r.value, standard: r.standard, unit: r.unit, status, type: r.type, illegal: r.illegal,
        delayed, delayMinutes: delayed ? delayMinutes : undefined,
        notify: delayed || isNotifyStatus(status),
      });
    }
  }
  return { details, latest, maxDelay };
}

function summarize(c) {
  if (c.state === 'source_error') return '來源讀取失敗';
  if (c.state === 'no_data') return 'No data（查無監測資料）';
  if (!c.details.length) return '正常';
  const labels = new Set();
  for (const d of c.details) {
    if (d.status !== NORMAL) labels.add(d.status);
    if (d.delayed) labels.add(`監測資料延遲超過 ${DELAY_MINUTES / 60} 小時`);
  }
  return `${c.details.length} 筆異常：${[...labels].join('、')}`;
}

function notifyKeys(c) {
  if (c.state === 'no_data') return ['nodata'];
  if (c.state !== 'abnormal') return [];
  const keys = new Set();
  for (const d of c.details) {
    if (d.delayed) keys.add('delay');
    if (isNotifyStatus(d.status)) keys.add(`${d.status}|${d.location}|${d.item}`);
  }
  return [...keys].sort();
}

function describeKey(k, c) {
  if (k === 'nodata') return 'No data（查無監測資料）';
  if (k === 'delay') return `監測資料延遲（最久落後 ${Math.floor(c.maxDelayMinutes / 60)} 小時 ${c.maxDelayMinutes % 60} 分）`;
  const [status, location, item] = k.split('|');
  return `${status}：${location}・${item}`;
}

async function sendDiscord(lines) {
  if (!WEBHOOK || !lines.length) return 0;
  const chunks = [];
  let buf = '';
  for (const l of lines) {
    if ((buf + '\n' + l).length > 1900) { chunks.push(buf); buf = ''; }
    buf = buf ? buf + '\n' + l : l;
  }
  if (buf) chunks.push(buf);
  let sent = 0;
  for (const content of chunks) {
    if (DRY_RUN) { console.log('[DRY_RUN discord]\n' + content); sent++; continue; }
    const res = await fetch(WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'CWMS Watch', content, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) console.error('Discord 傳送失敗', res.status, await res.text());
    else sent++;
    await new Promise((r) => setTimeout(r, 600));
  }
  return sent;
}

async function main() {
  const started = Date.now();
  const watch = await readJson('config/watchlist.json', {});
  const prevStatus = await readJson(D('status.json'), { companies: [] });
  const prevNotify = await readJson(D('notify-state.json'), {});
  const runs = await readJson(D('runs.json'), []);
  const catalog = await readJson(D('catalog.json'), null) ?? await readJson('data/catalog.json', { regions: [] });
  const prevByKey = new Map(prevStatus.companies.map((c) => [`${c.region}:${c.cno}`, c]));
  const catByKey = new Map(catalog.regions.map((r) => [r.key, r]));

  const regionResults = await Promise.all(ACTIVE.map(async (reg) => {
    const out = { ...reg, available: true, error: null, operators: catByKey.get(reg.key)?.operators ?? [] };
    try {
      out.operators = await withRetry(() => fetchOperators(reg.sourceUrl));
    } catch (e) {
      out.available = false;
      out.error = String(e.message || e);
      console.error(`[${reg.name}] 讀取業者清單失敗：${out.error}`);
    }
    const names = new Map(out.operators.map((o) => [o.cno, o.name]));
    const companies = [];
    for (const cno of watch[reg.key] ?? []) {
      const prev = prevByKey.get(`${reg.key}:${cno}`);
      const c = { region: reg.key, cno, company: names.get(cno) || prev?.company || cno, details: [] };
      try {
        if (!out.available) throw new Error(`縣市網站無法連線：${out.error}`);
        const { rows } = await withRetry(() => fetchOperatorRows(reg.sourceUrl, cno));
        const now = Date.now();
        if (!rows.length) {
          c.state = 'no_data';
        } else {
          const ev = evaluate(rows, now);
          c.company = rows[0].company || c.company;
          c.details = ev.details;
          c.rowCount = rows.length;
          c.lastDataAt = ev.latest ? new Date(ev.latest).toISOString() : null;
          c.maxDelayMinutes = ev.maxDelay || 0;
          c.state = ev.details.length ? 'abnormal' : 'normal';
        }
        c.sourceErrorStreak = 0;
      } catch (e) {
        c.state = 'source_error';
        c.error = String(e.message || e);
        c.sourceErrorStreak = (prev?.sourceErrorStreak || 0) + 1;
        c.lastSourceErrorAt = new Date().toISOString();
        // 保留上一次成功的資料供參考
        c.lastGood = prev?.state && prev.state !== 'source_error' ? { state: prev.state, summary: prev.summary, checkedAt: prev.checkedAt } : prev?.lastGood;
        if (out.available) console.error(`[${reg.name}] ${cno} 讀取失敗：${c.error}`);
      }
      c.summary = summarize(c);
      c.checkedAt = new Date().toISOString();
      c.changedAt = prev && prev.state === c.state && prev.summary === c.summary ? prev.changedAt : c.checkedAt;
      companies.push(c);
      if (out.available) await new Promise((r) => setTimeout(r, 300));
    }
    return { region: out, companies };
  }));

  const companies = regionResults.flatMap((r) => r.companies);
  const regionName = Object.fromEntries(REGIONS.map((r) => [r.key, r.name]));

  // ---- Discord：只在「新出現」需通知的狀況、或已恢復時發送 ----
  const nextNotify = {};
  const alertLines = [], recoverLines = [];
  for (const c of companies) {
    const key = `${c.region}:${c.cno}`;
    if (c.state === 'source_error') { if (prevNotify[key]) nextNotify[key] = prevNotify[key]; continue; }
    const keys = notifyKeys(c);
    const before = new Set(prevNotify[key] ?? []);
    if (keys.length) nextNotify[key] = keys;
    const fresh = keys.filter((k) => !before.has(k));
    const head = `**${regionName[c.region]}・${c.company}**（${c.cno}）`;
    if (fresh.length) alertLines.push(`🔔 ${head}\n` + fresh.map((k) => `　• ${describeKey(k, c)}`).join('\n'));
    else if (before.size && !keys.length) recoverLines.push(`✅ ${head} 已恢復正常`);
  }
  const header = `**CWMS Watch** ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}`;
  const msgLines = alertLines.length || recoverLines.length ? [header, ...alertLines, ...recoverLines] : [];
  const sent = await sendDiscord(msgLines);

  // ---- 寫檔 ----
  const checkedAt = new Date().toISOString();
  const totals = {
    watched: companies.length,
    abnormal: companies.filter((c) => c.state === 'abnormal').length,
    delayed: companies.filter((c) => c.details.some((d) => d.delayed)).length,
    noData: companies.filter((c) => c.state === 'no_data').length,
    sourceError: companies.filter((c) => c.state === 'source_error').length,
    notify: Object.keys(nextNotify).length,
  };
  await writeJson(D('status.json'), {
    source: RUN_NAME, checkedAt, trigger: TRIGGER, durationMs: Date.now() - started, delayMinutes: DELAY_MINUTES,
    discordConfigured: Boolean(WEBHOOK), totals,
    regions: regionResults.map(({ region: r }) => ({
      key: r.key, name: r.name, sourceUrl: r.sourceUrl, available: r.available, error: r.error,
      operatorCount: r.operators.length, watchedCount: (watch[r.key] ?? []).length,
    })),
    companies,
  });
  await writeJson(D('catalog.json'), {
    updatedAt: checkedAt,
    regions: regionResults.map(({ region: r }) => ({ key: r.key, name: r.name, sourceUrl: r.sourceUrl, operators: r.operators })),
  });
  await writeJson(D('notify-state.json'), nextNotify);
  runs.unshift({ source: RUN_NAME, at: checkedAt, trigger: TRIGGER, durationMs: Date.now() - started, ...totals, discordSent: sent });
  await writeJson(D('runs.json'), runs.slice(0, MAX_RUNS));

  console.log(`完成：${totals.watched} 家，異常 ${totals.abnormal}，No data ${totals.noData}，來源失敗 ${totals.sourceError}，Discord ${sent} 則`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
