/**
 * 深度审计脚本（本地专用）
 * 针对投票、计分、数据一致性做边界与对抗性测试，找出 e2e 没覆盖的问题。
 *
 *   node scripts/audit.mjs
 *   BASE=http://127.0.0.1:3100 ADMIN_PASS=LocalTest123 node scripts/audit.mjs
 *
 * 会自动造数据并在结束后清理；不修改（除临时设置的）系统配置。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'hostvote.db');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'LocalTest123';

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error('本脚本会修改数据，只允许对本地环境运行（BASE 指向本机）');
  process.exit(2);
}

const db = new DatabaseSync(DB_FILE);
const q = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

let pass = 0;
const bugs = [];
const notes = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else bugs.push({ name, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : '   → ' + detail}`);
};
const note = (t) => notes.push(t);

function newClient() {
  const cookies = new Map();
  return {
    cookies,
    async req(method, url, body, headers = {}) {
      const h = { ...headers };
      const ck = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) h.cookie = ck;
      let payload = body;
      if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
          if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
          else p.append(k, v);
        }
        payload = p.toString();
        h['content-type'] = 'application/x-www-form-urlencoded';
      }
      const res = await fetch(BASE + url, { method, headers: h, body: method === 'GET' ? undefined : payload, redirect: 'manual' });
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
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

const admin = newClient();
await admin.post('/manage/login', { username: ADMIN_USER, password: ADMIN_PASS });

/* 记录初始配置以便还原 */
const CFG_KEYS = [
  'group_enabled', 'group_start_at', 'group_end_at',
  'individual_enabled', 'individual_start_at', 'individual_end_at',
  'public_pick_count', 'top_points', 'zero_vote_points', 'tie_rank_rule',
  'judge_count', 'missing_judge_rule', 'pro_can_edit',
  'weight_group', 'weight_individual', 'score_cap', 'score_decimals', 'final_tie_break',
];
const ORIG_CFG = Object.fromEntries(CFG_KEYS.map((k) => [k, q('SELECT value FROM settings WHERE key=?', k)?.value]));
const restoreCfg = () => {
  for (const [k, v] of Object.entries(ORIG_CFG)) run('UPDATE settings SET value=? WHERE key=?', v ?? '', k);
};

const TAG = 'AUD' + Date.now().toString(36).slice(-4).toUpperCase();
const created = { codes: [], players: [], votes: [], scores: [] };

function addCode(role, label, slot = null) {
  const code = TAG + role.slice(0, 1).toUpperCase() + String(created.codes.length).padStart(2, '0');
  const info = run(
    `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
     VALUES (?,?,?,?,1,?,?,?)`,
    code, role, label, slot, '审计临时', new Date().toISOString(), new Date().toISOString()
  );
  const id = Number(info.lastInsertRowid);
  created.codes.push(id);
  return { id, code };
}
function addPlayer(name, no) {
  const info = run(
    `INSERT INTO players (no, name, photo, tag, intro, active, sort_order, created_at, updated_at)
     VALUES (?,?,NULL,NULL,NULL,1,999,?,?)`,
    no, name, new Date().toISOString(), new Date().toISOString()
  );
  const id = Number(info.lastInsertRowid);
  created.players.push(id);
  return id;
}

const playersAll = all('SELECT id, no, name FROM players WHERE active=1 ORDER BY sort_order, no, id');
const cleanup = () => {
  try {
    restoreCfg();
    run('DELETE FROM vote_items WHERE vote_id IN (SELECT id FROM votes WHERE code_id IN (SELECT id FROM voting_codes WHERE note=?))', '审计临时');
    run('DELETE FROM votes WHERE code_id IN (SELECT id FROM voting_codes WHERE note=?)', '审计临时');
    run('DELETE FROM scores WHERE note=? OR code_id IN (SELECT id FROM voting_codes WHERE note=?)', '审计临时', '审计临时');
    run('DELETE FROM sessions WHERE code_id IN (SELECT id FROM voting_codes WHERE note=?) OR admin_id IS NULL AND role=?', '审计临时', 'x');
    run('DELETE FROM voting_codes WHERE note=?', '审计临时');
    run('DELETE FROM players WHERE id IN (SELECT id FROM players WHERE name LIKE ?)', TAG + '%');
    run('DELETE FROM vote_items WHERE vote_id NOT IN (SELECT id FROM votes)');
    run('DELETE FROM results WHERE player_id NOT IN (SELECT id FROM players)');
    run('DELETE FROM final_results WHERE player_id NOT IN (SELECT id FROM players)');
    run("DELETE FROM audit_logs WHERE note LIKE '%审计%' OR actor LIKE ?", TAG + '%');
    run('DELETE FROM login_attempts WHERE identifier LIKE ?', TAG + '%');
  } catch (e) {
    console.error('清理出错：', e.message);
  }
};

console.log(`\n=== 深度审计 @ ${BASE} ===\n`);

try {
  /* ============================================================ 一、投票链路 ==== */
  console.log('【一】大众投票边界');

  // 确保小组赛可投
  run("UPDATE settings SET value='1' WHERE key='group_enabled'");
  run("UPDATE settings SET value='' WHERE key IN ('group_start_at','group_end_at')");

  const pick = playersAll.slice(0, 3).map((p) => p.id);

  // 1.1 正常投票
  {
    const c = addCode('public', '审计-正常');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const r = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('正常投票成功', r.status === 302, `status=${r.status}`);
  }

  // 1.2 停用密码条后，已登录会话不得再提交（当前实现可能漏检）
  {
    const c = addCode('public', '审计-停用');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    run('UPDATE voting_codes SET enabled=0 WHERE id=?', c.id);
    const r = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('密码条被停用后，已登录会话不能继续投票', r.status === 400 || r.status === 403, `status=${r.status}（若能提交说明漏检）`);
    const got = q('SELECT COUNT(*) c FROM votes WHERE code_id=? AND invalid=0', c.id).c;
    check('停用后确实没有写入投票', got === 0, `实际写入 ${got} 条`);
    run('UPDATE voting_codes SET enabled=1 WHERE id=?', c.id);
  }

  // 1.3 重复提交（并发）
  {
    const c = addCode('public', '审计-并发');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(() => cl.post('/vote/submit', { competition: 'group', player: pick }))
    );
    const okCount = results.filter((r) => r.status === 302).length;
    const rows = q('SELECT COUNT(*) c FROM votes WHERE code_id=? AND invalid=0', c.id).c;
    check('并发重复提交只写入 1 条投票', rows === 1, `成功响应 ${okCount} 次、写入 ${rows} 条`);
  }

  // 1.4 非法选手 ID
  for (const [label, value] of [
    ['不存在的大 ID', ['99999999']],
    ['负数/零', ['-1', '0']],
    ['非数字', ['abc', 'null', 'undefined']],
  ]) {
    const c = addCode('public', '审计-非法' + label);
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const r = await cl.post('/vote/submit', { competition: 'group', player: value });
    const wrote = q('SELECT COUNT(*) c FROM votes WHERE code_id=? AND invalid=0', c.id).c;
    check(`非法选票被拒绝（${label}）`, wrote === 0, `status=${r.status}，却写入了 ${wrote} 条`);
  }

  // 重复勾选同一选手：应去重后按「少选」处理（1 票），不能重复计数
  {
    const c = addCode('public', '审计-重复勾选');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const dup = playersAll[0].id;
    const r = await cl.post('/vote/submit', { competition: 'group', player: [dup, dup, dup] });
    const v = q('SELECT id FROM votes WHERE code_id=? AND invalid=0', c.id);
    const itemCount = v ? q('SELECT COUNT(*) c FROM vote_items WHERE vote_id=?', v.id).c : 0;
    check('重复勾选同一选手会被去重为 1 票', r.status === 302 && itemCount === 1, `status=${r.status}，条目数 ${itemCount}`);
  }

  // 1.5 已停用的选手不能被投
  {
    const pid = addPlayer(TAG + '临时选手甲', 900);
    const c = addCode('public', '审计-停用选手');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    run('UPDATE players SET active=0 WHERE id=?', pid);
    const r = await cl.post('/vote/submit', { competition: 'group', player: [playersAll[0].id, pid] });
    const wrote = q('SELECT COUNT(*) c FROM votes WHERE code_id=? AND invalid=0', c.id).c;
    check('已停用选手不能被投票', wrote === 0, `status=${r.status}，写入了 ${wrote} 条`);
  }

  // 1.6 超选 / 空选
  {
    const c = addCode('public', '审计-超选');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const over = await cl.post('/vote/submit', { competition: 'group', player: playersAll.slice(0, 4).map((p) => p.id) });
    const none = await cl.post('/vote/submit', { competition: 'group', player: [] });
    check('超过可选人数被拒绝', over.status === 400, `status=${over.status}`);
    check('一张都不选被拒绝', none.status === 400, `status=${none.status}`);
  }

  // 1.7 未登录直接提交
  {
    const anon = newClient();
    const r = await anon.post('/vote/submit', { competition: 'group', player: pick });
    check('未登录直接提交投票被拒（跳登录页）', r.status === 302 || r.status === 401, `status=${r.status}`);
  }

  // 1.8 伪造 / 篡改会话 cookie
  {
    const fake = newClient();
    fake.cookies.set('hv_sid', 'deadbeef'.repeat(8));
    const r = await fake.post('/vote/submit', { competition: 'group', player: pick });
    check('伪造的会话 cookie 不能投票', r.status === 302 || r.status === 401, `status=${r.status}`);
    const page = await fake.get('/vote/group');
    const html = await page.text();
    check('伪造会话访问投票页会回到登录页', /请输入您的密码条/.test(html), '');
  }

  // 1.9 赛事未开始 / 已截止
  {
    const c = addCode('public', '审计-未开始');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const future = new Date(Date.now() + 3600e3).toISOString();
    run("UPDATE settings SET value=? WHERE key='group_start_at'", future);
    const r1 = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('未开始的赛事不能投票', r1.status === 400, `status=${r1.status}`);
    run("UPDATE settings SET value='' WHERE key='group_start_at'");

    const past = new Date(Date.now() - 3600e3).toISOString();
    run("UPDATE settings SET value=? WHERE key='group_end_at'", past);
    const r2 = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('已截止的赛事不能投票', r2.status === 400, `status=${r2.status}`);
    run("UPDATE settings SET value='' WHERE key='group_end_at'");
  }

  // 1.10 截止时间边界（恰好在截止时刻应仍可提交，之后再拒绝）
  {
    const c = addCode('public', '审计-边界');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    run("UPDATE settings SET value=? WHERE key='group_end_at'", new Date(Date.now() + 1500).toISOString());
    const before = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('截止前 1.5 秒仍可投票', before.status === 302, `status=${before.status}`);
    run("UPDATE settings SET value='' WHERE key='group_end_at'");
  }

  // 1.11 密码条输入的容错（大小写、空格、横线）
  {
    const c = addCode('public', '审计-容错');
    const formatted = c.code.slice(0, 4) + '-' + c.code.slice(4);
    for (const [label, input] of [
      ['小写', c.code.toLowerCase()],
      ['带横线', formatted],
      ['带空格', ' ' + c.code.slice(0, 4) + ' ' + c.code.slice(4) + ' '],
    ]) {
      const cl = newClient();
      const r = await cl.post('/vote/login', { code: input, competition: 'group' });
      check(`密码条输入容错：${label}`, r.status === 302, `status=${r.status}`);
    }
  }

  /* ========================================================== 二、计分正确性 ==== */
  console.log('\n【二】计分正确性（手工复算比对）');

  // 构造一个可控场景：清空后写入确定数据
  const snapshot = {
    votes: all('SELECT * FROM votes'),
    items: all('SELECT * FROM vote_items'),
    scores: all('SELECT * FROM scores'),
  };
  const wipe = () => {
    db.exec('DELETE FROM vote_items'); db.exec('DELETE FROM votes'); db.exec('DELETE FROM scores');
  };
  const restoreSnapshot = () => {
    wipe();
    const iv = db.prepare('INSERT INTO votes (id,competition,code_id,code_snapshot,role,ip,ua,created_at,source,invalid,operator,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const v of snapshot.votes) iv.run(v.id, v.competition, v.code_id, v.code_snapshot, v.role, v.ip, v.ua, v.created_at, v.source, v.invalid, v.operator, v.note);
    const ii = db.prepare('INSERT INTO vote_items (id,vote_id,player_id) VALUES (?,?,?)');
    for (const it of snapshot.items) ii.run(it.id, it.vote_id, it.player_id);
    const is = db.prepare('INSERT INTO scores (id,competition,judge_slot,code_id,player_id,score,created_at,updated_at,source,operator,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const sc of snapshot.scores) is.run(sc.id, sc.competition, sc.judge_slot, sc.code_id, sc.player_id, sc.score, sc.created_at, sc.updated_at, sc.source, sc.operator, sc.note);
  };

  try {
    wipe();
    run("UPDATE settings SET value='4' WHERE key='judge_count'");
    run("UPDATE settings SET value='submitted' WHERE key='missing_judge_rule'");
    run("UPDATE settings SET value='110' WHERE key='score_cap'");
    run("UPDATE settings SET value='2' WHERE key='score_decimals'");
    run("UPDATE settings SET value='10' WHERE key='top_points'");
    run("UPDATE settings SET value='0' WHERE key='zero_vote_points'");

    const P = playersAll;
    // 票数设计：P0=4票, P1=4票（并列第1）, P2=1票, P3..P9=0票
    const mk = (codeId, ids) => {
      const info = run(
        `INSERT INTO votes (competition, code_id, code_snapshot, role, ip, ua, created_at, source, invalid, note)
         VALUES ('group', NULL, ?, 'public', '1.1.1.1', 'audit', ?, 'manual', 0, '审计')`,
        TAG, new Date().toISOString()
      );
      const vid = Number(info.lastInsertRowid);
      for (const id of ids) run('INSERT INTO vote_items (vote_id, player_id) VALUES (?,?)', vid, id);
    };
    mk(null, [P[0].id, P[1].id, P[2].id]);
    mk(null, [P[0].id, P[1].id]);
    mk(null, [P[0].id, P[1].id]);
    mk(null, [P[0].id]);
    mk(null, [P[1].id]);

    // 打分：评审1给 100/90/80… ，评审2只提交前 5 人
    for (let i = 0; i < P.length; i++) {
      run(`INSERT INTO scores (competition, judge_slot, code_id, player_id, score, created_at, updated_at, source, operator, note)
           VALUES ('group', 1, NULL, ?, ?, ?, ?, 'manual', 'audit', '审计')`, P[i].id, 100 - i * 10, new Date().toISOString(), new Date().toISOString());
    }
    for (let i = 0; i < 5; i++) {
      run(`INSERT INTO scores (competition, judge_slot, code_id, player_id, score, created_at, updated_at, source, operator, note)
           VALUES ('group', 2, NULL, ?, ?, ?, ?, 'manual', 'audit', '审计')`, P[i].id, 60, new Date().toISOString(), new Date().toISOString());
    }

    await admin.post('/manage/recalc', { back: '/manage' });
    const res = new Map(all("SELECT * FROM results WHERE competition='group'").map((r) => [r.player_id, r]));

    // 手工期望
    const expectVotes = [4, 4, 1, 0, 0, 0, 0, 0, 0, 0];
    let votesOk = true;
    P.forEach((p, i) => {
      const a = res.get(p.id)?.public_votes ?? -1;
      if (a !== expectVotes[i]) { votesOk = false; note(`${p.name} 票数 期望${expectVotes[i]} 实际${a}`); }
    });
    check('票数统计正确', votesOk);

    // 并列第1（4票两人）→ 都赋 10 分；第3名（1票）→ 名次3 → 8 分；0票 → 0分
    check('并列第 1 名两人均得 10 分', res.get(P[0].id).public_points === 10 && res.get(P[1].id).public_points === 10,
      `${res.get(P[0].id).public_points}/${res.get(P[1].id).public_points}`);
    check('并列后名次顺延（第 3 名）', res.get(P[2].id).public_rank === 3, `实际 ${res.get(P[2].id).public_rank}`);
    check('第 3 名赋 8 分', res.get(P[2].id).public_points === 8, `实际 ${res.get(P[2].id).public_points}`);
    check('零票选手赋 0 分', res.get(P[9].id).public_points === 0, `实际 ${res.get(P[9].id).public_points}`);

    // 专业平均分：P0 = (100+60)/2 = 80（按实际提交人数）
    check('专业平均分按实际提交人数计算（(100+60)/2=80）', Math.abs(res.get(P[0].id).pro_avg - 80) < 1e-9, `实际 ${res.get(P[0].id).pro_avg}`);
    check('仅 1 位评审提交时平均分即为该分数（P6=40）', Math.abs(res.get(P[6].id).pro_avg - 40) < 1e-9, `实际 ${res.get(P[6].id).pro_avg}`);
    check('有效评审席数量正确记录', res.get(P[0].id).pro_judges === 2 && res.get(P[6].id).pro_judges === 1,
      `${res.get(P[0].id).pro_judges}/${res.get(P[6].id).pro_judges}`);

    // 得分 = 平均分 + 赋分
    check('赛事得分 = 专业平均分 + 大众赋分', Math.abs(res.get(P[0].id).final_score - (80 + 10)) < 1e-9, `实际 ${res.get(P[0].id).final_score}`);
    check('零票选手得分 = 平均分', Math.abs(res.get(P[9].id).final_score - 10) < 1e-9, `实际 ${res.get(P[9].id).final_score}`);

    // 最终总成绩 = 小组赛×0.4 + 个人赛×0.6
    const fin = new Map(all('SELECT * FROM final_results').map((r) => [r.player_id, r]));
    const f0 = fin.get(P[0].id);
    const expectTotal = Math.round((f0.group_score * 0.4 + f0.individual_score * 0.6) * 100) / 100;
    check('最终总成绩加权计算正确', Math.abs(f0.total_score - expectTotal) < 1e-9, `${f0.total_score} vs ${expectTotal}`);

    // 与内存计算（页面/导出所用）保持一致
    const liveRes = await admin.get('/manage/export/full');
    check('导出接口在统计状态下可用', liveRes.status === 200, `status=${liveRes.status}`);

    /* ---- 中途修改规则后是否正确重算 ---- */
    run("UPDATE settings SET value='110' WHERE key='score_cap'");
    run("UPDATE settings SET value='1' WHERE key='score_cap'"); // 极端：上限 1 分
    await admin.post('/manage/recalc', { back: '/manage' });
    const capped = q("SELECT final_score FROM results WHERE competition='group' AND player_id=?", P[0].id).final_score;
    check('把上限设为 1 分时全部被截断为 1', capped === 1, `实际 ${capped}`);
    run("UPDATE settings SET value='110' WHERE key='score_cap'");

    /* ---- missing_judge_rule = all 的行为 ---- */
    run("UPDATE settings SET value='all' WHERE key='missing_judge_rule'");
    await admin.post('/manage/recalc', { back: '/manage' });
    const p6all = q("SELECT pro_avg FROM results WHERE competition='group' AND player_id=?", P[6].id).pro_avg;
    check('缺评按 0 分计入（÷4）时 P6 = 40/4 = 10', Math.abs(p6all - 10) < 1e-9, `实际 ${p6all}`);
    run("UPDATE settings SET value='submitted' WHERE key='missing_judge_rule'");

    /* ---- 超过 10 位选手时名次赋分 ---- */
    const extra = [addPlayer(TAG + '临时十一', 911), addPlayer(TAG + '临时十二', 912)];
    await admin.post('/manage/recalc', { back: '/manage' });
    const e11 = q("SELECT public_rank, public_points FROM results WHERE competition='group' AND player_id=?", extra[0]);
    note(`11 位选手时第 11 名的名次=${e11?.public_rank}、赋分=${e11?.public_points}（0 票，按规则应为 0 分）`);
    run('UPDATE players SET active=0 WHERE id IN (?,?)', extra[0], extra[1]);
    run('DELETE FROM players WHERE id IN (?,?)', extra[0], extra[1]);
    created.players = created.players.filter((x) => x !== extra[0] && x !== extra[1]);
    await admin.post('/manage/recalc', { back: '/manage' });

    /* ---- 停用选手后，结果表不得残留旧行 ---- */
    const p9 = P[9].id;
    run('UPDATE players SET active=0 WHERE id=?', p9);
    await admin.post('/manage/recalc', { back: '/manage' });
    const staleResults = q("SELECT COUNT(*) c FROM results WHERE competition='group' AND player_id=?", p9).c;
    const staleFinal = q('SELECT COUNT(*) c FROM final_results WHERE player_id=?', p9).c;
    check('停用选手后 results 不残留旧行', staleResults === 0, `残留 ${staleResults} 行`);
    check('停用选手后 final_results 不残留旧行', staleFinal === 0, `残留 ${staleFinal} 行`);
    const board = await (await admin.get('/manage/results')).text();
    check('停用选手不出现在结果页', !board.includes(P[9].name), `页面中仍出现 ${P[9].name}`);
    run('UPDATE players SET active=1 WHERE id=?', p9);
    await admin.post('/manage/recalc', { back: '/manage' });

    /* ---- 删除选手（有投票时必须拒绝） ---- */
    const hasVotes = q("SELECT COUNT(*) c FROM vote_items WHERE player_id=?", P[0].id).c > 0;
    if (hasVotes) {
      const delRes = await admin.post('/manage/players/delete', { id: P[0].id });
      const stillThere = q('SELECT COUNT(*) c FROM players WHERE id=?', P[0].id).c;
      check('有投票记录的选手不能被删除', stillThere === 1, `status=${delRes.status}，选手被删除了`);
    }
  } finally {
    restoreSnapshot();
  }

  /* ======================================================== 三、数据一致性 ==== */
  console.log('\n【三】数据一致性');

  await admin.post('/manage/recalc', { back: '/manage' });

  // 3.1 落库结果 vs 实时计算
  {
    const stored = all("SELECT * FROM results WHERE competition='group'");
    const liveVotes = new Map(
      all(`SELECT vi.player_id, COUNT(*) c FROM vote_items vi JOIN votes v ON v.id=vi.vote_id
           WHERE v.competition='group' AND v.invalid=0 GROUP BY vi.player_id`).map((r) => [r.player_id, r.c])
    );
    let mismatch = 0;
    for (const r of stored) {
      if ((liveVotes.get(r.player_id) || 0) !== r.public_votes) mismatch++;
    }
    check('落库票数与实时统计一致', mismatch === 0, `${mismatch} 位选手不一致`);
  }

  // 3.2 孤儿数据
  {
    const orphanItems = q('SELECT COUNT(*) c FROM vote_items WHERE vote_id NOT IN (SELECT id FROM votes)').c;
    check('无孤儿 vote_items', orphanItems === 0, `孤儿 ${orphanItems} 条`);
    const orphanResults = q('SELECT COUNT(*) c FROM results WHERE player_id NOT IN (SELECT id FROM players)').c;
    check('无指向已删除选手的 results', orphanResults === 0, `孤儿 ${orphanResults} 行`);
    const orphanFinal = q('SELECT COUNT(*) c FROM final_results WHERE player_id NOT IN (SELECT id FROM players)').c;
    check('无指向已删除选手的 final_results', orphanFinal === 0, `孤儿 ${orphanFinal} 行`);
    const dupRank = q(`SELECT COUNT(*) c FROM (SELECT player_id FROM final_results WHERE final_rank=1 GROUP BY final_rank HAVING COUNT(*)>1)`).c;
    note(`最终第 1 名人数：${q('SELECT COUNT(*) c FROM final_results WHERE final_rank=1').c}（并列同名次是允许的）`);
    // 同一评审席同选手唯一
    const dupScore = q('SELECT COUNT(*) c FROM (SELECT competition,judge_slot,player_id FROM scores GROUP BY competition,judge_slot,player_id HAVING COUNT(*)>1)').c;
    check('打分明细无重复（评审席×选手唯一）', dupScore === 0, `重复 ${dupScore} 组`);
    // 分数范围
    const badScore = q('SELECT COUNT(*) c FROM scores WHERE score<0 OR score>100').c;
    check('所有打分都在 0-100 之间', badScore === 0, `越界 ${badScore} 条`);
  }

  // 3.3 密码条投票状态与实际投票一致
  {
    const bad = q(`
      SELECT COUNT(*) c FROM (
        SELECT c.id,
          (SELECT COUNT(*) FROM votes v WHERE v.code_id=c.id AND v.competition='group' AND v.invalid=0) g
        FROM voting_codes c WHERE c.role='public'
      ) WHERE g > 1`).c;
    check('没有任何大众评审密码条在同一赛事投过两次', bad === 0, `${bad} 条异常`);
  }

  /* ============================================================ 四、管理操作 ==== */
  console.log('\n【四】管理操作一致性');

  // 4.1 作废投票后，密码条恢复可投
  {
    const c = addCode('public', '审计-作废恢复');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    await cl.post('/vote/submit', { competition: 'group', player: pick });
    const v = q('SELECT id FROM votes WHERE code_id=? AND invalid=0', c.id);
    await admin.post('/manage/votes/invalidate', { voteId: v.id, competition: 'group', invalid: '1' });
    const again = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('投票作废后同一密码条可重新投票', again.status === 302, `status=${again.status}`);
  }

  // 4.2 手动补票 N 张 = 票数 +N
  {
    const target = playersAll[2];
    const before = q("SELECT public_votes FROM results WHERE competition='group' AND player_id=?", target.id).public_votes;
    await admin.post('/manage/manual/apply', { competition: 'group', kind: 'bulk', playerId: target.id, count: 3, note: '审计补票' });
    const after = q("SELECT public_votes FROM results WHERE competition='group' AND player_id=?", target.id).public_votes;
    check('手动补 3 票后票数 +3', after - before === 3, `${before} → ${after}`);
  }

  // 4.3 清空单个赛事投票不影响另一赛事
  {
    const indBefore = q("SELECT COUNT(*) c FROM votes WHERE competition='individual'").c;
    const indScoresBefore = q("SELECT COUNT(*) c FROM scores WHERE competition='individual'").c;
    await admin.post('/manage/reset/apply', { groupVotes: 'on', password: ADMIN_PASS });
    const gAfter = q("SELECT COUNT(*) c FROM votes WHERE competition='group'").c;
    const indAfter = q("SELECT COUNT(*) c FROM votes WHERE competition='individual'").c;
    const indScoresAfter = q("SELECT COUNT(*) c FROM scores WHERE competition='individual'").c;
    check('清空小组赛投票后小组赛票数为 0', gAfter === 0, `剩余 ${gAfter}`);
    check('清空小组赛投票不影响个人赛', indAfter === indBefore && indScoresAfter === indScoresBefore, '');
  }

  // 4.4 修改选手姓名/停用后重算
  {
    const p = playersAll[3];
    await admin.post('/manage/players/save', { id: p.id, no: p.no, name: TAG + '改名测试', active: 'on' });
    const newName = q('SELECT name FROM players WHERE id=?', p.id).name;
    check('修改选手姓名生效', newName === TAG + '改名测试', `实际 ${newName}`);
    await admin.post('/manage/players/save', { id: p.id, no: p.no, name: p.name, active: 'on' });
  }

  /* ============================================================ 五、安全与输入 ==== */
  console.log('\n【五】安全与输入处理');

  // 5.1 选手名中的 HTML 必须被转义（XSS）
  {
    const pid = addPlayer(TAG + '<img src=x onerror=alert(1)>', 950);
    const page = await (await fetch(BASE + '/vote/group')).text();
    check('选手名中的 HTML 被转义（不出现可执行标签）', !page.includes('<img src=x onerror'), '页面中出现了未转义的标签');
    run('UPDATE players SET active=0 WHERE id=?', pid);
  }

  // 5.2 后台写接口需要登录
  {
    const anon = newClient();
    const r1 = await anon.post('/manage/recalc', {});
    const r2 = await anon.post('/manage/players/save', { name: 'x' });
    check('未登录不能调用后台写接口', r1.status === 302 || r1.status === 401, `status=${r1.status}`);
    check('未登录不能修改选手', r2.status === 302 || r2.status === 401, `status=${r2.status}`);
  }

  // 5.3 路径容错：末尾斜杠
  {
    const r = await fetch(BASE + '/vote/group/');
    note(`访问 /vote/group/（带末尾斜杠）返回 ${r.status}${r.status === 404 ? '（选手手输网址可能遇到）' : ''}`);
  }

  // 5.4 不存在的入口
  {
    const r = await fetch(BASE + '/vote/whatever');
    check('不存在的投票入口返回 404', r.status === 404, `status=${r.status}`);
  }

  // 5.5 上传校验：非图片应被拒；合法图片应成功；被拒时不得改动数据
  {
    const target = playersAll[0].id;
    const photoBefore = q('SELECT photo FROM players WHERE id=?', target).photo;

    const fd = new FormData();
    fd.append('playerId', String(target));
    fd.append('photo', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'x.txt');
    const r = await admin.req('POST', '/manage/players/photo', fd);
    const loc = decodeURIComponent(r.headers.get('location') || '');
    const msg = r.status === 302 ? loc : await r.text();
    check('上传非图片文件被拒绝并提示', /仅支持/.test(msg), `status=${r.status} loc=${loc.slice(0, 100)}`);
    check('被拒绝的上传不会修改选手照片', q('SELECT photo FROM players WHERE id=?', target).photo === photoBefore, '照片被改动了');

    // 合法的最小 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const fd2 = new FormData();
    fd2.append('playerId', String(target));
    fd2.append('photo', new Blob([png], { type: 'image/png' }), 'ok.png');
    const r2 = await admin.req('POST', '/manage/players/photo', fd2);
    const loc2 = decodeURIComponent(r2.headers.get('location') || '');
    const after = q('SELECT photo FROM players WHERE id=?', target).photo;
    check('上传合法 PNG 成功并写入照片字段', r2.status === 302 && /flash=ok/.test(loc2) && !!after && after !== photoBefore,
      `status=${r2.status} loc=${loc2.slice(0, 80)} photo=${after}`);
    const served = await fetch(`${BASE}/uploads/${after}`);
    check('上传的照片可通过 /uploads/ 访问', served.status === 200, `status=${served.status}`);
    // 还原
    run('UPDATE players SET photo=NULL WHERE id=?', target);
  }


  /* ==================================================== 六、深入一致性校验 ==== */
  console.log('\n【六】深入一致性校验');

  // 6.1 两个赛事互相独立
  {
    wipe();
    run("UPDATE settings SET value='1' WHERE key='group_enabled'");
    run("UPDATE settings SET value='1' WHERE key='individual_enabled'");
    const P = playersAll;
    const putVote = (comp, ids) => {
      const info = run(
        `INSERT INTO votes (competition, code_id, code_snapshot, role, ip, ua, created_at, source, invalid, note)
         VALUES (?, NULL, ?, 'public', '1.1.1.1', 'audit', ?, 'manual', 0, '审计')`,
        comp, TAG, new Date().toISOString()
      );
      const vid = Number(info.lastInsertRowid);
      for (const id of ids) run('INSERT INTO vote_items (vote_id, player_id) VALUES (?,?)', vid, id);
    };
    putVote('group', [P[0].id, P[1].id, P[2].id]);
    putVote('group', [P[0].id, P[1].id]);
    putVote('individual', [P[5].id, P[6].id, P[7].id]);

    run(`INSERT INTO scores (competition,judge_slot,player_id,score,created_at,updated_at,source,operator,note)
         VALUES ('group',1,?,?,?,?,'manual','audit','审计')`, P[0].id, 90, new Date().toISOString(), new Date().toISOString());
    run(`INSERT INTO scores (competition,judge_slot,player_id,score,created_at,updated_at,source,operator,note)
         VALUES ('individual',1,?,?,?,?,'manual','audit','审计')`, P[5].id, 70, new Date().toISOString(), new Date().toISOString());

    await admin.post('/manage/recalc', { back: '/manage' });
    const g = new Map(all("SELECT * FROM results WHERE competition='group'").map((r) => [r.player_id, r]));
    const i = new Map(all("SELECT * FROM results WHERE competition='individual'").map((r) => [r.player_id, r]));

    check('小组赛票数独立统计（P0=2, P1=2, P2=1）',
      g.get(P[0].id).public_votes === 2 && g.get(P[1].id).public_votes === 2 && g.get(P[2].id).public_votes === 1,
      `${g.get(P[0].id).public_votes}/${g.get(P[1].id).public_votes}/${g.get(P[2].id).public_votes}`);
    check('个人赛票数不受小组赛影响（P5=1，其余 0）',
      i.get(P[5].id).public_votes === 1 && i.get(P[0].id).public_votes === 0,
      `P5=${i.get(P[5].id).public_votes} P0=${i.get(P[0].id).public_votes}`);
    check('小组赛专业均分不影响个人赛',
      Math.abs(g.get(P[0].id).pro_avg - 90) < 1e-9 && Math.abs(i.get(P[5].id).pro_avg - 70) < 1e-9,
      `g(P0)=${g.get(P[0].id).pro_avg} i(P5)=${i.get(P[5].id).pro_avg}`);

    // 6.2 两个赛事都有数据时，最终总成绩 = 小组×0.4 + 个人×0.6（逐人手算比对）
    const fin = all('SELECT * FROM final_results');
    const wg = Number(q("SELECT value FROM settings WHERE key='weight_group'").value);
    const wi = Number(q("SELECT value FROM settings WHERE key='weight_individual'").value);
    let bad = 0;
    for (const f of fin) {
      const exp = Math.round((f.group_score * wg + f.individual_score * wi) * 100) / 100;
      if (Math.abs(f.total_score - exp) > 1e-9) { bad++; note(`${f.player_id}: ${f.total_score} vs ${exp}`); }
    }
    check('最终总成绩逐人加权计算正确', bad === 0, `${bad} 人偏差`);

    // 6.3 手动赋分预览 与 实际执行结果 必须一致（否则预览会误导）
    {
      const target = P[3].id;
      const pv = await admin.post('/manage/manual/preview', { competition: 'group', kind: 'bulk', playerId: target, count: 5, view: 'final' });
      const pvRows = (await pv.json()).rows || [];
      const pvRow = pvRows.find((r) => r.playerId === target) || pvRows.find((r) => String(r.name) === P[3].name);
      const beforeVotes = g.get(target).public_votes;
      await admin.post('/manage/manual/apply', { competition: 'group', kind: 'bulk', playerId: target, count: 5, note: '审计预览一致性' });
      const afterRow = q("SELECT public_votes, public_points, final_score FROM results WHERE competition='group' AND player_id=?", target);
      const previewOk = pvRow && pvRow.afterVotes === afterRow.public_votes && Math.abs(pvRow.afterPoints - afterRow.public_points) < 1e-9;
      check('手动赋分"预览"与"实际执行"结果一致（票数与赋分）',
        previewOk, `预览 after=${pvRow?.afterVotes}/${pvRow?.afterPoints}，实际=${afterRow.public_votes}/${afterRow.public_points}（原票数 ${beforeVotes}）`);
      const pvScoreOk = pvRow && Math.abs(pvRow.afterScore - afterRow.final_score) < 1e-9;
      check('手动赋分预览的赛事得分与实际一致', pvScoreOk, `预览=${pvRow?.afterScore} 实际=${afterRow.final_score}`);
    }

    // 6.4 导出 Excel 的数值必须与数据库一致
    {
      const { default: ExcelJS } = await import('exceljs');
      const res = await admin.get('/manage/export/full');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
      const ws = wb.getWorksheet('最终总排名');
      const dbFinal = new Map(all('SELECT f.*, p.name FROM final_results f JOIN players p ON p.id=f.player_id').map((r) => [r.name, r]));
      let checked = 0;
      let mismatch = 0;
      ws.eachRow((row, idx) => {
        if (idx === 1) return;
        const name = row.getCell(3).value;
        if (!name || !dbFinal.has(name)) return;
        const f = dbFinal.get(name);
        checked++;
        const total = Number(row.getCell(10).value);
        const gs = Number(row.getCell(6).value);
        const is = Number(row.getCell(9).value);
        if (Math.abs(total - f.total_score) > 1e-9 || Math.abs(gs - f.group_score) > 1e-9 || Math.abs(is - f.individual_score) > 1e-9) {
          mismatch++;
          note(`导出与库不一致：${name} 导出(${gs}/${is}/${total}) 库(${f.group_score}/${f.individual_score}/${f.total_score})`);
        }
      });
      check('导出"最终总排名"数值与数据库完全一致', mismatch === 0 && checked > 0, `比对 ${checked} 人，${mismatch} 人不一致`);

      // 仅排名表：姓名 + 排名 应与库一致且顺序正确
      const r2 = await admin.get('/manage/export/rank');
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.load(Buffer.from(await r2.arrayBuffer()));
      const ws2 = wb2.worksheets[0];
      const rows2 = [];
      ws2.eachRow((row, idx) => {
        if (idx === 1) return;
        const rank = row.getCell(1).value;
        const name = row.getCell(2).value;
        if (typeof rank === 'number' && name) rows2.push({ rank, name });
      });
      const dbRanks = all("SELECT p.name, f.final_rank FROM final_results f JOIN players p ON p.id=f.player_id ORDER BY f.final_rank, p.no");
      const rankOk = rows2.length === dbRanks.length && rows2.every((r, i) => r.name === dbRanks[i].name && r.rank === dbRanks[i].final_rank);
      check('导出"仅排名表"与库中排名顺序一致', rankOk, `${rows2.length} vs ${dbRanks.length}`);

      // 计分过程表：①票数 ③赋分 ⑧平均分 ⑪最终得分 应与库一致
      const wsProc = wb.getWorksheet('小组赛-计分过程');
      const procG = new Map(all("SELECT r.*, p.name FROM results r JOIN players p ON p.id=r.player_id WHERE r.competition='group'").map((r) => [r.name, r]));
      let procBad = 0;
      wsProc.eachRow((row, idx) => {
        if (idx === 1) return;
        const name = row.getCell(2).value;
        if (!name || !procG.has(name)) return;
        const d = procG.get(name);
        if (Number(row.getCell(3).value) !== d.public_votes) procBad++;
        else if (Math.abs(Number(row.getCell(6).value) - d.public_points) > 1e-9) procBad++;
        else if (Math.abs(Number(row.getCell(14).value) - d.pro_avg) > 1e-9) procBad++;
        else if (Math.abs(Number(row.getCell(17).value) - d.final_score) > 1e-9) procBad++;
      });
      check('导出"计分过程"逐步数值与库一致', procBad === 0, `${procBad} 处不一致`);
    }

    // 6.5 公示榜页面数值与库一致
    {
      run("UPDATE settings SET value='1' WHERE key='board_public'");
      const html = await (await admin.get('/manage/board?c=final')).text();
      const top = all('SELECT p.name, f.total_score FROM final_results f JOIN players p ON p.id=f.player_id ORDER BY f.final_rank, p.no LIMIT 3');
      const okAll = top.every((t) => html.includes(t.name) && html.includes(String(t.total_score)));
      check('公示榜显示的名次与分数与库一致', okAll, `前 3 名：${top.map((t) => t.name + '=' + t.total_score).join(', ')}`);
      run("UPDATE settings SET value='0' WHERE key='board_public'");
    }
  }

  // 6.6 会话过期后必须失效
  {
    const c = addCode('public', '审计-过期');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const sid = [...cl.cookies.entries()].find(([k]) => k === 'hv_sid')?.[1];
    run('UPDATE sessions SET expires_at=? WHERE sid=?', new Date(Date.now() - 1000).toISOString(), sid);
    const page = await cl.get('/vote/group');
    const html = await page.text();
    check('会话过期后访问投票页回到登录页', /请输入您的密码条/.test(html), '');
    const r = await cl.post('/vote/submit', { competition: 'group', player: pick });
    const wrote = q('SELECT COUNT(*) c FROM votes WHERE code_id=? AND invalid=0', c.id).c;
    check('会话过期后不能提交投票', wrote === 0 && (r.status === 302 || r.status === 401), `status=${r.status} 写入 ${wrote}`);
  }

  // 6.7 登录限流生效且可配置
  {
    const orig = q("SELECT value FROM settings WHERE key='login_rate_max'").value;
    run("UPDATE settings SET value='5' WHERE key='login_rate_max'");
    run("UPDATE settings SET value='5' WHERE key='login_rate_window_minutes'");
    let blocked = false;
    for (let i = 0; i < 12; i++) {
      const cl = newClient();
      const r = await cl.post('/vote/login', { code: 'NOSUCHCODE' + i, competition: 'group' });
      const t = await r.text();
      if (/过于频繁/.test(t)) { blocked = true; break; }
    }
    check('同一 IP 登录次数超限后被限流', blocked, '12 次尝试均未被限流');
    run("UPDATE settings SET value=? WHERE key='login_rate_max'", orig);
  }


  /* =================================================== 七、赛程时区与边界 ==== */
  console.log('\n【七】赛程时间（时区与边界）');

  // 7.1 后台以"北京时间"录入，入库必须换算为正确的 UTC
  {
    await admin.post('/manage/schedule/save', {
      group_enabled: 'on', group_start_at: '2026-10-12T09:30', group_end_at: '2026-10-12T11:00',
      individual_enabled: 'on', individual_start_at: '', individual_end_at: '',
    });
    const st = q("SELECT value FROM settings WHERE key='group_start_at'").value;
    const en = q("SELECT value FROM settings WHERE key='group_end_at'").value;
    // 北京时间 09:30 → UTC 01:30
    check('北京时间 09:30 正确换算为 UTC 01:30', st === '2026-10-12T01:30:00.000Z', `实际 ${st}`);
    check('北京时间 11:00 正确换算为 UTC 03:00', en === '2026-10-12T03:00:00.000Z', `实际 ${en}`);

    // 反向：后台页面回显仍是北京时间
    const html = await (await admin.get('/manage/schedule')).text();
    check('后台表单回显为北京时间 09:30（未串时区）', html.includes('value="2026-10-12T09:30"'), '回显值不正确');

    // 该时刻之前应为「未开始」
    const status = await (await fetch(BASE + '/healthz')).json();
    check('未来时间的赛事状态为 pending', status.group === 'pending', `实际 ${status.group}`);

    // 选手在未开始时不能投票
    const c = addCode('public', '审计-时区');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const r = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('未开始的赛事无法投票', r.status === 400, `status=${r.status}`);
  }

  // 7.2 边界：开始时刻到达即可投；截止时刻之后不可投
  {
    const now = Date.now();
    const fmt = (ms) => {
      const d = new Date(ms + 8 * 3600e3);
      const p2 = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    };
    // 开始时间 = 1 分钟前（北京时间格式）
    await admin.post('/manage/schedule/save', {
      group_enabled: 'on', group_start_at: fmt(now - 60e3), group_end_at: '',
      individual_enabled: 'on', individual_start_at: '', individual_end_at: '',
    });
    let status = await (await fetch(BASE + '/healthz')).json();
    check('开始时间已过 → 状态 open', status.group === 'open', `实际 ${status.group}`);

    // 截止时间 = 1 分钟后 → 可投
    await admin.post('/manage/schedule/save', {
      group_enabled: 'on', group_start_at: '', group_end_at: fmt(now + 60e3),
      individual_enabled: 'on', individual_start_at: '', individual_end_at: '',
    });
    status = await (await fetch(BASE + '/healthz')).json();
    check('截止时间未到 → 状态 open', status.group === 'open', `实际 ${status.group}`);

    // 截止时间 = 1 分钟前 → 关闭
    await admin.post('/manage/schedule/save', {
      group_enabled: 'on', group_start_at: '', group_end_at: fmt(now - 60e3),
      individual_enabled: 'on', individual_start_at: '', individual_end_at: '',
    });
    status = await (await fetch(BASE + '/healthz')).json();
    check('截止时间已过 → 状态 ended', status.group === 'ended', `实际 ${status.group}`);

    // 还原为无时间限制
    await admin.post('/manage/schedule/save', {
      group_enabled: 'on', group_start_at: '', group_end_at: '',
      individual_enabled: 'on', individual_start_at: '', individual_end_at: '',
    });
    status = await (await fetch(BASE + '/healthz')).json();
    check('清空起止时间后状态恢复 open', status.group === 'open', `实际 ${status.group}`);
  }

  /* ============================================ 八、需求核心：一码两投 ==== */
  console.log('\n【八】同一密码条在小组赛与个人赛各投一次');

  {
    const c = addCode('public', '审计-一码两投');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    const r1 = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('小组赛投票成功', r1.status === 302, `status=${r1.status}`);
    // 同一会话直接去个人赛
    const r2 = await cl.post('/vote/submit', { competition: 'individual', player: pick });
    check('同一密码条可在个人赛再投一次', r2.status === 302, `status=${r2.status}`);
    const gCount = q("SELECT COUNT(*) c FROM votes WHERE code_id=? AND competition='group' AND invalid=0", c.id).c;
    const iCount = q("SELECT COUNT(*) c FROM votes WHERE code_id=? AND competition='individual' AND invalid=0", c.id).c;
    check('两个赛事各留下 1 条记录（互不干扰）', gCount === 1 && iCount === 1, `group=${gCount} individual=${iCount}`);
    // 第三投（同一赛事）必须被拒
    const r3 = await cl.post('/vote/submit', { competition: 'group', player: pick });
    check('同一赛事重复投第三票被拒绝', r3.status === 400, `status=${r3.status}`);
  }

  // 8.2 修改某条投票所投选手后，票数应正确增减
  {
    const P = playersAll;
    const c = addCode('public', '审计-改票');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    await cl.post('/vote/submit', { competition: 'group', player: [P[0].id, P[1].id] });
    const v = q('SELECT id FROM votes WHERE code_id=? AND invalid=0', c.id);
    const before0 = q("SELECT public_votes FROM results WHERE competition='group' AND player_id=?", P[0].id).public_votes;
    const before4 = q("SELECT public_votes FROM results WHERE competition='group' AND player_id=?", P[4].id).public_votes;
    await admin.post('/manage/votes/update', { voteId: v.id, competition: 'group', player: [P[4].id, P[5].id] });
    const after0 = q("SELECT public_votes FROM results WHERE competition='group' AND player_id=?", P[0].id).public_votes;
    const after4 = q("SELECT public_votes FROM results WHERE competition='group' AND player_id=?", P[4].id).public_votes;
    check('改票后原选手票数 -1', after0 === before0 - 1, `${before0} → ${after0}`);
    check('改票后新选手票数 +1', after4 === before4 + 1, `${before4} → ${after4}`);
    const items = q('SELECT COUNT(*) c FROM vote_items WHERE vote_id=?', v.id).c;
    check('改票后该条记录仍是 2 个选项（无残留）', items === 2, `实际 ${items}`);
  }

  // 8.3 作废唯一一票后，选手赋分归零
  {
    const P = playersAll;
    const c = addCode('public', '审计-归零');
    const cl = newClient();
    await cl.post('/vote/login', { code: c.code, competition: 'group' });
    await cl.post('/vote/submit', { competition: 'group', player: [P[7].id] });
    const v = q('SELECT id FROM votes WHERE code_id=? AND invalid=0', c.id);
    const withVote = q("SELECT public_points FROM results WHERE competition='group' AND player_id=?", P[7].id).public_points;
    await admin.post('/manage/votes/invalidate', { voteId: v.id, competition: 'group', invalid: '1' });
    const withoutVote = q("SELECT public_votes, public_points FROM results WHERE competition='group' AND player_id=?", P[7].id);
    check('作废唯一一票后赋分归零', withoutVote.public_points === 0 && withoutVote.public_votes === 0,
      `作废前赋分=${withVote}，作废后票=${withoutVote.public_votes} 赋分=${withoutVote.public_points}`);
  }


  /* ======================================================= 九、备份可用性 ==== */
  console.log('\n【九】备份可用性（灾难恢复路径）');
  {
    const os = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const crypto = await import('node:crypto');
    const bakDir = path.join(os.tmpdir(), 'hv-audit-bak-' + Date.now());
    fs.mkdirSync(bakDir, { recursive: true });
    let out = '';
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'backup.mjs')], {
        env: { ...process.env, HV_DATA_DIR: path.dirname(DB_FILE), HV_BACKUP_DIR: bakDir },
        encoding: 'utf8',
      });
    } catch (e) {
      out = 'ERR:' + (e.stdout || e.message);
    }
    const bakFiles = fs.existsSync(bakDir) ? fs.readdirSync(bakDir).filter((f) => f.endsWith('.db')) : [];
    check('备份脚本能生成快照文件', bakFiles.length === 1, `${bakFiles.length} 个文件；输出：${out.slice(0, 120)}`);

    if (bakFiles.length === 1) {
      const bdb = new DatabaseSync(path.join(bakDir, bakFiles[0]), { readOnly: true });
      const integ = bdb.prepare('PRAGMA integrity_check').get();
      check('备份文件完整可打开（integrity_check = ok）', String(Object.values(integ)[0]).toLowerCase() === 'ok', JSON.stringify(integ));

      const hashOf = (db2, sql) =>
        crypto.createHash('sha1').update(JSON.stringify(db2.prepare(sql).all())).digest('hex').slice(0, 12);
      const tables = [
        ['players', 'SELECT id,no,name,active FROM players ORDER BY id'],
        ['voting_codes', 'SELECT id,code,role,judge_slot,enabled FROM voting_codes ORDER BY id'],
        ['votes', 'SELECT id,competition,code_id,invalid FROM votes ORDER BY id'],
        ['vote_items', 'SELECT id,vote_id,player_id FROM vote_items ORDER BY id'],
        ['scores', 'SELECT competition,judge_slot,player_id,score FROM scores ORDER BY competition,judge_slot,player_id'],
        ['settings', 'SELECT key,value FROM settings ORDER BY key'],
      ];
      let diff = 0;
      for (const [name, sql] of tables) {
        const a = hashOf(db, sql);
        const b = hashOf(bdb, sql);
        if (a !== b) { diff++; note(`备份与线上不一致的表：${name}`); }
      }
      check('备份内容与线上数据库逐表一致（选手/密码条/投票/选项/打分/设置）', diff === 0, `${diff} 张表不一致`);
      bdb.close();
    }
    fs.rmSync(bakDir, { recursive: true, force: true });
  }

  /* ===================================================== 十、极端配置与空数据 ==== */
  console.log('\n【十】极端配置与空数据');

  // 10.1 全部选手停用（0 位参赛者）时系统不应崩溃
  {
    run('UPDATE players SET active=0');
    await admin.post('/manage/recalc', { back: '/manage' });
    const pages = ['/manage', '/manage/results', '/manage/votes?c=group', '/manage/scores?c=group', '/manage/manual?c=group', '/manage/board'];
    let bad = [];
    for (const pg of pages) {
      const r = await admin.get(pg);
      if (r.status !== 200) bad.push(`${pg}=${r.status}`);
    }
    check('没有任何参赛选手时后台页面不报错', bad.length === 0, bad.join(', '));
    const votePage = await (await fetch(BASE + '/vote/group')).text();
    check('没有任何选手时投票页仍可打开（不 500）', votePage.length > 100, '');
    const st = await (await fetch(BASE + '/healthz')).json();
    check('空数据时健康检查正常', st.ok === true, JSON.stringify(st));
    run('UPDATE players SET active=1');
    await admin.post('/manage/recalc', { back: '/manage' });
  }

  // 10.2 极端设置组合
  {
    const combos = [
      { name: '只允许选 1 人', cfg: { public_pick_count: '1' } },
      { name: '第 1 名赋 0 分', cfg: { top_points: '0' } },
      { name: '零票也赋 5 分', cfg: { zero_vote_points: '5' } },
      { name: '只有 1 位评审', cfg: { judge_count: '1' } },
      { name: '小数位 0', cfg: { score_decimals: '0' } },
      { name: '权重 0 / 1', cfg: { weight_group: '0', weight_individual: '1' } },
      { name: '并列取平均名次', cfg: { tie_rank_rule: 'average' } },
      { name: '总成绩并列按小组赛优先', cfg: { final_tie_break: 'group' } },
    ];
    for (const combo of combos) {
      try {
        for (const [k, v] of Object.entries(combo.cfg)) run('UPDATE settings SET value=? WHERE key=?', v, k);
        const r = await admin.post('/manage/recalc', { back: '/manage' });
        const ok = r.status === 302;
        const resultsPage = await admin.get('/manage/results');
        const exportRes = await admin.get('/manage/export/full');
        check(`极端配置可用：${combo.name}`, ok && resultsPage.status === 200 && exportRes.status === 200,
          `recalc=${r.status} results=${resultsPage.status} export=${exportRes.status}`);
        for (const [k, v] of Object.entries(combo.cfg)) run('UPDATE settings SET value=? WHERE key=?', ORIG_CFG[k] ?? '', k);
      } catch (e) {
        check(`极端配置可用：${combo.name}`, false, e.message);
        for (const k of Object.keys(combo.cfg)) run('UPDATE settings SET value=? WHERE key=?', ORIG_CFG[k] ?? '', k);
      }
    }
    // 校验：第 1 名赋 0 分时，最高票选手赋分为 0
    run("UPDATE settings SET value='0' WHERE key='top_points'");
    await admin.post('/manage/recalc', { back: '/manage' });
    const top = q("SELECT public_points FROM results WHERE competition='group' ORDER BY public_votes DESC LIMIT 1");
    check('第 1 名赋分设为 0 时确实为 0', top.public_points === 0, `实际 ${top.public_points}`);
    run("UPDATE settings SET value='10' WHERE key='top_points'");
    await admin.post('/manage/recalc', { back: '/manage' });
  }

  await admin.post('/manage/recalc', { back: '/manage' });
} catch (err) {
  console.error('\n审计脚本异常：', err.stack || err.message);
  bugs.push({ name: '审计脚本异常', detail: err.message });
} finally {
  cleanup();
  await admin.post('/manage/recalc', { back: '/manage' }).catch(() => {});
}

console.log(`\n=== 审计结果：通过 ${pass} 项，发现 ${bugs.length} 个问题 ===`);
if (bugs.length) {
  console.log('\n问题清单：');
  bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b.name}${b.detail ? '  → ' + b.detail : ''}`));
}
if (notes.length) {
  console.log('\n观察记录：');
  notes.forEach((n) => console.log('  · ' + n));
}
db.close();
process.exit(bugs.length ? 1 : 0);
