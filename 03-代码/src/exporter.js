/**
 * Excel 导出（exceljs）。
 *
 * 设计原则：完全透明可复核 —— 每个 sheet 要么是「原始数据」，要么是「处理过程」，
 * 从中可以一步一步手工复现系统算出的任何一个数字。
 *
 *  1. 最终总排名            —— 结论
 *  2. 说明与规则            —— 算法与参数（含公式文字描述）
 *  3. 小组赛-计分过程        —— 原始票数 → 排名 → 赋分 → 各评审打分 → 平均分 → 合计 → 封顶
 *  4. 个人赛-计分过程
 *  5. 总成绩计算过程        —— 加权乘数与加权值逐项列出
 *  6. 原始数据-大众投票明细  —— 每一条投票记录（谁的密码条、几点、什么IP、投给谁、是否被改过）
 *  7. 原始数据-专业评审打分  —— 每一格分数
 *  8. 原始数据-密码条清单    —— 全部密码条与投票状态
 *  9. 原始数据-选手名单
 * 10. 操作日志              —— 全部增删改的前后快照
 * 11. 统计摘要
 */
import ExcelJS from 'exceljs';
import { getSettings } from './db.js';
import {
  computeAllOnly,
  listPlayers,
  listCodes,
  codeVoteStates,
  votesWithItems,
  listScores,
  listAudit,
  dashboardStats,
} from './repo.js';
import { explainRules, TIE_BREAK_LABEL } from './scoring.js';
import { fmtLocal, nowIso, formatCode } from './util.js';
import { COMPETITIONS } from './config.js';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A6B' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const SUB_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF1F7' } };
const RAW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF6E5' } };
const PROC_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF5EA' } };

function addSheet(wb, name, columns, fill = HEADER_FILL) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
  });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 14, style: c.style }));
  const head = ws.getRow(1);
  head.height = 22;
  head.eachCell((cell) => {
    cell.fill = fill;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  head.commit();
  ws.autoFilter = undefined;
  return ws;
}

function stripe(ws) {
  ws.eachRow((row, i) => {
    if (i === 1) return;
    if (i % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
      });
    }
  });
}

function titleRow(ws, text, span) {
  // 在末尾追加说明块
  const r = ws.addRow([]);
  const row = ws.addRow([text]);
  row.getCell(1).font = { italic: true, color: { argb: 'FF666666' } };
  if (span > 1) ws.mergeCells(row.number, 1, row.number, span);
  return r;
}

/** 主工作簿：全量数据 + 处理过程 */
export async function buildFullWorkbook({ operator = 'system' } = {}) {
  const settings = getSettings();
  const wb = new ExcelJS.Workbook();
  wb.creator = `${settings.event_title} 投票系统`;
  wb.created = new Date();

  const { group, individual, final } = computeAllOnly(settings);
  const players = listPlayers({ activeOnly: false });
  const playerName = new Map(players.map((p) => [p.id, p.name]));
  const playerNo = new Map(players.map((p) => [p.id, p.no]));
  const judgeCount = settings.judgeCount;
  const judgeHeaders = Array.from({ length: judgeCount }, (_, i) => `评审${i + 1}打分`);

  /* ------------------------------------------------ 1. 最终总排名 ---- */
  const wsFinal = addSheet(
    wb,
    '最终总排名',
    [
      { header: '最终排名', key: 'rank', width: 10 },
      { header: '选手序号', key: 'no', width: 10 },
      { header: '姓名', key: 'name', width: 16 },
      { header: `小组赛·大众赋分(满分${settings.topPoints})`, key: 'gp', width: 22 },
      { header: '小组赛·专业评审平均分', key: 'gpro', width: 20 },
      { header: '小组赛总分(上限110)', key: 'gs', width: 18 },
      { header: `个人赛·大众赋分(满分${settings.topPoints})`, key: 'ip', width: 22 },
      { header: '个人赛·专业评审平均分', key: 'ipro', width: 20 },
      { header: '个人赛总分(上限110)', key: 'is', width: 18 },
      { header: `最终总成绩 = 小组赛×${settings.weightGroup} + 个人赛×${settings.weightIndividual}`, key: 'total', width: 34 },
      { header: '备注', key: 'note', width: 26 },
    ],
    { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8A45C' } }
  );
  for (const r of final.rows) {
    wsFinal.addRow({
      rank: r.finalRank == null ? '—' : r.finalRank,
      no: r.no,
      name: r.name,
      gp: r.groupPublicPoints,
      gpro: r.groupProAvg,
      gs: r.groupScore,
      ip: r.individualPublicPoints,
      ipro: r.individualProAvg,
      is: r.individualScore,
      total: r.totalScore,
      note: r.tieNote || '',
    });
  }
  wsFinal.getColumn('total').font = { bold: true };
  stripe(wsFinal);
  titleRow(
    wsFinal,
    `导出时间：${fmtLocal(nowIso())}（北京时间）｜导出人：${operator}｜最终总成绩 = 小组赛得分 × ${settings.weightGroup} + 个人赛得分 × ${settings.weightIndividual}，保留 ${settings.decimals} 位小数`,
    11
  );

  /* -------------------------------------------- 2. 说明与规则 ---- */
  const wsRule = addSheet(wb, '说明与规则', [
    { header: '项目', key: 'item', width: 22 },
    { header: '规则 / 算法说明', key: 'detail', width: 110 },
  ]);
  const stats = dashboardStats();
  wsRule.addRow({ item: '赛事名称', detail: settings.event_title + (settings.event_subtitle ? ' · ' + settings.event_subtitle : '') });
  wsRule.addRow({ item: '导出时间(北京)', detail: fmtLocal(nowIso()) });
  wsRule.addRow({ item: '导出人', detail: operator });
  wsRule.addRow({ item: '参赛选手数', detail: String(players.filter((p) => p.active).length) });
  wsRule.addRow({ item: '专业评审席位数', detail: String(judgeCount) });
  wsRule.addRow({ item: '小组赛·投票开关', detail: settings.groupEnabled ? '已开启' : '未开启' });
  wsRule.addRow({
    item: '小组赛·起止时间',
    detail: `${settings.group_start_at ? fmtLocal(settings.group_start_at) : '未设置'} ~ ${settings.group_end_at ? fmtLocal(settings.group_end_at) : '未设置'}`,
  });
  wsRule.addRow({ item: '个人赛·投票开关', detail: settings.individualEnabled ? '已开启' : '未开启' });
  wsRule.addRow({
    item: '个人赛·起止时间',
    detail: `${settings.individual_start_at ? fmtLocal(settings.individual_start_at) : '未设置'} ~ ${settings.individual_end_at ? fmtLocal(settings.individual_end_at) : '未设置'}`,
  });
  for (const r of explainRules(settings)) wsRule.addRow({ item: r.item, detail: r.detail });
  wsRule.addRow({ item: '本工作簿结构', detail: '「最终总排名」=结论；「小组赛/个人赛-计分过程」=逐步推导；「总成绩计算过程」=加权推导；「原始数据-*」=未经加工的原始记录；「操作日志」=全部人工修改留痕。可据此手工复现任意一个分数。' });
  stripe(wsRule);

  /* ------------------------------------ 3/4. 两个赛事的计分过程 ---- */
  for (const key of ['group', 'individual']) {
    const comp = key;
    const result = key === 'group' ? group : individual;
    const rows = [...result.rows].sort((a, b) => (a.publicRank || 999) - (b.publicRank || 999) || a.no - b.no);
    const label = COMPETITIONS[comp].name;
    const ws = addSheet(
      wb,
      `${label}-计分过程`,
      [
        { header: '选手序号', key: 'no', width: 10 },
        { header: '姓名', key: 'name', width: 14 },
        { header: '①大众有效票数', key: 'votes', width: 14 },
        { header: '②大众原始排名', key: 'rank', width: 14 },
        { header: '并列情况', key: 'tie', width: 22 },
        { header: `③大众赋分(第1名${settings.topPoints}分递减)`, key: 'points', width: 30 },
        ...judgeHeaders.map((h, i) => ({ header: `④${h}`, key: `j${i + 1}`, width: 12 })),
        { header: '⑤有效评审数', key: 'jcount', width: 12 },
        { header: '⑥打分合计', key: 'jsum', width: 12 },
        { header: '⑦平均分除数', key: 'jdiv', width: 13 },
        { header: '⑧专业评审平均分 =⑥÷⑦', key: 'proavg', width: 20 },
        { header: '⑨封顶前得分 =⑧+③', key: 'raw', width: 18 },
        { header: '⑩封顶上限', key: 'cap', width: 11 },
        { header: '⑪赛事最终得分 =MIN(⑨,⑩)', key: 'final', width: 22 },
      ],
      PROC_FILL
    );
    for (const r of rows) {
      const row = {
        no: r.no,
        name: r.name,
        votes: r.publicVotes,
        rank: r.publicRank == null ? '—' : r.publicRank,
        tie: r.publicRankTied?.length ? `与 ${r.publicRankTied.map((id) => playerName.get(id) || id).join('、')} 票数并列` : '',
        points: r.publicPoints,
        jcount: r.judgeSubmitted,
        jsum: r.judgeSum,
        jdiv: r.judgeDivisor,
        proavg: r.proAvg,
        raw: r.rawScore,
        cap: settings.scoreCap,
        final: r.finalScore,
      };
      r.judgeScores.forEach((js, i) => {
        row[`j${i + 1}`] = js.score === null || js.score === undefined ? '未评' : js.score;
      });
      ws.addRow(row);
    }
    ws.getColumn('final').font = { bold: true };
    stripe(ws);
    titleRow(
      ws,
      `处理过程：① 统计每条有效投票记录所选选手得到 ② 按票数降序排名（并列取最优名次，其后顺延） ③ 名次换算赋分（第1名${settings.topPoints}分，逐名递减，得0票者${settings.zeroVotePoints}分） ④ 汇总各评审席原始打分 ⑤⑥⑦ 有效评审数与除数（当前规则：${settings.missing_judge_rule === 'all' ? '缺评记0分后除以' + judgeCount : '按实际提交人数平均'}） ⑧ 平均分 ⑨ 平均分+赋分 ⑩⑪ 封顶后得到赛事得分`,
      14
    );
  }

  /* --------------------------------------- 5. 总成绩计算过程 ---- */
  const wsTotal = addSheet(
    wb,
    '总成绩计算过程',
    [
      { header: '选手序号', key: 'no', width: 10 },
      { header: '姓名', key: 'name', width: 14 },
      { header: '小组赛得分', key: 'gs', width: 14 },
      { header: `小组赛权重`, key: 'gw', width: 12 },
      { header: '小组赛加权值', key: 'gwx', width: 14 },
      { header: '个人赛得分', key: 'is', width: 14 },
      { header: '个人赛权重', key: 'iw', width: 12 },
      { header: '个人赛加权值', key: 'iwx', width: 14 },
      { header: '最终总成绩 = 加权值之和', key: 'total', width: 24 },
      { header: '最终排名', key: 'rank', width: 10 },
      { header: '并列说明', key: 'tie', width: 30 },
    ],
    PROC_FILL
  );
  for (const r of final.rows) {
    wsTotal.addRow({
      no: r.no,
      name: r.name,
      gs: r.groupScore,
      gw: settings.weightGroup,
      gwx: r.weightedGroup,
      is: r.individualScore,
      iw: settings.weightIndividual,
      iwx: r.weightedIndividual,
      total: r.totalScore,
      rank: r.finalRank == null ? '—' : r.finalRank,
      tie: r.tieNote || '',
    });
  }
  wsTotal.getColumn('total').font = { bold: true };
  stripe(wsTotal);
  titleRow(
    wsTotal,
    `计算公式：最终总成绩 = 小组赛得分 × ${settings.weightGroup} + 个人赛得分 × ${settings.weightIndividual}（保留 ${settings.decimals} 位小数）。并列决胜规则：${TIE_BREAK_LABEL[settings.final_tie_break] || settings.final_tie_break}`,
    11
  );

  /* ---------------------------------- 6. 原始数据 - 大众投票明细 ---- */
  const wsVotes = addSheet(
    wb,
    '原始数据-大众投票明细',
    [
      { header: '记录ID', key: 'id', width: 9 },
      { header: '赛事', key: 'comp', width: 9 },
      { header: '密码条', key: 'code', width: 14 },
      { header: '投票人(密码条标签)', key: 'label', width: 20 },
      { header: '权限类型', key: 'role', width: 12 },
      { header: '数据来源', key: 'source', width: 12 },
      { header: '投票时间(北京)', key: 'at', width: 20 },
      { header: '投票时间(UTC/ISO)', key: 'atIso', width: 24 },
      { header: 'IP', key: 'ip', width: 16 },
      { header: '浏览器UA', key: 'ua', width: 30 },
      { header: '本票投给(序号-姓名)', key: 'targets', width: 34 },
      { header: '计入统计', key: 'valid', width: 11 },
      { header: '操作人', key: 'operator', width: 12 },
      { header: '备注', key: 'note', width: 24 },
    ],
    RAW_FILL
  );
  const codeMap = new Map(listCodes().map((c) => [c.id, c]));
  for (const comp of ['group', 'individual']) {
    for (const v of votesWithItems(comp)) {
      wsVotes.addRow({
        id: v.id,
        comp: COMPETITIONS[comp].name,
        code: v.code_id ? formatCode(codeMap.get(v.code_id)?.code || v.code_snapshot || '') : '—',
        label: codeMap.get(v.code_id)?.label || (v.source === 'manual' ? '管理员手动录入' : v.code_snapshot || ''),
        role: v.role === 'pro' ? '专业评审' : '大众评审',
        source: v.source === 'manual' ? '手动录入' : '本人提交',
        at: fmtLocal(v.created_at),
        atIso: v.created_at,
        ip: v.ip || '',
        ua: v.ua || '',
        targets: v.playerIds.map((pid) => `${playerNo.get(pid) ?? '?'}-${playerName.get(pid) ?? '已删除选手'}`).join('、'),
        valid: v.invalid ? '已作废(不计票)' : '是',
        operator: v.operator || '',
        note: v.note || '',
      });
    }
  }
  stripe(wsVotes);
  titleRow(wsVotes, '说明：以「计入统计=是」的记录为准，每条记录中被投中的选手各计 1 票。若某条记录被作废，其票数不计入排名，同时该密码条恢复可投票状态。', 14);

  /* ---------------------------------- 7. 原始数据 - 专业评审打分 ---- */
  const wsScores = addSheet(
    wb,
    '原始数据-专业评审打分',
    [
      { header: '赛事', key: 'comp', width: 9 },
      { header: '评审席', key: 'slot', width: 10 },
      { header: '密码条标签', key: 'label', width: 20 },
      { header: '选手序号', key: 'no', width: 10 },
      { header: '选手姓名', key: 'name', width: 14 },
      { header: '分数(百分制)', key: 'score', width: 14 },
      { header: '数据来源', key: 'source', width: 12 },
      { header: '录入人', key: 'operator', width: 14 },
      { header: '首次录入时间(北京)', key: 'created', width: 20 },
      { header: '最近修改时间(北京)', key: 'updated', width: 20 },
      { header: '备注', key: 'note', width: 22 },
    ],
    RAW_FILL
  );
  for (const comp of ['group', 'individual']) {
    for (const s of listScores(comp)) {
      const code = s.code_id ? codeMap.get(s.code_id) : null;
      wsScores.addRow({
        comp: COMPETITIONS[comp].name,
        slot: `评审${s.judge_slot}`,
        label: code?.label || (s.source === 'manual' ? '管理员手动录入' : ''),
        no: playerNo.get(s.player_id) ?? '?',
        name: playerName.get(s.player_id) ?? '已删除选手',
        score: s.score,
        source: s.source === 'manual' ? '手动录入' : '评审本人提交',
        operator: s.operator || '',
        created: fmtLocal(s.created_at),
        updated: fmtLocal(s.updated_at),
        note: s.note || '',
      });
    }
  }
  stripe(wsScores);
  titleRow(wsScores, `说明：每位选手的专业评审平均分由本表对应赛事、对应选手的分数按当前规则求得（当前规则：${settings.missing_judge_rule === 'all' ? `缺评记 0 分后除以 ${judgeCount}` : '已提交评审分数之和 ÷ 实际提交人数'}）。未出现在本表中的格子视为「未评」。`, 11);

  /* --------------------------------- 8. 原始数据 - 密码条清单 ---- */
  const wsCodes = addSheet(
    wb,
    '原始数据-密码条清单',
    [
      { header: '密码条', key: 'code', width: 14 },
      { header: '权限类型', key: 'role', width: 14 },
      { header: '标签', key: 'label', width: 20 },
      { header: '绑定评审席', key: 'slot', width: 12 },
      { header: '状态', key: 'enabled', width: 10 },
      { header: '小组赛已投', key: 'vg', width: 12 },
      { header: '个人赛已投', key: 'vi', width: 12 },
      { header: '最后登录(北京)', key: 'last', width: 20 },
      { header: '累计登录次数', key: 'logins', width: 13 },
      { header: '备注', key: 'note', width: 24 },
    ],
    RAW_FILL
  );
  const states = codeVoteStates();
  for (const c of listCodes()) {
    const st = states.get(c.id) || { group: 0, individual: 0 };
    wsCodes.addRow({
      code: formatCode(c.code),
      role: c.role === 'pro' ? '专业评审' : '大众评审',
      label: c.label || '',
      slot: c.judge_slot ? `评审${c.judge_slot}` : '',
      enabled: c.enabled ? '启用' : '停用',
      vg: st.group > 0 ? '已投' : '未投',
      vi: st.individual > 0 ? '已投' : '未投',
      last: c.last_login_at ? fmtLocal(c.last_login_at) : '',
      logins: c.login_count,
      note: c.note || '',
    });
  }
  stripe(wsCodes);

  /* -------------------------------------- 9. 原始数据 - 选手名单 ---- */
  const wsPlayers = addSheet(
    wb,
    '原始数据-选手名单',
    [
      { header: '序号', key: 'no', width: 10 },
      { header: '姓名', key: 'name', width: 16 },
      { header: '标签', key: 'tag', width: 14 },
      { header: '参赛状态', key: 'active', width: 12 },
      { header: '排序', key: 'sort', width: 10 },
      { header: '照片文件', key: 'photo', width: 30 },
      { header: '简介', key: 'intro', width: 40 },
    ],
    RAW_FILL
  );
  for (const p of players) {
    wsPlayers.addRow({
      no: p.no,
      name: p.name,
      tag: p.tag || '',
      active: p.active ? '参赛中' : '已停用',
      sort: p.sort_order,
      photo: p.photo || '',
      intro: p.intro || '',
    });
  }
  stripe(wsPlayers);

  /* ------------------------------------------ 10. 操作日志 ---- */
  const wsLog = addSheet(
    wb,
    '操作日志',
    [
      { header: '时间(北京)', key: 'at', width: 20 },
      { header: '操作者类型', key: 'actorType', width: 12 },
      { header: '操作人', key: 'actor', width: 20 },
      { header: '动作', key: 'action', width: 22 },
      { header: '对象', key: 'target', width: 26 },
      { header: '修改前', key: 'before', width: 46 },
      { header: '修改后', key: 'after', width: 46 },
      { header: 'IP', key: 'ip', width: 16 },
      { header: '备注', key: 'note', width: 28 },
    ],
    RAW_FILL
  );
  const logs = listAudit({ limit: 20000 });
  for (const l of logs) {
    wsLog.addRow({
      at: fmtLocal(l.at),
      actorType: l.actor_type === 'admin' ? '管理员' : l.actor_type === 'code' ? '投票人' : '系统',
      actor: l.actor || '',
      action: l.action,
      target: l.target || '',
      before: l.before_json || '',
      after: l.after_json || '',
      ip: l.ip || '',
      note: l.note || '',
    });
  }
  stripe(wsLog);
  titleRow(wsLog, `说明：本表为全部人工操作留痕（含投票提交、评分提交、手动补票、数据修改、开关赛程、导出等），共 ${logs.length} 条。`, 9);

  /* ------------------------------------------ 11. 统计摘要 ---- */
  const wsSum = addSheet(wb, '统计摘要', [
    { header: '统计项', key: 'item', width: 34 },
    { header: '数值', key: 'value', width: 40 },
  ]);
  const put = (item, value) => wsSum.addRow({ item, value: String(value) });
  put('导出时间(北京)', fmtLocal(nowIso()));
  put('导出人', operator);
  put('参赛选手数（启用中）', players.filter((p) => p.active).length);
  put('停用选手数', players.filter((p) => !p.active).length);
  put('密码条总数（大众评审）', stats.codeStats.public?.total ?? 0);
  put('密码条总数（专业评审）', stats.codeStats.pro?.total ?? 0);
  for (const key of ['group', 'individual']) {
    const c = COMPETITIONS[key].name;
    const st = stats[key];
    put(`【${c}】有效投票记录数`, st.votes);
    put(`【${c}】其中手动录入记录数`, st.manual);
    put(`【${c}】已作废记录数`, st.invalid);
    put(`【${c}】已提交打分的评审席数`, `${st.judgeSlots} / ${judgeCount}`);
    put(`【${c}】打分明细格数`, st.scoreRows);
    const res = key === 'group' ? group : individual;
    put(`【${c}】有票选手数`, res.meta.playersWithVotes);
    put(`【${c}】最高封顶前得分`, res.meta.maxRawScore);
  }
  put('大众评审投票总数（小组赛）', stats.publicSubmitted.group);
  put('大众评审投票总数（个人赛）', stats.publicSubmitted.individual);
  put('最近一次重算时间(北京)', stats.lastRecalc ? fmtLocal(stats.lastRecalc) : '尚未重算');
  stripe(wsSum);

  return wb;
}

/** 仅姓名 + 排名的精简导出 */
export async function buildRankWorkbook({ operator = 'system' } = {}) {
  const settings = getSettings();
  const wb = new ExcelJS.Workbook();
  wb.creator = `${settings.event_title} 投票系统`;
  const { final } = computeAllOnly(settings);
  const ws = wb.addWorksheet('最终排名', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: '最终排名', key: 'rank', width: 12 },
    { header: '姓名', key: 'name', width: 22 },
  ];
  const head = ws.getRow(1);
  head.height = 26;
  head.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (const r of final.rows) {
    const row = ws.addRow({ rank: r.finalRank, name: r.name });
    row.height = 22;
    row.getCell('rank').alignment = { horizontal: 'center' };
    if (r.finalRank <= 3) row.font = { bold: true };
  }
  ws.addRow([]);
  titleRow(ws, `导出时间：${fmtLocal(nowIso())}（北京时间）｜导出人：${operator}｜共 ${final.rows.length} 位选手`, 2);
  return wb;
}

/** 仅密码条清单（用于打印发放） */
export async function buildCodesWorkbook({ role = null } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = addSheet(wb, '密码条清单', [
    { header: '密码条', key: 'code', width: 16 },
    { header: '权限类型', key: 'role', width: 16 },
    { header: '标签', key: 'label', width: 22 },
    { header: '绑定评审席', key: 'slot', width: 12 },
    { header: '状态', key: 'enabled', width: 10 },
    { header: '小组赛', key: 'vg', width: 10 },
    { header: '个人赛', key: 'vi', width: 10 },
  ]);
  const states = codeVoteStates();
  for (const c of listCodes({ role })) {
    const st = states.get(c.id) || { group: 0, individual: 0 };
    ws.addRow({
      code: formatCode(c.code),
      role: c.role === 'pro' ? '专业评审' : '大众评审',
      label: c.label || '',
      slot: c.judge_slot ? `评审${c.judge_slot}` : '',
      enabled: c.enabled ? '启用' : '停用',
      vg: st.group > 0 ? '已投' : '未投',
      vi: st.individual > 0 ? '已投' : '未投',
    });
  }
  stripe(ws);
  return wb;
}

export function xlsxHeaders(filename) {
  const encoded = encodeURIComponent(filename);
  return {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
  };
}

export function stamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
