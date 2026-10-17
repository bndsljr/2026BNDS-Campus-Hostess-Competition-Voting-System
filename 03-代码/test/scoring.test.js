/**
 * 计分引擎单元测试 —— 覆盖并列、零票、缺评、封顶、加权总成绩等边界。
 * 运行：npm test
 *
 * 注意：此处使用的选项数、赋分梯度、评审人数、权重均为测试用示例值，
 * 与任何具体赛事规则无关（实际规则由后台配置项决定）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicRanking,
  pointsForRank,
  proAverage,
  computeCompetition,
  computeFinal,
} from '../src/scoring.js';

const players = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, no: i + 1, name: `选手${i + 1}` }));
const TOP = 5; // 示例：第 1 名 5 分
const JUDGES = 3; // 示例：3 位评审

test('标准竞赛排名：并列取最优名次、后续名次跳过', () => {
  const rows = buildPublicRanking(
    [
      { playerId: 1, votes: 9 },
      { playerId: 2, votes: 9 },
      { playerId: 3, votes: 7 },
      { playerId: 4, votes: 6 },
    ],
    'best'
  );
  assert.deepEqual(rows.map((r) => r.rank), [1, 1, 3, 4]);
  assert.deepEqual(rows[0].tiedWith, [2]);
});

test('全员零票时并列同名次', () => {
  const rows = buildPublicRanking(players.map((p) => ({ playerId: p.id, votes: 0 })));
  assert.ok(rows.every((r) => r.rank === 1));
});

test('名次换算赋分：第 1 名为最高分，逐名递减 1 分', () => {
  assert.equal(pointsForRank(1, { topPoints: TOP }), 5);
  assert.equal(pointsForRank(2, { topPoints: TOP }), 4);
  assert.equal(pointsForRank(TOP, { topPoints: TOP }), 1);
  assert.equal(pointsForRank(TOP + 1, { topPoints: TOP }), 0);
});

test('零票选手赋分按 zeroVotePoints（默认 0）', () => {
  assert.equal(pointsForRank(3, { topPoints: TOP, zeroVotePoints: 0, votes: 0 }), 0);
  assert.equal(pointsForRank(3, { topPoints: TOP, zeroVotePoints: 0, votes: 2 }), 3);
  assert.equal(pointsForRank(3, { topPoints: TOP, zeroVotePoints: 2, votes: 0 }), 2);
});

test('专业评审平均分：按实际提交人数（缺评不计入分母）', () => {
  const r = proAverage([90, 80, null], { judgeCount: JUDGES, rule: 'submitted' });
  assert.equal(r.submitted, 2);
  assert.equal(r.divisor, 2);
  assert.equal(r.avg, 85);
});

test('专业评审平均分：缺评按 0 分计入后除以总人数', () => {
  const r = proAverage([90, 80, null], { judgeCount: JUDGES, rule: 'all' });
  assert.equal(r.divisor, 3);
  assert.equal(r.avg, 56.666666666666664);
});

test('无人提交打分时平均分为 0', () => {
  const r = proAverage([null, null, null], { judgeCount: JUDGES, rule: 'submitted' });
  assert.equal(r.avg, 0);
  assert.equal(r.divisor, 0);
});

test('赛事得分 = 专业平均分 + 大众赋分', () => {
  const res = computeCompetition({
    players,
    votesByPlayer: { 1: 5, 2: 3, 3: 1 },
    judgeScores: {
      1: { 1: 90, 2: 80, 3: 70 },
      2: { 1: 90, 2: 80, 3: 70 },
      3: { 1: 90, 2: 80, 3: 70 },
    },
    opts: { topPoints: TOP, judgeCount: JUDGES, scoreCap: 105, decimals: 2, zeroVotePoints: 0 },
  });
  const p1 = res.rows.find((r) => r.playerId === 1);
  assert.equal(p1.publicVotes, 5);
  assert.equal(p1.publicRank, 1);
  assert.equal(p1.publicPoints, 5);
  assert.equal(p1.proAvg, 90);
  assert.equal(p1.finalScore, 95);
  const p4 = res.rows.find((r) => r.playerId === 4);
  assert.equal(p4.publicVotes, 0);
  assert.equal(p4.publicPoints, 0);
  assert.equal(p4.proAvg, 0);
});

test('得分封顶：超过 scoreCap 时截断', () => {
  const res = computeCompetition({
    players: players.slice(0, 1),
    votesByPlayer: { 1: 9 },
    judgeScores: { 1: { 1: 100 }, 2: { 1: 100 }, 3: { 1: 100 } },
    opts: { topPoints: TOP, judgeCount: JUDGES, scoreCap: 100, decimals: 2 },
  });
  assert.equal(res.rows[0].rawScore, 105);
  assert.equal(res.rows[0].finalScore, 100);
  assert.equal(res.rows[0].capped, true);
});

test('并列票的赋分相同且后续名次跳过', () => {
  const res = computeCompetition({
    players,
    votesByPlayer: { 1: 4, 2: 4, 3: 2 },
    judgeScores: {},
    opts: { topPoints: TOP, judgeCount: JUDGES, decimals: 2 },
  });
  const m = new Map(res.rows.map((r) => [r.playerId, r]));
  assert.equal(m.get(1).publicPoints, 5);
  assert.equal(m.get(2).publicPoints, 5);
  assert.equal(m.get(3).publicRank, 3);
  assert.equal(m.get(3).publicPoints, 3);
});

test('最终总成绩按权重加权求和', () => {
  const group = { rows: [{ playerId: 1, finalScore: 100 }, { playerId: 2, finalScore: 80 }] };
  const individual = { rows: [{ playerId: 1, finalScore: 50 }, { playerId: 2, finalScore: 100 }] };
  const final = computeFinal({
    group,
    individual,
    players: players.slice(0, 2),
    opts: { weightGroup: 0.5, weightIndividual: 0.5, decimals: 2, tieBreak: 'individual' },
  });
  const m = new Map(final.rows.map((r) => [r.playerId, r]));
  assert.equal(m.get(1).totalScore, 75); // 100*0.5 + 50*0.5
  assert.equal(m.get(2).totalScore, 90); // 80*0.5 + 100*0.5
  assert.equal(final.rows[0].playerId, 2);
  assert.equal(final.rows[0].finalRank, 1);
});

test('总成绩并列时按个人赛得分高者优先', () => {
  const group = { rows: [{ playerId: 1, finalScore: 90 }, { playerId: 2, finalScore: 80 }] };
  const individual = { rows: [{ playerId: 1, finalScore: 80 }, { playerId: 2, finalScore: 90 }] };
  const final = computeFinal({
    group,
    individual,
    players: players.slice(0, 2),
    opts: { weightGroup: 0.5, weightIndividual: 0.5, decimals: 2, tieBreak: 'individual' },
  });
  assert.equal(final.rows[0].totalScore, final.rows[1].totalScore);
  assert.equal(final.rows[0].playerId, 2, '个人赛更高者应排前');
  assert.ok(final.rows[0].tieNote.includes('并列'));
});

test('三项分数完全一致时并列同名次', () => {
  const group = { rows: [{ playerId: 1, finalScore: 90 }, { playerId: 2, finalScore: 90 }] };
  const individual = { rows: [{ playerId: 1, finalScore: 80 }, { playerId: 2, finalScore: 80 }] };
  const final = computeFinal({
    group,
    individual,
    players: players.slice(0, 2),
    opts: { weightGroup: 0.5, weightIndividual: 0.5, decimals: 2 },
  });
  assert.equal(final.rows[0].finalRank, 1);
  assert.equal(final.rows[1].finalRank, 1);
});

test('小数保留位数可控', () => {
  const res = computeCompetition({
    players: players.slice(0, 1),
    votesByPlayer: { 1: 1 },
    judgeScores: { 1: { 1: 100 / 3 }, 2: { 1: 0 }, 3: { 1: 0 } },
    opts: { topPoints: TOP, judgeCount: JUDGES, decimals: 3 },
  });
  assert.equal(res.rows[0].proAvg, 11.111);
});

test('越界分数在引擎层被兜底到 0-100', () => {
  const res = computeCompetition({
    players: players.slice(0, 2),
    votesByPlayer: { 1: 1, 2: 1 },
    judgeScores: { 1: { 1: -10, 2: 1000 }, 2: { 1: 999, 2: -5 } },
    opts: { topPoints: TOP, judgeCount: JUDGES, scoreCap: 105, decimals: 2, missingJudgeRule: 'submitted' },
  });
  const m = new Map(res.rows.map((r) => [r.playerId, r]));
  assert.equal(m.get(1).proAvg, 50, '-10 截为 0，999 截为 100，平均 50');
  assert.equal(m.get(2).proAvg, 50, '1000 截为 100，-5 截为 0，平均 50');
});
