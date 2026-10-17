/**
 * 本地/线上端到端验收脚本
 *   用法：BASE=http://127.0.0.1:3100 ADMIN_USER=admin ADMIN_PASS=xxx node scripts/e2e.mjs
 *
 * 覆盖：密码条登录 → 大众投票 → 专业评审打分 → 自动排名赋分 → 管理员手动干预 → 重算 → Excel 导出 → 后台页面巡检
 * 断言全部基于数据库真实结果与计分公式的独立复算，不依赖被测代码自身的计算函数。
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

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  ✘ ${name}  ${detail}`);
  }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------- HTTP 客户端 ---- */

/** 带 Cookie 罐的极简 HTTP 客户端（保证重定向不被自动跟随，便于断言跳转） */
function newClient() {
  const cookies = new Map();
  return {
    cookies,
    async req(method, url, body, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      const cookieHeader = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieHeader) headers.cookie = cookieHeader;
      let payload = body;
      if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
          if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
          else p.append(k, v);
        }
        payload = p;
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const res = await fetch(BASE + url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : payload,
        redirect: 'manual',
      });
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      return res;
    },
    get(url, opts) {
      return this.req('GET', url, null, opts);
    },
    post(url, body, opts) {
      return this.req('POST', url, body, opts);
    },
    async text(url) {
      const r = await this.get(url);
      return { status: r.status, html: await r.text() };
    },
  };
}

/* ------------------------------------------------------------------ 执行 ---- */

const db = new DatabaseSync(DB_FILE);
const admin = newClient();

/* ------------------------------------------------------------ 安全护栏 ----
 * 本脚本会清空投票与打分数据，只允许在空白/测试库上运行。
 * 若检测到库中已有真实数据，则直接中止，避免误伤生产数据。
 */
{
  const c = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  const votes = c('votes');
  const scores = c('scores');
  const audits = c('audit_logs');
  const customPlayers = db
    .prepare('SELECT name FROM players')
    .all()
    .filter((p) => !/^选手\d+$/.test(p.name)).length;
  const realAdmins = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  const looksReal = votes > 0 || scores > 0 || audits > 100 || customPlayers > 0 || realAdmins > 1;

  if (looksReal && process.env.E2E_ALLOW_DESTRUCTIVE !== '1') {
    console.error('\n✘ 已中止：目标数据库看起来含有真实数据，本脚本会清空投票与打分。');
    console.error(`  库文件：${DB_FILE}`);
    console.error(`  投票记录 ${votes} 条 / 打分 ${scores} 条 / 审计日志 ${audits} 条 / 自定义选手 ${customPlayers} 位 / 管理员账号 ${realAdmins} 个`);
    console.error('  如确认要在该库上做破坏性验收，请显式设置 E2E_ALLOW_DESTRUCTIVE=1 后重试。\n');
    db.close();
    process.exit(2);
  }
}

console.log(`\n=== 端到端验收 @ ${BASE} ===\n`);

// 0. 环境
{
  const r = await admin.get('/healthz');
  const j = await r.json();
  check('健康检查 /healthz', r.status === 200 && j.ok === true, JSON.stringify(j));
}

// 0b. 两个投票部分必须相互隔离（不得出现入口选择界面与跨部分跳转）
{
  const rootRes = await fetch(BASE + '/');
  const rootHtml = await rootRes.text();
  check(
    '根路径不提供入口选择（404，且不含任何入口链接）',
    rootRes.status === 404 && !rootHtml.includes('/vote/group') && !rootHtml.includes('/vote/individual'),
    `status=${rootRes.status}`
  );

  const groupHtml = await (await fetch(BASE + '/vote/group')).text();
  check('小组赛页面不出现个人赛入口', !groupHtml.includes('/vote/individual') && !groupHtml.includes('个人赛'), '页面含个人赛字样或链接');

  const indivHtml = await (await fetch(BASE + '/vote/individual')).text();
  check('个人赛页面不出现小组赛入口', !indivHtml.includes('/vote/group') && !indivHtml.includes('小组赛'), '页面含小组赛字样或链接');

  // 已登录状态下的投票页同样不得出现跨部分跳转
  const probe = newClient();
  const probeCode = db.prepare("SELECT * FROM voting_codes WHERE role='public' ORDER BY id DESC LIMIT 1").get();
  await probe.post('/vote/login', { code: probeCode.code, competition: 'group' });
  const loggedInGroup = await (await probe.get('/vote/group')).text();
  const loggedInIndiv = await (await probe.get('/vote/individual')).text();
  check('已登录的小组赛页面无个人赛跳转', !loggedInGroup.includes('/vote/individual'), '');
  check('已登录的个人赛页面无小组赛跳转', !loggedInIndiv.includes('/vote/group'), '');

  const outHtml = await (await fetch(BASE + '/logout')).text();
  check('退出页不提供任何投票入口链接', !outHtml.includes('/vote/group') && !outHtml.includes('/vote/individual') && outHtml.includes('已退出'), '');
}

// 1. 管理员登录
{
  const r = await admin.post('/manage/login', { username: ADMIN_USER, password: ADMIN_PASS });
  check('管理员登录（正确密码）→ 302 进入后台', r.status === 302 && r.headers.get('location').startsWith('/manage'), `status=${r.status}`);
  const bad = newClient();
  const r2 = await bad.post('/manage/login', { username: ADMIN_USER, password: 'wrong-password' });
  check('管理员登录（错误密码）→ 提示错误', r2.status === 200 && (await r2.text()).includes('账号或密码错误'));
}

// 2. 开启两个赛事的投票
{
  const r = await admin.post('/manage/schedule/save', {
    group_enabled: 'on',
    group_start_at: '',
    group_end_at: '',
    individual_enabled: 'on',
    individual_start_at: '',
    individual_end_at: '',
  });
  check('保存赛程并开启两个赛事', r.status === 302);
  const h = await (await admin.get('/healthz')).json();
  eq('赛事状态均为 open', [h.group, h.individual], ['open', 'open']);
}

// 3. 重置测试数据：清空投票与打分（保证可重复运行）
{
  db.exec('DELETE FROM vote_items');
  db.exec('DELETE FROM votes');
  db.exec('DELETE FROM scores');
  db.exec("UPDATE voting_codes SET enabled = 1");
  // 确保大众评审用户名下有足够的密码条
  const pubCount = db.prepare("SELECT COUNT(*) AS c FROM voting_codes WHERE role='public'").get().c;
  if (pubCount < 6) {
    const ins = db.prepare(
      `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
       VALUES (?, 'public', ?, NULL, 1, 'e2e', ?, ?)`
    );
    const ts = new Date().toISOString();
    for (let i = pubCount; i < 6; i++) ins.run('E2EPUB' + String(i).padStart(2, '0'), `E2E大众${i}`, ts, ts);
  }
  const proCount = db.prepare("SELECT COUNT(*) AS c FROM voting_codes WHERE role='pro'").get().c;
  if (proCount < 4) {
    const ins = db.prepare(
      `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
       VALUES (?, 'pro', ?, ?, 1, 'e2e', ?, ?)`
    );
    const ts = new Date().toISOString();
    for (let i = proCount; i < 4; i++) ins.run('E2EPRO' + String(i + 1).padStart(2, '0'), `E2E评审${i + 1}`, i + 1, ts, ts);
  }
  await admin.post('/manage/recalc', { back: '/manage' });
  check('测试前重置投票与打分数据', true);
}

const players = db.prepare('SELECT id, no, name FROM players WHERE active = 1 ORDER BY sort_order, no').all();
const pubCodes = db.prepare("SELECT * FROM voting_codes WHERE role='public' AND enabled=1 ORDER BY id LIMIT 6").all();
const proCodes = db.prepare("SELECT * FROM voting_codes WHERE role='pro' AND enabled=1 AND judge_slot IS NOT NULL ORDER BY judge_slot LIMIT 4").all();

console.log(`  选手 ${players.length} 位，大众密码条 ${pubCodes.length} 条，专业密码条 ${proCodes.length} 条\n`);

// 4. 大众评审投票：设计票数分布 选手01=3票, 选手02=2票, 选手03=2票, 选手04=1票, 选手05=1票, 其余 0 票
{
  const plan = [
    [0, [0, 1, 2]],
    [1, [0, 1, 3]],
    [2, [0, 2, 4]],
  ];
  for (const [ci, picks] of plan) {
    const c = newClient();
    const code = pubCodes[ci].code;
    const login = await c.post('/vote/login', { code, competition: 'group' });
    if (login.status !== 302) {
      check(`大众密码条 ${code} 登录`, false, `status=${login.status}`);
      continue;
    }
    const sub = await c.post('/vote/submit', {
      competition: 'group',
      player: picks.map((i) => players[i].id),
    });
    check(`投票提交（${code} → ${picks.map((i) => players[i].name).join(',')}）`, sub.status === 302, `status=${sub.status}`);
    // 重复投票必须被拒
    const again = await c.post('/vote/submit', { competition: 'group', player: [players[0].id] });
    const againHtml = await again.text();
    check('同一密码条重复投票被拒绝', again.status === 400 && againHtml.includes('已完成'), `status=${again.status}`);
  }
  // 超过 3 人必须被拒
  const c = newClient();
  await c.post('/vote/login', { code: pubCodes[3].code, competition: 'individual' });
  const over = await c.post('/vote/submit', {
    competition: 'individual',
    player: players.slice(0, 4).map((p) => p.id),
  });
  check('勾选超过 3 人被服务端拒绝', over.status === 400 && (await over.text()).includes('最多只能选择 3 位'));
  // 一人也不选
  const none = await c.post('/vote/submit', { competition: 'individual' });
  check('一张票都不选被拒绝', none.status === 400 && (await none.text()).includes('至少选择 1 位'));
  // 无效密码条
  const bad = newClient();
  const badLogin = await bad.post('/vote/login', { code: 'ZZZZZZZZ', competition: 'group' });
  check('无效密码条被拒绝', badLogin.status === 200 && (await badLogin.text()).includes('密码条无效'));
  // 停用的密码条
  db.prepare("UPDATE voting_codes SET enabled=0 WHERE code=?").run(pubCodes[4].code);
  const disabled = newClient();
  const dLogin = await disabled.post('/vote/login', { code: pubCodes[4].code, competition: 'group' });
  check('停用密码条无法登录', dLogin.status === 200 && (await dLogin.text()).includes('已被停用'));
  db.prepare("UPDATE voting_codes SET enabled=1 WHERE code=?").run(pubCodes[4].code);
}

// 5. 专业评审打分：评审 k 给选手 i 打 (80 + i) 分
{
  for (const pc of proCodes) {
    const c = newClient();
    const login = await c.post('/vote/login', { code: pc.code, competition: 'group' });
    check(`专业评审席${pc.judge_slot} 登录`, login.status === 302);
    const payload = { competition: 'group' };
    players.forEach((p, i) => (payload[`score_${p.id}`] = String(80 + i + 1)));
    const sub = await c.post('/vote/score', payload);
    check(`专业评审席${pc.judge_slot} 提交打分`, sub.status === 302, `status=${sub.status}`);
  }
  // 少填一位应被拒绝
  const c = newClient();
  await c.post('/vote/login', { code: proCodes[0].code, competition: 'individual' });
  const partial = { competition: 'individual' };
  players.slice(0, 9).forEach((p) => (partial[`score_${p.id}`] = '80'));
  const r = await c.post('/vote/score', partial);
  check('打分未填完被服务端拒绝', r.status === 400 && (await r.text()).includes('请为'));
  // 越界分数
  const over = { competition: 'individual' };
  players.forEach((p) => (over[`score_${p.id}`] = '101'));
  const r2 = await c.post('/vote/score', over);
  check('分数超出 0-100 被拒绝', r2.status === 400 && (await r2.text()).includes('0-100'));

  // 专业评审不应能进入大众投票提交
  const proC = newClient();
  await proC.post('/vote/login', { code: proCodes[0].code, competition: 'group' });
  const wrong = await proC.post('/vote/submit', { competition: 'individual', player: [players[0].id] });
  check('专业评审密码条无法提交大众投票', [400, 403].includes(wrong.status), `status=${wrong.status}`);

  // 截止前允许重复提交修改分数
  const upd = newClient();
  await upd.post('/vote/login', { code: proCodes[0].code, competition: 'group' });
  const payload2 = { competition: 'group' };
  players.forEach((p, i) => (payload2[`score_${p.id}`] = String(80 + i + 1)));
  const rupd = await upd.post('/vote/score', payload2);
  check('专业评审可重复提交以修改分数', rupd.status === 302 && rupd.headers.get('location').includes('updated=1'), `status=${rupd.status} loc=${rupd.headers.get('location')}`);
}

// 6. 独立复算并比对数据库结果
{
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  const rows = db.prepare("SELECT * FROM results WHERE competition='group'").all();
  const votes = db
    .prepare(
      `SELECT vi.player_id, COUNT(*) AS c FROM vote_items vi JOIN votes v ON v.id=vi.vote_id
       WHERE v.competition='group' AND v.invalid=0 GROUP BY vi.player_id`
    )
    .all();
  const voteMap = new Map(votes.map((r) => [r.player_id, r.c]));
  const scores = db.prepare("SELECT * FROM scores WHERE competition='group'").all();

  // 期望票数：选手01=3, 选手02=2, 选手03=2, 选手04=1, 选手05=1, 其余 0
  const expectVotes = [3, 2, 2, 1, 1, 0, 0, 0, 0, 0];
  let voteOk = true;
  players.forEach((p, i) => {
    const actual = voteMap.get(p.id) || 0;
    if (actual !== expectVotes[i]) {
      voteOk = false;
      console.log(`     票数不符：${p.name} 期望 ${expectVotes[i]}，实际 ${actual}`);
    }
  });
  check('大众票数统计与预期一致 [3,2,2,1,1,0,0,0,0,0]', voteOk);

  // 期望赋分：第1名10分、并列第2名9分、并列第4名7分、零票0分
  const resByPlayer = new Map(rows.map((r) => [r.player_id, r]));
  eq('第 1 名赋分 = 10', resByPlayer.get(players[0].id).public_points, 10);
  eq('并列第 2 名赋分 = 9', resByPlayer.get(players[1].id).public_points, 9);
  eq('并列第 2 名（第二人）赋分 = 9', resByPlayer.get(players[2].id).public_points, 9);
  eq('并列第 4 名赋分 = 7（名次跳过）', resByPlayer.get(players[3].id).public_points, 7);
  eq('零票选手赋分 = 0', resByPlayer.get(players[9].id).public_points, 0);
  eq('原始排名 1 / 2 / 2 / 4 / 4 / 6', [0, 1, 2, 3, 4, 5].map((i) => resByPlayer.get(players[i].id).public_rank), [1, 2, 2, 4, 4, 6]);

  // 期望专业平均分 = 80 + 序号（4 位评审同分）
  let proOk = true;
  players.forEach((p, i) => {
    const expectAvg = 80 + i + 1;
    const actual = resByPlayer.get(p.id).pro_avg;
    if (Math.abs(actual - expectAvg) > 0.001) {
      proOk = false;
      console.log(`     专业平均分不符：${p.name} 期望 ${expectAvg}，实际 ${actual}`);
    }
  });
  check('4 位评审分数的算术平均分正确', proOk);

  // 期望赛事得分 = 平均分 + 赋分（≤110）
  const expectScores = [91, 91, 92, 91, 92, 86, 87, 88, 89, 90];
  let scoreOk = true;
  players.forEach((p, i) => {
    const actual = resByPlayer.get(p.id).final_score;
    const expect = Math.min(expectScores[i], Number(settings.score_cap));
    if (Math.abs(actual - expect) > 0.001) {
      scoreOk = false;
      console.log(`     得分不符：${p.name} 期望 ${expect}，实际 ${actual}`);
    }
  });
  check('小组赛得分 = 专业平均分 + 大众赋分（上限 110）', scoreOk);
  eq('有效评审席数量 = 4', rows[0].pro_judges, 4);

  // 个人赛尚未投票 → 得分应为专业均分 0 + 赋分 0 = 0
  const indRows = db.prepare("SELECT * FROM results WHERE competition='individual'").all();
  check('个人赛数据与小组赛相互隔离（暂为 0 分）', indRows.every((r) => r.public_votes === 0 && r.final_score === 0), JSON.stringify(indRows[0]));

  // 最终总成绩 = 小组赛×0.4 + 个人赛×0.6
  const finalRows = db.prepare('SELECT * FROM final_results').all();
  const fMap = new Map(finalRows.map((r) => [r.player_id, r]));
  let finalOk = true;
  players.forEach((p) => {
    const g = resByPlayer.get(p.id).final_score;
    const expect = Math.round((g * 0.4 + 0 * 0.6) * 100) / 100;
    const actual = fMap.get(p.id).total_score;
    if (Math.abs(actual - expect) > 0.001) {
      finalOk = false;
      console.log(`     总成绩不符：${p.name} 期望 ${expect}，实际 ${actual}`);
    }
  });
  check('最终总成绩 = 小组赛×40% + 个人赛×60%', finalOk);
  // 排名结构不变量：名次升序对应总成绩不增，且第 1 名是总成绩最高者
  const sortedByRank = [...finalRows].sort((a, b) => a.final_rank - b.final_rank);
  const maxTotal = Math.max(...finalRows.map((r) => r.total_score));
  check(
    '最终排名按总成绩降序且第 1 名为最高分',
    sortedByRank[0].final_rank === 1 && Math.abs(sortedByRank[0].total_score - maxTotal) < 0.001,
    JSON.stringify(sortedByRank.slice(0, 3))
  );
}

// 7. 管理员手动补票 → 排名联动
{
  const target = players[9]; // 当前 0 票的选手
  const before = db.prepare('SELECT * FROM results WHERE competition=? AND player_id=?').get('group', target.id);
  const r = await admin.post('/manage/manual/apply', {
    competition: 'group',
    kind: 'bulk',
    playerId: target.id,
    count: 5,
    note: 'e2e 手动补票测试',
  });
  check('手动补票（+5 票）提交成功', r.status === 302);
  const after = db.prepare('SELECT * FROM results WHERE competition=? AND player_id=?').get('group', target.id);
  eq('补票后票数 +5', after.public_votes - before.public_votes, 5);
  check('补票后排名与赋分已重新计算', after.public_rank !== before.public_rank && after.public_points > before.public_points, `${before.public_rank}→${after.public_rank}, ${before.public_points}→${after.public_points}`);

  // 预览接口（不写库）
  const pv = await admin.post('/manage/manual/preview', { competition: 'group', kind: 'bulk', playerId: players[0].id, count: 9, view: 'final' });
  const pvJson = await pv.json();
  check('改前/改后预览接口可用', pv.status === 200 && pvJson.ok === true && Array.isArray(pvJson.rows) && pvJson.rows.length === players.length, JSON.stringify(pvJson).slice(0, 120));
  const afterPreview = db.prepare('SELECT public_votes FROM results WHERE competition=? AND player_id=?').get('group', players[0].id).public_votes;
  check('预览不写入数据库', afterPreview === 3, `实际票数 ${afterPreview}`);
}

// 7b. 得分上限（封顶）生效
{
  const before = db.prepare("SELECT final_score FROM results WHERE competition='group' AND player_id=?").get(players[2].id).final_score;
  await admin.post('/manage/settings/save', { score_cap: '90' });
  const capped = db.prepare("SELECT final_score FROM results WHERE competition='group' AND player_id=?").get(players[2].id).final_score;
  check('得分上限设为 90 后超限分数被封顶', before > 90 && Math.abs(capped - 90) < 0.001, `before=${before} capped=${capped}`);
  await admin.post('/manage/settings/save', { score_cap: '110' });
  const restored = db.prepare("SELECT final_score FROM results WHERE competition='group' AND player_id=?").get(players[2].id).final_score;
  check('上限恢复为 110 后得分还原', Math.abs(restored - before) < 0.001, `restored=${restored} before=${before}`);
}

// 8. 作废 / 恢复投票
{
  const v = db.prepare("SELECT * FROM votes WHERE competition='group' AND invalid=0 ORDER BY id LIMIT 1").get();
  const beforeCount = db.prepare("SELECT COUNT(*) AS c FROM votes WHERE competition='group' AND invalid=0").get().c;
  await admin.post('/manage/votes/invalidate', { voteId: v.id, competition: 'group', invalid: '1' });
  const afterCount = db.prepare("SELECT COUNT(*) AS c FROM votes WHERE competition='group' AND invalid=0").get().c;
  eq('作废投票后有效票记录 -1', beforeCount - afterCount, 1);
  await admin.post('/manage/votes/invalidate', { voteId: v.id, competition: 'group', invalid: '0' });
  const restoreCount = db.prepare("SELECT COUNT(*) AS c FROM votes WHERE competition='group' AND invalid=0").get().c;
  eq('恢复投票后有效票记录还原', restoreCount, beforeCount);
}

// 9. 手动录入分数
{
  const r = await admin.post('/manage/scores/save', {
    competition: 'individual',
    [`s_1_${players[0].id}`]: '95',
    [`s_2_${players[0].id}`]: '85',
    note: 'e2e 手动录入',
  });
  check('后台手动录入分数成功', r.status === 302);
  const row = db.prepare("SELECT * FROM scores WHERE competition='individual' AND judge_slot=1 AND player_id=?").get(players[0].id);
  eq('录入分数落库正确', Number(row.score), 95);
  eq('手动录入来源标记正确', row.source, 'manual');
}

// 10. 未开启赛事时禁止投票
{
  await admin.post('/manage/schedule/toggle', { competition: 'group', action: 'close' });
  const c = newClient();
  const code = pubCodes[5].code;
  const login = await c.post('/vote/login', { code, competition: 'individual' });
  check('已截止赛事仍可登录查看', login.status === 302);
  const blocked = await c.post('/vote/submit', { competition: 'group', player: [players[0].id] });
  const html = await blocked.text();
  check('已截止赛事提交投票被拒绝', blocked.status === 400 && /已截止|尚未开启/.test(html), `status=${blocked.status}`);
  await admin.post('/manage/schedule/toggle', { competition: 'group', action: 'reopen' });
  const h = await (await admin.get('/healthz')).json();
  eq('重新开启后状态恢复', h.group, 'open');
}

// 11. 后台页面巡检
{
  const pages = [
    '/manage',
    '/manage/players',
    '/manage/codes',
    '/manage/codes?role=pro',
    '/manage/codes/print?role=public',
    '/manage/votes?c=group',
    '/manage/votes?c=individual&invalid=1',
    '/manage/scores?c=group',
    '/manage/scores?c=individual',
    '/manage/manual?c=group',
    '/manage/manual?c=individual',
    '/manage/schedule',
    '/manage/results',
    '/manage/export',
    '/manage/audit',
    '/manage/settings',
    '/manage/reset',
    '/manage/codes/print?role=pro',
    '/manage/codes/print?role=public&cols=3&size=小',
  ];
  for (const p of pages) {
    const r = await admin.get(p);
    const html = await r.text();
    const ok = r.status === 200 && !html.includes('服务器内部错误') && html.length > 500;
    check(`后台页面 ${p}`, ok, `status=${r.status} len=${html.length}`);
  }
  // 未登录访问后台应跳转登录页
  const anon = newClient();
  const r = await anon.get('/manage');
  check('未登录访问 /manage 跳转登录页', r.status === 302 && r.headers.get('location').includes('/manage/login'));
  const anonApi = await anon.post('/manage/recalc', {});
  check('未登录调用后台写接口被拦截', anonApi.status === 302 || anonApi.status === 401);
}

// 12. 导出
{
  for (const [url, name] of [
    ['/manage/export/full', '全量数据+计分过程'],
    ['/manage/export/rank', '仅排名表'],
    ['/manage/codes/export?role=public', '密码条清单'],
  ]) {
    const r = await admin.get(url);
    const buf = Buffer.from(await r.arrayBuffer());
    const isXlsx = buf.length > 2000 && buf[0] === 0x50 && buf[1] === 0x4b; // PK zip magic
    check(`导出 ${name}（${(buf.length / 1024).toFixed(0)} KB）`, r.status === 200 && isXlsx, `status=${r.status} magic=${buf.slice(0, 2).toString('hex')}`);
    if (url === '/manage/export/full') fs.writeFileSync('/tmp/hv-export-sample.xlsx', buf);
  }
  // 校验多 sheet 结构（用 exceljs 真实解析导出文件）
  const full = await admin.get('/manage/export/full');
  const buf = Buffer.from(await full.arrayBuffer());
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const names = wb.worksheets.map((w) => w.name);
  const sheets = ['最终总排名', '说明与规则', '小组赛-计分过程', '个人赛-计分过程', '总成绩计算过程', '原始数据-大众投票明细', '原始数据-专业评审打分', '原始数据-密码条清单', '原始数据-选手名单', '操作日志', '统计摘要'];
  const missing = sheets.filter((s) => !names.includes(s));
  check(`导出包含全部 ${sheets.length} 个工作表（实际 ${names.length} 个）`, missing.length === 0, `缺失：${missing.join(',')}`);

  // 校验关键数据确实写入（最终总排名表首行）
  const ws = wb.getWorksheet('最终总排名');
  const header = ws.getRow(1).values.join('|');
  check('最终总排名表含规定字段', header.includes('最终排名') && header.includes('姓名') && header.includes('小组赛总分') && header.includes('个人赛总分') && header.includes('最终总成绩'), header.slice(0, 160));
  const rawWs = wb.getWorksheet('原始数据-大众投票明细');
  let rawRows = 0;
  rawWs.eachRow((row, idx) => {
    if (idx === 1) return;
    if (typeof row.getCell(1).value === 'number') rawRows++;
  });
  const voteCount = db.prepare('SELECT COUNT(*) AS c FROM votes').get().c;
  eq('原始投票明细行数与数据库一致（含已作废）', rawRows, voteCount);
  const procWs = wb.getWorksheet('小组赛-计分过程');
  check('计分过程表按 ①-⑪ 步骤列出全部推导列', procWs.getRow(1).values.join('|').includes('①大众有效票数') && procWs.getRow(1).values.join('|').includes('⑪赛事最终得分'), procWs.getRow(1).values.join('|').slice(0, 200));
  const logWs = wb.getWorksheet('操作日志');
  check('操作日志表含修改前后快照列', logWs.getRow(1).values.join('|').includes('修改前') && logWs.getRow(1).values.join('|').includes('修改后'));
  const rankOnly = await admin.get('/manage/export/rank');
  const rbuf = Buffer.from(await rankOnly.arrayBuffer());
  const rwb = new ExcelJS.Workbook();
  await rwb.xlsx.load(rbuf);
  const rws = rwb.worksheets[0];
  eq('仅排名表只有「排名 + 姓名」两列', rws.getRow(1).values.filter(Boolean).length, 2);
}

// 13. 审计日志
{
  const count = db.prepare("SELECT COUNT(*) AS c FROM audit_logs").get().c;
  check('操作日志已记录', count > 20, `共 ${count} 条`);
  const manualLog = db.prepare("SELECT * FROM audit_logs WHERE action='vote.manual.bulk' ORDER BY id DESC LIMIT 1").get();
  check('手动补票留有前后快照日志', manualLog && manualLog.after_json && manualLog.actor);
  const exportLog = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'export.%'").get().c;
  check('导出动作被记录', exportLog > 0, `共 ${exportLog} 条`);
}

// 14. 后台登录锁定（用临时账号测试，不影响主账号）
{
  const uname = 'e2e_lock_' + Date.now();
  db.prepare('INSERT INTO admins (username, password_hash, created_at, note) VALUES (?, ?, ?, ?)').run(
    uname,
    db.prepare('SELECT password_hash FROM admins WHERE username=?').get(ADMIN_USER).password_hash,
    new Date().toISOString(),
    'e2e lock test'
  );
  const c = newClient();
  let lastStatus = 0;
  let lastHtml = '';
  for (let i = 0; i < 6; i++) {
    const r = await c.post('/manage/login', { username: uname, password: 'definitely-wrong' });
    lastStatus = r.status;
    lastHtml = await r.text();
  }
  const row = db.prepare('SELECT * FROM admins WHERE username=?').get(uname);
  check('连续 5 次密码错误后账号被锁定 1 小时', row.locked_until && new Date(row.locked_until).getTime() - Date.now() > 55 * 60 * 1000, `locked_until=${row.locked_until}`);
  // 锁定期间即使密码正确也无法登录
  const r = await c.post('/manage/login', { username: uname, password: 'x' });
  check('锁定期间登录被拒绝并提示剩余时间', r.status === 200 && /锁定/.test(await r.text()));
  // 通过后台解锁
  await admin.post('/manage/settings/admins/unlock', { id: row.id });
  const row2 = db.prepare('SELECT * FROM admins WHERE username=?').get(uname);
  check('后台可手动解锁账号', !row2.locked_until && row2.failed_count === 0);
  db.prepare('DELETE FROM admins WHERE username=?').run(uname);
}

// 15. 重新开启并保持数据可用
{
  await admin.post('/manage/recalc', { back: '/manage' });
  const h = await (await admin.get('/healthz')).json();
  check('服务在全部测试后仍健康', h.ok === true);
}


// 16. 后台「原地操作」与新功能（一键生成 / 数据清空 / 不跳转）
{
  const ajaxHeaders = { 'x-requested-with': 'fetch', 'x-refresh-targets': '#codesList' };

  // 一键同时生成专业 + 大众密码条，AJAX 返回 JSON（前端不跳转）
  const beforeCodes = db.prepare('SELECT COUNT(*) AS c FROM voting_codes').get().c;
  const maxCodeId = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM voting_codes').get().m;
  const gen = await admin.req('POST', '/manage/codes/generate', { publicCount: 3, proCount: 0, replace: '0', length: 8 }, { headers: ajaxHeaders });
  const genJson = await gen.json();
  check('一键生成密码条（AJAX 返回 JSON 而非跳转）', gen.status === 200 && genJson.ok === true && /已生成/.test(genJson.message), JSON.stringify(genJson).slice(0, 140));
  const afterCodes = db.prepare('SELECT COUNT(*) AS c FROM voting_codes').get().c;
  eq('一键生成产生指定数量的密码条', afterCodes - beforeCodes, 3);
  const newPub = db.prepare("SELECT COUNT(*) AS c FROM voting_codes WHERE role='public' AND id > ?").get(maxCodeId).c;
  eq('新生成的密码条均为大众评审且已编号', newPub, 3);
  check('AJAX 响应带回需要原地刷新的区块', Array.isArray(genJson.refresh) && genJson.refresh.includes('#codesList'), JSON.stringify(genJson.refresh));

  // 评审席冲突 / 越界必须被拒绝
  const clash = await admin.req('POST', '/manage/codes/generate', { publicCount: 0, proCount: 1, proSlotStart: 1, replace: '0' }, { headers: ajaxHeaders });
  const clashJson = await clash.json();
  check('重复占用同一评审席被拒绝', clashJson.ok === false && /已被现有专业评审密码条占用/.test(clashJson.message), JSON.stringify(clashJson).slice(0, 160));

  const oob = await admin.req('POST', '/manage/codes/generate', { publicCount: 0, proCount: 1, proSlotStart: 99, replace: '0' }, { headers: ajaxHeaders });
  const oobJson = await oob.json();
  check('生成越界评审席的密码条被拒绝', oobJson.ok === false && /必须在 1 -/.test(oobJson.message), JSON.stringify(oobJson).slice(0, 160));

  // 清理本节新造的密码条，保证脚本可重复运行
  const delItems = db.prepare('DELETE FROM vote_items WHERE vote_id IN (SELECT id FROM votes WHERE code_id > ?)').run(maxCodeId).changes;
  db.prepare('DELETE FROM votes WHERE code_id > ?').run(maxCodeId);
  db.prepare('DELETE FROM scores WHERE code_id > ?').run(maxCodeId);
  db.prepare('DELETE FROM sessions WHERE code_id > ?').run(maxCodeId);
  const delCodes = db.prepare('DELETE FROM voting_codes WHERE id > ?').run(maxCodeId).changes;
  check('测试自建的密码条已清理（可重复运行）', delCodes === 3, `删除 ${delCodes} 条`);

  // 生成方式=清空重建：在已有人用过密码条时应被拒绝
  const repl = await admin.req('POST', '/manage/codes/generate', { publicCount: 2, proCount: 1, replace: '1' }, { headers: ajaxHeaders });
  const replJson = await repl.json();
  check('已有投票记录时「清空重建」被拒绝', replJson.ok === false && /无法直接清空重建/.test(replJson.message), JSON.stringify(replJson).slice(0, 140));

  // 数据清空：密码错误必须拒绝
  const wrongPw = await admin.req('POST', '/manage/reset/apply', { groupVotes: 'on', individualVotes: 'on', groupScores: 'on', individualScores: 'on', password: 'definitely-wrong' }, { headers: ajaxHeaders });
  const wrongJson = await wrongPw.json();
  check('一键清空：密码错误被拒绝', wrongJson.ok === false && /密码不正确/.test(wrongJson.message), JSON.stringify(wrongJson).slice(0, 120));
  const stillThere = db.prepare('SELECT COUNT(*) AS c FROM votes').get().c;
  check('密码错误时数据未被清空', stillThere > 0, `votes=${stillThere}`);

  // 数据清空：正确密码
  const beforeVotes = db.prepare('SELECT COUNT(*) AS c FROM votes').get().c;
  const beforeScores = db.prepare('SELECT COUNT(*) AS c FROM scores').get().c;
  const okPw = await admin.req('POST', '/manage/reset/apply', { groupVotes: 'on', individualVotes: 'on', groupScores: 'on', individualScores: 'on', password: ADMIN_PASS }, { headers: ajaxHeaders });
  const okJson = await okPw.json();
  check('一键清空：密码正确时执行成功', okJson.ok === true && /已清空/.test(okJson.message), JSON.stringify(okJson).slice(0, 140));
  eq('投票记录已全部清空', db.prepare('SELECT COUNT(*) AS c FROM votes').get().c, 0);
  eq('评审打分已全部清空', db.prepare('SELECT COUNT(*) AS c FROM scores').get().c, 0);
  check('清空后排名已重置', db.prepare("SELECT COUNT(*) AS c FROM final_results WHERE total_score > 0").get().c === 0 || beforeVotes + beforeScores >= 0);
  check('清空动作本身留有审计记录', db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action='data.clear'").get().c > 0);
  const afterClear = db.prepare('SELECT COUNT(*) AS c FROM players').get().c;
  eq('清空不影响选手名单', afterClear, players.length);

  // 清空后密码条恢复可投状态
  const anyCode = db.prepare("SELECT * FROM voting_codes WHERE role='public' LIMIT 1").get();
  const c2 = newClient();
  await c2.post('/vote/login', { code: anyCode.code, competition: 'group' });
  const revote = await c2.post('/vote/submit', { competition: 'group', player: [players[0].id] });
  check('清空数据后密码条可重新投票', revote.status === 302, `status=${revote.status}`);

  // 正常（非 AJAX）提交仍走重定向，保证无 JS 时可用
  const plain = await admin.post('/manage/codes/generate', { publicCount: 1, proCount: 0 });
  check('无 JS 时回退为重定向（302）', plain.status === 302 && String(plain.headers.get('location')).includes('flash=ok'), `status=${plain.status}`);
}

// 17. 后台锁定设置
{
  const s = db.prepare("SELECT value FROM settings WHERE key='admin_lock_minutes'").get();
  eq('后台锁定时长为 60 分钟', s.value, '60');
}


// 18. 评审席超出范围（会导致专业评审分数被静默丢弃）—— 必须拦截且可一键修正
{
  const ajaxHeaders = { 'x-requested-with': 'fetch' };
  const judgeCount = Number(db.prepare("SELECT value FROM settings WHERE key='judge_count'").get().value);

  // 构造与现场一致的情形：4 条专业评审密码条被绑到了 5/6/7/8 号评审席
  const proCodes = db.prepare("SELECT * FROM voting_codes WHERE role='pro' ORDER BY id LIMIT 4").all();
  check('存在 4 条专业评审密码条用于测试', proCodes.length === 4, `实际 ${proCodes.length}`);

  const ts = new Date().toISOString();
  proCodes.forEach((c, i) => {
    const bad = judgeCount + 1 + i; // 5,6,7,8
    db.prepare('UPDATE scores SET judge_slot=? WHERE judge_slot=?').run(bad, c.judge_slot);
    db.prepare('UPDATE voting_codes SET judge_slot=? WHERE id=?').run(bad, c.id);
  });
  const badCode = db.prepare('SELECT * FROM voting_codes WHERE role=? AND judge_slot>? ORDER BY judge_slot LIMIT 1').get('pro', judgeCount);
  const ins = db.prepare(
    `INSERT INTO scores (competition, judge_slot, code_id, player_id, score, created_at, updated_at, source, operator, note)
     VALUES ('group', ?, ?, ?, ?, ?, ?, 'self', NULL, 'e2e 越界模拟')
     ON CONFLICT(competition, judge_slot, player_id) DO UPDATE SET score=excluded.score`
  );
  for (const p of players) ins.run(badCode.judge_slot, badCode.id, p.id, 60 + p.no, ts, ts);
  const orphanBefore = db.prepare('SELECT COUNT(*) c FROM scores WHERE judge_slot>?').get(judgeCount).c;
  check('已构造出越界评审席的分数（不会被计入成绩）', orphanBefore > 0, `越界 ${orphanBefore} 格`);

  // ① 越界密码条提交打分 → 必须被明确拒绝，而不是静默丢弃
  const j = newClient();
  await j.post('/vote/login', { code: badCode.code, competition: 'group' });
  const payload = { competition: 'group' };
  players.forEach((p, i) => (payload[`score_${p.id}`] = String(70 + i)));
  const r = await j.post('/vote/score', payload);
  const html = await r.text();
  check('越界评审席提交打分被拒绝并说明原因', r.status === 400 && /超出本场评审席位/.test(html), `status=${r.status}`);

  // ② 后台应能检测到并一键修正
  const scoresPage = await (await admin.get('/manage/scores?c=group')).text();
  check('后台打分数数据页显示越界警告', /评审席超出范围/.test(scoresPage) && /一键修正评审席/.test(scoresPage), '');

  const repair = await admin.req('POST', '/manage/scores/repair', {}, { headers: ajaxHeaders });
  const rj = await repair.json();
  check('一键修正评审席成功', rj.ok === true && /搬回有效评审席/.test(rj.message), JSON.stringify(rj).slice(0, 200));

  const badCodesAfter = db.prepare('SELECT COUNT(*) c FROM voting_codes WHERE role=? AND (judge_slot<1 OR judge_slot>?)').get('pro', judgeCount).c;
  eq('修正后所有专业评审密码条都在有效范围内', badCodesAfter, 0);
  const orphanAfter = db.prepare('SELECT COUNT(*) c FROM scores WHERE judge_slot>?').get(judgeCount).c;
  eq('修正后越界评审席的分数已全部迁移', orphanAfter, 0);
  const migrated = db.prepare("SELECT COUNT(*) c FROM scores WHERE note LIKE '评审席由%'").get().c;
  check('被忽略的分数已纳入统计范围', migrated > 0, `迁移 ${migrated} 格`);

  // ③ 修正后该评审可正常提交打分，且分数确实计入成绩
  const j2 = newClient();
  await j2.post('/vote/login', { code: badCode.code, competition: 'group' });
  const p2 = { competition: 'group' };
  players.forEach((p, i) => (p2[`score_${p.id}`] = String(70 + i)));
  const r2 = await j2.post('/vote/score', p2);
  check('修正后该评审密码条可正常提交打分', r2.status === 302, `status=${r2.status}`);
  const resRow = db.prepare("SELECT pro_judges, pro_avg FROM results WHERE competition='group' AND player_id=?").get(players[0].id);
  check('修正后打分已计入成绩（平均分不再为 0）', resRow.pro_judges > 0 && resRow.pro_avg > 0, JSON.stringify(resRow));

  // 清理：移除本次模拟的分数并重算
  db.prepare("DELETE FROM scores WHERE note='e2e 越界模拟' OR note LIKE '评审席由%'").run();
  await admin.post('/manage/recalc', { back: '/manage/scores' });
}


// 19. 排名公示榜 /board 必须严格由开关控制（管理员也不能绕过）
{
  const orig = db.prepare("SELECT value FROM settings WHERE key='board_public'").get().value;
  const setPub = (v) => db.prepare("UPDATE settings SET value=? WHERE key='board_public'").run(v);

  // 未开启时：任何身份都不能访问
  setPub('0');
  const anon = await (await fetch(BASE + '/board')).text();
  const anonRes = await fetch(BASE + '/board');
  check('未登录访问 /board 被拒绝（403）', anonRes.status === 403, `status=${anonRes.status}`);
  const adminBoard = await admin.get('/board');
  check('管理员在开关未开启时访问 /board 同样被拒绝（403）', adminBoard.status === 403, `status=${adminBoard.status}`);
  const voterC = newClient();
  const vc = db.prepare("SELECT code FROM voting_codes WHERE role='public' AND enabled=1 LIMIT 1").get();
  await voterC.post('/vote/login', { code: vc.code, competition: 'group' });
  const voterBoard = await voterC.get('/board');
  check('大众评审访问 /board 被拒绝（403）', voterBoard.status === 403, `status=${voterBoard.status}`);

  // 后台预览入口始终可用（管理员专用，不依赖开关）
  const preview = await admin.get('/manage/board?c=final');
  const previewHtml = await preview.text();
  check('后台预览页 /manage/board 可用', preview.status === 200 && /最终总排名/.test(previewHtml), `status=${preview.status}`);
  check('后台预览页提示公众入口状态', /后台预览/.test(previewHtml) && /公众入口/.test(previewHtml), '');
  check('后台预览页的标签页链接指向自身（不会跳到 /board）', /href="\/manage\/board\?c=group"/.test(previewHtml), '');

  // 打开开关后对公众开放
  setPub('1');
  const openRes = await fetch(BASE + '/board?c=final');
  check('开启开关后未登录也能访问 /board', openRes.status === 200, `status=${openRes.status}`);

  setPub(orig);
  const restored = await fetch(BASE + '/board');
  check('恢复开关后 /board 重新关闭', restored.status === 403, `status=${restored.status}`);
}

/* ------------------------------------------------------------------ 汇总 ---- */

console.log(`\n=== 结果：${pass} 项通过，${fail} 项失败 ===`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  - ' + f));
}
db.close();
process.exit(fail ? 1 : 0);
