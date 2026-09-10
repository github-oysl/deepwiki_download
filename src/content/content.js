/*!
 * DeepWiki → Markdown  Exporter
 * 内容脚本：页面内悬浮面板、问答行内按钮、导出/复制/笔记夹、整站批量导出
 */
(function () {
  'use strict';
  if (window.__DW_EXPORTER_LOADED__) return;
  window.__DW_EXPORTER_LOADED__ = true;

  const OPT_KEY = 'dw_options';
  const NOTES_KEY = 'dw_notes';
  const UI_CLASS = 'dw-md-export-ui';

  /* ==================== 选项 ==================== */

  let options = DW.mergeOptions({});
  const optionsReady = new Promise(function (resolve) {
    try {
      chrome.storage.local.get([OPT_KEY], function (r) {
        options = DW.mergeOptions((r && r[OPT_KEY]) || {});
        resolve(options);
      });
    } catch (e) {
      resolve(options);
    }
  });

  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === 'local' && ch[OPT_KEY]) {
        options = DW.mergeOptions(ch[OPT_KEY].newValue || {});
      }
    });
  } catch (e) { /* ignore */ }

  async function getOptions() {
    await optionsReady;
    return options;
  }

  /* ==================== 小工具 ==================== */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function dirOf(path) {
    return path.replace(/[^/]*$/, '');
  }

  function bg(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          resolve(res || { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : '无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) {
        return false;
      }
    }
  }

  async function downloadResult(res) {
    const files = [{
      filename: res.filename,
      content: res.markdown,
      mime: 'text/markdown;charset=utf-8'
    }];
    (res.assets || []).forEach(function (a) {
      files.push({
        filename: dirOf(res.filename) + a.dir + '/' + a.name,
        content: a.content,
        mime: a.mime || 'image/svg+xml'
      });
    });
    const r = await bg({ type: 'DW_DOWNLOAD_BATCH', files: files });
    if (!r || !r.ok) {
      // 兜底：页面内直接触发下载
      try {
        const blob = new Blob([res.markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename.split('/').pop();
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        return { ok: true, fallback: true };
      } catch (e) {
        return { ok: false, error: (r && r.error) || String(e) };
      }
    }
    return r;
  }

  /* ==================== 笔记夹 ==================== */

  async function readNotes() {
    const r = await chrome.storage.local.get([NOTES_KEY]);
    return (r && r[NOTES_KEY]) || [];
  }

  async function addNotes(items) {
    const notes = await readNotes();
    items.forEach(function (it) { notes.push(it); });
    await chrome.storage.local.set({ [NOTES_KEY]: notes });
    return notes.length;
  }

  /* ==================== 导出逻辑 ==================== */

  async function exportCurrent(kind, onlyIndexes) {
    const opts = await getOptions();
    let res;
    if (kind === 'wiki') {
      res = DW.buildWikiPage(document, opts);
    } else {
      res = DW.buildSearchPage(document, opts, onlyIndexes);
    }
    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || '导出失败' };
    }
    const dl = await downloadResult(res);
    return Object.assign({}, res, {
      ok: !!dl.ok,
      downloaded: !!dl.ok,
      downloadError: dl.error || '',
      markdown: undefined,
      assets: undefined
    });
  }

  async function copyCurrent(kind, onlyIndexes) {
    const opts = await getOptions();
    let res;
    if (kind === 'wiki') {
      res = DW.buildWikiPage(document, opts);
    } else {
      res = DW.buildSearchPage(document, opts, onlyIndexes);
    }
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || '转换失败' };
    const ok = await copyText(res.markdown);
    return { ok: ok, chars: res.markdown.length, error: ok ? '' : '复制失败，请检查浏览器权限' };
  }

  async function collectCurrent(kind, onlyIndexes) {
    const opts = await getOptions();
    const now = Date.now();
    if (kind === 'wiki') {
      const res = DW.buildWikiPage(document, opts);
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || '转换失败' };
      const total = await addNotes([{
        id: uid(), type: 'wiki', repo: res.repo, question: res.title,
        markdown: res.markdown, url: res.url, ts: now
      }]);
      return { ok: true, added: 1, total: total };
    }
    const ext = DW.extractSearch(document);
    if (!ext || !ext.ok) return { ok: false, error: (ext && ext.error) || '未找到问答' };
    let items = ext.items;
    if (onlyIndexes && onlyIndexes.length) {
      items = items.filter(function (it) { return onlyIndexes.indexOf(it.index) >= 0; });
    }
    if (!items.length) return { ok: false, error: '未匹配到问答' };
    const notes = items.map(function (it) {
      const frag = DW.buildNoteFragment(it, ext, opts);
      return {
        id: uid(), type: 'search', repo: it.repo || ext.repo, question: it.question,
        markdown: frag.markdown, url: ext.url, ts: now
      };
    });
    const total = await addNotes(notes);
    return { ok: true, added: notes.length, total: total };
  }

  /* ==================== 整站批量导出 ==================== */

  let batchFrame = null;

  function getBatchFrame() {
    if (!batchFrame || !batchFrame.isConnected) {
      batchFrame = document.createElement('iframe');
      batchFrame.className = UI_CLASS;
      batchFrame.setAttribute('aria-hidden', 'true');
      batchFrame.style.cssText =
        'position:fixed;left:-12000px;top:0;width:1440px;height:1000px;border:0;visibility:hidden;pointer-events:none;';
      document.body.appendChild(batchFrame);
    }
    return batchFrame;
  }

  function naturalParts(path, repo) {
    let rest = '';
    if (path === '/' + repo) rest = '';
    else if (path.indexOf('/' + repo + '/') === 0) rest = path.slice(repo.length + 2);
    else rest = path.replace(/^\//, '');
    const m = /^([\d.]+)/.exec(rest);
    if (!m) return [1000, rest];
    const nums = m[1].split('.').map(Number);
    return nums;
  }

  function collectWikiLinks(repo) {
    const out = [];
    const seen = {};
    if (!repo) return out;
    Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
      const href = a.getAttribute('href');
      if (!href || /^[a-z]+:/i.test(href) || href.charAt(0) !== '/') return;
      const p = href.replace(/[?#].*$/, '').replace(/\/+$/, '');
      if (p === '/search' || p.indexOf('/search/') === 0) return;
      if (p !== '/' + repo && p.indexOf('/' + repo + '/') !== 0) return;
      if (seen[p]) return;
      seen[p] = 1;
      out.push(p);
    });
    out.sort(function (a, b) {
      const pa = naturalParts(a, repo);
      const pb = naturalParts(b, repo);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i], y = pb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (typeof x === 'number' && typeof y === 'number') {
          if (x !== y) return x - y;
        } else if (String(x) !== String(y)) {
          return String(x) < String(y) ? -1 : 1;
        }
      }
      return 0;
    });
    return out;
  }

  async function loadPageInFrame(path, timeoutMs) {
    const f = getBatchFrame();
    const t = timeoutMs || 30000;
    await new Promise(function (resolve) {
      let settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        f.removeEventListener('load', finish);
        resolve();
      }
      f.addEventListener('load', finish);
      try {
        f.src = path;
      } catch (e) {
        finish();
      }
      setTimeout(finish, t);
    });
    const t0 = Date.now();
    while (Date.now() - t0 < t) {
      await sleep(300);
      let d = null;
      try {
        d = f.contentDocument;
      } catch (e) {
        return null;
      }
      if (!d) return null;
      const c = d.querySelector('div.prose-custom');
      if (c && c.textContent.replace(/\s+/g, '').length > 80) return d;
    }
    return null;
  }

  let batchCancelled = false;

  async function batchExport(onProgress) {
    const opts = await getOptions();
    const info = DW.detectPage(document);
    const repo = info.repo;
    if (!repo) return { ok: false, error: '当前页面不是仓库 Wiki 页面' };

    const links = collectWikiLinks(repo);
    if (!links.length) return { ok: false, error: '未在页面上找到可导出的 Wiki 页面链接' };

    const index = [];
    let done = 0;
    const failed = [];
    let assetCount = 0;
    let dir = '';
    batchCancelled = false;

    for (let i = 0; i < links.length; i++) {
      if (batchCancelled) break;
      const path = links[i];
      if (onProgress) onProgress(done, links.length, path);

      const doc = await loadPageInFrame(path);
      let res = null;
      if (doc) {
        try {
          res = DW.buildWikiPage(doc, opts);
        } catch (e) {
          res = null;
        }
      }
      if (!res || !res.ok) {
        failed.push(path);
        done++;
        if (onProgress) onProgress(done, links.length, path);
        continue;
      }

      if (!dir) dir = dirOf(res.filename);
      const files = [{
        filename: res.filename,
        content: res.markdown,
        mime: 'text/markdown;charset=utf-8'
      }];
      (res.assets || []).forEach(function (a) {
        assetCount++;
        files.push({
          filename: dirOf(res.filename) + a.dir + '/' + a.name,
          content: a.content,
          mime: a.mime || 'image/svg+xml'
        });
      });

      // 逐页投递下载，避免一次性拼接超大消息
      const dl = await bg({ type: 'DW_DOWNLOAD_BATCH', files: files });
      if (!dl || !dl.ok) failed.push(path);
      else index.push({
        title: res.title,
        pageId: res.pageId,
        file: res.filename.replace(/^.*\//, ''),
        url: res.url
      });

      done++;
      if (onProgress) onProgress(done, links.length, path);
      await sleep(120);
    }

    if (index.length) {
      const lines = [
        '# ' + repo + ' · DeepWiki 目录',
        '',
        '> 来源：https://deepwiki.com/' + repo,
        '> 导出时间：' + DW.nowLocalIso(),
        '> 共 ' + index.length + ' 个页面',
        ''
      ];
      index.forEach(function (it) {
        lines.push('- [' + it.title + '](' + encodeURI(it.file) + ')');
      });
      await bg({
        type: 'DW_DOWNLOAD_BATCH',
        files: [{
          filename: dir + '00-目录.md',
          content: lines.join('\n') + '\n',
          mime: 'text/markdown;charset=utf-8'
        }]
      });
    }

    if (!index.length) return { ok: false, error: '没有成功导出任何页面', failed: failed };
    return { ok: true, pages: index.length, assets: assetCount, failed: failed };
  }

  /* ==================== 页面内 UI ==================== */

  let fab = null;
  let panel = null;
  let toastEl = null;
  let progressEl = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls + ' ' + UI_CLASS;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureRoot() {
    if (fab && fab.isConnected) return;
    fab = document.createElement('div');
    fab.className = UI_CLASS + ' dw-fab';
    fab.title = 'DeepWiki → Markdown';
    fab.textContent = 'MD';
    fab.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePanel();
    });
    document.body.appendChild(fab);
  }

  // 样式通过 manifest 的 content_scripts.css 注入
  function ensureStyles() { /* no-op */ }

  function toast(msg, type) {
    ensureStyles();
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.className = UI_CLASS + ' dw-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.setAttribute('data-type', type || 'info');
    toastEl.classList.add('dw-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      if (toastEl) toastEl.classList.remove('dw-show');
    }, 3200);
  }

  function statusLine() {
    const info = DW.detectPage(document);
    if (info.type === 'search') {
      const ext = DW.extractSearch(document);
      const n = ext.ok ? ext.items.length : 0;
      return {
        kind: 'search',
        title: '问答页面',
        detail: (ext.ok ? ext.repo || '未知仓库' : '未识别仓库') + ' ｜ 检测到 ' + n + ' 组问答'
      };
    }
    if (info.type === 'wiki') {
      const ext = DW.extractWiki(document);
      return {
        kind: 'wiki',
        title: 'Wiki 页面',
        detail: info.repo + ' ｜ ' + (ext.ok ? ext.title : '正文未就绪')
      };
    }
    return { kind: 'other', title: '不支持的页面', detail: '请打开某个仓库的 Wiki 页面或问答页面' };
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.className = UI_CLASS + ' dw-panel';

    const head = document.createElement('div');
    head.className = UI_CLASS + ' dw-head';
    const hTitle = el('span', 'dw-h-title', 'DeepWiki → Markdown');
    const close = el('button', 'dw-x', '×');
    close.title = '关闭';
    close.addEventListener('click', function () { panel.classList.remove('dw-open'); });
    head.appendChild(hTitle);
    head.appendChild(close);

    const body = document.createElement('div');
    body.className = UI_CLASS + ' dw-body';

    const st = el('div', 'dw-status');
    body.appendChild(st);

    const actions = el('div', 'dw-actions');
    body.appendChild(actions);

    progressEl = el('div', 'dw-progress');
    progressEl.hidden = true;
    body.appendChild(progressEl);

    const foot = el('div', 'dw-foot');
    const noteBtn = el('button', 'dw-btn dw-btn-ghost', '笔记夹');
    noteBtn.addEventListener('click', async function () {
      const notes = await readNotes();
      if (!notes.length) {
        toast('笔记夹为空', 'info');
        return;
      }
      const opts = await getOptions();
      const md = buildNotesMarkdown(notes, opts);
      const ok = await copyText(md);
      toast(ok ? '已复制 ' + notes.length + ' 条笔记（Markdown）' : '复制失败', ok ? 'ok' : 'err');
    });
    const expNotes = el('button', 'dw-btn dw-btn-ghost', '导出笔记');
    expNotes.addEventListener('click', async function () {
      const notes = await readNotes();
      if (!notes.length) { toast('笔记夹为空', 'info'); return; }
      const opts = await getOptions();
      const r = await downloadResult({
        filename: DW.sanitizeSegment('DeepWiki-问答笔记-' + DW.todayStr()) + '.md',
        markdown: buildNotesMarkdown(notes, opts),
        assets: []
      });
      toast(r.ok ? '已导出笔记夹' : '导出失败：' + (r.error || ''), r.ok ? 'ok' : 'err');
    });
    foot.appendChild(noteBtn);
    foot.appendChild(expNotes);

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);

    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(panel);
    return panel;
  }

  function buildNotesMarkdown(notes, opts) {
    return DW.buildNotesMarkdown(notes, opts);
  }

  function renderActions() {
    const actions = panel.querySelector('.dw-actions');
    const st = panel.querySelector('.dw-status');
    actions.textContent = '';
    const s = statusLine();
    st.textContent = '';
    const t1 = el('div', 'dw-st-title', s.title);
    const t2 = el('div', 'dw-st-detail', s.detail);
    st.appendChild(t1);
    st.appendChild(t2);

    function mk(label, cls, fn) {
      const b = el('button', 'dw-btn ' + (cls || ''), label);
      b.addEventListener('click', async function () {
        if (b.disabled) return;
        b.disabled = true;
        const old = b.textContent;
        b.textContent = '处理中…';
        try {
          await fn();
        } catch (e) {
          toast('出错：' + String((e && e.message) || e), 'err');
        }
        b.disabled = false;
        b.textContent = old;
      });
      actions.appendChild(b);
      return b;
    }

    if (s.kind === 'other') {
      const tip = el('div', 'dw-tip', '打开 deepwiki.com/<owner>/<repo> 的 Wiki 页面或 /search/ 问答页面后再使用。');
      actions.appendChild(tip);
      return;
    }

    mk('下载 Markdown', 'dw-btn-primary', async function () {
      const r = await exportCurrent(s.kind);
      toast(r.ok ? '已开始下载：' + r.filename.split('/').pop() : '导出失败：' + r.error, r.ok ? 'ok' : 'err');
    });
    mk('复制 Markdown', '', async function () {
      const r = await copyCurrent(s.kind);
      toast(r.ok ? '已复制 ' + r.chars + ' 字符' : '复制失败：' + r.error, r.ok ? 'ok' : 'err');
    });
    mk('加入笔记夹', '', async function () {
      const r = await collectCurrent(s.kind);
      toast(r.ok ? '已加入 ' + r.added + ' 条（共 ' + r.total + ' 条）' : '失败：' + r.error, r.ok ? 'ok' : 'err');
    });

    if (s.kind === 'search') {
      const list = DW.listQuestions(document);
      if (list.ok) {
        const box = el('div', 'dw-qlist');
        box.appendChild(el('div', 'dw-ql-title', '逐条导出'));
        list.items.forEach(function (it) {
          const row = el('div', 'dw-ql-row');
          const q = el('div', 'dw-ql-q', (it.index + 1) + '. ' + it.question);
          q.title = it.question;
          const b1 = el('button', 'dw-mini', 'MD');
          b1.title = '下载这一条';
          b1.addEventListener('click', async function () {
            const r = await exportCurrent('search', [it.index]);
            toast(r.ok ? '已下载第 ' + (it.index + 1) + ' 条' : '失败：' + r.error, r.ok ? 'ok' : 'err');
          });
          const b2 = el('button', 'dw-mini', '复制');
          b2.title = '复制这一条';
          b2.addEventListener('click', async function () {
            const r = await copyCurrent('search', [it.index]);
            toast(r.ok ? '已复制' : '失败：' + r.error, r.ok ? 'ok' : 'err');
          });
          const b3 = el('button', 'dw-mini', '＋');
          b3.title = '加入笔记夹';
          b3.addEventListener('click', async function () {
            const r = await collectCurrent('search', [it.index]);
            toast(r.ok ? '已加入笔记夹（共 ' + r.total + ' 条）' : '失败：' + r.error, r.ok ? 'ok' : 'err');
          });
          row.appendChild(q);
          row.appendChild(b1);
          row.appendChild(b2);
          row.appendChild(b3);
          box.appendChild(row);
        });
        actions.appendChild(box);
      }
    }

    if (s.kind === 'wiki') {
      const info = DW.detectPage(document);
      const links = collectWikiLinks(info.repo);
      const b = mk('批量导出整个 Wiki（' + links.length + ' 页）', '', async function () {
        if (!links.length) { toast('未找到 Wiki 页面链接', 'info'); return; }
        if (!confirm('将依次抓取 ' + links.length + ' 个页面并导出为 Markdown 文件，是否继续？\n\n注意：批量抓取使用隐藏 iframe，不会包含翻译插件产生的译文。')) {
          return;
        }
        progressEl.hidden = false;
        batchCancelled = false;
        setProgress(0, links.length + 1, '准备中…');
        const r = await batchExport(function (done, total, path) {
          setProgress(done, total + 1, path);
        });
        progressEl.hidden = true;
        if (r.ok) {
          toast('已导出 ' + r.pages + ' 个页面' + (r.failed.length ? '（' + r.failed.length + ' 个失败）' : ''), 'ok');
        } else {
          toast('批量导出失败：' + r.error, 'err');
        }
      });
      if (!links.length) b.disabled = true;
      const tip = el('div', 'dw-tip', '批量导出会连同侧边栏中的所有子页面一起保存到下载目录下，并生成 00-目录.md。由于使用隐藏 iframe 抓取，译文不会被包含。');
      actions.appendChild(tip);
    }
  }

  function setProgress(done, total, path) {
    if (!progressEl) return;
    progressEl.hidden = false;
    progressEl.textContent = '';
    const bar = el('div', 'dw-bar');
    const inner = el('div', 'dw-bar-i');
    inner.style.width = Math.min(100, Math.round((done / Math.max(1, total)) * 100)) + '%';
    bar.appendChild(inner);
    const txt = el('div', 'dw-progress-txt', done + ' / ' + total + '　' + (path || ''));
    progressEl.appendChild(bar);
    progressEl.appendChild(txt);
  }

  function togglePanel() {
    ensureStyles();
    if (!panel || !panel.isConnected) buildPanel();
    if (panel.classList.contains('dw-open')) {
      panel.classList.remove('dw-open');
      return;
    }
    renderActions();
    panel.classList.add('dw-open');
  }

  function ensureFab() {
    const info = DW.detectPage(document);
    ensureStyles();
    if (info.type === 'home' || info.type === 'unknown') {
      if (fab && fab.isConnected) fab.remove();
      if (panel && panel.isConnected) panel.remove();
      return;
    }
    if (!fab || !fab.isConnected) ensureRoot();
  }

  /* 逐条导出/收藏入口统一放在悬浮面板的「逐条导出」列表里，不往页面正文里插按钮，
     避免与 DeepWiki 自身的 React 渲染相互干扰。 */

  /* ==================== 消息处理（供 popup 调用） ==================== */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.target) return false; // 定向给 offscreen / 其他上下文的消息，忽略
    const done = function (r) { try { sendResponse(r); } catch (e) { /* ignore */ } };

    if (msg.type === 'DW_STATUS') {
      (async function () {
        const info = DW.detectPage(document);
        const s = statusLine();
        let questions = [];
        if (info.type === 'search') {
          const l = DW.listQuestions(document);
          if (l.ok) questions = l.items.map(function (i) { return { index: i.index, question: i.question }; });
        }
        const notes = await readNotes();
        done({
          ok: true,
          page: {
            type: info.type,
            repo: info.repo,
            pageId: info.pageId,
            url: info.url,
            title: s.title,
            detail: s.detail
          },
          questions: questions,
          notesCount: notes.length
        });
      })();
      return true;
    }

    if (msg.type === 'DW_EXPORT') {
      (async function () {
        done(await exportCurrent(msg.kind || 'wiki', msg.onlyIndexes));
      })();
      return true;
    }

    if (msg.type === 'DW_COPY') {
      (async function () {
        done(await copyCurrent(msg.kind || 'wiki', msg.onlyIndexes));
      })();
      return true;
    }

    if (msg.type === 'DW_COLLECT') {
      (async function () {
        done(await collectCurrent(msg.kind || 'wiki', msg.onlyIndexes));
      })();
      return true;
    }

    if (msg.type === 'DW_BATCH') {
      (async function () {
        const info = DW.detectPage(document);
        if (info.type !== 'wiki') { done({ ok: false, error: '当前不是 Wiki 页面' }); return; }
        if (!panel || !panel.isConnected) buildPanel();
        panel.classList.add('dw-open');
        renderActions();
        progressEl.hidden = false;
        setProgress(0, collectWikiLinks(info.repo).length + 1, '准备中…');
        const r = await batchExport(function (d, t, p) { setProgress(d, t + 1, p); });
        progressEl.hidden = true;
        done(r);
      })();
      return true;
    }

    if (msg.type === 'DW_NOTES_CLEAR') {
      chrome.storage.local.set({ [NOTES_KEY]: [] }, function () { done({ ok: true }); });
      return true;
    }

    if (msg.type === 'DW_OPEN_PANEL') {
      togglePanel();
      done({ ok: true });
      return false;
    }

    return false;
  });

  /* ==================== 初始化 ==================== */

  function boot() {
    ensureFab();
    // DeepWiki 是单页应用，路由切换时也要保证按钮存在
    let last = location.href;
    setInterval(function () {
      if (location.href !== last) last = location.href;
      ensureFab();
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
