// 把 data/<RUN_NAME>/ 的結果 commit 並推回 GitHub（Windows / Linux 都能用）。
// 這些檔案每次都是完整重新產生的，所以不用 merge：
// 先記下這次的結果 → 對齊遠端最新版本 → 把結果寫回去 → commit → push，失敗就重來。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RUN_NAME = (process.env.RUN_NAME || 'cloud').replace(/[^\w-]/g, '');
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const DIR = join('data', RUN_NAME);
const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const sleep = (ms) => execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);

if (!existsSync(DIR)) { console.log('沒有結果檔'); process.exit(0); }
const files = Object.fromEntries(readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => [f, readFileSync(join(DIR, f))]));

git('config', 'user.name', 'cwms-watch-bot');
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
git('config', 'core.autocrlf', 'false');

const stamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

for (let i = 1; i <= 5; i++) {
  try {
    try { execFileSync('git', ['rebase', '--abort'], { stdio: 'ignore' }); } catch {}
    git('fetch', 'origin', BRANCH);
    git('checkout', '-f', '-B', BRANCH, 'FETCH_HEAD');
    mkdirSync(DIR, { recursive: true });
    for (const [f, buf] of Object.entries(files)) writeFileSync(join(DIR, f), buf);
    git('add', '--all', DIR);
    if (!git('diff', '--staged', '--name-only')) { console.log('沒有變更'); process.exit(0); }
    git('commit', '-m', `data(${RUN_NAME}): ${stamp} 監控結果`);
    git('push', 'origin', `HEAD:${BRANCH}`);
    console.log('已推送');
    process.exit(0);
  } catch (e) {
    console.warn(`推送失敗（第 ${i} 次），稍後重試`);
    sleep(2000 + Math.random() * 4000 * i);
  }
}
console.error('推送失敗');
process.exit(1);
