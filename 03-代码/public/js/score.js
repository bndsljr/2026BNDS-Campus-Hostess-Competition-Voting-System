/* 专业评审打分页：进度提示、草稿本地保存、提交前校验 */
(function () {
  const form = document.getElementById('scoreForm');
  if (!form) return;
  const competition = form.dataset.competition || 'group';
  const slot = form.dataset.slot || '0';
  const draftKey = `hostvote:draft:${competition}:${slot}`;
  const inputs = Array.from(form.querySelectorAll('input[type="number"]'));
  const progBar = document.getElementById('progBar');
  const progText = document.getElementById('progText');
  const progText2 = document.getElementById('progText2');
  const submitBtn = document.getElementById('submitBtn');

  function filledCount() {
    return inputs.filter((i) => i.value !== '' && i.value !== null).length;
  }

  function refresh() {
    const n = filledCount();
    if (progText) progText.textContent = `${n} / ${inputs.length}`;
    if (progText2) progText2.textContent = String(n);
    if (progBar) progBar.style.width = `${inputs.length ? (n / inputs.length) * 100 : 0}%`;
    inputs.forEach((i) => i.closest('.score-row')?.classList.toggle('filled', i.value !== ''));
    if (submitBtn) submitBtn.disabled = n !== inputs.length;
  }

  function saveDraft() {
    const data = {};
    inputs.forEach((i) => (data[i.name] = i.value));
    try {
      localStorage.setItem(draftKey, JSON.stringify(data));
    } catch (e) {}
  }

  // 回填草稿（仅当服务器没有已提交分数时）
  const hasServerData = inputs.some((i) => i.dataset.server === '1');
  try {
    const raw = localStorage.getItem(draftKey);
    if (raw && !hasServerData) {
      const data = JSON.parse(raw);
      inputs.forEach((i) => {
        if (data[i.name] !== undefined && i.value === '') i.value = data[i.name];
      });
    }
  } catch (e) {}

  inputs.forEach((i) => {
    i.addEventListener('input', () => {
      let v = i.value;
      if (v !== '') {
        let n = Number(v);
        if (Number.isFinite(n)) {
          if (n < 0) i.value = '0';
          if (n > 100) i.value = '100';
        }
      }
      refresh();
      saveDraft();
    });
    i.addEventListener('blur', () => {
      if (i.value !== '') {
        const n = Number(i.value);
        if (Number.isFinite(n)) i.value = String(Math.round(n * 10) / 10);
      }
      refresh();
      saveDraft();
    });
  });

  form.addEventListener('submit', (e) => {
    const missing = inputs.filter((i) => i.value === '');
    if (missing.length) {
      e.preventDefault();
      alert(`还有 ${missing.length} 位选手未打分，请填写完整后提交。`);
      return;
    }
    const bad = inputs.find((i) => Number(i.value) < 0 || Number(i.value) > 100 || !Number.isFinite(Number(i.value)));
    if (bad) {
      e.preventDefault();
      alert('分数必须是 0 到 100 之间的数字。');
      return;
    }
    if (!confirm('确认提交本次打分？提交后可在截止前再次修改。')) {
      e.preventDefault();
      return;
    }
    try {
      localStorage.removeItem(draftKey);
    } catch (e2) {}
  });

  const clearBtn = document.getElementById('clearDraft');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!confirm('清空当前页面填写的分数？')) return;
      inputs.forEach((i) => (i.value = ''));
      try {
        localStorage.removeItem(draftKey);
      } catch (e) {}
      refresh();
    });
  }

  refresh();
})();
