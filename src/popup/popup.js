/*!
 * DeepWiki → Markdown  Exporter —— 弹窗逻辑
 */
(function () {
  'use strict';

  const OPT_KEY = 'dw_options';
  const NOTES_KEY = 'dw_notes';

  let options = DW.mergeOptions({});
  let tab = null;
  let status = null;

  const $ = function (id) { return document.getElementById(id); };

  /* ---------------- 通用 ---------------- */

  function toast(msg, type) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast show ' + (type || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast ' + (type || ''); }, 3000);
  }

  async function bg(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      return r || { ok: false, error: '无响应' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function sendToTab(msg, noWait) {
    if (!tab || tab.id == null) return { ok: false, error: '没有可用的标签页' };
    if (noWait) {
      try {
        chrome.tabs.sendMessage(tab.id, msg, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* ignore */ }
      return { ok: true };
    }
    try {
      const r = await chrome.tabs.sendMessage(tab.id, msg);
      return r || { ok: false, error: '页面脚本无响应' };
    } catch (e) {
      return {
        ok: false,
        error: '无法与页面通信，请刷新 DeepWiki 页面后重试。'
      };
    }
  }

  /* ---------------- 设置 ---------------- */

  function applyOptionsToForm() {
    document.querySelectorAll('[data-opt]').forEach(function (el) {
      const key = el.getAttribute('data-opt');
      const v = options[key];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : String(v);
    });
  }

  async function loadOptions() {
    const r = await chrome.storage.local.get([OPT_KEY]);
    options = DW.mergeOptions(r[OPT_KEY] || {});
    applyOptionsToForm();
  }

  async function saveOptions(patch) {
    options = DW.mergeOptions(Object.assign({}, options, patch));
    await chrome.storage.local.set({ [OPT_KEY]: options });
  }

  function bindOptions() {
    document.querySelectorAll('[data-opt]').forEach(function (el) {
      const key = el.getAttribute('data-opt');
      const evt = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
      let timer = null;
      el.addEventListener(evt, function () {
        const isBool = typeof DW.DEFAULT_OPTIONS[key] === 'boolean';
        const value = el.type === 'checkbox' ? el.checked : el.value;
        clearTimeout(timer);
        timer = setTimeout(function () {
          saveOptions({ [key]: isBool ? !!value : value });
        }, 220);
      });
    });

    $('btn-reset').addEventListener('click', async function () {
      options = DW.mergeOptions({});
      await chrome.storage.local.set({ [OPT_KEY]: options });
      applyOptionsToForm();
      toast('已恢复默认设置', 'ok');
    });
  }

  /* ---------------- 页面信息 ---------------- */

  function renderStatus() {
    const typeEl = $('page-type');
    const nameEl = $('page-name');
    const detailEl = $('page-detail');
    const hintEl = $('hint');
    const actionsEl = $('actions');
    const qbox = $('qbox');
    const batch = $('btn-batch');
    const batchHint = $('batch-hint');

    if (!status || !status.ok) {
      typeEl.textContent = '不可用';
      typeEl.className = 'ptag bad';
      nameEl.textContent = '未连接到 DeepWiki 页面';
      detailEl.textContent = (status && status.error) || '请在 deepwiki.com 上打开某个仓库的页面';
      actionsEl.style.display = 'none';
      qbox.hidden = true;
      batch.hidden = true;
      batchHint.hidden = true;
      hintEl.hidden = false;
      hintEl.innerHTML = '打开 <b>deepwiki.com/&lt;owner&gt;/&lt;repo&gt;</b> 的 Wiki 页面，' +
        '或 <b>/search/…</b> 问答页面后再点击本扩展。';
      return;
    }

    const p = status.page;
    actionsEl.style.display = '';
    hintEl.hidden = true;

    if (p.type === 'wiki') {
      typeEl.textContent = 'Wiki 页面';
      typeEl.className = 'ptag wiki';
      nameEl.textContent = p.repo || '—';
      detailEl.textContent = p.pageId + ' ｜ ' + (p.title || '');
      batch.hidden = false;
      batchHint.hidden = true;
      qbox.hidden = true;
    } else if (p.type === 'search') {
      typeEl.textContent = '问答页面';
      typeEl.className = 'ptag search';
      nameEl.textContent = p.repo || 'DeepWiki 问答';
      detailEl.textContent = status.questions.length + ' 组问答';
      batch.hidden = true;
      batchHint.hidden = true;
      qbox.hidden = false;
      renderQuestions();
    } else {
      typeEl.textContent = '不支持的页面';
      typeEl.className = 'ptag bad';
      nameEl.textContent = p.url || '';
      detailEl.textContent = '请打开仓库 Wiki 页面或问答页面';
      actionsEl.style.display = 'none';
      qbox.hidden = true;
      batch.hidden = true;
      batchHint.hidden = true;
    }
  }

  function renderQuestions() {
    const list = $('qlist');
    list.textContent = '';
    const qs = (status && status.questions) || [];
    if (!qs.length) {
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = '未检测到问答内容（答案可能仍在生成）';
      list.appendChild(d);
      return;
    }
    qs.forEach(function (q, i) {
      const row = document.createElement('div');
      row.className = 'qrow';
      const t = document.createElement('div');
      t.className = 'qq';
      t.textContent = (q.index + 1) + '. ' + q.question;
      t.title = q.question;
      row.appendChild(t);

      const mk = function (label, title, fn) {
        const b = document.createElement('button');
        b.className = 'mini';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', function () {
          fn(b);
        });
        return b;
      };

      row.appendChild(mk('MD', '下载这一条', async function (b) {
        b.disabled = true;
        const r = await sendToTab({ type: 'DW_EXPORT', kind: 'search', onlyIndexes: [q.index] });
        b.disabled = false;
        toast(r.ok ? '已开始下载' : '失败：' + (r.error || ''), r.ok ? 'ok' : 'err');
      }));
      row.appendChild(mk('复制', '复制这一条', async function () {
        const r = await sendToTab({ type: 'DW_COPY', kind: 'search', onlyIndexes: [q.index] });
        toast(r.ok ? '已复制 ' + r.chars + ' 字符' : '失败：' + (r.error || ''), r.ok ? 'ok' : 'err');
      }));
      row.appendChild(mk('＋', '加入笔记夹', async function () {
        const r = await sendToTab({ type: 'DW_COLLECT', kind: 'search', onlyIndexes: [q.index] });
        if (r.ok) updateNotesCount(r.total);
        toast(r.ok ? '已加入笔记夹（共 ' + r.total + ' 条）' : '失败：' + (r.error || ''), r.ok ? 'ok' : 'err');
      }));

      list.appendChild(row);
    });
  }

  /* ---------------- 笔记夹 ---------------- */

  let notesCache = [];

  async function loadNotes() {
    const r = await chrome.storage.local.get([NOTES_KEY]);
    notesCache = r[NOTES_KEY] || [];
    updateNotesCount(notesCache.length);
  }

  function updateNotesCount(n) {
    $('notes-count').textContent = String(n);
    const has = n > 0;
    $('btn-notes-export').disabled = !has;
    $('btn-notes-copy').disabled = !has;
    $('btn-notes-clear').disabled = !has;
  }

  function bindNotes() {
    $('btn-notes-export').addEventListener('click', async function () {
      if (!notesCache.length) return;
      const md = DW.buildNotesMarkdown(notesCache, options);
      const name = DW.sanitizeSegment('DeepWiki-问答笔记-' + DW.todayStr()) + '.md';
      const filename = options.subfolder
        ? DW.sanitizeSegment(options.subfolder) + '/' + name
        : name;
      const r = await bg({
        type: 'DW_DOWNLOAD_BATCH',
        files: [{ filename: filename, content: md, mime: 'text/markdown;charset=utf-8' }]
      });
      toast(r.ok ? '已导出笔记夹（' + notesCache.length + ' 条）' : '导出失败：' + (r.error || ''), r.ok ? 'ok' : 'err');
    });

    $('btn-notes-copy').addEventListener('click', async function () {
      if (!notesCache.length) return;
      const md = DW.buildNotesMarkdown(notesCache, options);
      try {
        await navigator.clipboard.writeText(md);
        toast('已复制 ' + notesCache.length + ' 条笔记', 'ok');
      } catch (e) {
        toast('复制失败', 'err');
      }
    });

    $('btn-notes-clear').addEventListener('click', async function () {
      if (!notesCache.length) return;
      if (!confirm('确定清空笔记夹中的 ' + notesCache.length + ' 条内容吗？此操作不可撤销。')) return;
      await chrome.storage.local.set({ [NOTES_KEY]: [] });
      notesCache = [];
      updateNotesCount(0);
      toast('笔记夹已清空', 'ok');
    });
  }

  /* ---------------- 主动作 ---------------- */

  function bindActions() {
    $('btn-download').addEventListener('click', async function () {
      const kind = status && status.page ? status.page.type : 'wiki';
      const r = await sendToTab({ type: 'DW_EXPORT', kind: kind });
      const tr = r && r.blocks ? ' · 译文 ' + r.translatedBlocks + '/' + r.blocks + ' 处' : '';
      toast(r.ok ? '已开始下载：' + String(r.filename || '').split('/').pop() + tr : '失败：' + (r.error || ''), r.ok ? 'ok' : 'err');
    });

    $('btn-copy').addEventListener('click', async function () {
      const kind = status && status.page ? status.page.type : 'wiki';
      const r = await sendToTab({ type: 'DW_COPY', kind: kind });
      toast(r.ok ? '已复制 ' + r.chars + ' 字符到剪贴板' : '失败：' + (r.error || ''), r.ok ? 'ok' : 'err');
    });

    $('btn-collect').addEventListener('click', async function () {
      const kind = status && status.page ? status.page.type : 'wiki';
      const r = await sendToTab({ type: 'DW_COLLECT', kind: kind });
      if (r.ok) updateNotesCount(r.total);
      toast(r.ok ? '已加入 ' + r.added + ' 条（共 ' + r.total + ' 条）' : '失败：' + (r.error || ''), r.ok ? 'ok' : 'err');
    });

    $('btn-batch').addEventListener('click', async function () {
      const mode = options.batchTranslation || 'original';
      const modeText = mode === 'translated'
        ? '译文处理：逐页等待译文（慢）——这一趟会逐页滚动等翻译补齐再抓取。\n\n'
        : (mode === 'ask'
          ? '译文处理：每次导出前询问（本次已按你的选择执行）。\n\n'
          : '译文处理：只导出原文（快）——不滚动页面，也不等翻译，' +
            '正文与架构图都会完整导出，适合之后交给大模型翻译。\n\n');
      if (!confirm('将在当前标签页里自动翻页导出左侧目录的全部子页面：\n' +
        '逐页打开 → 等正文与架构图渲染完整 → 提取，每页一个独立文件夹（index.md + assets/），' +
        '并在仓库目录下生成 00-目录.md。完成后自动回到起始页面。\n\n' + modeText +
        '整个流程页面可见、可随时在页面右下角停止；重复导出会直接覆盖同名文件。\n\n是否继续？')) {
        return;
      }
      $('batch-hint').hidden = false;
      await sendToTab({ type: 'DW_BATCH' }, true);
      toast('已开始批量导出，进度见页面右下角', 'ok');
      window.close();
    });
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
    await loadOptions();
    bindOptions();
    bindActions();
    bindNotes();

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
    const url = (tab && tab.url) || '';
    if (!/^https:\/\/deepwiki\.com\//.test(url)) {
      status = { ok: false, error: '当前标签页不是 DeepWiki 页面' };
      renderStatus();
      await loadNotes();
      return;
    }
    status = await sendToTab({ type: 'DW_STATUS' });
    renderStatus();
    await loadNotes();
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[NOTES_KEY]) {
      notesCache = changes[NOTES_KEY].newValue || [];
      updateNotesCount(notesCache.length);
    }
  });

  document.addEventListener('DOMContentLoaded', init);
})();
