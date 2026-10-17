/**
 * 后台管理路由（/manage）—— 全部管理权限功能。
 * 登录之外的接口统一由 requireAdmin 守卫。
 */
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { UPLOAD_DIR, ALLOWED_IMAGE_TYPES, COMPETITIONS } from './config.js';
import { getSettings, setSetting, getDb } from './db.js';
import {
  tx,
  listPlayers,
  getPlayer,
  createPlayer,
  updatePlayer,
  deletePlayer,
  reorderPlayers,
  listCodes,
  getCode,
  createCode,
  updateCode,
  deleteCode,
  setCodeEnabled,
  codeVoteStates,
  codeVoteState,
  votesWithItems,
  listScores,
  getStoredResults,
  getStoredFinal,
  recomputeAll,
  logAudit,
  listAudit,
  countAudit,
  dashboardStats,
  competitionStatus,
  computeAllOnly,
  getAdmin,
  listAdmins,
  createAdmin,
  updateAdminPassword,
  deleteAdmin,
  unlockAdmin,
  publicVotesByPlayer,
  judgeScoresBySlot,
} from './repo.js';
import {
  addManualVote,
  addManualVotesForPlayer,
  updateVoteItems,
  setVoteInvalid,
  deleteVote,
  resetCodeVotes,
  setScoresBulk,
  clearScore,
  generateCodes,
  generateCodesBulk,
  clearData,
  repairJudgeSlots,
} from './services.js';
import { computeCompetition, computeFinal, explainRules, TIE_BREAK_LABEL } from './scoring.js';
import { issueSession, dropSession, requireAdmin, loginWithAdmin, verifyAdminPassword } from './auth.js';
import { normalizeCode, formatCode, nowIso, fmtLocal, isoToLocalInput, localToIso, randomPassword, round } from './util.js';
import { buildFullWorkbook, buildRankWorkbook, buildCodesWorkbook, xlsxHeaders, stamp } from './exporter.js';

function clientIp(request) {
  return (request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.ip;
}

function actor(request) {
  return request.user?.username || 'admin';
}

/**
 * 把 before/after 两套结果整理成对比表。
 * 关键：票数/赋分/专业均分/赛事得分/名次一律取**所编辑的那个赛事**的数据，
 * （此前在 view=final 时误取了个人赛的票数与赋分，导致预览数字与实际执行结果不一致）
 * 当 withFinal=true 时，额外附上最终总成绩与总名次两列。
 */
function buildDiff(before, after, competition, withFinal = false) {
  const bComp = new Map((before[competition]?.rows || []).map((r) => [r.playerId, r]));
  const aComp = new Map((after[competition]?.rows || []).map((r) => [r.playerId, r]));
  const bFinal = withFinal ? new Map((before.final?.rows || []).map((r) => [r.playerId, r])) : null;
  const aFinal = withFinal ? new Map((after.final?.rows || []).map((r) => [r.playerId, r])) : null;

  const pick = (r) =>
    r
      ? { name: r.name, votes: r.publicVotes, points: r.publicPoints, proAvg: r.proAvg, score: r.finalScore, rank: r.publicRank }
      : { name: '—', votes: 0, points: 0, proAvg: 0, score: 0, rank: null };

  const ids = [...new Set([...bComp.keys(), ...aComp.keys()])];
  const rows = ids.map((id) => {
    const pb = pick(bComp.get(id));
    const pa = pick(aComp.get(id));
    const row = {
      playerId: id,
      competition,
      name: pa.name !== '—' ? pa.name : pb.name,
      beforeRank: pb.rank,
      afterRank: pa.rank,
      beforeScore: pb.score,
      afterScore: pa.score,
      beforeVotes: pb.votes,
      afterVotes: pa.votes,
      beforePoints: pb.points,
      afterPoints: pa.points,
      beforeProAvg: pb.proAvg,
      afterProAvg: pa.proAvg,
      rankChanged: pb.rank !== pa.rank,
      scoreChanged: round(pb.score, 3) !== round(pa.score, 3),
    };
    if (withFinal && bFinal && aFinal) {
      row.beforeTotal = bFinal.get(id)?.totalScore ?? 0;
      row.afterTotal = aFinal.get(id)?.totalScore ?? 0;
      row.beforeFinalRank = bFinal.get(id)?.finalRank ?? null;
      row.afterFinalRank = aFinal.get(id)?.finalRank ?? null;
      row.totalChanged = round(row.beforeTotal, 3) !== round(row.afterTotal, 3);
    }
    return row;
  });
  rows.sort((x, y) => (x.afterRank ?? 999) - (y.afterRank ?? 999) || x.playerId - y.playerId);
  return rows;
}

/** 内存中模拟变更后的结果（不写库），用于「改前/改后」预览 */
function simulate({ competition, extraVotes = {}, scoreOverrides = [], removeVotes = {} }) {
  const settings = getSettings();
  const players = listPlayers({ activeOnly: true });
  const votes = publicVotesByPlayer(competition);
  for (const [pid, n] of Object.entries(extraVotes)) {
    const id = Number(pid);
    votes.set(id, Math.max(0, (votes.get(id) || 0) + Number(n)));
  }
  for (const [pid, n] of Object.entries(removeVotes)) {
    const id = Number(pid);
    votes.set(id, Math.max(0, (votes.get(id) || 0) - Number(n)));
  }
  const scores = judgeScoresBySlot(competition);
  for (const o of scoreOverrides) {
    const slot = Number(o.judgeSlot);
    if (!scores.has(slot)) scores.set(slot, new Map());
    scores.get(slot).set(Number(o.playerId), Number(o.score));
  }
  const opts = {
    topPoints: settings.topPoints,
    zeroVotePoints: settings.zeroVotePoints,
    judgeCount: settings.judgeCount,
    missingJudgeRule: settings.missing_judge_rule,
    scoreCap: settings.scoreCap,
    decimals: settings.decimals,
    tieRankRule: settings.tie_rank_rule,
  };
  const simulated = computeCompetition({ players, votesByPlayer: votes, judgeScores: scores, opts });
  const current = computeAllOnly(settings);
  const group = competition === 'group' ? simulated : current.group;
  const individual = competition === 'individual' ? simulated : current.individual;
  const final = computeFinal({
    group,
    individual,
    players,
    opts: {
      weightGroup: settings.weightGroup,
      weightIndividual: settings.weightIndividual,
      decimals: settings.decimals,
      tieBreak: settings.final_tie_break,
    },
  });
  return { group, individual, final, current };
}

export async function registerManageRoutes(app) {
  /* ===================================================== 登录 / 登出 ==== */

  const renderLogin = (request, reply, error = null, extra = {}) =>
    reply.view('manage/login', { ...app.commonData(request), error, ...extra });

  app.get('/manage/login', async (request, reply) => {
    if (request.user?.type === 'admin') return reply.redirect('/manage');
    return renderLogin(request, reply, request.query.err ? decodeURIComponent(request.query.err) : null);
  });

  app.post('/manage/login', async (request, reply) => {
    const { username, password } = request.body || {};
    const ip = clientIp(request);
    const ua = String(request.headers['user-agent'] || '').slice(0, 300);
    const result = loginWithAdmin({ username, password, ip, ua });
    if (!result.ok) {
      return renderLogin(request, reply, result.error, { username });
    }
    issueSession(reply, { role: 'admin', adminId: result.admin.id, label: result.admin.username, ip, ua });
    logAudit({ actorType: 'admin', actor: result.admin.username, action: 'admin.login', ip, note: '后台登录成功' });
    const next = typeof request.query.next === 'string' && request.query.next.startsWith('/manage') ? request.query.next : '/manage';
    return reply.redirect(next);
  });

  app.get('/manage/logout', async (request, reply) => {
    if (request.user?.type === 'admin') {
      logAudit({ actorType: 'admin', actor: request.user.username, action: 'admin.logout', ip: clientIp(request), note: '退出登录' });
    }
    dropSession(request, reply);
    return reply.redirect('/manage/login');
  });

  /* ======================================================= 受保护区域 ==== */
  await app.register(
    async (scope) => {
      scope.addHook('preHandler', requireAdmin);

      const view = (request, reply, name, extra = {}) => reply.view(`manage/${name}`, { ...app.commonData(request), ...extra });

      /* ------------------------------------------------------ 仪表盘 ---- */
      scope.get('/', async (request, reply) => {
        const stats = dashboardStats();
        const settings = getSettings();
        const group = getStoredResults('group');
        const individual = getStoredResults('individual');
        const final = getStoredFinal();
        const codes = listCodes();
        return view(request, reply, 'dashboard', {
          stats,
          group,
          individual,
          final,
          codes,
          groupStatus: competitionStatus('group', settings),
          individualStatus: competitionStatus('individual', settings),
          recentLogs: listAudit({ limit: 12 }),
          nav: 'dashboard',
        });
      });

      /* ------------------------------------------------------ 选手管理 ---- */
      scope.get('/players', async (request, reply) => {
        return view(request, reply, 'players', { players: listPlayers({ activeOnly: false }), nav: 'players' });
      });

      scope.post('/players/save', async (request, reply) => {
        const b = request.body || {};
        const id = Number(b.id) || 0;
        const payload = {
          no: Number(b.no) || 0,
          name: String(b.name || '').trim(),
          tag: b.tag || null,
          intro: b.intro || null,
          active: b.active === 'on' || b.active === '1' ? 1 : 0,
        };
        if (!payload.name) return reply.flashRedirect('/manage/players', 'error', '选手姓名不能为空');
        if (id) {
          const r = updatePlayer(id, payload);
          logAudit({ actorType: 'admin', actor: actor(request), action: 'player.update', target: `players#${id}`, before: r?.before, after: r?.after, ip: clientIp(request) });
        } else {
          const newId = createPlayer(payload);
          logAudit({ actorType: 'admin', actor: actor(request), action: 'player.create', target: `players#${newId}`, after: payload, ip: clientIp(request) });
        }
        recomputeAll();
        return reply.flashRedirect('/manage/players', 'ok', id ? '选手信息已保存，已重新计算排名' : '选手已添加');
      });

      scope.post('/players/delete', async (request, reply) => {
        const id = Number(request.body?.id);
        try {
          const row = deletePlayer(id);
          logAudit({ actorType: 'admin', actor: actor(request), action: 'player.delete', target: `players#${id}`, before: row, ip: clientIp(request) });
          recomputeAll();
          return reply.flashRedirect('/manage/players', 'ok', '选手已删除');
        } catch (err) {
          return reply.flashRedirect('/manage/players', 'error', err.message);
        }
      });

      scope.post('/players/photo', async (request, reply) => {
        const data = await request.file();
        if (!data) return reply.flashRedirect('/manage/players', 'error', '未接收到文件');
        const playerId = Number(data.fields?.playerId?.value || 0);
        if (!playerId || !getPlayer(playerId)) return reply.flashRedirect('/manage/players', 'error', '选手不存在');
        if (!ALLOWED_IMAGE_TYPES.has(data.mimetype)) {
          return reply.flashRedirect('/manage/players', 'error', '仅支持 JPG / PNG / WebP / GIF 图片');
        }
        const ext = data.mimetype === 'image/png' ? 'png' : data.mimetype === 'image/webp' ? 'webp' : data.mimetype === 'image/gif' ? 'gif' : 'jpg';
        const filename = `p${playerId}-${Date.now()}.${ext}`;
        const dest = path.join(UPLOAD_DIR, filename);
        await new Promise((resolve, reject) => {
          const stream = fs.createWriteStream(dest);
          data.file.pipe(stream);
          stream.on('finish', resolve);
          stream.on('error', reject);
          data.file.on('limit', () => reject(new Error('图片体积超出限制')));
        });
        const before = getPlayer(playerId);
        if (before.photo && before.photo !== filename) {
          const old = path.join(UPLOAD_DIR, path.basename(before.photo));
          fs.existsSync(old) && fs.unlinkSync(old);
        }
        updatePlayer(playerId, { photo: filename });
        logAudit({ actorType: 'admin', actor: actor(request), action: 'player.photo', target: `players#${playerId}`, before: { photo: before.photo }, after: { photo: filename }, ip: clientIp(request) });
        return reply.flashRedirect('/manage/players', 'ok', '照片已上传');
      });

      scope.post('/players/photo/delete', async (request, reply) => {
        const id = Number(request.body?.id);
        const p = getPlayer(id);
        if (p?.photo) {
          const f = path.join(UPLOAD_DIR, path.basename(p.photo));
          fs.existsSync(f) && fs.unlinkSync(f);
          updatePlayer(id, { photo: null });
          logAudit({ actorType: 'admin', actor: actor(request), action: 'player.photo.delete', target: `players#${id}`, before: { photo: p.photo }, ip: clientIp(request) });
        }
        return reply.flashRedirect('/manage/players', 'ok', '照片已移除');
      });

      scope.post('/players/reorder', async (request, reply) => {
        const order = String(request.body?.order || '')
          .split(',')
          .map((v) => Number(v.trim()))
          .filter(Boolean);
        if (order.length) {
          reorderPlayers(order);
          logAudit({ actorType: 'admin', actor: actor(request), action: 'player.reorder', after: { order }, ip: clientIp(request) });
        }
        return reply.send({ ok: true });
      });

      /* ------------------------------------------------------ 密码条 ---- */
      scope.get('/codes', async (request, reply) => {
        const role = ['public', 'pro'].includes(request.query.role) ? request.query.role : null;
        const q = request.query.q ? String(request.query.q) : null;
        const codes = listCodes({ role, q });
        const db = getDb();
        const usedSlots = db
          .prepare("SELECT judge_slot FROM voting_codes WHERE role='pro' AND judge_slot IS NOT NULL ORDER BY judge_slot")
          .all()
          .map((r) => r.judge_slot);
        const judgeCount = getSettings().judgeCount;
        const validSlots = usedSlots.filter((x) => x >= 1 && x <= judgeCount);
        let nextFree = null;
        for (let i = 1; i <= judgeCount; i++) if (!validSlots.includes(i)) { nextFree = i; break; }
        const counts = {
          usedSlots: validSlots,
          outOfRangeSlots: usedSlots.filter((x) => !(x >= 1 && x <= judgeCount)),
          nextFreeSlot: nextFree,
          judgeCount,
          public: db.prepare("SELECT COUNT(*) AS c FROM voting_codes WHERE role='public'").get().c,
          pro: db.prepare("SELECT COUNT(*) AS c FROM voting_codes WHERE role='pro'").get().c,
          enabled: db.prepare('SELECT COUNT(*) AS c FROM voting_codes WHERE enabled=1').get().c,
          groupVoted: db.prepare("SELECT COUNT(DISTINCT code_id) AS c FROM votes WHERE competition='group' AND invalid=0 AND code_id IS NOT NULL").get().c,
          individualVoted: db.prepare("SELECT COUNT(DISTINCT code_id) AS c FROM votes WHERE competition='individual' AND invalid=0 AND code_id IS NOT NULL").get().c,
        };
        return view(request, reply, 'codes', {
          codes,
          role,
          q,
          counts,
          states: codeVoteStates(),
          nav: 'codes',
          judgeCount: getSettings().judgeCount,
        });
      });

      scope.post('/codes/generate', async (request, reply) => {
        const b = request.body || {};
        try {
          const created = generateCodesBulk({
            publicCount: Number(b.publicCount) || 0,
            proCount: Number(b.proCount) || 0,
            proSlotStart: Number(b.proSlotStart) || 1,
            length: Number(b.length) || 8,
            prefix: b.prefix || '',
            labelPrefixPublic: b.labelPrefixPublic || '大众评审',
            labelPrefixPro: b.labelPrefixPro || '专业评审',
            replace: b.replace === 'on' || b.replace === '1',
            note: b.note || '后台一键生成',
          });
          logAudit({
            actorType: 'admin',
            actor: actor(request),
            action: 'code.generate',
            target: `专业评审 ${created.pro.length} 条 / 大众评审 ${created.public.length} 条${b.replace ? '（先清空重建）' : '（追加）'}`,
            after: { pro: created.pro, public: created.public.slice(0, 20) },
            ip: clientIp(request),
            note: `一键生成密码条：专业 ${created.pro.length} 条、大众 ${created.public.length} 条`,
          });
          const parts = [];
          if (created.pro.length) parts.push(`专业评审 ${created.pro.length} 条`);
          if (created.public.length) parts.push(`大众评审 ${created.public.length} 条`);
          return reply.flashRedirect('/manage/codes', 'ok', `已生成 ${parts.join('、')}`);
        } catch (err) {
          return reply.flashRedirect('/manage/codes', 'error', err.message);
        }
      });

      scope.post('/codes/save', async (request, reply) => {
        const b = request.body || {};
        const id = Number(b.id) || 0;
        const code = normalizeCode(b.code);
        if (!code) return reply.flashRedirect('/manage/codes', 'error', '密码条内容不能为空');
        const role = b.role === 'pro' ? 'pro' : 'public';
        const judgeCount = getSettings().judgeCount;
        const slotRaw = b.judge_slot === '' || b.judge_slot === undefined || b.judge_slot === null ? null : Number(b.judge_slot);
        if (role === 'pro' && slotRaw !== null && (slotRaw < 1 || slotRaw > judgeCount)) {
          return reply.flashRedirect('/manage/codes', 'error', `评审席必须在 1 - ${judgeCount} 之间（超出范围的打分不会被计入成绩）`);
        }
        const payload = {
          code,
          role,
          label: b.label || null,
          judge_slot: role === 'pro' ? slotRaw : null,
          enabled: b.enabled === 'on' || b.enabled === '1' ? 1 : 0,
          note: b.note || null,
        };
        try {
          if (id) {
            const r = updateCode(id, payload);
            logAudit({ actorType: 'admin', actor: actor(request), action: 'code.update', target: `voting_codes#${id}`, before: r?.before, after: r?.after, ip: clientIp(request) });
          } else {
            const newId = createCode(payload);
            logAudit({ actorType: 'admin', actor: actor(request), action: 'code.create', target: `voting_codes#${newId}`, after: payload, ip: clientIp(request) });
          }
          return reply.flashRedirect('/manage/codes', 'ok', '密码条已保存');
        } catch (err) {
          const msg = String(err.message).includes('UNIQUE') ? '该密码条已存在，请更换' : err.message;
          return reply.flashRedirect('/manage/codes', 'error', msg);
        }
      });

      scope.post('/codes/toggle', async (request, reply) => {
        const id = Number(request.body?.id);
        const enabled = request.body?.enabled === '1' ? 1 : 0;
        setCodeEnabled(id, enabled);
        logAudit({ actorType: 'admin', actor: actor(request), action: enabled ? 'code.enable' : 'code.disable', target: `voting_codes#${id}`, ip: clientIp(request) });
        return reply.flashRedirect('/manage/codes', 'ok', enabled ? '密码条已启用' : '密码条已停用');
      });

      scope.post('/codes/delete', async (request, reply) => {
        const id = Number(request.body?.id);
        const row = deleteCode(id);
        logAudit({ actorType: 'admin', actor: actor(request), action: 'code.delete', target: `voting_codes#${id}`, before: row, ip: clientIp(request) });
        return reply.flashRedirect('/manage/codes', 'ok', '密码条已删除');
      });

      scope.post('/codes/reset', async (request, reply) => {
        const id = Number(request.body?.id);
        const competition = ['group', 'individual'].includes(request.body?.competition) ? request.body.competition : null;
        const r = resetCodeVotes({ codeId: id, competition, operator: actor(request), ip: clientIp(request) });
        return reply.flashRedirect('/manage/codes', 'ok', r.count ? `已作废 ${r.count} 条投票记录，该密码条可重新投票` : '该密码条没有投票记录');
      });

      scope.get('/codes/print', async (request, reply) => {
        const role = ['public', 'pro'].includes(request.query.role) ? request.query.role : 'public';
        const cols = Math.min(Math.max(Number(request.query.cols) || 2, 1), 3);
        const size = ['大', '中', '小'].includes(request.query.size) ? request.query.size : '中';
        const db = getDb();
        return reply.view('manage/codes_print', {
          ...app.commonData(request),
          codes: listCodes({ role, enabled: 1 }),
          role,
          cols,
          size,
          counts: {
            public: db.prepare("SELECT COUNT(*) AS c FROM voting_codes WHERE role='public' AND enabled=1").get().c,
            pro: db.prepare("SELECT COUNT(*) AS c FROM voting_codes WHERE role='pro' AND enabled=1").get().c,
          },
          forPrint: true,
        });
      });

      scope.get('/codes/export', async (request, reply) => {
        const role = ['public', 'pro'].includes(request.query.role) ? request.query.role : null;
        const wb = await buildCodesWorkbook({ role });
        const buf = await wb.xlsx.writeBuffer();
        logAudit({ actorType: 'admin', actor: actor(request), action: 'export.codes', ip: clientIp(request), note: '导出密码条清单' });
        return reply.headers(xlsxHeaders(`密码条清单-${stamp()}.xlsx`)).send(Buffer.from(buf));
      });

      /* ------------------------------------------------------ 投票数据 ---- */
      scope.get('/votes', async (request, reply) => {
        const competition = ['group', 'individual'].includes(request.query.c) ? request.query.c : 'group';
        const includeInvalid = request.query.invalid === '1';
        const source = ['self', 'manual'].includes(request.query.source) ? request.query.source : null;
        let votes = votesWithItems(competition);
        if (!includeInvalid) votes = votes.filter((v) => !v.invalid);
        if (source) votes = votes.filter((v) => v.source === source);
        votes = votes.reverse();
        const players = listPlayers({ activeOnly: false });
        const playerMap = new Map(players.map((p) => [p.id, p]));
        const codeMap = new Map(listCodes().map((c) => [c.id, c]));
        const tally = publicVotesByPlayer(competition);
        const db = getDb();
        const summary = {
          votes: db.prepare('SELECT COUNT(*) AS c FROM votes WHERE competition=? AND invalid=0').get(competition).c,
          invalid: db.prepare('SELECT COUNT(*) AS c FROM votes WHERE competition=? AND invalid=1').get(competition).c,
          scoreRows: db.prepare('SELECT COUNT(*) AS c FROM scores WHERE competition=?').get(competition).c,
          judgeSlots: db.prepare('SELECT COUNT(DISTINCT judge_slot) AS c FROM scores WHERE competition=?').get(competition).c,
          judgeCount: getSettings().judgeCount,
        };
        return view(request, reply, 'votes', {
          competition,
          summary,
          competitionName: COMPETITIONS[competition].name,
          votes,
          playerMap,
          codeMap,
          players,
          tally,
          includeInvalid,
          source,
          results: getStoredResults(competition),
          nav: 'votes',
        });
      });

      scope.post('/votes/update', async (request, reply) => {
        const b = request.body || {};
        const raw = b.player === undefined ? [] : Array.isArray(b.player) ? b.player : [b.player];
        try {
          updateVoteItems({ voteId: Number(b.voteId), playerIds: raw, operator: actor(request), ip: clientIp(request) });
          recomputeAll();
          return reply.flashRedirect(`/manage/votes?c=${b.competition || 'group'}`, 'ok', '投票内容已修改，排名已重新计算');
        } catch (err) {
          return reply.flashRedirect(`/manage/votes?c=${b.competition || 'group'}`, 'error', err.message);
        }
      });

      scope.post('/votes/invalidate', async (request, reply) => {
        const b = request.body || {};
        setVoteInvalid({ voteId: Number(b.voteId), invalid: b.invalid === '1', operator: actor(request), ip: clientIp(request), note: b.note });
        recomputeAll();
        return reply.flashRedirect(`/manage/votes?c=${b.competition || 'group'}&invalid=1`, 'ok', b.invalid === '1' ? '该投票已作废，不计入统计' : '该投票已恢复');
      });

      scope.post('/votes/delete', async (request, reply) => {
        const b = request.body || {};
        try {
          deleteVote({ voteId: Number(b.voteId), operator: actor(request), ip: clientIp(request) });
          recomputeAll();
          return reply.flashRedirect(`/manage/votes?c=${b.competition || 'group'}`, 'ok', '投票记录已彻底删除');
        } catch (err) {
          return reply.flashRedirect(`/manage/votes?c=${b.competition || 'group'}`, 'error', err.message);
        }
      });

      /* -------------------------------------------------- 打分数据 ---- */
      scope.get('/scores', async (request, reply) => {
        const competition = ['group', 'individual'].includes(request.query.c) ? request.query.c : 'group';
        const settings = getSettings();
        const players = listPlayers({ activeOnly: false });
        const rows = listScores(competition);
        const grid = new Map();
        for (const r of rows) grid.set(`${r.judge_slot}:${r.player_id}`, r);
        const codeMap = new Map(listCodes().map((c) => [c.id, c]));
        // 检查是否有"评审席超出范围"的密码条或分数（这些不会计入成绩）
        const db = getDb();
        const outOfRangeCodes = listCodes({ role: 'pro' }).filter((c) => !(c.judge_slot >= 1 && c.judge_slot <= settings.judgeCount));
        const outOfRangeScores = db
          .prepare('SELECT judge_slot, COUNT(*) AS c FROM scores WHERE judge_slot < 1 OR judge_slot > ? GROUP BY judge_slot ORDER BY judge_slot')
          .all(settings.judgeCount);
        return view(request, reply, 'scores', {
          competition,
          competitionName: COMPETITIONS[competition].name,
          players,
          grid,
          codeMap,
          judgeCount: settings.judgeCount,
          results: getStoredResults(competition),
          outOfRangeCodes,
          outOfRangeScores,
          nav: 'scores',
        });
      });

      scope.post('/scores/save', async (request, reply) => {
        const b = request.body || {};
        const competition = ['group', 'individual'].includes(b.competition) ? b.competition : 'group';
        const entries = [];
        for (const [key, value] of Object.entries(b)) {
          const m = key.match(/^s_(\d+)_(\d+)$/);
          if (!m) continue;
          if (value === '' || value === null || value === undefined) continue;
          entries.push({ judgeSlot: Number(m[1]), playerId: Number(m[2]), score: value });
        }
        try {
          setScoresBulk({ competition, entries, operator: actor(request), ip: clientIp(request), note: b.note || '后台表格录入' });
          recomputeAll();
          return reply.flashRedirect(`/manage/scores?c=${competition}`, 'ok', `已保存 ${entries.length} 个分数，排名已重新计算`);
        } catch (err) {
          return reply.flashRedirect(`/manage/scores?c=${competition}`, 'error', err.message);
        }
      });

      scope.post('/scores/repair', async (request, reply) => {
        const r = repairJudgeSlots({ operator: actor(request), ip: clientIp(request) });
        recomputeAll();
        if (!r.moves.length && !r.noSlot.length) {
          return reply.flashRedirect('/manage/scores', 'ok', '没有发现评审席错位的数据，无需修正');
        }
        const parts = [];
        if (r.moves.length) parts.push(`已把 ${r.moves.map((m) => `${m.label}（席${m.from}→席${m.to}）`).join('、')} 搬回有效评审席`);
        if (r.conflicts.length) parts.push(`${r.conflicts.length} 格因目标评审席已有同选手分数未迁移`);
        if (r.noSlot.length) parts.push(`${r.noSlot.join('、')} 没有空闲评审席可分配，请先删除多余的专业评审密码条`);
        return reply.flashRedirect('/manage/scores', 'ok', parts.join('；'));
      });

      scope.post('/scores/clear', async (request, reply) => {
        const b = request.body || {};
        const competition = ['group', 'individual'].includes(b.competition) ? b.competition : 'group';
        clearScore({ competition, judgeSlot: Number(b.judgeSlot), playerId: Number(b.playerId), operator: actor(request), ip: clientIp(request) });
        recomputeAll();
        return reply.flashRedirect(`/manage/scores?c=${competition}`, 'ok', '该分数已清空（视为未评）');
      });

      /* -------------------------------------------------- 手动赋分 ---- */
      scope.get('/manual', async (request, reply) => {
        const competition = ['group', 'individual'].includes(request.query.c) ? request.query.c : 'group';
        const settings = getSettings();
        return view(request, reply, 'manual', {
          competition,
          competitionName: COMPETITIONS[competition].name,
          players: listPlayers({ activeOnly: true }),
          judgeCount: settings.judgeCount,
          results: getStoredResults(competition),
          tally: publicVotesByPlayer(competition),
          nav: 'manual',
        });
      });

      /** 预览接口：返回变更前后的排名对比（不写库） */
      scope.post('/manual/preview', async (request, reply) => {
        const b = request.body || {};
        const competition = ['group', 'individual'].includes(b.competition) ? b.competition : 'group';
        try {
          const before = computeAllOnly();
          let after;
          if (b.kind === 'bulk') {
            const after2 = simulate({ competition, extraVotes: { [Number(b.playerId)]: Number(b.count) || 0 } });
            after = { group: after2.group, individual: after2.individual, final: after2.final };
          } else if (b.kind === 'scores') {
            const entries = [];
            for (const [key, value] of Object.entries(b)) {
              const m = key.match(/^s_(\d+)_(\d+)$/);
              if (m && value !== '' && value !== null && value !== undefined) {
                entries.push({ judgeSlot: Number(m[1]), playerId: Number(m[2]), score: value });
              }
            }
            const after2 = simulate({ competition, scoreOverrides: entries });
            after = { group: after2.group, individual: after2.individual, final: after2.final };
          } else {
            const ids = (Array.isArray(b.player) ? b.player : [b.player]).filter(Boolean).map(Number);
            const extraVotes = {};
            for (const id of ids) extraVotes[id] = (extraVotes[id] || 0) + 1;
            const after2 = simulate({ competition, extraVotes });
            after = { group: after2.group, individual: after2.individual, final: after2.final };
          }
          return reply.send({
            ok: true,
            competition,
            withFinal: b.view === 'final',
            rows: buildDiff(before, after, competition, b.view === 'final'),
          });
        } catch (err) {
          return reply.code(400).send({ ok: false, error: err.message });
        }
      });

      scope.post('/manual/apply', async (request, reply) => {
        const b = request.body || {};
        const competition = ['group', 'individual'].includes(b.competition) ? b.competition : 'group';
        const back = `/manage/manual?c=${competition}`;
        try {
          if (b.kind === 'bulk') {
            const r = addManualVotesForPlayer({
              competition,
              playerId: Number(b.playerId),
              count: Number(b.count),
              note: b.note,
              operator: actor(request),
              ip: clientIp(request),
            });
            recomputeAll();
            return reply.flashRedirect(back, 'ok', `已为选手补 ${r.count} 票，排名已重新计算`);
          }
          if (b.kind === 'scores') {
            const entries = [];
            for (const [key, value] of Object.entries(b)) {
              const m = key.match(/^s_(\d+)_(\d+)$/);
              if (m && value !== '' && value !== null && value !== undefined) {
                entries.push({ judgeSlot: Number(m[1]), playerId: Number(m[2]), score: value });
              }
            }
            const r = setScoresBulk({ competition, entries, operator: actor(request), ip: clientIp(request), note: b.note || '手动赋分页录入' });
            recomputeAll();
            return reply.flashRedirect(back, 'ok', `已保存 ${r.count} 个分数，排名已重新计算`);
          }
          const ids = (Array.isArray(b.player) ? b.player : [b.player]).filter(Boolean);
          const r = addManualVote({ competition, playerIds: ids, note: b.note, operator: actor(request), ip: clientIp(request) });
          recomputeAll();
          return reply.flashRedirect(back, 'ok', `已手动新增 1 条投票（记录 #${r.voteId}），排名已重新计算`);
        } catch (err) {
          return reply.flashRedirect(back, 'error', err.message);
        }
      });

      /* -------------------------------------------------- 赛程开关 ---- */
      scope.get('/schedule', async (request, reply) => {
        const settings = getSettings();
        // 入口地址按当前访问的域名动态生成（此前写死为某一台服务器的 IP）
        const host = String(request.headers.host || 'localhost');
        const proto = String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        return view(request, reply, 'schedule', {
          groupStatus: competitionStatus('group', settings),
          individualStatus: competitionStatus('individual', settings),
          isoToLocalInput,
          baseUrl: `${proto}://${host}`,
          nav: 'schedule',
        });
      });

      scope.post('/schedule/save', async (request, reply) => {
        const b = request.body || {};
        const before = getSettings();
        const map = {
          group_enabled: b.group_enabled === 'on' || b.group_enabled === '1' ? '1' : '0',
          group_start_at: localToIso(b.group_start_at) || '',
          group_end_at: localToIso(b.group_end_at) || '',
          individual_enabled: b.individual_enabled === 'on' || b.individual_enabled === '1' ? '1' : '0',
          individual_start_at: localToIso(b.individual_start_at) || '',
          individual_end_at: localToIso(b.individual_end_at) || '',
        };
        for (const [k, v] of Object.entries(map)) setSetting(k, v);
        logAudit({
          actorType: 'admin',
          actor: actor(request),
          action: 'schedule.save',
          target: 'settings',
          before: Object.fromEntries(Object.keys(map).map((k) => [k, before[k]])),
          after: map,
          ip: clientIp(request),
          note: '保存赛程与开关',
        });
        return reply.flashRedirect('/manage/schedule', 'ok', '赛程与开关已保存（截止后系统自动锁定并统计）');
      });

      scope.post('/schedule/toggle', async (request, reply) => {
        const b = request.body || {};
        const competition = b.competition === 'individual' ? 'individual' : 'group';
        const action = b.action;
        const keyEnabled = competition === 'group' ? 'group_enabled' : 'individual_enabled';
        const keyEnd = competition === 'group' ? 'group_end_at' : 'individual_end_at';
        const keyStart = competition === 'group' ? 'group_start_at' : 'individual_start_at';
        const before = { [keyEnabled]: getSettings()[keyEnabled], [keyEnd]: getSettings()[keyEnd] };
        if (action === 'open') {
          setSetting(keyEnabled, '1');
          if (getSettings()[keyStart] && new Date(getSettings()[keyStart]).getTime() > Date.now()) setSetting(keyStart, '');
        } else if (action === 'close') {
          setSetting(keyEnabled, '0');
          setSetting(keyEnd, nowIso());
        } else if (action === 'clear_end') {
          setSetting(keyEnd, '');
        } else if (action === 'reopen') {
          setSetting(keyEnabled, '1');
          setSetting(keyEnd, '');
        }
        logAudit({
          actorType: 'admin',
          actor: actor(request),
          action: `schedule.${action}`,
          target: competition,
          before,
          after: { [keyEnabled]: getSettings()[keyEnabled], [keyEnd]: getSettings()[keyEnd] },
          ip: clientIp(request),
          note: { open: '开启投票', close: '截止投票', clear_end: '清除截止时间', reopen: '重新开启投票' }[action] || action,
        });
        recomputeAll();
        const label = { open: '已开启投票', close: '已截止投票并完成统计', clear_end: '已清除截止时间', reopen: '已重新开启投票' }[action] || '操作完成';
        return reply.flashRedirect('/manage/schedule', 'ok', `${COMPETITIONS[competition].name}${label}`);
      });

      /* -------------------------------------------- 结果与重算 ---- */
      scope.get('/results', async (request, reply) => {
        const settings = getSettings();
        return view(request, reply, 'results', {
          group: getStoredResults('group'),
          individual: getStoredResults('individual'),
          final: getStoredFinal(),
          rules: explainRules(settings),
          tieLabel: TIE_BREAK_LABEL[settings.final_tie_break] || settings.final_tie_break,
          nav: 'results',
        });
      });

      scope.post('/recalc', async (request, reply) => {
        const r = recomputeAll();
        logAudit({ actorType: 'admin', actor: actor(request), action: 'result.recalc', ip: clientIp(request), note: '手动触发全量重算' });
        return reply.flashRedirect(request.body?.back || '/manage/results', 'ok', `已完成重算：小组赛 ${r.group.rows.length} 人，个人赛 ${r.individual.rows.length} 人，总排名 ${r.final.rows.length} 人`);
      });

      /* ------------------------------------------ 排名公示榜（后台预览）---- */
      scope.get('/board', async (request, reply) => {
        const { renderBoard } = await import('./routes-public.js');
        return renderBoard(request, reply, app, getSettings(), '/manage/board');
      });

      /* -------------------------------------------------- 数据清空 ---- */
      scope.get('/reset', async (request, reply) => {
        const stats = dashboardStats();
        return view(request, reply, 'reset', {
          stats,
          nav: 'reset',
          counts: {
            groupVotes: getDb().prepare("SELECT COUNT(*) AS c FROM votes WHERE competition='group'").get().c,
            individualVotes: getDb().prepare("SELECT COUNT(*) AS c FROM votes WHERE competition='individual'").get().c,
            groupScores: getDb().prepare("SELECT COUNT(*) AS c FROM scores WHERE competition='group'").get().c,
            individualScores: getDb().prepare("SELECT COUNT(*) AS c FROM scores WHERE competition='individual'").get().c,
            audit: countAudit(),
          },
        });
      });

      scope.post('/reset/apply', async (request, reply) => {
        const b = request.body || {};
        const scopes = {
          groupVotes: b.groupVotes === 'on' || b.groupVotes === '1',
          individualVotes: b.individualVotes === 'on' || b.individualVotes === '1',
          groupScores: b.groupScores === 'on' || b.groupScores === '1',
          individualScores: b.individualScores === 'on' || b.individualScores === '1',
        };
        const clearAudit = b.clearAudit === 'on' || b.clearAudit === '1';
        // 二次确认：必须输入当前管理员密码
        if (!verifyAdminPassword(request.user.id, b.password)) {
          logAudit({
            actorType: 'admin',
            actor: actor(request),
            action: 'data.clear.failed',
            ip: clientIp(request),
            note: '一键清空数据：密码校验未通过',
          });
          return reply.flashRedirect('/manage/reset', 'error', '密码不正确，未执行任何清空操作');
        }
        try {
          const r = clearData({ scopes, clearAudit, operator: actor(request), ip: clientIp(request) });
          recomputeAll();
          const parts = [];
          if (r.removed.votes) parts.push(`投票 ${r.removed.votes} 条`);
          if (r.removed.scores) parts.push(`打分 ${r.removed.scores} 条`);
          if (r.removed.audit) parts.push(`操作日志 ${r.removed.audit} 条`);
          return reply.flashRedirect('/manage/reset', 'ok', parts.length ? `已清空：${parts.join('、')}，排名已重置` : '没有需要清空的数据');
        } catch (err) {
          return reply.flashRedirect('/manage/reset', 'error', err.message);
        }
      });

      /* -------------------------------------------------- 导出中心 ---- */
      scope.get('/export', async (request, reply) => {
        const stats = dashboardStats();
        return view(request, reply, 'export', { stats, nav: 'export' });
      });

      scope.get('/export/full', async (request, reply) => {
        const wb = await buildFullWorkbook({ operator: actor(request) });
        const buf = await wb.xlsx.writeBuffer();
        logAudit({ actorType: 'admin', actor: actor(request), action: 'export.full', ip: clientIp(request), note: '导出全量数据与计分过程' });
        return reply.headers(xlsxHeaders(`主持人大赛投票-全量数据与计分过程-${stamp()}.xlsx`)).send(Buffer.from(buf));
      });

      scope.get('/export/rank', async (request, reply) => {
        const wb = await buildRankWorkbook({ operator: actor(request) });
        const buf = await wb.xlsx.writeBuffer();
        logAudit({ actorType: 'admin', actor: actor(request), action: 'export.rank', ip: clientIp(request), note: '导出仅排名表' });
        return reply.headers(xlsxHeaders(`主持人大赛-最终排名-${stamp()}.xlsx`)).send(Buffer.from(buf));
      });

      /* -------------------------------------------------- 操作日志 ---- */
      scope.get('/audit', async (request, reply) => {
        const page = Math.max(1, Number(request.query.page) || 1);
        const perPage = 100;
        const action = request.query.action ? String(request.query.action) : null;
        const q = request.query.q ? String(request.query.q) : null;
        const logs = listAudit({ limit: perPage, offset: (page - 1) * perPage, action, q });
        return view(request, reply, 'audit', {
          logs,
          page,
          perPage,
          total: countAudit(),
          action,
          q,
          nav: 'audit',
        });
      });

      scope.get('/audit/export', async (request, reply) => {
        const wb = await buildFullWorkbook({ operator: actor(request) });
        const buf = await wb.xlsx.writeBuffer();
        logAudit({ actorType: 'admin', actor: actor(request), action: 'export.audit', ip: clientIp(request), note: '导出含操作日志的全量数据' });
        return reply.headers(xlsxHeaders(`主持人大赛-含操作日志-${stamp()}.xlsx`)).send(Buffer.from(buf));
      });

      /* -------------------------------------------------- 系统设置 ---- */
      scope.get('/settings', async (request, reply) => {
        const st = getSettings();
        return view(request, reply, 'settings', {
          settings: st,
          weightSum: Math.round((st.weightGroup + st.weightIndividual) * 1000) / 1000,
          admins: listAdmins(),
          nav: 'settings',
          currentAdminId: request.user.id,
        });
      });

      const SETTING_KEYS = [
        'event_title', 'event_subtitle', 'footer_note',
        'public_pick_count', 'top_points', 'zero_vote_points', 'tie_rank_rule',
        'judge_count', 'missing_judge_rule', 'pro_can_edit',
        'weight_group', 'weight_individual', 'score_cap', 'score_decimals', 'final_tie_break',
        'theme_color', 'accent_color', 'board_public',
        'login_rate_max', 'login_rate_window_minutes',
        'admin_max_fails', 'admin_lock_minutes', 'session_hours',
      ];
      const CHECKBOX_KEYS = new Set(['pro_can_edit', 'board_public']);

      scope.post('/settings/save', async (request, reply) => {
        const b = request.body || {};
        const before = getSettings();
        const changed = {};
        // 完整表单会带 __settings_form 标记：此时「复选框未出现在请求中」表示未勾选；
        // 而只提交部分字段的接口式调用则保持其余设置不变，避免误清空开关类设置。
        const fullForm = b.__settings_form === '1';
        for (const key of SETTING_KEYS) {
          const present = Object.prototype.hasOwnProperty.call(b, key);
          let value;
          if (CHECKBOX_KEYS.has(key)) {
            if (!present && !fullForm) continue;
            value = present && (b[key] === 'on' || b[key] === '1') ? '1' : '0';
          } else {
            if (!present) continue;
            value = String(b[key]);
            if (key === 'weight_group' || key === 'weight_individual') {
              const num = Number(value);
              if (!Number.isFinite(num) || num < 0 || num > 1) {
                return reply.flashRedirect('/manage/settings', 'error', '权重需为 0-1 之间的小数（如 0.4 / 0.6）');
              }
            }
          }
          if (String(before[key] ?? '') !== String(value ?? '')) changed[key] = value;
        }
        for (const [k, v] of Object.entries(changed)) setSetting(k, v);
        logAudit({
          actorType: 'admin',
          actor: actor(request),
          action: 'settings.save',
          target: 'settings',
          before: Object.fromEntries(Object.keys(changed).map((k) => [k, before[k]])),
          after: changed,
          ip: clientIp(request),
          note: `修改系统设置 ${Object.keys(changed).length} 项`,
        });
        recomputeAll();
        return reply.flashRedirect('/manage/settings', 'ok', `设置已保存${Object.keys(changed).length ? `（变更 ${Object.keys(changed).length} 项，已重新计算排名）` : ''}`);
      });

      scope.post('/settings/password', async (request, reply) => {
        const b = request.body || {};
        const admin = getAdmin(request.user.id);
        if (!bcrypt.compareSync(String(b.current || ''), admin.password_hash)) {
          return reply.flashRedirect('/manage/settings', 'error', '当前密码不正确');
        }
        const next = String(b.next || '');
        if (next.length < 6) return reply.flashRedirect('/manage/settings', 'error', '新密码至少 6 位');
        if (next !== String(b.confirm || '')) return reply.flashRedirect('/manage/settings', 'error', '两次输入的新密码不一致');
        updateAdminPassword(admin.id, bcrypt.hashSync(next, 10));
        logAudit({ actorType: 'admin', actor: admin.username, action: 'admin.password.change', target: `admins#${admin.id}`, ip: clientIp(request), note: '修改本账号密码' });
        return reply.flashRedirect('/manage/settings', 'ok', '密码已修改');
      });

      scope.post('/settings/admins/create', async (request, reply) => {
        const b = request.body || {};
        const username = String(b.username || '').trim();
        const password = String(b.password || '') || randomPassword(12);
        if (!username) return reply.flashRedirect('/manage/settings', 'error', '请填写账号');
        if (password.length < 6) return reply.flashRedirect('/manage/settings', 'error', '密码至少 6 位');
        try {
          const id = createAdmin({ username, passwordHash: bcrypt.hashSync(password, 10), note: b.note || null });
          logAudit({ actorType: 'admin', actor: actor(request), action: 'admin.create', target: `admins#${id}`, after: { username }, ip: clientIp(request), note: '新增管理员' });
          return reply.flashRedirect('/manage/settings', 'ok', `管理员 ${username} 已创建${b.password ? '' : `，自动生成密码：${password}（请立即记录）`}`);
        } catch (err) {
          const msg = String(err.message).includes('UNIQUE') ? '该账号已存在' : err.message;
          return reply.flashRedirect('/manage/settings', 'error', msg);
        }
      });

      scope.post('/settings/admins/delete', async (request, reply) => {
        const id = Number(request.body?.id);
        if (id === request.user.id) return reply.flashRedirect('/manage/settings', 'error', '不能删除当前登录的账号');
        const all = listAdmins();
        if (all.length <= 1) return reply.flashRedirect('/manage/settings', 'error', '至少需要保留一个管理员账号');
        deleteAdmin(id);
        logAudit({ actorType: 'admin', actor: actor(request), action: 'admin.delete', target: `admins#${id}`, ip: clientIp(request), note: '删除管理员' });
        return reply.flashRedirect('/manage/settings', 'ok', '管理员已删除');
      });

      scope.post('/settings/admins/unlock', async (request, reply) => {
        const id = Number(request.body?.id);
        unlockAdmin(id);
        logAudit({ actorType: 'admin', actor: actor(request), action: 'admin.unlock', target: `admins#${id}`, ip: clientIp(request), note: '解除账号锁定' });
        return reply.flashRedirect('/manage/settings', 'ok', '已解除锁定并清零失败次数');
      });

      scope.post('/settings/admins/password', async (request, reply) => {
        const b = request.body || {};
        const id = Number(b.id);
        const password = String(b.password || '');
        if (password.length < 6) return reply.flashRedirect('/manage/settings', 'error', '密码至少 6 位');
        updateAdminPassword(id, bcrypt.hashSync(password, 10));
        logAudit({ actorType: 'admin', actor: actor(request), action: 'admin.password.reset', target: `admins#${id}`, ip: clientIp(request), note: '重置管理员密码' });
        return reply.flashRedirect('/manage/settings', 'ok', '已重置该管理员密码');
      });
    },
    { prefix: '/manage' }
  );
}
