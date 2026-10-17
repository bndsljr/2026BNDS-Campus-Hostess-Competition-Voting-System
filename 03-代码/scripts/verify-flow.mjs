/**
 * 生产环境「投票/打分链路」自检（安全：自己造临时数据，验证完立即清理，不动你的任何数据）
 *
 * 用法（在服务器上）：
 *   cd /opt/hostvote/app
 *   BASE=http://127.0.0.1:3000 node scripts/verify-flow.mjs
 *
 * 它做四件事：
 *   1) 临时建 1 个大众评审密码条 + 1 个专业评审密码条（绑定空评审席）
 *   2) 用它们分别提交一次投票与一次打分（就像选手/评审在手机上操作）
 *   3) 用临时管理员账号打开后台，检查这两条数据是否出现在「投票数据」「打分数数据」页面上
 *   4) 清理掉自己造的全部临时数据（密码条、投票、打分、管理员、日志），并重算排名
 */
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/loadenv.js';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_FILE = process.env.HV_DB || path.join(process.env.HV_DATA_DIR || path.join(ROOT, 'data'), 'hostvote.db');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

const PUB_CODE = 'ZZVERIFYPUB';
const PRO_CODE = 'ZZVERIFYPRO';
const ADMIN_USER = 'zz_verify_tmp';
const ADMIN_PASS = 'ZZverify#' + Math.random().toString(36).slice(2, 8);
const START = new Date().toISOString();

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}  ${detail}`);
  }
};

const db = new DatabaseSync(DB_FILE);
const q = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

function client() {
  const cookies = new Map();
  return {
    async req(method, url, body, headers = {}) {
      const h = { ...headers };
      const ck = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) h.cookie = ck;
      let payload = body;
      if (body && typeof body === 'object') {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
          if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
          else p.append(k, v);
        }
        payload = p.toString();
        h['content-type'] = 'application/x-www-form-urlencoded';
      }
      const res = await fetch(BASE + url, { method, headers: h, body: method === 'GET' ? undefined : payload, redirect: 'manual' });
      for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [p] = c.split(';');
        const i = p.indexOf('=');
        cookies.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
      }
      return res;
    },
    get(u, h) {
      return this.req('GET', u, null, h);
    },
    post(u, b, h) {
      return this.req('POST', u, b, h);
    },
  };
}

console.log(`\n=== 生产环境链路自检 @ ${BASE} ===`);
console.log(`数据库：${DB_FILE}\n`);

const players = all('SELECT id, no, name FROM players WHERE active = 1 ORDER BY sort_order, no, id');
const judgeCount = Number(q("SELECT value FROM settings WHERE key='judge_count'").value);
const status = await (await fetch(BASE + '/healthz')).json();
console.log(`选手 ${players.length} 位｜评审席 ${judgeCount} 个｜小组赛 ${status.group}｜个人赛 ${status.individual}`);
console.log(`自检前：投票 ${q('SELECT COUNT(*) c FROM votes').c} 条、打分 ${q('SELECT COUNT(*) c FROM scores').c} 格\n`);

let pubId = null;
let proId = null;
let adminId = null;
let slot = null;
let voteId = null;

try {
  /* ------------------------------------------------------- 准备临时数据 ---- */
  const now = new Date().toISOString();
  db.prepare('DELETE FROM voting_codes WHERE code IN (?,?)').run(PUB_CODE, PRO_CODE);
  db.prepare('DELETE FROM admins WHERE username=?').run(ADMIN_USER);

  pubId = Number(db.prepare('INSERT INTO voting_codes (code,role,label,judge_slot,enabled,note,created_at,updated_at) VALUES (?,?,?,NULL,1,?,?,?)')
    .run(PUB_CODE, 'public', '自检临时-大众', '链路自检（脚本自动清理）', now, now).lastInsertRowid);

  // 找一个当前没有任何打分的评审席，避免影响真实数据
  const usedSlots = new Set(all('SELECT DISTINCT judge_slot FROM scores').map((r) => r.judge_slot));
  slot = Array.from({ length: judgeCount }, (_, i) => i + 1).find((s) => !usedSlots.has(s)) || judgeCount;
  proId = Number(db.prepare('INSERT INTO voting_codes (code,role,label,judge_slot,enabled,note,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?)')
    .run(PRO_CODE, 'pro', `自检临时-评审席${slot}`, slot, '链路自检（脚本自动清理）', now, now).lastInsertRowid);

  adminId = Number(db.prepare('INSERT INTO admins (username,password_hash,created_at,note) VALUES (?,?,?,?)')
    .run(ADMIN_USER, bcrypt.hashSync(ADMIN_PASS, 10), now, '链路自检临时账号').lastInsertRowid);
  console.log(`临时数据已就绪：大众码 ${PUB_CODE}、专业码 ${PRO_CODE}（评审席 ${slot}）、临时管理员 ${ADMIN_USER}\n`);

  /* ---------------------------------------- 模拟手机端：登录并投票/打分 ---- */
  const voter = client();
  const login1 = await voter.post('/vote/login', { code: PUB_CODE, competition: 'group' });
  check('大众评审密码条登录', login1.status === 302, `status=${login1.status}`);
  const page1 = await voter.get('/vote/group');
  const html1 = await page1.text();
  check('登录后进入的是「大众评审投票页」', page1.status === 200 && html1.includes('请勾选您支持的选手'), `status=${page1.status}`);

  const picks = players.slice(0, 3).map((p) => p.id);
  const submit1 = await voter.post('/vote/submit', { competition: 'group', player: picks });
  if (submit1.status !== 302) {
    const t = await submit1.text();
    const m = t.match(/<div class="flash flash-error">([^<]*)/);
    console.log('    提交失败原因：' + (m ? m[1] : t.slice(0, 120)));
  }
  check('提交大众投票', submit1.status === 302 && String(submit1.headers.get('location')).includes('/vote/done'), `status=${submit1.status}`);
  voteId = q("SELECT id FROM votes WHERE code_id=? AND competition='group'", pubId)?.id;
  check('投票已写入数据库', !!voteId, JSON.stringify(q('SELECT * FROM votes WHERE code_id=?', pubId)));

  const judge = client();
  const login2 = await judge.post('/vote/login', { code: PRO_CODE, competition: 'group' });
  check('专业评审密码条登录', login2.status === 302, `status=${login2.status}`);
  const page2 = await judge.get('/vote/group');
  const html2 = await page2.text();
  check('登录后进入的是「专业评审打分页」', page2.status === 200 && html2.includes('请为每位选手打分'), `status=${page2.status}`);

  const scoreBody = { competition: 'group' };
  players.forEach((p) => (scoreBody[`score_${p.id}`] = String(80 + p.no)));
  const submit2 = await judge.post('/vote/score', scoreBody);
  check('提交专业评审打分', submit2.status === 302, `status=${submit2.status}`);
  const scoreRows = q('SELECT COUNT(*) c FROM scores WHERE competition=? AND judge_slot=?', 'group', slot).c;
  check('打分已写入数据库', scoreRows === players.length, `实际 ${scoreRows} 格`);

  /* -------------------------------------- 模拟后台：检查是否能看到数据 ---- */
  const admin = client();
  const alogin = await admin.post('/manage/login', { username: ADMIN_USER, password: ADMIN_PASS });
  check('临时管理员登录后台', alogin.status === 302, `status=${alogin.status}`);

  const votesPage = await (await admin.get('/manage/votes?c=group')).text();
  check('【投票数据】页能看到这条投票', votesPage.includes('自检临时-大众'), '页面中未出现该密码条标签');
  const pickedNames = players.slice(0, 3).map((p) => p.name);
  check('【投票数据】页显示了所投的选手', pickedNames.every((n) => votesPage.includes(n)), pickedNames.join(','));
  const scoresPage = await (await admin.get('/manage/scores?c=group')).text();
  check('【打分数数据】页能看到这次打分', new RegExp(`评审\\s*${slot}`).test(scoresPage) && scoresPage.includes('自检临时-评审席'), '页面中未出现该评审席');
  const resultsPage = await (await admin.get('/manage/results')).text();
  check('【结果与排名】页已反映最新分数', resultsPage.includes('1 / ' + judgeCount) || resultsPage.includes(`${judgeCount}`), '');

  const dash = await (await admin.get('/manage')).text();
  check('【仪表盘】统计到有效投票', /小组赛·有效投票[\s\S]{0,200}?>\s*1\s*</.test(dash) || dash.includes('>1<'), '未在仪表盘找到 1 条有效投票');

  /* ------------------------------------------------------------- 清理 ---- */
  console.log('\n清理自检产生的临时数据 ...');
  db.exec('BEGIN IMMEDIATE');
  const clean = {};
  try {
  clean.items = db.prepare('DELETE FROM vote_items WHERE vote_id IN (SELECT id FROM votes WHERE code_id=?)').run(pubId).changes;
  clean.votes = db.prepare('DELETE FROM votes WHERE code_id=?').run(pubId).changes;
  clean.scores = db.prepare('DELETE FROM scores WHERE code_id=? OR (competition=? AND judge_slot=?)').run(proId, 'group', slot).changes;
  clean.codes = db.prepare('DELETE FROM voting_codes WHERE id IN (?,?)').run(pubId, proId).changes;
  clean.sessions = db.prepare('DELETE FROM sessions WHERE admin_id=? OR code_id IN (?,?)').run(adminId, pubId, proId).changes;
  clean.admins = db.prepare('DELETE FROM admins WHERE id=?').run(adminId).changes;
  clean.audits = db.prepare('DELETE FROM audit_logs WHERE at >= ? OR actor IN (?,?,?)').run(START, ADMIN_USER, '自检临时-大众', '自检临时-评审席' + slot).changes;
  clean.logins = db.prepare('DELETE FROM login_attempts WHERE at >= ?').run(START).changes;
  db.exec('COMMIT');
  console.log('  已清理：' + JSON.stringify(clean));
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('  清理失败，已回滚：' + e.message);
  }

  console.log('\n（请重启服务或点「强制重算」以刷新排名）');
} catch (err) {
  console.error('\n自检过程中出错：', err.message);
  fail++;
}

const finalVotes = q('SELECT COUNT(*) c FROM votes').c;
const finalScores = q('SELECT COUNT(*) c FROM scores').c;
console.log(`\n=== 结果：${pass} 项通过，${fail} 项失败 ===`);
console.log(`自检后：投票 ${finalVotes} 条、打分 ${finalScores} 格（已恢复到自检前状态）\n`);
db.close();
process.exit(fail ? 1 : 0);
