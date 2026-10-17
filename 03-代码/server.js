/**
 * 2026 主持人大赛投票系统 —— 服务入口
 *
 * 入口划分：
 *   /                     入口选择页（现场海报/二维码落地页）
 *   /vote/group           小组赛投票入口（密码条登录）
 *   /vote/individual      个人赛投票入口（密码条登录）
 *   /board                排名公示榜（可选公开）
 *   /manage               后台管理（账号密码登录）
 *   /healthz              健康检查
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import ejs from 'ejs';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { PORT, HOST, PUBLIC_DIR, UPLOAD_DIR, VIEWS_DIR, MAX_UPLOAD_BYTES } from './src/config.js';
import { getDb, getSettings, closeDb } from './src/db.js';
import { attachUser } from './src/auth.js';
import { competitionStatus, purgeExpiredSessions, recomputeAll } from './src/repo.js';
import { registerPublicRoutes } from './src/routes-public.js';
import { registerManageRoutes } from './src/routes-manage.js';
import { fmtLocal, humanRemain } from './src/util.js';

/**
 * 静态资源版本号：按 CSS/JS 内容计算，拼在资源 URL 后面。
 * 这样升级后用户浏览器会立即拿到新样式，而不是继续用缓存里的旧版本（默认缓存 1 小时）。
 */
const ASSET_VERSION = (() => {
  const hash = crypto.createHash('sha1');
  const files = ['css/app.css', 'js/vote.js', 'js/score.js', 'js/manage.js'].map((f) => path.join(PUBLIC_DIR, f));
  for (const f of files) {
    try {
      hash.update(fs.readFileSync(f));
    } catch {
      /* 文件不存在则忽略 */
    }
  }
  return hash.digest('hex').slice(0, 10);
})();

const app = Fastify({
  logger: {
    level: process.env.HV_LOG_LEVEL || 'info',
    transport: undefined,
  },
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024,
  // 容忍末尾斜杠：/vote/group/ 与 /vote/group 等价（选手手输网址时常见）
  ignoreTrailingSlash: true,
});

/* ------------------------------------------------------------ 插件注册 ---- */

await app.register(cookie);
await app.register(formbody);
await app.register(multipart, {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});
await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/assets/',
  cacheControl: true,
  maxAge: '1h',
});
await app.register(fastifyStatic, {
  root: UPLOAD_DIR,
  prefix: '/uploads/',
  decorateReply: false,
  cacheControl: true,
  maxAge: '1h',
});

/* -------------------------------------------------------------- 模板 ---- */

const templateCache = new Map();

function renderTemplate(name, data) {
  const file = path.join(VIEWS_DIR, `${name}.ejs`);
  if (!templateCache.has(file)) {
    templateCache.set(file, fs.readFileSync(file, 'utf8'));
  }
  return ejs.render(templateCache.get(file), data, {
    filename: file,
    async: false,
    rmWhitespace: false,
  });
}

app.decorateReply('view', function view(name, data = {}) {
  const html = renderTemplate(name, data);
  this.header('Content-Type', 'text/html; charset=utf-8');
  this.header('X-Content-Type-Options', 'nosniff');
  this.header('Referrer-Policy', 'same-origin');
  return this.send(html);
});

/**
 * 表单提交后的统一出口。
 * - 普通提交：带提示信息重定向（无 JS 时的回退方案）
 * - AJAX 提交（X-Requested-With: fetch）：返回 JSON，前端原地提示并局部刷新，**不发生跳转**
 */
app.decorateReply('flashRedirect', function flashRedirect(url, type, message) {
  if (isAjaxRequest(this.request)) {
    const targets = String(this.request.headers['x-refresh-targets'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.send({ ok: type !== 'error', type: type || 'ok', message, refresh: targets, redirect: url });
  }
  const sep = url.includes('?') ? '&' : '?';
  return this.redirect(`${url}${sep}flash=${encodeURIComponent(type)}&msg=${encodeURIComponent(message)}`);
});

/* -------------------------------------------------------------- 钩子 ---- */

app.addHook('preHandler', attachUser);

/** 基础 CSRF 防护：带 Origin 的写请求必须同源（同站表单 + SameSite=Lax 兜底） */
app.addHook('preHandler', async (request, reply) => {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const origin = request.headers.origin || request.headers.referer;
  if (!origin) return;
  try {
    const host = new URL(origin).hostname;
    const self = String(request.headers.host || '').split(':')[0];
    if (host && self && host !== self) {
      return reply.code(403).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif">请求来源校验失败（403），请返回重试。</h3>');
    }
  } catch {
    /* 非法 Origin 直接忽略 */
  }
});

/** 是否为后台 AJAX（原地操作）请求 */
function isAjaxRequest(request) {
  return String(request.headers['x-requested-with'] || '').toLowerCase() === 'fetch';
}

/** 业务校验错误的错误码集合（应作为 400 提示用户，而非 500） */
const BIZ_CODES = new Set(['INVALID', 'CLOSED', 'DONE', 'ROLE', 'LOCKED', 'NO_SLOT', 'IN_USE', 'NOT_FOUND']);

app.setErrorHandler((error, request, reply) => {
  const isBiz = BIZ_CODES.has(error.code);
  if (!isBiz && !error.statusCode) request.log.error({ err: error }, 'request failed');
  const status = isBiz ? 400 : error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
  const message = isBiz
    ? error.message
    : status === 500
      ? '服务器内部错误，请稍后重试或联系管理员'
      : error.message;
  if (request.url.startsWith('/api/') || isAjaxRequest(request)) {
    return reply.code(status).send({ ok: false, type: 'error', message, error: message });
  }
  return reply.code(status).view('error', {
    title: status === 500 ? '服务器错误' : '操作未完成',
    message,
    status,
    backUrl: request.headers.referer || '/',
  });
});

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ ok: false, error: '接口不存在' });
  if (request.url.startsWith('/manage') && request.user?.type !== 'admin') {
    return reply.redirect('/manage/login?next=' + encodeURIComponent(request.url));
  }
  // 根路径刻意不提供任何入口选择：两个投票部分彼此不可见
  const isRoot = request.url === '/' || request.url.split('?')[0] === '/';
  if (isRoot) {
    return reply.code(404).view('error', {
      title: '请从投票入口进入',
      message: '本系统不提供统一的入口页面。请使用现场工作人员提供的入口链接，或扫描现场二维码进入对应的投票页面。',
      status: 404,
      backUrl: null,
    });
  }
  return reply.code(404).view('error', {
    title: '页面不存在',
    message: `未找到路径：${request.url}`,
    status: 404,
    backUrl: request.url.startsWith('/manage') ? '/manage' : null,
  });
});

/* ------------------------------------------------------------ 公共数据 ---- */

app.decorate('commonData', function commonData(request, extra = {}) {
  const settings = getSettings();
  return {
    settings,
    user: request.user,
    title: settings.event_title,
    subtitle: settings.event_subtitle,
    flash: { type: request.query?.flash || null, msg: request.query?.msg || null },
    fmtLocal,
    humanRemain,
    assetVersion: ASSET_VERSION,
    serverNowIso: new Date().toISOString(),
    competitionStatus: (c) => competitionStatus(c, settings),
    now: Date.now(),
    ...extra,
  };
});

/* ------------------------------------------------------------ 基础路由 ---- */

app.get('/healthz', async () => {
  const settings = getSettings();
  return {
    ok: true,
    app: 'hostvote-2026',
    time: new Date().toISOString(),
    group: competitionStatus('group', settings).reason,
    individual: competitionStatus('individual', settings).reason,
  };
});

app.get('/favicon.ico', async (request, reply) => reply.code(204).send());

await registerPublicRoutes(app);
await registerManageRoutes(app);

/* ------------------------------------------------------------ 启动逻辑 ---- */

// 启动即重算一次，确保后台看到的排名与原始数据一致（幂等，可随时重复执行）
try {
  const r = recomputeAll();
  app.log.info(
    { groupPlayers: r.group.rows.length, individualPlayers: r.individual.rows.length },
    '启动重算完成'
  );
} catch (err) {
  app.log.error({ err }, '启动重算失败（不影响启动）');
}

purgeExpiredSessions();

// 每小时清理过期会话
const cleanupTimer = setInterval(() => {
  try {
    purgeExpiredSessions();
  } catch (err) {
    app.log.warn({ err }, '清理过期会话失败');
  }
}, 3600 * 1000);
cleanupTimer.unref?.();

async function shutdown(signal) {
  app.log.info(`收到 ${signal}，正在关闭...`);
  try {
    await app.close();
    closeDb();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

getDb();

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`投票系统已启动：http://${HOST}:${PORT}（外部通过 Nginx 80 / 8080 访问）`);
} catch (err) {
  app.log.error({ err }, '启动失败');
  process.exit(1);
}
