/**
 * 页面截图工具（开发/验收用）：用无头 Chrome + CDP 抓取各页面真实渲染效果。
 * 用法：BASE=http://127.0.0.1:3100 ADMIN_PASS=xxx node scripts/screenshot.mjs [输出目录]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'hostvote.db');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'LocalTest123';
const OUT = process.argv[2] || '/tmp/hv-shots';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

fs.mkdirSync(OUT, { recursive: true });

/* ---------------------------------------------------------------- CDP ---- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const list = this.waiters.get(msg.method) || [];
        this.waiters.set(msg.method, []);
        list.forEach((r) => r(msg.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }
  once(method) {
    return new Promise((resolve) => {
      const list = this.waiters.get(method) || [];
      list.push(resolve);
      this.waiters.set(method, list);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- 登录 ---- */

function newClient() {
  const cookies = new Map();
  return {
    async req(method, url, body) {
      const headers = {};
      const cookieHeader = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieHeader) headers.cookie = cookieHeader;
      let payload = body;
      if (body && typeof body === 'object') {
        payload = new URLSearchParams(body).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const res = await fetch(BASE + url, { method, headers, body: method === 'GET' ? undefined : payload, redirect: 'manual' });
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
    get(u) {
      return this.req('GET', u);
    },
    post(u, b) {
      return this.req('POST', u, b);
    },
    sid() {
      return cookies.get('hv_sid');
    },
  };
}

// DB 可用时用于挑选「未投过票」的密码条并微调展示设置；
// 对着远程环境截图时可改用 PUB_CODE / PRO_CODE / PRO_CODE2 环境变量直接指定。
let db = null;
try {
  if (fs.existsSync(DB_FILE)) {
    db = new DatabaseSync(DB_FILE);
    db.prepare("UPDATE settings SET value='1' WHERE key IN ('pro_can_edit','board_public')").run();
  }
} catch (err) {
  console.warn(`[warn] 无法打开数据库（${DB_FILE}），改用环境变量指定密码条：${err.message}`);
}

const pickCode = (sql, fallback) => {
  if (!db) return null;
  try {
    return db.prepare(sql).get();
  } catch {
    return fallback || null;
  }
};

const pubCode =
  pickCode(
    `SELECT * FROM voting_codes c WHERE c.role='public' AND c.enabled=1
       AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.code_id=c.id AND v.competition='group' AND v.invalid=0)
     ORDER BY c.id LIMIT 1`
  ) || (process.env.PUB_CODE ? { code: process.env.PUB_CODE } : null);
const proCode =
  pickCode("SELECT * FROM voting_codes WHERE role='pro' AND enabled=1 AND judge_slot IS NOT NULL ORDER BY judge_slot LIMIT 1") ||
  (process.env.PRO_CODE ? { code: process.env.PRO_CODE } : null);
const proCode2 =
  pickCode("SELECT * FROM voting_codes WHERE role='pro' AND enabled=1 AND judge_slot IS NOT NULL ORDER BY judge_slot LIMIT 1 OFFSET 1") ||
  proCode;

if (!pubCode || !proCode) {
  console.error('无法确定用于截图的密码条，请设置 PUB_CODE / PRO_CODE 环境变量。');
  process.exit(1);
}

const pubClient = newClient();
await pubClient.post('/vote/login', { code: pubCode.code, competition: 'group' });
const proClient = newClient();
await proClient.post('/vote/login', { code: proCode.code, competition: 'group' });
const proCode2Client = newClient();
await proCode2Client.post('/vote/login', { code: proCode2.code, competition: 'group' });
const adminClient = newClient();
const adminRes = await adminClient.post('/manage/login', { username: ADMIN_USER, password: ADMIN_PASS });
if (!adminClient.sid()) {
  console.error('管理员登录失败，无法截图后台页面');
  console.error('status', adminRes.status, await adminRes.text());
  process.exit(1);
}
console.log('已取得三类会话 cookie');

/* ---------------------------------------------------------- 启动 Chrome ---- */

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-proxy-server',
    '--proxy-bypass-list=*',
    '--disable-features=NetworkServiceSandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=/tmp/hv-chrome-profile',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let list = null;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    list = await r.json();
    if (list.some((t) => t.type === 'page')) break;
  } catch {
    /* 等待 Chrome 启动 */
  }
}
if (!list) {
  console.error('无法连接 Chrome 调试端口');
  chrome.kill();
  process.exit(1);
}

const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
const cdp = new CDP(ws);
await cdp.send('Network.enable');
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

async function setSid(sid) {
  await cdp.send('Network.clearBrowserCookies');
  if (!sid) return;
  await cdp.send('Network.setCookie', { name: 'hv_sid', value: sid, domain: new URL(BASE).hostname, path: '/' });
}

async function shoot(name, url, { sid = null, width = 430, height = 1000, mobile = true, fullPage = true, wait = 600, after = null } = {}) {
  await setSid(sid);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(6000)]);
  await sleep(wait);
  if (after) {
    await cdp.send('Runtime.evaluate', { expression: after });
    await sleep(400);
  }
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: fullPage,
  });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  const size = fs.statSync(file).size;
  console.log(`  📸 ${name.padEnd(26)} ${(size / 1024).toFixed(0)} KB  ${url}`);
  return file;
}

console.log('\n开始截图：');

// 移动端（投票现场视角）
await shoot('01-mobile-root-closed', `${BASE}/`, { width: 430, mobile: true });
await shoot('02-mobile-login', `${BASE}/vote/group`, { width: 430, mobile: true });
await shoot('03-mobile-vote', `${BASE}/vote/group`, {
  sid: pubClient.sid(),
  width: 430,
  mobile: true,
  after: "document.querySelectorAll('.player input')[0].click(); document.querySelectorAll('.player input')[2].click();",
});
await shoot('03b-mobile-vote-confirm', `${BASE}/vote/group`, {
  sid: pubClient.sid(),
  width: 430,
  mobile: true,
  fullPage: false,
  after:
    "document.querySelectorAll('.player input')[0].click(); document.querySelectorAll('.player input')[2].click(); document.getElementById('voteForm').dispatchEvent(new Event('submit',{cancelable:true}));",
});
await shoot('04-mobile-score', `${BASE}/vote/group`, { sid: proClient.sid(), width: 430, mobile: true });
await shoot('04b-mobile-score-edit', `${BASE}/vote/group`, { sid: proCode2Client.sid(), width: 430, mobile: true });
await shoot('05-mobile-score-individual', `${BASE}/vote/individual`, { sid: proClient.sid(), width: 430, mobile: true });
await shoot('06-mobile-login-individual', `${BASE}/vote/individual`, { width: 430, mobile: true });
await shoot('07-mobile-board', `${BASE}/board?c=final`, { sid: adminClient.sid(), width: 430, mobile: true });

// 桌面端（后台）
await shoot('10-admin-login', `${BASE}/manage/login`, { width: 1440, mobile: false });
await shoot('11-admin-dashboard', `${BASE}/manage`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('12-admin-players', `${BASE}/manage/players`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('13-admin-codes', `${BASE}/manage/codes`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('14-admin-votes', `${BASE}/manage/votes?c=group`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('15-admin-scores', `${BASE}/manage/scores?c=group`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('16-admin-manual', `${BASE}/manage/manual?c=group`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('17-admin-schedule', `${BASE}/manage/schedule`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('18-admin-results', `${BASE}/manage/results`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('19-admin-export', `${BASE}/manage/export`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('20-admin-audit', `${BASE}/manage/audit`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('21-admin-settings', `${BASE}/manage/settings`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('22-admin-codes-print', `${BASE}/manage/codes/print?role=public`, { sid: adminClient.sid(), width: 1024, mobile: false });
await shoot('24-admin-reset', `${BASE}/manage/reset`, { sid: adminClient.sid(), width: 1440, mobile: false });
await shoot('23-desktop-board', `${BASE}/board?c=final`, { sid: adminClient.sid(), width: 1440, mobile: false });

ws.close();
chrome.kill();
db?.close();
console.log(`\n全部截图已保存到 ${OUT}\n`);
process.exit(0);
