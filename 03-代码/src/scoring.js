/**
 * 计分引擎 —— 纯函数、无副作用、可单元测试。
 *
 * 小组赛 / 个人赛规则完全一致，且各自独立调用本引擎，数据天然隔离：
 *   赛事得分 = 专业评审平均分(0-100) + 大众评审赋分(第1名10分…第10名1分)，上限 110 分
 * 最终总成绩 = 小组赛得分 × 40% + 个人赛得分 × 60%
 *
 * 所有中间量（原始票数、原始排名、赋分、每位评审原始打分、有效评审数、平均分、封顶前后分数）
 * 都会随结果一起返回，供后台展示与 Excel「处理过程」导出使用 —— 保证结果可复核。
 */
import { round } from './util.js';

/**
 * 标准竞赛排名（并列取最优名次，后续名次跳过）：票数 9,9,7,6 → 名次 1,1,3,4
 * @param {Array<{playerId:number, votes:number}>} entries
 * @returns {Array<{playerId:number, votes:number, rank:number, tiedWith:number[]}>}
 */
export function buildPublicRanking(entries, tieRule = 'best') {
  const sorted = [...entries].sort((a, b) => b.votes - a.votes || a.playerId - b.playerId);
  const out = [];
  let lastVotes = null;
  let lastRank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    let rank;
    if (lastVotes !== null && cur.votes === lastVotes) {
      // 并列：取最优名次（tieRule='best'，即与上一个相同者同名次）
      rank = tieRule === 'average' ? null : lastRank;
    } else {
      rank = i + 1;
      lastRank = rank;
      lastVotes = cur.votes;
    }
    out.push({ playerId: cur.playerId, votes: cur.votes, rank });
  }
  if (tieRule === 'average') {
    // 备选规则：并列者取平均名次（默认不启用，保留可切换）
    const groups = new Map();
    for (const row of out) {
      const key = row.votes;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const [, rows] of groups) {
      const avg = rows.reduce((s, r) => s + (r._seq = rows.indexOf(r) + 1), 0) / rows.length;
      const ranks = rows.map((r) => out.indexOf(r) + 1);
      const mean = ranks.reduce((s, v) => s + v, 0) / ranks.length;
      rows.forEach((r) => (r.rank = round(mean, 4) || avg));
    }
  }
  // 标记并列组
  const byVotes = new Map();
  for (const row of out) {
    if (!byVotes.has(row.votes)) byVotes.set(row.votes, []);
    byVotes.get(row.votes).push(row.playerId);
  }
  for (const row of out) row.tiedWith = byVotes.get(row.votes).filter((id) => id !== row.playerId);
  return out;
}

/**
 * 名次 → 大众评审赋分。第 1 名 10 分，第 2 名 9 分 …… 第 10 名 1 分。
 * 未获任何票 → zeroVotePoints（默认 0 分）。
 */
export function pointsForRank(rank, { topPoints = 10, zeroVotePoints = 0, votes = null } = {}) {
  if (votes !== null && votes !== undefined && votes <= 0) return zeroVotePoints;
  if (!rank || rank < 1) return zeroVotePoints;
  const points = topPoints - rank + 1;
  return points > 0 ? points : 0;
}

/**
 * 专业评审平均分。
 * @param {number[]} scores 该选手各评审席得分（缺失为 null/undefined）
 * @param {{judgeCount:number, rule:'submitted'|'all'}} opts
 */
export function proAverage(scores, { judgeCount = 4, rule = 'submitted' } = {}) {
  const valid = scores.filter((s) => s !== null && s !== undefined && !Number.isNaN(Number(s)));
  const sum = valid.reduce((s, v) => s + Number(v), 0);
  if (rule === 'all') {
    // 缺评按 0 分计入，再除以评审总人数
    return { sum, submitted: valid.length, divisor: judgeCount, avg: judgeCount > 0 ? sum / judgeCount : 0 };
  }
  // 按实际提交人数求平均
  return { sum, submitted: valid.length, divisor: valid.length, avg: valid.length > 0 ? sum / valid.length : 0 };
}

/**
 * 计算一个赛事的完整结果。
 *
 * @param {Object} input
 * @param {Array<{id:number,no:number,name:string,photo?:string}>} input.players 参赛选手（启用中）
 * @param {Map<number, number>|Object} input.votesByPlayer 选手ID → 有效大众票数
 * @param {Map<number, Map<number, number>>|Object} input.judgeScores 评审席 → (选手ID → 分数)
 * @param {Object} input.opts { topPoints, zeroVotePoints, judgeCount, missingJudgeRule, scoreCap, decimals, tieRankRule }
 */
export function computeCompetition({ players, votesByPlayer, judgeScores, opts = {} }) {
  const {
    topPoints = 10,
    zeroVotePoints = 0,
    judgeCount = 4,
    missingJudgeRule = 'submitted',
    scoreCap = 110,
    decimals = 2,
    tieRankRule = 'best',
  } = opts;

  const voteMap = toMap(votesByPlayer, (v) => Number(v) || 0);
  const scoreMap = toNestedMap(judgeScores);

  const entries = players.map((p) => ({ playerId: p.id, votes: voteMap.get(p.id) || 0 }));
  const ranking = buildPublicRanking(entries, tieRankRule);
  const rankByPlayer = new Map(ranking.map((r) => [r.playerId, r]));

  const judgeSlots = Array.from({ length: judgeCount }, (_, i) => i + 1);
  const totalBallots = sumValues(voteMap);
  const hasAnyJudgeScore = [...scoreMap.values()].some((m) => m.size > 0);
  // 全场没有任何投票时，「大众评审排名」尚无意义 —— 显示为空而不是全部并列第 1 名
  const noVotesYet = totalBallots === 0;

  const rows = players.map((p) => {
    const rk = rankByPlayer.get(p.id) || { votes: 0, rank: null, tiedWith: [] };
    const judgeScoresArr = judgeSlots.map((slot) => {
      const v = scoreMap.get(slot)?.get(p.id);
      if (v === undefined || v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      // 兜底：百分制分数一律按 0-100 计（应用层已校验，这里防止绕过校验的脏数据算出异常平均分）
      return Math.min(100, Math.max(0, n));
    });
    const points = noVotesYet ? zeroVotePoints : pointsForRank(rk.rank, { topPoints, zeroVotePoints, votes: rk.votes });
    const pro = proAverage(judgeScoresArr, { judgeCount, rule: missingJudgeRule });
    const proAvg = round(pro.avg, decimals);
    const rawScore = round(proAvg + points, decimals);
    const finalScore = round(Math.min(rawScore, scoreCap), decimals);
    return {
      playerId: p.id,
      no: p.no,
      name: p.name,
      photo: p.photo || null,
      publicVotes: rk.votes,
      publicRank: noVotesYet ? null : rk.rank,
      publicRankTied: rk.tiedWith || [],
      publicPoints: points,
      judgeScores: judgeSlots.map((slot, i) => ({ slot, score: judgeScoresArr[i] })),
      judgeSubmitted: pro.submitted,
      judgeDivisor: pro.divisor,
      judgeSum: round(pro.sum, decimals),
      proAvg,
      rawScore,
      finalScore,
      capped: rawScore > scoreCap,
    };
  });

  const rowsByScore = [...rows].sort(
    (a, b) => b.finalScore - a.finalScore || b.proAvg - a.proAvg || a.no - b.no
  );

  const submittedSlots = judgeSlots.filter((slot) => (scoreMap.get(slot)?.size || 0) > 0);

  return {
    rows,
    rowsByScore,
    meta: {
      judgeCount,
      judgeSlots,
      submittedSlots,
      submittedJudgeCount: submittedSlots.length,
      topPoints,
      zeroVotePoints,
      scoreCap,
      decimals,
      missingJudgeRule,
      tieRankRule,
      totalBallots,
      hasAnyJudgeScore,
      noVotesYet,
      totalBallotItems: totalBallots,
      playersWithVotes: rows.filter((r) => r.publicVotes > 0).length,
      maxRawScore: rows.reduce((m, r) => Math.max(m, r.rawScore), 0),
    },
  };
}

/** 最终总成绩比较器（并列时的决胜顺序） */
export function compareForFinal(a, b, tieBreak = 'individual') {
  if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
  if (tieBreak === 'group') {
    if (b.groupScore !== a.groupScore) return b.groupScore - a.groupScore;
    if (b.individualScore !== a.individualScore) return b.individualScore - a.individualScore;
  } else if (tieBreak === 'pro_avg') {
    const pa = (a.groupProAvg || 0) + (a.individualProAvg || 0);
    const pb = (b.groupProAvg || 0) + (b.individualProAvg || 0);
    if (pb !== pa) return pb - pa;
    if (b.individualScore !== a.individualScore) return b.individualScore - a.individualScore;
  } else {
    // 默认：个人赛得分高者优先
    if (b.individualScore !== a.individualScore) return b.individualScore - a.individualScore;
    if (b.groupScore !== a.groupScore) return b.groupScore - a.groupScore;
  }
  return a.no - b.no;
}

export const TIE_BREAK_LABEL = {
  individual: '个人赛得分高者优先',
  group: '小组赛得分高者优先',
  pro_avg: '专业评审平均分之和高者优先',
};

/**
 * 计算最终总成绩：总成绩 = 小组赛得分 × weightGroup + 个人赛得分 × weightIndividual
 * @param {Object} input { group, individual, opts:{weightGroup, weightIndividual, decimals, tieBreak} }
 */
export function computeFinal({ group, individual, players, opts = {} }) {
  const { weightGroup = 0.4, weightIndividual = 0.6, decimals = 2, tieBreak = 'individual' } = opts;
  const gMap = new Map((group?.rows || []).map((r) => [r.playerId, r]));
  const iMap = new Map((individual?.rows || []).map((r) => [r.playerId, r]));

  const rows = players.map((p) => {
    const g = gMap.get(p.id);
    const i = iMap.get(p.id);
    const groupScore = round(g?.finalScore || 0, decimals);
    const individualScore = round(i?.finalScore || 0, decimals);
    const totalScore = round(groupScore * weightGroup + individualScore * weightIndividual, decimals);
    return {
      playerId: p.id,
      no: p.no,
      name: p.name,
      photo: p.photo || null,
      groupScore,
      individualScore,
      totalScore,
      groupPublicPoints: g?.publicPoints ?? 0,
      groupPublicVotes: g?.publicVotes ?? 0,
      groupProAvg: g?.proAvg ?? 0,
      individualPublicPoints: i?.publicPoints ?? 0,
      individualPublicVotes: i?.publicVotes ?? 0,
      individualProAvg: i?.proAvg ?? 0,
      weightedGroup: round(groupScore * weightGroup, decimals),
      weightedIndividual: round(individualScore * weightIndividual, decimals),
      tieNote: '',
    };
  });

  rows.sort((a, b) => compareForFinal(a, b, tieBreak));

  // 尚无任何分数时，不显示排名（避免全部并列第 1 名造成误解）
  const hasAnyScore = rows.some((r) => r.totalScore > 0);

  let lastRank = 0;
  let prev = null;
  rows.forEach((row, idx) => {
    if (!hasAnyScore) {
      row.finalRank = null;
      row.tieNote = '暂无数据（尚未产生任何分数）';
      return;
    }
    const identical =
      prev &&
      prev.totalScore === row.totalScore &&
      prev.individualScore === row.individualScore &&
      prev.groupScore === row.groupScore;
    if (identical) {
      row.finalRank = lastRank;
      row.tieNote = '与上一名完全并列（三项均相同）';
    } else {
      row.finalRank = idx + 1;
      lastRank = row.finalRank;
      prev = row;
    }
    if (!row.tieNote) {
      const tiedOnTotal = rows.filter((r) => r !== row && r.totalScore === row.totalScore);
      if (tiedOnTotal.length) {
        row.tieNote = `总成绩并列，按「${TIE_BREAK_LABEL[tieBreak] || tieBreak}」决胜`;
      }
    }
  });

  return {
    rows,
    meta: { weightGroup, weightIndividual, decimals, tieBreak, tieBreakLabel: TIE_BREAK_LABEL[tieBreak] || tieBreak },
  };
}

/* ----------------------------------------------------------------- 工具 ---- */

function toMap(obj, mapper = (v) => v) {
  if (obj instanceof Map) return obj;
  const m = new Map();
  for (const [k, v] of Object.entries(obj || {})) m.set(Number(k), mapper(v));
  return m;
}

function toNestedMap(obj) {
  if (obj instanceof Map) {
    const out = new Map();
    for (const [slot, inner] of obj) out.set(Number(slot), toMap(inner));
    return out;
  }
  const out = new Map();
  for (const [slot, inner] of Object.entries(obj || {})) out.set(Number(slot), toMap(inner));
  return out;
}

function sumValues(map) {
  let s = 0;
  for (const v of map.values()) s += Number(v) || 0;
  return s;
}

/** 生成「规则说明」文本，供导出与后台展示 —— 让处理过程完全透明可复核 */
export function explainRules(settings) {
  const s = settings;
  return [
    { item: '大众评审投票规则', detail: `每位大众评审从全部选手中勾选 ${s.publicPickCount} 位（不可多选，可少选）；每条密码条在每个赛事仅可提交一次。` },
    { item: '大众评审赋分', detail: `按有效票数排名：第 1 名 ${s.topPoints} 分，第 2 名 ${s.topPoints - 1} 分，依次递减，第 ${s.topPoints} 名 1 分；得 0 票者赋 ${s.zeroVotePoints} 分。` },
    { item: '并列名次处理', detail: '票数相同者取并列最优名次，其后名次顺延（如两人并列第 2，则下一名为第 4 名）。' },
    { item: '专业评审打分', detail: `共 ${s.judgeCount} 位专业评审，每位对每位选手打 0-100 分（百分制，支持一位小数）。` },
    { item: '专业评审平均分', detail: s.missingJudgeRule === 'all' ? `4 位评审分数之和 ÷ ${s.judgeCount}（缺评按 0 分计入）` : '已提交评审分数之和 ÷ 实际提交评审人数（缺评不计入分母）' },
    { item: '赛事得分', detail: `赛事得分 = 专业评审平均分（0-100）+ 大众评审赋分（1-${s.topPoints}），上限 ${s.scoreCap} 分。` },
    { item: '最终总成绩', detail: `总成绩 = 小组赛得分 × ${s.weightGroup} + 个人赛得分 × ${s.weightIndividual}（保留 ${s.decimals} 位小数）。` },
    { item: '总成绩并列', detail: `总成绩相同时按「${TIE_BREAK_LABEL[s.final_tie_break] || s.final_tie_break}」决胜；三项分数完全一致时并列同名次。` },
    { item: '数据隔离', detail: '小组赛与个人赛使用彼此独立的投票记录、打分明细、开关与统计，任一方数据变动不会影响另一方。' },
    { item: '可追溯性', detail: '所有投票、打分、修改均记录操作人与时间；管理员修改保留修改前后快照（见「操作日志」表）。' },
  ];
}
