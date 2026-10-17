/**
 * 业务服务层：投票提交、专业评审打分提交、管理员手动赋分与数据修正。
 * 所有入口都在服务端做强校验（前端置灰只是体验，不是防线）。
 */
import { getDb, getSettings } from './db.js';
import {
  tx,
  listPlayers,
  logAudit,
  getCode,
  validVotes,
  competitionStatus,
} from './repo.js';
import { nowIso, round, randomCode, formatCode } from './util.js';

const err = (msg, code = 'INVALID') => {
  const e = new Error(msg);
  e.code = code;
  return e;
};

export function activePlayerIds() {
  return listPlayers({ activeOnly: true }).map((p) => p.id);
}

/* -------------------------------------------------------- 大众评审投票 ---- */

function validatePicks(playerIds, settings) {
  const ids = [...new Set((playerIds || []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))];
  const active = new Set(activePlayerIds());
  if (ids.length === 0) throw err('请至少选择 1 位选手');
  if (ids.length > settings.publicPickCount) throw err(`最多只能选择 ${settings.publicPickCount} 位选手`);
  for (const id of ids) if (!active.has(id)) throw err('所选选手中包含已停用的选手，请刷新页面重试');
  return ids;
}

/** 密码条必须处于启用状态（停用后即使会话仍然有效，也不得再投票/打分） */
export function assertCodeEnabled(code) {
  if (!code) throw err('密码条不存在，请重新登录', 'DISABLED');
  if (!code.enabled) throw err('该密码条已被停用，无法继续操作，请联系现场工作人员', 'DISABLED');
}

export function assertOpen(competition, settings = getSettings()) {
  const st = competitionStatus(competition, settings);
  if (!st.open) {
    const map = { closed: '该赛事投票尚未开启', pending: '该赛事投票尚未开始', ended: '该赛事投票已截止' };
    throw err(map[st.reason] || '当前不可投票', 'CLOSED');
  }
  return st;
}

/** 大众评审提交投票（每条密码条每个赛事仅一次） */
export function submitPublicVote({ competition, code, playerIds, ip, ua }) {
  const s = getSettings();
  assertCodeEnabled(code);
  assertOpen(competition, s);
  if (code.role !== 'public') throw err('该密码条为专业评审权限，请使用专业评审打分入口', 'ROLE');
  const ids = validatePicks(playerIds, s);

  const existing = getDb()
    .prepare('SELECT id FROM votes WHERE competition = ? AND code_id = ? AND invalid = 0')
    .get(competition, code.id);
  if (existing) throw err('您已完成本场投票，感谢参与', 'DONE');

  const ts = nowIso();
  let voteId;
  tx((db) => {
    const info = db
      .prepare(
        `INSERT INTO votes (competition, code_id, code_snapshot, role, ip, ua, created_at, source, invalid, note)
         VALUES (?, ?, ?, 'public', ?, ?, ?, 'self', 0, NULL)`
      )
      .run(competition, code.id, code.code, ip, ua, ts);
    voteId = Number(info.lastInsertRowid);
    const stmt = db.prepare('INSERT INTO vote_items (vote_id, player_id) VALUES (?, ?)');
    for (const pid of ids) stmt.run(voteId, pid);
  });

  logAudit({
    actorType: 'code',
    actor: code.label || formatCode(code.code),
    action: 'vote.submit',
    target: `votes#${voteId}`,
    after: { competition, playerIds: ids },
    ip,
    note: '大众评审提交投票',
  });

  return { voteId, count: ids.length };
}

/* ------------------------------------------------------ 专业评审打分 ---- */

/** 专业评审提交百分制打分（截止前可修改，由设置 pro_can_edit 控制） */
export function submitProScores({ competition, code, scores, ip, ua }) {
  const s = getSettings();
  assertCodeEnabled(code);
  assertOpen(competition, s);
  if (code.role !== 'pro') throw err('该密码条为大众评审权限，无法进入打分入口', 'ROLE');
  if (code.judge_slot === null || code.judge_slot === undefined) {
    throw err('该专业评审密码条未绑定评审席，请联系管理员在后台设置', 'NO_SLOT');
  }
  const slot = Number(code.judge_slot);
  if (slot < 1 || slot > s.judgeCount) {
    throw err(
      `该密码条绑定的评审席（${slot}）超出本场评审席位数（${s.judgeCount}），分数无法计入。请联系管理员在后台修正评审席绑定。`,
      'BAD_SLOT'
    );
  }
  const players = listPlayers({ activeOnly: true });
  const entries = [];
  for (const p of players) {
    const raw = scores?.[p.id] ?? scores?.[String(p.id)];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw err(`请为「${p.name}」填写分数`);
    }
    const val = Number(raw);
    if (!Number.isFinite(val)) throw err(`「${p.name}」的分数格式不正确`);
    if (val < 0 || val > 100) throw err(`「${p.name}」的分数需在 0-100 之间`);
    entries.push({ playerId: p.id, score: round(val, 1) });
  }

  const db = getDb();
  const existing = db
    .prepare('SELECT COUNT(*) AS c FROM scores WHERE competition = ? AND judge_slot = ?')
    .get(competition, slot).c;
  if (existing > 0 && !s.proCanEdit) {
    throw err('您已提交过本场打分，且当前不允许修改，请联系管理员', 'LOCKED');
  }

  const before = db
    .prepare('SELECT player_id, score FROM scores WHERE competition = ? AND judge_slot = ?')
    .all(competition, slot);

  const ts = nowIso();
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO scores (competition, judge_slot, code_id, player_id, score, created_at, updated_at, source, operator, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'self', NULL, NULL)
       ON CONFLICT(competition, judge_slot, player_id) DO UPDATE SET
         score = excluded.score, updated_at = excluded.updated_at, code_id = excluded.code_id`
    );
    for (const e of entries) stmt.run(competition, slot, code.id, e.playerId, e.score, ts, ts);
  });

  logAudit({
    actorType: 'code',
    actor: `评审席${slot}(${code.label || formatCode(code.code)})`,
    action: existing > 0 ? 'score.update' : 'score.submit',
    target: `scores:${competition}:slot${slot}`,
    before: before.length ? before : null,
    after: entries,
    ip,
    note: existing > 0 ? '专业评审修改打分' : '专业评审首次提交打分',
  });

  return { slot, count: entries.length, updated: existing > 0 };
}

/* -------------------------------------------------- 管理员：投票数据 ---- */

/** 手动新增一条大众投票（可选 1..pickCount 位选手） */
export function addManualVote({ competition, playerIds, note, operator, ip }) {
  const s = getSettings();
  const ids = validatePicks(playerIds, s);
  const ts = nowIso();
  let voteId;
  tx((db) => {
    const info = db
      .prepare(
        `INSERT INTO votes (competition, code_id, code_snapshot, role, ip, ua, created_at, source, invalid, operator, note)
         VALUES (?, NULL, '手动录入', 'public', ?, NULL, ?, 'manual', 0, ?, ?)`
      )
      .run(competition, ip, ts, operator, note || null);
    voteId = Number(info.lastInsertRowid);
    const stmt = db.prepare('INSERT INTO vote_items (vote_id, player_id) VALUES (?, ?)');
    for (const pid of ids) stmt.run(voteId, pid);
  });
  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'vote.manual.add',
    target: `votes#${voteId}`,
    after: { competition, playerIds: ids, note },
    ip,
    note: '手动新增投票',
  });
  return { voteId };
}

/** 给某位选手一次性补 N 票（生成 N 条单人手动投票，便于逐条追溯） */
export function addManualVotesForPlayer({ competition, playerId, count, note, operator, ip }) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0 || n > 500) throw err('票数需为 1-500 的整数');
  const pid = Number(playerId);
  if (!activePlayerIds().includes(pid)) throw err('选手不存在或已停用');
  const ts = nowIso();
  const ids = [];
  tx((db) => {
    const v = db.prepare(
      `INSERT INTO votes (competition, code_id, code_snapshot, role, ip, ua, created_at, source, invalid, operator, note)
       VALUES (?, NULL, '手动补票', 'public', ?, NULL, ?, 'manual', 0, ?, ?)`
    );
    const it = db.prepare('INSERT INTO vote_items (vote_id, player_id) VALUES (?, ?)');
    for (let i = 0; i < n; i++) {
      const info = v.run(competition, ip, ts, operator, note || `手动补 ${n} 票`);
      const vid = Number(info.lastInsertRowid);
      ids.push(vid);
      it.run(vid, pid);
    }
  });
  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'vote.manual.bulk',
    target: `players#${pid} ×${n}`,
    after: { competition, playerId: pid, count: n, note },
    ip,
    note: '手动补票',
  });
  return { count: n, voteIds: ids };
}

/** 修改某条投票记录投给谁 */
export function updateVoteItems({ voteId, playerIds, operator, ip }) {
  const s = getSettings();
  const ids = validatePicks(playerIds, s);
  const db = getDb();
  const vote = db.prepare('SELECT * FROM votes WHERE id = ?').get(Number(voteId));
  if (!vote) throw err('投票记录不存在');
  const before = db.prepare('SELECT player_id FROM vote_items WHERE vote_id = ?').all(vote.id).map((r) => r.player_id);
  tx((d) => {
    d.prepare('DELETE FROM vote_items WHERE vote_id = ?').run(vote.id);
    const stmt = d.prepare('INSERT INTO vote_items (vote_id, player_id) VALUES (?, ?)');
    for (const pid of ids) stmt.run(vote.id, pid);
  });
  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'vote.items.update',
    target: `votes#${vote.id}`,
    before: { playerIds: before },
    after: { playerIds: ids },
    ip,
    note: '修改投票内容',
  });
  return { before, after: ids };
}

/** 作废 / 恢复一条投票（作废后不计票，且释放该密码条的投票资格） */
export function setVoteInvalid({ voteId, invalid, operator, ip, note }) {
  const db = getDb();
  const vote = db.prepare('SELECT * FROM votes WHERE id = ?').get(Number(voteId));
  if (!vote) throw err('投票记录不存在');
  db.prepare('UPDATE votes SET invalid = ?, operator = ?, note = COALESCE(?, note) WHERE id = ?').run(
    invalid ? 1 : 0,
    operator,
    note || null,
    vote.id
  );
  logAudit({
    actorType: 'admin',
    actor: operator,
    action: invalid ? 'vote.invalidate' : 'vote.restore',
    target: `votes#${vote.id}`,
    before: { invalid: vote.invalid },
    after: { invalid: invalid ? 1 : 0 },
    ip,
    note: note || (invalid ? '作废投票' : '恢复投票'),
  });
}

/** 彻底删除一条投票记录（含选项，不可恢复） */
export function deleteVote({ voteId, operator, ip }) {
  const db = getDb();
  const vote = db.prepare('SELECT * FROM votes WHERE id = ?').get(Number(voteId));
  if (!vote) throw err('投票记录不存在');
  const items = db.prepare('SELECT player_id FROM vote_items WHERE vote_id = ?').all(vote.id).map((r) => r.player_id);
  tx((d) => {
    d.prepare('DELETE FROM vote_items WHERE vote_id = ?').run(vote.id);
    d.prepare('DELETE FROM votes WHERE id = ?').run(vote.id);
  });
  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'vote.delete',
    target: `votes#${vote.id}`,
    before: { ...vote, playerIds: items },
    ip,
    note: '彻底删除投票记录',
  });
}

/** 重置某密码条的投票状态（作废其全部投票，使其可重新投票） */
export function resetCodeVotes({ codeId, competition = null, operator, ip }) {
  const db = getDb();
  const rows = competition
    ? db.prepare('SELECT * FROM votes WHERE code_id = ? AND competition = ?').all(Number(codeId), competition)
    : db.prepare('SELECT * FROM votes WHERE code_id = ?').all(Number(codeId));
  if (!rows.length) return { count: 0 };
  tx((d) => {
    const stmt = d.prepare('UPDATE votes SET invalid = 1, operator = ? WHERE id = ?');
    for (const r of rows) stmt.run(operator, r.id);
  });
  const code = getCode(codeId);
  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'code.votes.reset',
    target: `voting_codes#${codeId}`,
    before: { votes: rows.map((r) => ({ id: r.id, competition: r.competition })) },
    after: { invalidated: rows.length },
    ip,
    note: `重置密码条投票状态${code ? `（${code.label || code.code}）` : ''}`,
  });
  return { count: rows.length };
}

/* ------------------------------------------------ 管理员：打分数据 ---- */

/** 批量录入/覆盖打分（手动赋分专用页） */
export function setScoresBulk({ competition, entries, operator, ip, note }) {
  const players = new Set(activePlayerIds());
  const clean = [];
  for (const e of entries || []) {
    const slot = Number(e.judgeSlot);
    const pid = Number(e.playerId);
    if (!Number.isInteger(slot) || slot < 1) throw err('评审席编号不正确');
    if (!players.has(pid)) throw err(`选手 #${pid} 不存在或已停用`);
    if (e.score === '' || e.score === null || e.score === undefined) continue;
    const val = Number(e.score);
    if (!Number.isFinite(val) || val < 0 || val > 100) throw err('分数需在 0-100 之间');
    clean.push({ judgeSlot: slot, playerId: pid, score: round(val, 1) });
  }
  if (!clean.length) throw err('没有需要保存的分数');

  const db = getDb();
  const before = db
    .prepare('SELECT judge_slot, player_id, score FROM scores WHERE competition = ?')
    .all(competition);
  const ts = nowIso();
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO scores (competition, judge_slot, code_id, player_id, score, created_at, updated_at, source, operator, note)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 'manual', ?, ?)
       ON CONFLICT(competition, judge_slot, player_id) DO UPDATE SET
         score = excluded.score, updated_at = excluded.updated_at,
         source = 'manual', operator = excluded.operator, note = excluded.note`
    );
    for (const e of clean) stmt.run(competition, e.judgeSlot, e.playerId, e.score, ts, ts, operator, note || null);
  });

  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'score.manual.set',
    target: `scores:${competition}`,
    before,
    after: clean,
    ip,
    note: note || '手动录入/覆盖专业评审分数',
  });
  return { count: clean.length };
}

/** 删除某条打分（使该评审席该选手变为「未评」） */
export function clearScore({ competition, judgeSlot, playerId, operator, ip }) {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM scores WHERE competition = ? AND judge_slot = ? AND player_id = ?')
    .get(competition, Number(judgeSlot), Number(playerId));
  if (!row) return { removed: 0 };
  db.prepare('DELETE FROM scores WHERE id = ?').run(row.id);
  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'score.clear',
    target: `scores:${competition}:slot${judgeSlot}:player${playerId}`,
    before: row,
    ip,
    note: '清空该评分（视为未评）',
  });
  return { removed: 1 };
}

/** 单条生成（供 generateCodesBulk 内部复用） */
function insertCode(db, { code, role, label, judgeSlot, note, ts }) {
  db.prepare(
    `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(code, role, label, judgeSlot, note, ts, ts);
}

function uniqueCode(db, prefix, len) {
  for (let i = 0; i < 200; i++) {
    const code = (prefix || '') + randomCode(len);
    if (!db.prepare('SELECT 1 FROM voting_codes WHERE code = ?').get(code)) return code;
  }
  throw err('随机码冲突过多，请增大长度后重试');
}

/**
 * 一键生成密码条：可同时生成「专业评审」与「大众评审」两套，自动编号。
 * @param {Object} p
 * @param {number} p.publicCount 大众评审数量（0 表示不生成）
 * @param {number} p.proCount    专业评审数量（0 表示不生成），自动绑定评审席 1..N
 * @param {boolean} p.replace    true=先清空现有密码条再生成（已有人用过的密码条存在时拒绝）
 */
export function generateCodesBulk({
  publicCount = 0,
  proCount = 0,
  proSlotStart = 1,
  length = 8,
  prefix = '',
  labelPrefixPublic = '大众评审',
  labelPrefixPro = '专业评审',
  replace = false,
  note = null,
}) {
  const pub = Math.max(0, Math.min(Number(publicCount) || 0, 1000));
  const pro = Math.max(0, Math.min(Number(proCount) || 0, 50));
  if (pub === 0 && pro === 0) throw err('请填写需要生成的数量');
  const len = Math.min(Math.max(Number(length) || 8, 6), 16);
  const cleanPrefix = String(prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const db = getDb();

  if (replace) {
    const used = db.prepare('SELECT COUNT(*) AS c FROM votes WHERE code_id IS NOT NULL').get().c;
    if (used > 0) {
      throw err('已有密码条被使用过（存在历史投票记录），无法直接清空重建。请先清空投票数据，或改用「追加生成」。');
    }
  }

  // 追加生成专业评审密码条时，评审席不能与已有的重复，
  // 否则两个密码条会写入同一评审席的分数并互相覆盖。
  const slotStart = Number(proSlotStart) || 1;
  const judgeCount = getSettings().judgeCount;
  if (pro > 0) {
    const want = Array.from({ length: pro }, (_, i) => slotStart + i);
    const outOfRange = want.filter((x) => x < 1 || x > judgeCount);
    if (outOfRange.length) {
      throw err(
        `评审席编号必须在 1 - ${judgeCount} 之间（当前系统设置的评审席位数为 ${judgeCount}）。` +
          `评审席超出范围的密码条，其打分不会被计入成绩。` +
          `如确实需要更多评审，请先到「系统设置」把「专业评审席位数」调大。`
      );
    }
    if (!replace) {
      const usedSlots = db
        .prepare('SELECT judge_slot FROM voting_codes WHERE role=? AND judge_slot IS NOT NULL')
        .all('pro')
        .map((r) => r.judge_slot);
      const clash = want.filter((x) => usedSlots.includes(x));
      if (clash.length) {
        throw err(
          `评审席 ${clash.join('、')} 已被现有专业评审密码条占用（同一评审席会互相覆盖分数）。` +
            `请先删除或停用多余的专业评审密码条，或改用「清空后重新生成」。`
        );
      }
    }
  }

  const created = { public: [], pro: [] };
  tx((d) => {
    const ts = nowIso();
    if (replace) d.exec('DELETE FROM voting_codes');

    for (let i = 1; i <= pro; i++) {
      const code = uniqueCode(d, cleanPrefix, len);
      const label = `${labelPrefixPro}${String(i).padStart(2, '0')}`;
      insertCode(d, { code, role: 'pro', label, judgeSlot: Number(proSlotStart) + i - 1, note, ts });
      created.pro.push({ code, label, judgeSlot: Number(proSlotStart) + i - 1 });
    }
    for (let i = 1; i <= pub; i++) {
      const code = uniqueCode(d, cleanPrefix, len);
      const label = `${labelPrefixPublic}${String(i).padStart(2, '0')}`;
      insertCode(d, { code, role: 'public', label, judgeSlot: null, note, ts });
      created.public.push({ code, label });
    }
  });
  return created;
}

/**
 * 一键清空运行数据（可分别选择范围）。用于删除测试数据、或赛前重置。
 * @param {Object} p
 * @param {Object} p.scopes { groupVotes, individualVotes, groupScores, individualScores }
 * @param {boolean} p.clearAudit 是否连同操作日志一起清空
 */
export function clearData({ scopes = {}, clearAudit = false, operator, ip }) {
  const wantVotes = { group: !!scopes.groupVotes, individual: !!scopes.individualVotes };
  const wantScores = { group: !!scopes.groupScores, individual: !!scopes.individualScores };
  if (!wantVotes.group && !wantVotes.individual && !wantScores.group && !wantScores.individual && !clearAudit) {
    throw err('请至少选择一项需要清空的数据');
  }

  const db = getDb();
  const before = {
    votes: db.prepare('SELECT COUNT(*) AS c FROM votes').get().c,
    scores: db.prepare('SELECT COUNT(*) AS c FROM scores').get().c,
    audit: db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c,
  };
  const removed = { votes: 0, items: 0, scores: 0, audit: 0 };

  tx((d) => {
    for (const comp of ['group', 'individual']) {
      if (wantVotes[comp]) {
        const ids = d.prepare("SELECT id FROM votes WHERE competition = ?").all(comp).map((r) => r.id);
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          removed.items += d.prepare(`DELETE FROM vote_items WHERE vote_id IN (${ph})`).run(...ids).changes;
          removed.votes += d.prepare(`DELETE FROM votes WHERE id IN (${ph})`).run(...ids).changes;
        }
      }
      if (wantScores[comp]) {
        removed.scores += d.prepare('DELETE FROM scores WHERE competition = ?').run(comp).changes;
      }
    }
    if (clearAudit) removed.audit = d.prepare('DELETE FROM audit_logs').run().changes;

    // 派生数据一并重置（随后会统一重算）
    d.exec('DELETE FROM results');
    d.exec('DELETE FROM final_results');
  });

  // 记录本次清空（即使刚刚清空了日志，也留下这一条，保证可追溯）
  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'data.clear',
    target: Object.entries({ ...wantVotes, ...wantScores })
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(',') + (clearAudit ? ',audit' : ''),
    before,
    after: { removed },
    ip,
    note: `一键清空数据：投票 ${removed.votes} 条、打分 ${removed.scores} 条${clearAudit ? `、操作日志 ${removed.audit} 条` : ''}`,
  });

  return { before, removed };
}


export function generateCodes({ count, role = 'public', length = 8, prefix = '', labelPrefix = '', judgeSlotStart = null, note = null }) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0 || n > 500) throw err('生成数量需为 1-500 的整数');
  const len = Math.min(Math.max(Number(length) || 8, 6), 16);
  const db = getDb();
  const created = [];
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO voting_codes (code, role, label, judge_slot, enabled, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    );
    const ts = nowIso();
    let guard = 0;
    while (created.length < n) {
      if (guard++ > n * 50) throw err('随机码冲突过多，请增大长度后重试');
      const code = (prefix ? String(prefix).toUpperCase().replace(/[^A-Z0-9]/g, '') : '') + randomCode(len);
      if (db.prepare('SELECT 1 FROM voting_codes WHERE code = ?').get(code)) continue;
      const slot = role === 'pro' && judgeSlotStart !== null ? Number(judgeSlotStart) + created.length : null;
      const label = `${labelPrefix || (role === 'pro' ? '专业评审' : '大众评审')}${String(created.length + 1).padStart(2, '0')}`;
      stmt.run(code, role, label, slot, note, ts, ts);
      created.push({ code, role, label, judgeSlot: slot });
    }
  });
  return created;
}

/* ------------------------------------------------ 评审席错位修正 ---- */

/**
 * 一键修正：把「评审席超出 1..judge_count」的专业评审密码条（及其已提交的分数）
 * 重新分配到有效的空闲评审席上。
 * 场景：历史数据中评审席位数被调小、或密码条被误绑到 5/6/7… 号评审席，
 *       导致这些分数被计分引擎忽略（静默不计入成绩）。
 */
export function repairJudgeSlots({ operator, ip }) {
  const s = getSettings();
  const judgeCount = s.judgeCount;
  const db = getDb();

  const allPro = db.prepare("SELECT * FROM voting_codes WHERE role='pro' ORDER BY judge_slot IS NULL, judge_slot, id").all();
  const inRange = new Set(allPro.filter((c) => c.judge_slot >= 1 && c.judge_slot <= judgeCount).map((c) => c.judge_slot));
  const broken = allPro.filter((c) => !(c.judge_slot >= 1 && c.judge_slot <= judgeCount));

  const moves = [];
  const conflicts = [];
  const noSlot = [];

  for (const code of broken) {
    let target = null;
    for (let slot = 1; slot <= judgeCount; slot++) if (!inRange.has(slot)) { target = slot; break; }
    if (target === null) { noSlot.push(code.label || code.code); continue; }
    inRange.add(target);
    moves.push({ codeId: code.id, label: code.label || code.code, from: code.judge_slot, to: target });
  }

  if (!moves.length && !noSlot.length) return { moves: [], conflicts: [], noSlot: [], changed: 0 };

  tx((d) => {
    const ts = nowIso();
    for (const m of moves) {
      // 迁移该密码条已提交的分数到新评审席
      const rows = d.prepare('SELECT * FROM scores WHERE competition IS NOT NULL AND judge_slot = ? AND code_id = ?').all(m.from, m.codeId);
      for (const r of rows) {
        const dup = d.prepare('SELECT id FROM scores WHERE competition=? AND judge_slot=? AND player_id=?').get(r.competition, m.to, r.player_id);
        if (dup) {
          conflicts.push({ label: m.label, competition: r.competition, playerId: r.player_id, kept: '既有分数', dropped: r.score });
          d.prepare('DELETE FROM scores WHERE id=?').run(r.id);
        } else {
          d.prepare('UPDATE scores SET judge_slot=?, updated_at=?, note=? WHERE id=?')
            .run(m.to, ts, `评审席由 ${m.from} 修正为 ${m.to}`, r.id);
        }
      }
      // 评审席错位但未绑定密码条的散落分数（手工录入等）一并搬迁
      const orphan = d.prepare('SELECT * FROM scores WHERE judge_slot = ? AND (code_id IS NULL OR code_id != ?)').all(m.from, m.codeId);
      for (const r of orphan) {
        const dup = d.prepare('SELECT id FROM scores WHERE competition=? AND judge_slot=? AND player_id=?').get(r.competition, m.to, r.player_id);
        if (!dup) d.prepare('UPDATE scores SET judge_slot=?, updated_at=? WHERE id=?').run(m.to, ts, r.id);
      }
      d.prepare('UPDATE voting_codes SET judge_slot=?, updated_at=? WHERE id=?').run(m.to, ts, m.codeId);
    }
  });

  logAudit({
    actorType: 'admin',
    actor: operator,
    action: 'score.repair_slots',
    target: `judge_slots(1-${judgeCount})`,
    before: { moves: moves.map((m) => `${m.label}: 席${m.from}`) },
    after: { moves: moves.map((m) => `${m.label}: 席${m.to}`), conflicts: conflicts.length, noSlot: noSlot.length },
    ip,
    note: `修正评审席错位：搬迁 ${moves.length} 条密码条${conflicts.length ? `，${conflicts.length} 格因目标评审席已有同选手分数而未迁移` : ''}${noSlot.length ? `，${noSlot.length} 条无空闲评审席` : ''}`,
  });

  return { moves, conflicts, noSlot, changed: moves.length };
}
