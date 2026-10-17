/* 大众评审投票页：限选 3 人、实时计数、未选中的自动置灰、提交前二次确认 */
(function () {
  const form = document.getElementById('voteForm');
  if (!form) return;
  const max = Number(form.dataset.max || 3);
  const boxes = Array.from(form.querySelectorAll('input[name="player"]'));
  const countEl = document.getElementById('pickCount');
  const submitBtn = document.getElementById('submitBtn');
  const modal = document.getElementById('confirmModal');
  const modalList = document.getElementById('confirmList');
  const modalOk = document.getElementById('confirmOk');

  function picked() {
    return boxes.filter((b) => b.checked);
  }

  function refresh() {
    const chosen = picked();
    if (countEl) countEl.textContent = String(chosen.length);
    boxes.forEach((b) => {
      const card = b.closest('.player');
      if (!card) return;
      const isChecked = b.checked;
      const full = chosen.length >= max;
      card.classList.toggle('selected', isChecked);
      card.classList.toggle('disabled-pick', !isChecked && full);
    });
    if (submitBtn) submitBtn.disabled = chosen.length === 0;
  }

  boxes.forEach((b) => {
    b.addEventListener('change', () => {
      if (picked().length > max) {
        b.checked = false;
        flashTip(`最多只能选择 ${max} 位选手`);
      }
      refresh();
    });
  });

  function flashTip(text) {
    let el = document.getElementById('pickTip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pickTip';
      el.className = 'flash flash-error';
      el.style.position = 'fixed';
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
      el.style.bottom = '92px';
      el.style.zIndex = '120';
      el.style.margin = '0';
      el.style.maxWidth = '90vw';
      document.body.appendChild(el);
    }
    el.textContent = text;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.remove(), 1800);
  }

  form.addEventListener('submit', (e) => {
    if (form.dataset.confirmed === '1') return;
    e.preventDefault();
    const chosen = picked();
    if (chosen.length === 0) return;
    if (modal && modalList) {
      modalList.innerHTML = chosen
        .map((b) => `<li>${b.dataset.no ? b.dataset.no + '号 · ' : ''}${b.dataset.name || ''}</li>`)
        .join('');
      modal.classList.add('show');
    } else if (confirm(`确认提交以下 ${chosen.length} 位选手？提交后不可修改。`)) {
      form.dataset.confirmed = '1';
      form.submit();
    }
  });

  if (modalOk) {
    modalOk.addEventListener('click', () => {
      form.dataset.confirmed = '1';
      modal.classList.remove('show');
      form.submit();
    });
  }
  document.querySelectorAll('[data-close-modal]').forEach((el) =>
    el.addEventListener('click', () => document.getElementById('confirmModal')?.classList.remove('show'))
  );

  refresh();
})();
