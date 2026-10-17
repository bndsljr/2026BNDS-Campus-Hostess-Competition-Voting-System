/**
 * 认证与鉴权：
 *  - 普通用户：凭「密码条」登录，密码条本身即身份凭证（一人一条），并绑定权限类型（大众评审 / 专业评审）
 *  - 管理员：独立账号密码，连续 5 次错误锁定 1 小时
 *  - 会话存库（重启不掉线），Cookie 为随机 sid，不承载任何可伪造信息
 */
import bcrypt from 'bcryptjs';
import {
  createSession,
  getSession,
  deleteSession,
  getCode,
  getCodeByValue,
  touchCodeLogin,
  getAdminByUsername,
  getAdmin,
  registerAdminFailure,
  resetAdminFailure,
  logAudit,
  logLoginAttempt,
} from './repo.js';
import { getSettings } from './db.js';
import { newSid, normalizeCode } from './util.js';

export const COOKIE_NAME = 'hv_sid';

/* ------------------------------------------------------- 简单内存限流 ---- */

const buckets = new Map();

/** 滑动窗口限流：同一 IP 在 windowMs 内最多 max 次 */
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return { ok: false, retryAfterMs: windowMs - (now - arr[0]) };
  }
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
  }
  return { ok: true };
}

/* ------------------------------------------------------------- 会话 ---- */

export function issueSession(reply, { role, codeId = null, adminId = null, label = null, ip, ua }) {
  const s = getSettings();
  const sid = newSid();
  createSession({ sid, role, codeId, adminId, label, hours: s.sessionHours, ip, ua });
  reply.setCookie(COOKIE_NAME, sid, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // 需求：无 HTTPS，密码条仅做鉴权
    maxAge: s.sessionHours * 3600,
  });
  return sid;
}

export function dropSession(request, reply) {
  const sid = request.cookies?.[COOKIE_NAME];
  if (sid) deleteSession(sid);
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

/** 解析当前会话，并挂到 request.user */
export function attachUser(request, _reply, done) {
  const sid = request.cookies?.[COOKIE_NAME];
  const sess = getSession(sid);
  if (!sess) {
    request.user = null;
    return done();
  }
  if (sess.role === 'admin') {
    const admin = getAdmin(sess.admin_id);
    request.user = admin
      ? { type: 'admin', id: admin.id, username: admin.username, sid, session: sess }
      : null;
  } else {
    const code = getCode(sess.code_id);
    request.user = code
      ? {
          type: 'code',
          role: code.role, // public | pro
          codeId: code.id,
          label: code.label || code.code,
          judgeSlot: code.judge_slot,
          enabled: code.enabled,
          sid,
          session: sess,
        }
      : null;
  }
  done();
}

export function requireAdmin(request, reply, done) {
  if (!request.user || request.user.type !== 'admin') {
    const isAjax = String(request.headers['x-requested-with'] || '').toLowerCase() === 'fetch';
    if (request.url.startsWith('/api') || isAjax) {
      // 会话过期时让前端明确跳转到登录页，而不是把提示混在页面里
      return reply.send({
        ok: false,
        type: 'error',
        loginRequired: true,
        message: '登录状态已过期，请重新登录后再操作',
        redirect: '/manage/login?next=' + encodeURIComponent(request.url),
      });
    }
    return reply.redirect('/manage/login?next=' + encodeURIComponent(request.url));
  }
  done();
}

/* ------------------------------------------------------- 普通用户登录 ---- */

export function loginWithCode({ code, ip, ua }) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, error: '请输入密码条' };
  const row = getCodeByValue(normalized);
  logLoginAttempt({ kind: 'code', identifier: normalized.slice(0, 4) + '****', ip, ua, success: !!row });
  if (!row) return { ok: false, error: '密码条无效，请核对后重试' };
  if (!row.enabled) return { ok: false, error: '该密码条已被停用，请联系工作人员' };
  touchCodeLogin(row.id);
  return { ok: true, code: row };
}

/* --------------------------------------------------------- 管理员登录 ---- */

/** 检查管理员是否处于锁定期 */
export function adminLockState(admin) {
  if (!admin?.locked_until) return { locked: false };
  const until = new Date(admin.locked_until).getTime();
  if (until <= Date.now()) return { locked: false };
  return { locked: true, until: admin.locked_until, remainMs: until - Date.now() };
}

export function loginWithAdmin({ username, password, ip, ua }) {
  const s = getSettings();
  const admin = getAdminByUsername(username);
  logLoginAttempt({ kind: 'admin', identifier: username, ip, ua, success: false });

  if (!admin) {
    return { ok: false, error: '账号或密码错误' };
  }
  const lock = adminLockState(admin);
  if (lock.locked) {
    const mins = Math.ceil(lock.remainMs / 60000);
    return { ok: false, error: `账号已锁定，请 ${mins} 分钟后再试`, locked: true };
  }

  const good = bcrypt.compareSync(String(password || ''), admin.password_hash);
  if (!good) {
    const r = registerAdminFailure(admin.id, s.adminMaxFails, s.adminLockMinutes);
    const left = Math.max(0, s.adminMaxFails - r.fails);
    logAudit({
      actorType: 'admin',
      actor: username,
      action: 'admin.login.failed',
      target: `admins#${admin.id}`,
      ip,
      note: `连续失败 ${r.fails} 次${r.lockedUntil ? '，账号已锁定' : `，剩余尝试 ${left} 次`}`,
    });
    if (r.lockedUntil) {
      return { ok: false, error: `密码错误次数过多，账号已锁定 ${s.adminLockMinutes} 分钟`, locked: true };
    }
    return { ok: false, error: `账号或密码错误（剩余尝试 ${left} 次）` };
  }

  resetAdminFailure(admin.id);
  logLoginAttempt({ kind: 'admin', identifier: username, ip, ua, success: true });
  return { ok: true, admin };
}

/**
 * 校验当前管理员的密码 —— 用于「危险操作」的二次确认（例如一键清空投票数据）。
 * 仅比对密码，不改变失败计数与锁定状态。
 */
export function verifyAdminPassword(adminId, password) {
  if (!password) return false;
  const admin = getAdmin(adminId);
  if (!admin) return false;
  return bcrypt.compareSync(String(password), admin.password_hash);
}
