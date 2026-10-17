/**
 * 前台路由：两个投票入口（小组赛 / 个人赛）、密码条登录、排名公示榜。
 * 普通用户仅能从这里进入系统，页面中不出现任何后台入口。
 */
import { getSettings, getDb } from './db.js';
import { issueSession, dropSession, loginWithCode, rateLimit } from './auth.js';
import {
  listPlayers,
  competitionStatus,
  logAudit,
  codeVoteState,
  validVotes,
  getStoredResults,
  getStoredFinal,
  recomputeAll,
} from './repo.js';
import { submitPublicVote, submitProScores } from './services.js';
import { COMPETITIONS, isCompetition } from './config.js';
import { normalizeCode, fmtLocal, humanRemain } from './util.js';

const ERR_LABEL = {
  closed: '本场投票尚未开启',
  pending: '本场投票尚未开始',
  ended: '本场投票已经截止，感谢您的参与',
};

function clientIp(request) {
  return (request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.ip;
}

/** 投票页所需的公共上下文 */
function ballotContext(request, competition) {
  const settings = getSettings();
  const players = listPlayers({ activeOnly: true });
  const user = request.user;
  let existingVote = null;
  let myScores = {};
  if (user?.type === 'code') {
    if (user.role === 'public') {
      const row = getDb()
        .prepare('SELECT id FROM votes WHERE competition = ? AND code_id = ? AND invalid = 0')
        .get(competition, user.codeId);
      if (row) existingVote = row.id;
    } else if (user.judgeSlot) {
      const rows = getDb()
        .prepare('SELECT player_id, score FROM scores WHERE competition = ? AND judge_slot = ?')
        .all(competition, user.judgeSlot);
      for (const r of rows) myScores[r.player_id] = r.score;
    }
  }
  return {
    settings,
    players,
    competition,
    competitionName: COMPETITIONS[competition].name,
    status: competitionStatus(competition, settings),
    existingVote,
    myScores,
    alreadyVoted: existingVote !== null,
    error: null,
  };
}

export async function registerPublicRoutes(app) {
  const S = (request) => getSettings();

  /* ------------------------------------------------------------ 首页 ----
   * 刻意不提供「入口选择页」：两个投票部分彼此不可见，避免现场选手在
   * 小组赛/个人赛之间互相串场。根路径直接返回 404。
   * （notFoundHandler 统一处理，此处不注册路由。）
   */

  /* ---------------------------------------------------- 投票入口页 ---- */
  app.get('/vote/:competition', async (request, reply) => {
    const competition = String(request.params.competition);
    if (!isCompetition(competition)) return reply.code(404).view('error', { title: '入口不存在', message: '投票入口不存在', status: 404, backUrl: '/' });

    const settings = S(request);
    const user = request.user;
    const status = competitionStatus(competition, settings);

    // 未登录 → 密码条登录页
    if (!user || user.type !== 'code') {
      return reply.view('login', {
        ...app.commonData(request),
        competition,
        competitionName: COMPETITIONS[competition].name,
        status,
        loginError: request.query.err ? decodeURIComponent(request.query.err) : null,
      });
    }

    if (!user.enabled) {
      dropSession(request, reply);
      return reply.view('login', {
        ...app.commonData(request),
        competition,
        competitionName: COMPETITIONS[competition].name,
        status,
        loginError: '该密码条已被停用，请联系现场工作人员',
      });
    }

    const ctx = ballotContext(request, competition);

    // 赛事不可投时展示状态页（专业评审即便截止也可查看自己的分数）
    if (!status.open && user.role === 'public') {
      return reply.view('status', {
        ...app.commonData(request),
        competition,
        competitionName: COMPETITIONS[competition].name,
        status,
        roleLabel: '大众评审',
      });
    }

    if (user.role === 'pro') {
      return reply.view('score', {
        ...app.commonData(request),
        ...ctx,
        roleLabel: '专业评审',
        judgeSlot: user.judgeSlot,
        canEdit: settings.proCanEdit || Object.keys(ctx.myScores).length === 0,
        closed: !status.open,
      });
    }

    return reply.view('vote', {
      ...app.commonData(request),
      ...ctx,
      roleLabel: '大众评审',
      pickCount: settings.publicPickCount,
      error: request.query.err ? decodeURIComponent(request.query.err) : null,
    });
  });

  /* ---------------------------------------------------- 密码条登录 ---- */
  app.post('/vote/login', async (request, reply) => {
    const body = request.body || {};
    const competition = isCompetition(body.competition) ? body.competition : 'group';
    const ip = clientIp(request);
    const ua = String(request.headers['user-agent'] || '').slice(0, 300);

    const s = S(request);
    const limited = rateLimit(`code-login:${ip}`, s.loginRateMax, s.loginRateWindowMs);
    if (!limited.ok) {
      return reply.view('login', {
        ...app.commonData(request),
        competition,
        competitionName: COMPETITIONS[competition].name,
        status: competitionStatus(competition, S(request)),
        loginError: '操作过于频繁，请稍候再试',
      });
    }

    const result = loginWithCode({ code: body.code, ip, ua });
    if (!result.ok) {
      logAudit({ actorType: 'code', actor: normalizeCode(body.code).slice(0, 4) + '****', action: 'code.login.failed', ip, note: result.error });
      return reply.view('login', {
        ...app.commonData(request),
        competition,
        competitionName: COMPETITIONS[competition].name,
        status: competitionStatus(competition, S(request)),
        loginError: result.error,
      });
    }

    issueSession(reply, {
      role: 'code',
      codeId: result.code.id,
      label: result.code.label || result.code.code,
      ip,
      ua,
    });
    logAudit({
      actorType: 'code',
      actor: result.code.label || result.code.code,
      action: 'code.login',
      target: `voting_codes#${result.code.id}`,
      ip,
      note: `密码条登录（${result.code.role === 'pro' ? '专业评审' : '大众评审'}）`,
    });
    return reply.redirect(`/vote/${competition}`);
  });

  /* ------------------------------------------------------ 提交投票 ---- */
  app.post('/vote/submit', async (request, reply) => {
    const body = request.body || {};
    const competition = isCompetition(body.competition) ? body.competition : 'group';
    const ip = clientIp(request);
    if (!request.user || request.user.type !== 'code') return reply.redirect(`/vote/${competition}`);

    const raw = body.player === undefined ? [] : Array.isArray(body.player) ? body.player : [body.player];
    const codeRow = getDb().prepare('SELECT * FROM voting_codes WHERE id = ?').get(request.user.codeId);

    try {
      await submitPublicVote({
        competition,
        code: codeRow,
        playerIds: raw,
        ip,
        ua: String(request.headers['user-agent'] || '').slice(0, 300),
      });
      // 立即重算，保证后台看板与公示榜实时反映最新票数
      recomputeAll();
      return reply.redirect(`/vote/done?c=${competition}`);
    } catch (err) {
      const ctx = ballotContext(request, competition);
      return reply
        .code(err.code === 'ROLE' || err.code === 'DISABLED' ? 403 : 400)
        .view('vote', {
          ...app.commonData(request),
          ...ctx,
          roleLabel: '大众评审',
          pickCount: S(request).publicPickCount,
          error: err.message,
          selectedIds: raw.map(Number),
        });
    }
  });

  /* -------------------------------------------------- 提交评审打分 ---- */
  app.post('/vote/score', async (request, reply) => {
    const body = request.body || {};
    const competition = isCompetition(body.competition) ? body.competition : 'group';
    const ip = clientIp(request);
    if (!request.user || request.user.type !== 'code') return reply.redirect(`/vote/${competition}`);

    const players = listPlayers({ activeOnly: true });
    const scores = {};
    for (const p of players) scores[p.id] = body[`score_${p.id}`];

    const codeRow = getDb().prepare('SELECT * FROM voting_codes WHERE id = ?').get(request.user.codeId);
    try {
      const res = await submitProScores({
        competition,
        code: codeRow,
        scores,
        ip,
        ua: String(request.headers['user-agent'] || '').slice(0, 300),
      });
      recomputeAll();
      return reply.redirect(`/vote/done?c=${competition}&updated=${res.updated ? 1 : 0}`);
    } catch (err) {
      const ctx = ballotContext(request, competition);
      return reply
        .code(err.code === 'ROLE' || err.code === 'DISABLED' ? 403 : 400)
        .view('score', {
          ...app.commonData(request),
          ...ctx,
          roleLabel: '专业评审',
          judgeSlot: request.user.judgeSlot,
          canEdit: true,
          closed: false,
          error: err.message,
          draftScores: Object.fromEntries(players.map((p) => [p.id, body[`score_${p.id}`] ?? ''])),
        });
    }
  });

  /* ------------------------------------------------------ 完成页面 ---- */
  app.get('/vote/done', async (request, reply) => {
    const competition = isCompetition(request.query.c) ? request.query.c : 'group';
    return reply.view('done', {
      ...app.commonData(request),
      competition,
      competitionName: COMPETITIONS[competition].name,
      updated: request.query.updated === '1',
      role: request.user?.role || 'public',
    });
  });

  /* -------------------------------------------------------- 退出 ----
   * 退出后展示中性的结束页，不提供任何通往某个投票部分的链接。
   */
  app.get('/logout', async (request, reply) => {
    dropSession(request, reply);
    return reply.view('loggedout', { ...app.commonData(request) });
  });

  /* ---------------------------------------------------- 公示排名榜 ----
   * 严格由「系统设置 → 向公众开放排名公示榜」控制，**不区分身份**：
   * 未开启时任何人（含已登录的管理员）访问 /board 都返回 403。
   * 管理员需要预览/投屏时走后台专用的 /manage/board。
   */
  app.get('/board', async (request, reply) => {
    const settings = S(request);
    if (!settings.boardPublic) {
      return reply.code(403).view('error', {
        title: '排名公示榜未开放',
        message: '该页面尚未开放。如需查看排名，请登录后台在「结果与排名」中查看；如需对外公示，请到「系统设置」勾选「向公众开放排名公示榜」。',
        status: 403,
        backUrl: request.user?.type === 'admin' ? '/manage' : null,
      });
    }
    return renderBoard(request, reply, app, settings);
  });
}

/** 渲染公示榜（/board 与后台预览 /manage/board 共用） */
export function renderBoard(request, reply, app, settings = getSettings(), basePath = '/board') {
  const which = ['group', 'individual', 'final'].includes(request.query.c) ? request.query.c : 'final';
  return reply.view('board', {
    ...app.commonData(request),
    which,
    boardBase: basePath,
    boardPreview: basePath !== '/board',
    group: getStoredResults('group'),
    individual: getStoredResults('individual'),
    final: getStoredFinal(),
  });
}
