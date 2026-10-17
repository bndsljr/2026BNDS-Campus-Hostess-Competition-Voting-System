/**
 * 并发压测（可在生产服务器上安全运行）
 *
 * 模拟 N 个大众评审"扫码 → 输密码 → 勾选 3 人 → 提交"的完整过程，
 * 全部使用临时密码条，结束后自动清理（含投票记录），并重算排名。
 *
 * 用法（在服务器上）：
 *   cd /opt/hostvote/app
 *   BASE=http://127.0.0.1:80 USERS=200 node scripts/loadtest.mjs
 *   BASE=http://127.0.0.1:80 USERS=400 PHASE=read node scripts/loadtest.mjs   # 只压读取
 *
 * 参数：
 *   USERS   并发用户数（默认 200）
 *   PHASE   full=完整流程 | read=只读页面 | burst=仅同时提交
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { loadEnv } from '../src/loadenv.js';

loadEnv();

process.on('uncaughtException', (e) => {
  console.error('未捕获异常：', e.message);
  process.exit(1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_FILE = process.env.HV_DB || path.join(process.env.HV_DATA_DIR || path.join(ROOT, 'data'), 'hostvote.db');
const BASE = process.env.BASE || 'http://127.0.0.1:80';
const USERS = Number(process.env.USERS || 200);
const PHASE = process.env.PHASE || 'full';
const COMP = ['group', 'individual'].includes(process.env.COMP) ? process.env.COMP : 'group';
const PREFIX = 'LT' + Date.now().toString(36).slice(-5).toUpperCase(); // 临时密码条前缀，便于清理

const url = new URL(BASE);
const agent = new http.Agent({ keepAlive: true, maxSockets: USERS + 50, maxFreeSockets: 50 });

const latencies = [];
let errors = 0;
const errorSamples = [];

function request(method, p, { body, cookie, redirect = 'manual' } = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const headers = { host: url.host };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body) {
      // 注意：URLSearchParams 会把数组转成 "1,2,3"，必须逐项 append 才能与浏览器表单一致
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
        else params.append(k, v);
      }
      payload = params.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: url.hostname, port: url.port || 80, path: p, method, headers, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          latencies.push(ms);
          const setCookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
          resolve({ status: res.statusCode, headers: res.headers, cookie: setCookie, body: Buffer.concat(chunks).toString('utf8'), ms });
        });
      }
    );
    req.on('error', (e) => {
      errors++;
      errorSamples.push(String(e.message));
      resolve({ status: 0, error: e.message, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function oneUser(code, picks, phase) {
  const pages = [];
  try {
    // 1. 打开投票入口（未登录 → 登录页）
    let r = await request('GET', `/vote/${COMP}`);
    if (r.status !== 200) throw new Error('login page ' + r.status);
    pages.push('loginpage');

    if (phase === 'read') return;

    // 2. 提交密码条登录
    r = await request('POST', '/vote/login', { body: { code, competition: COMP } });
    if (r.status !== 302) throw new Error('login ' + r.status);
    const cookie = r.cookie;

    // 3. 打开投票页
    r = await request('GET', `/vote/${COMP}`, { cookie });
    if (r.status !== 200) throw new Error('vote page ' + r.status);
    pages.push('votepage');

    if (phase === 'burst') return;

    // 4. 提交投票
    const body = { competition: COMP };
    r = await request('POST', '/vote/submit', { body: { ...body, player: picks }, cookie });
    if (r.status !== 302) {
      const m = (r.body || '').match(/<div class="flash flash-error">([^<]*)/);
      throw new Error('submit ' + r.status + ' ' + (m ? m[1].trim() : (r.body || '').slice(0, 100).replace(/\s+/g, ' ')));
    }
    pages.push('submit');

    // 5. 完成页
    r = await request('GET', `/vote/done?c=${COMP}`, { cookie });
    if (r.status !== 200) throw new Error('done ' + r.status);
    pages.push('done');
  } catch (e) {
    errors++;
    if (errorSamples.length < 6) errorSamples.push(e.message);
  }
}

/* ------------------------------------------------------------------ 主流程 ---- */

const db = new DatabaseSync(DB_FILE);
const players = db.prepare('SELECT id FROM players WHERE active=1 ORDER BY sort_order,no,id').all().map((r) => r.id);
const judgeCount = Number(db.prepare("SELECT value FROM settings WHERE key='judge_count'").get().value);
const pickCount = Number(db.prepare("SELECT value FROM settings WHERE key='public_pick_count'").get().value);
const before = {
  votes: db.prepare('SELECT COUNT(*) c FROM votes').get().c,
  scores: db.prepare('SELECT COUNT(*) c FROM scores').get().c,
  codes: db.prepare('SELECT COUNT(*) c FROM voting_codes').get().c,
};

console.log(`\n=== 并发压测 @ ${BASE} ===`);
console.log(`并发用户 ${USERS} 位｜模式 ${PHASE}｜服务器 ${os.cpus().length} 核 / ${(os.totalmem() / 1073741824).toFixed(1)}GB｜Node ${process.version}`);
console.log(`压测前：投票 ${before.votes} 条、打分 ${before.scores} 格、密码条 ${before.codes} 条\n`);

// 记录赛程原状态（开关 + 起止时间），测试期间临时放开，结束后完整还原
const pfx = COMP === 'group' ? 'group' : 'individual';
const scheduleKeys = [`${pfx}_enabled`, `${pfx}_start_at`, `${pfx}_end_at`];
const beforeSchedule = Object.fromEntries(
  scheduleKeys.map((k) => [k, db.prepare('SELECT value FROM settings WHERE key=?').get(k).value])
);
db.prepare('UPDATE settings SET value=? WHERE key=?').run('1', `${pfx}_enabled`);
db.prepare('UPDATE settings SET value=? WHERE key=?').run('', `${pfx}_start_at`);
db.prepare('UPDATE settings SET value=? WHERE key=?').run('', `${pfx}_end_at`);
console.log(`（压测期间临时放开${COMP === 'group' ? '小组赛' : '个人赛'}的开关与起止时间，结束后完整还原）`);
const restoreSchedule = () => {
  try {
    for (const [k, v] of Object.entries(beforeSchedule)) db.prepare('UPDATE settings SET value=? WHERE key=?').run(v, k);
  } catch { /* ignore */ }
};

// 准备临时密码条
const now = new Date().toISOString();
db.exec('BEGIN IMMEDIATE');
db.prepare('DELETE FROM voting_codes WHERE code LIKE ?').run(PREFIX + '%');
const insCode = db.prepare(
  `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
   VALUES (?, 'public', ?, NULL, 1, '压测临时（自动清理）', ?, ?)`
);
const codes = [];
for (let i = 0; i < USERS; i++) {
  const code = PREFIX + String(i).padStart(4, '0');
  insCode.run(code, `压测${String(i + 1).padStart(3, '0')}`, now, now);
  codes.push(code);
}
db.exec('COMMIT');
console.log(`已创建 ${codes.length} 条临时密码条（前缀 ${PREFIX}）`);

// 并发执行
const t0 = Date.now();
await Promise.all(
  codes.map((code, i) => {
    const picks = Array.from({ length: pickCount }, (_, k) => players[(i + k) % players.length]);
    return oneUser(code, [...new Set(picks)], PHASE);
  })
);
const wall = (Date.now() - t0) / 1000;

// 结果
const okReqs = latencies.length;
console.log(`\n--- 结果 ---`);
console.log(`总耗时        : ${wall.toFixed(2)} s`);
console.log(`请求数        : ${okReqs}（失败 ${errors}）`);
console.log(`吞吐          : ${(okReqs / wall).toFixed(0)} req/s`);
console.log(`延迟 平均/p50 : ${(latencies.reduce((a, b) => a + b, 0) / okReqs).toFixed(0)} / ${pct(latencies, 50).toFixed(0)} ms`);
console.log(`延迟 p95/p99  : ${pct(latencies, 95).toFixed(0)} / ${pct(latencies, 99).toFixed(0)} ms`);
console.log(`延迟 最大     : ${Math.max(...latencies).toFixed(0)} ms`);
if (errors) console.log(`错误样例      : ${errorSamples.slice(0, 4).join(' | ')}`);

const votesMade = db.prepare("SELECT COUNT(*) c FROM votes v JOIN voting_codes c ON c.id=v.code_id WHERE c.code LIKE ?").get(PREFIX + '%').c;

// 清理
console.log(`\n清理压测数据 ...（本次产生 ${votesMade} 条投票）`);
db.exec('BEGIN IMMEDIATE');
try {
  const items = db.prepare('DELETE FROM vote_items WHERE vote_id IN (SELECT v.id FROM votes v JOIN voting_codes c ON c.id=v.code_id WHERE c.code LIKE ?)').run(PREFIX + '%').changes;
  const vs = db.prepare('DELETE FROM votes WHERE code_id IN (SELECT id FROM voting_codes WHERE code LIKE ?)').run(PREFIX + '%').changes;
  const ss = db.prepare('DELETE FROM sessions WHERE code_id IN (SELECT id FROM voting_codes WHERE code LIKE ?)').run(PREFIX + '%').changes;
  const cs = db.prepare('DELETE FROM voting_codes WHERE code LIKE ?').run(PREFIX + '%').changes;
  const au = db.prepare("DELETE FROM audit_logs WHERE actor LIKE '压测%' OR note LIKE '压测%'").run().changes;
  const la = db.prepare('DELETE FROM login_attempts WHERE identifier LIKE ?').run(PREFIX + '%').changes;
  db.exec('COMMIT');
  console.log(`  已删除 vote_items=${items} votes=${vs} sessions=${ss} codes=${cs} audit=${au} login_attempts=${la}`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('  清理失败已回滚：' + e.message);
}

const after = {
  votes: db.prepare('SELECT COUNT(*) c FROM votes').get().c,
  scores: db.prepare('SELECT COUNT(*) c FROM scores').get().c,
  codes: db.prepare('SELECT COUNT(*) c FROM voting_codes').get().c,
};
console.log(`压测后：投票 ${after.votes} 条、打分 ${after.scores} 格、密码条 ${after.codes} 条`);
console.log(`（已恢复到压测前状态：投票 ${before.votes}、打分 ${before.scores}、密码条 ${before.codes}）`);
console.log(`\n提示：请重启服务或点「强制重算」以刷新排名。\n`);

restoreSchedule();
console.log('赛程设置已完整还原：' + JSON.stringify(beforeSchedule));
agent.destroy();
db.close();
process.exit(errors ? 1 : 0);
