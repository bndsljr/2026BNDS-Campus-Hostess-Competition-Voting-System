/* =============================================================================
   后台通用交互
   核心：所有带 data-ajax 的表单/按钮都通过 fetch 提交，**不发生页面跳转**：
     · 成功/失败以右下角浮层提示（支持连续多条堆叠）
     · 通过 data-refresh="#a,#b" 指定需要原地更新的区块，局部替换 DOM
     · 表单里的输入内容不会被清空（除提交成功的操作本身）
   ============================================================================= */
(function () {
  'use strict';

  const TOAST_HOST_ID = 'hvToastHost';
  let toastSeq = 0;

  /* ----------------------------------------------------------- 浮层提示 ---- */
  function toastHost() {
    let host = document.getElementById(TOAST_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = TOAST_HOST_ID;
      host.style.cssText =
        'position:fixed;right:18px;bottom:18px;z-index:200;display:flex;flex-direction:column;gap:10px;max-width:min(420px,90vw)';
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(message, type = 'ok', ms = 4200) {
    if (!message) return;
    const el = document.createElement('div');
    const palette =
      type === 'error'
        ? { bg: '#fdeeee', bd: '#f3c9c7', fg: '#93231f', icon: '✘' }
        : type === 'info'
          ? { bg: '#eef3fb', bd: '#cddcf3', fg: '#22406f', icon: 'ℹ' }
          : { bg: '#e9f8ef', bd: '#bfe7cd', fg: '#16673a', icon: '✔' };
    el.style.cssText =
      `background:${palette.bg};border:1px solid ${palette.bd};color:${palette.fg};` +
      'padding:12px 16px;border-radius:10px;font-size:.93rem;box-shadow:0 6px 22px rgba(23,43,77,.16);' +
      'display:flex;gap:9px;align-items:flex-start;line-height:1.5;transition:opacity .35s,transform .35s;opacity:0;transform:translateY(8px)';
    el.dataset.toastType = type;
    el.innerHTML = `<span style="flex:0 0 auto">${palette.icon}</span><span style="flex:1">${escapeHtml(message)}</span>`;
    toastHost().appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    const id = ++toastSeq;
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 400);
    }, ms);
    el.addEventListener('click', () => el.remove());
    return id;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------- 局部刷新区块 ---- */
  async function refreshBlocks(selectors, root) {
    const list = (selectors || []).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return;
    try {
      const res = await fetch(window.location.pathname + window.location.search, {
        headers: { 'X-Requested-With': 'fetch' },
        credentials: 'same-origin',
      });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const touched = [];
      for (const sel of list) {
        const fresh = doc.querySelector(sel);
        const current = document.querySelector(sel);
        if (fresh && current) {
          current.replaceWith(fresh);
          touched.push(fresh);
        }
      }
      touched.forEach((el) => init(el));
    } catch (err) {
      // 局部刷新失败不影响主流程，仅提示
      console.warn('局部刷新失败', err);
    }
  }

  /* ------------------------------------------------------------ AJAX ---- */
  function bindAjax(root) {
    root.querySelectorAll('form[data-ajax]').forEach((form) => {
      if (form.dataset.ajaxBound === '1') return;
      form.dataset.ajaxBound = '1';
      form.addEventListener('submit', async (e) => {
        // 二次确认（提交时实时读取，允许脚本动态修改）
        if (form.dataset.confirm && !confirm(form.dataset.confirm)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();

        const submitter = e.submitter || null;
        let url = form.getAttribute('action') || window.location.pathname;
        if (submitter && submitter.getAttribute('formaction')) url = submitter.getAttribute('formaction');

        const buttons = Array.from(form.querySelectorAll('button[type="submit"], button:not([type])'));
        buttons.forEach((b) => (b.disabled = true));
        const originalText = submitter ? submitter.textContent : '';
        if (submitter) submitter.textContent = '处理中...';

        try {
          const fd = new FormData(form, submitter);
          // 关键：无文件时以 application/x-www-form-urlencoded 提交（服务端 formbody 解析）；
          // 含文件（选手照片）时才用 multipart，此时服务端走 @fastify/multipart 读取。
          const hasFile = Array.from(form.elements).some(
            (el) => el.type === 'file' && el.files && el.files.length > 0
          );
          const headers = {
            'X-Requested-With': 'fetch',
            'X-Refresh-Targets': form.dataset.refresh || '',
          };
          let body;
          if (hasFile) {
            body = fd;
          } else {
            const params = new URLSearchParams();
            for (const [k, v] of fd.entries()) params.append(k, typeof v === 'string' ? v : v.name);
            body = params.toString();
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
          }

          const res = await fetch(url, {
            method: 'POST',
            body,
            credentials: 'same-origin',
            headers,
          });

          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const data = await res.json();
            if (data.loginRequired && data.redirect) {
              toast(data.message || '登录状态已过期', 'error', 1500);
              setTimeout(() => (window.location.href = data.redirect), 900);
              return;
            }
            if (data.ok === false) {
              toast(data.message || data.error || '操作未完成', 'error');
            } else {
              toast(data.message || '操作完成', data.type === 'error' ? 'error' : 'ok');
              clearFlash();
              const extra = (data.refresh || []).concat((form.dataset.refresh || '').split(','));
              await refreshBlocks(extra.filter(Boolean));
              if (form.dataset.resetOnSuccess === '1') form.reset();
            }
          } else {
            // 非 JSON：可能是错误页（校验失败等），把提示文案抓出来
            const html = await res.text();
            const msg = extractMessage(html) || `操作未完成（HTTP ${res.status}）`;
            toast(msg, 'error');
          }
        } catch (err) {
          toast('网络错误：' + err.message, 'error');
        } finally {
          buttons.forEach((b) => (b.disabled = false));
          if (submitter) submitter.textContent = originalText;
        }
      });
    });
  }

  function extractMessage(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const box = doc.querySelector('.box p');
      if (box && box.textContent.trim()) return box.textContent.trim();
      const flash = doc.querySelector('.flash-error');
      if (flash) return flash.textContent.trim();
      const h = doc.querySelector('.box h1');
      if (h) return h.textContent.trim();
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  function clearFlash() {
    document.querySelectorAll('.flash[data-auto]').forEach((el) => el.remove());
  }

  /* -------------------------------------------------------- 其它绑定 ---- */
  function bindConfirms(root) {
    root.querySelectorAll('[data-confirm]').forEach((el) => {
      if (el.dataset.confirmBound === '1') return;
      if (el.tagName === 'FORM' && el.hasAttribute('data-ajax')) return; // 交给 AJAX 流程处理
      el.dataset.confirmBound = '1';
      const handler = (e) => {
        if (!confirm(el.dataset.confirm)) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      if (el.tagName === 'FORM') el.addEventListener('submit', handler);
      else el.addEventListener('click', handler);
    });
  }

  function bindFlash(root) {
    root.querySelectorAll('.flash[data-auto]').forEach((el) => {
      if (el.dataset.flashBound === '1') return;
      el.dataset.flashBound = '1';
      setTimeout(() => {
        el.style.transition = 'opacity .4s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 450);
      }, 4200);
    });
  }

  function bindToggleRows(root) {
    root.querySelectorAll('[data-toggle-row]').forEach((btn) => {
      if (btn.dataset.toggleBound === '1') return;
      btn.dataset.toggleBound = '1';
      btn.addEventListener('click', () => {
        const row = document.getElementById(btn.dataset.toggleRow);
        if (row) row.style.display = row.style.display === 'none' || !row.style.display ? 'table-row' : 'none';
      });
    });
  }

  function bindPreviews(root) {
    root.querySelectorAll('input[type="file"][data-preview]').forEach((input) => {
      if (input.dataset.previewBound === '1') return;
      input.dataset.previewBound = '1';
      input.addEventListener('change', () => {
        const img = document.getElementById(input.dataset.preview);
        if (img && input.files && input.files[0]) {
          img.src = URL.createObjectURL(input.files[0]);
          img.style.display = 'block';
        }
      });
    });
  }

  function bindCopy(root) {
    root.querySelectorAll('[data-copy]').forEach((btn) => {
      if (btn.dataset.copyBound === '1') return;
      btn.dataset.copyBound = '1';
      btn.addEventListener('click', async () => {
        const text = btn.dataset.copy;
        try {
          await navigator.clipboard.writeText(text);
          const old = btn.textContent;
          btn.textContent = '已复制';
          setTimeout(() => (btn.textContent = old), 1400);
        } catch (e) {
          prompt('请手动复制：', text);
        }
      });
    });
  }

  function bindSearch(root) {
    root.querySelectorAll('input[data-auto-submit]').forEach((input) => {
      if (input.dataset.searchBound === '1') return;
      input.dataset.searchBound = '1';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.closest('form')?.submit();
      });
    });
  }

  function bindNumberInputs(root) {
    root
      .querySelectorAll('table.table input[type="number"], .score-row input[type="number"]')
      .forEach((input) => {
        if (input.dataset.numBound === '1') return;
        input.dataset.numBound = '1';
        input.addEventListener('focus', () => input.select());
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const all = Array.from(
              document.querySelectorAll('table.table input[type="number"], .score-row input[type="number"]')
            );
            const next = all[all.indexOf(input) + 1];
            if (next) next.focus();
          }
        });
      });
  }

  /* ----------------------------------------------- 手动赋分：影响预览 ---- */
  function renderPreview(box, rows, title) {
    if (!rows || !rows.length) {
      box.innerHTML = '<div class="empty">没有可比对的数据</div>';
      return;
    }
    const hasTotal = rows.some((r) => r.afterTotal !== undefined);
    const changed = rows.filter((r) => r.rankChanged || r.scoreChanged || r.totalChanged).length;
    box.innerHTML = `
      <div class="flash flash-info" style="margin-bottom:10px">
        ${title || '预览完成（未写入数据库）'}：共 ${rows.length} 位选手，其中 <b>${changed}</b> 位的名次或分数会发生变化。
      </div>
      <div class="table-wrap">
        <table class="table compact">
          <thead><tr>
            <th>选手</th><th class="num">票数 改前→改后</th><th class="num">赋分</th>
            <th class="num">专业均分</th><th class="num">本场得分 改前→改后</th><th class="num">本场名次 改前→改后</th>
            ${hasTotal ? '<th class="num">最终总成绩 改前→改后</th><th class="num">总名次 改前→改后</th>' : ''}
          </tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
              <td>${escapeHtml(r.name)}</td>
              <td class="num">${r.beforeVotes} → ${r.afterVotes}</td>
              <td class="num">${r.beforePoints} → ${r.afterPoints}</td>
              <td class="num">${r.beforeProAvg} → ${r.afterProAvg}</td>
              <td class="num">${r.beforeScore} → <b>${r.afterScore}</b></td>
              <td class="num">${r.beforeRank ?? '-'} → <b>${r.afterRank ?? '-'}</b>
                ${r.rankChanged ? (r.afterRank < r.beforeRank ? '<span class="diff-up">↑</span>' : '<span class="diff-down">↓</span>') : ''}
              </td>
              ${
                hasTotal
                  ? `<td class="num">${r.beforeTotal ?? '-'} → <b>${r.afterTotal ?? '-'}</b></td>
                     <td class="num">${r.beforeFinalRank ?? '-'} → <b>${r.afterFinalRank ?? '-'}</b></td>`
                  : ''
              }
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  async function doPreview(btn, form, box) {
    if (!btn || !form || !box) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '计算中...';
    try {
      const params = new URLSearchParams(new FormData(form));
      params.set('view', 'final');
      const res = await fetch('/manage/manual/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
        body: params.toString(),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '预览失败');
      renderPreview(box, data.rows);
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      box.innerHTML = `<div class="flash flash-error">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = original || '预览影响（改前 → 改后）';
    }
  }

  function bindManualPreview(root) {
    root.querySelectorAll('button[data-preview-for]').forEach((btn) => {
      if (btn.dataset.previewBound === '1') return;
      btn.dataset.previewBound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const form = document.getElementById(btn.dataset.previewFor);
        const box = document.getElementById(btn.dataset.previewBox || 'previewResult');
        doPreview(btn, form, box);
      });
    });
  }

  /* ------------------------------------------------------------- 初始化 ---- */
  function init(root) {
    const scope = root && root.querySelectorAll ? root : document;
    bindConfirms(scope);
    bindFlash(scope);
    bindToggleRows(scope);
    bindPreviews(scope);
    bindCopy(scope);
    bindSearch(scope);
    bindNumberInputs(scope);
    bindAjax(scope);
    bindManualPreview(scope);
  }

  window.hvAdmin = { init, toast, refreshBlocks };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(document));
  } else {
    init(document);
  }
})();
