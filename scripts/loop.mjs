// 本機計時器：在 self-hosted runner 上持續執行，每 30 分鐘
//   1) 觸發雲端 workflow（台中、雲林、苗栗、南投）
//   2) 在本機檢查彰化並推送結果
// 跑滿 LOOP_HOURS 小時後重新觸發自己，換一個新的 GitHub token 繼續。
// 不依賴 GitHub 的 cron 排程（免費排程常延遲或跳過）。
import { execFileSync } from 'node:child_process';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const REF = process.env.GITHUB_REF_NAME || 'main';
const INTERVAL_MIN = Number(process.env.INTERVAL_MINUTES || 30);
const LOOP_HOURS = Number(process.env.LOOP_HOURS || 6);
const CLOUD_WORKFLOW = 'monitor.yml';
const SELF_WORKFLOW = 'monitor-local.yml';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

async function dispatch(workflow) {
  if (!TOKEN || !REPO) { console.warn('缺少 GITHUB_TOKEN / GITHUB_REPOSITORY，略過觸發', workflow); return false; }
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cwms-watch' },
        body: JSON.stringify({ ref: REF, inputs: { reason: 'auto' } }),
      });
      if (res.status === 204) { console.log(`[${now()}] 已觸發 ${workflow}`); return true; }
      console.warn(`[${now()}] 觸發 ${workflow} 失敗 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      console.warn(`[${now()}] 觸發 ${workflow} 失敗：${e.message}`);
    }
    await sleep(5000 * i);
  }
  return false;
}

function runNode(script) {
  try {
    execFileSync(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, TRIGGER_LABEL: 'auto' } });
    return true;
  } catch (e) {
    console.error(`[${now()}] ${script} 結束代碼 ${e.status}`);
    return false;
  }
}

const started = Date.now();
const deadline = started + LOOP_HOURS * 3600e3;
let cycle = 0;
while (true) {
  const cycleStart = Date.now();
  cycle++;
  console.log(`\n===== 第 ${cycle} 輪 ${now()} =====`);
  await dispatch(CLOUD_WORKFLOW);
  if (runNode('scripts/check.mjs')) runNode('scripts/commit.mjs');

  const next = cycleStart + INTERVAL_MIN * 60e3;
  if (next + 60e3 > deadline) break;
  console.log(`[${now()}] 下一輪約 ${Math.round((next - Date.now()) / 60e3)} 分鐘後`);
  await sleep(Math.max(0, next - Date.now()));
}

// 等到這一輪的 30 分鐘到了再交棒，避免連續兩輪太接近
const wait = cycle ? Math.max(0, started + cycle * INTERVAL_MIN * 60e3 - Date.now() - 60e3) : 0;
if (wait > 0) await sleep(wait);
console.log(`[${now()}] 已跑 ${cycle} 輪，重新啟動下一段`);
await dispatch(SELF_WORKFLOW);
