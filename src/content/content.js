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
    // 「一篇一个文件夹」模式下资源统一放在该页的 assets/ 里
    const dir = res.dir != null ? res.dir : dirOf(res.filename);
    (res.assets || []).forEach(function (a) {
      files.push({
        filename: dir + '/' + a.dir + '/' + a.name,
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

  /* ==================== 译文就绪（陪读蛙 / 沉浸式翻译等） ==================== */

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** 找到正文所在的可滚动容器（DeepWiki 的正文常在内层滚动区里） */
  function scrollContainerOf(el, win) {
    let p = el;
    while (p && p.nodeType === 1 && p !== win.document.body) {
      let cs = null;
      try { cs = win.getComputedStyle(p); } catch (e) { break; }
      if (cs && /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 40) return p;
      p = p.parentElement;
    }
    return win.document.scrollingElement || win.document.documentElement;
  }

  function articleRootOf(doc) {
    return doc.querySelector('div.prose-custom') || doc.body;
  }

  function statsOf(doc) {
    try {
      return DW.translationStats(doc);
    } catch (e) {
      return { blocks: 0, translated: 0, ratio: 0, wrappers: 0, only: 0 };
    }
  }

  function translationHint(doc) {
    return statsOf(doc);
  }

  /** 从头滚到底（小步 + 停顿），把「滚动到哪翻到哪」的翻译插件喂饱 */
  async function scrollPass(doc, opts) {
    const o = opts || {};
    const win = doc.defaultView;
    if (!win) return;
    const root = articleRootOf(doc);
    if (!root) return;
    const sc = scrollContainerOf(root, win);
    const delay = o.stepDelay || 300;
    const view = sc.clientHeight || win.innerHeight || 800;
    const step = Math.max(200, Math.round(view * (o.stepRatio || 0.6)));
    const limitOf = function () { return Math.max(0, (sc.scrollHeight || 0) - view + 40); };
    try { sc.scrollTop = 0; } catch (e) { /* ignore */ }
    await sleep(delay);
    for (let y = step, guard = 0; guard < 400; guard++, y += step) {
      const limit = limitOf();
      try { sc.scrollTop = y > limit ? limit : y; } catch (e) { break; }
      await sleep(delay);
      if (o.cancelled && o.cancelled()) return;
      if (y >= limit) break;
    }
    await sleep(delay);
  }

  /** 等译文数量不再增长（译文是分批返回的） */
  async function waitTranslationIdle(doc, opts) {
    const o = opts || {};
    const idleMs = o.idleMs || 4000;
    const maxMs = o.maxMs || 15000;
    const t0 = Date.now();
    let last = statsOf(doc).translated;
    let lastChange = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(400);
      const n = statsOf(doc).translated;
      if (n !== last) {
        last = n;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= idleMs) {
        break;
      }
      if (o.cancelled && o.cancelled()) break;
    }
    return statsOf(doc);
  }

  /**
   * 把整页翻完：滚一遍 → 等译文停 → 还有新增就再来一遍（最多 4 轮）。
   * 翻译插件按视口懒翻译，只滚一次往往只能覆盖开头一部分，这正是
   * 「只翻译了一部分」的原因。
   */
  async function translateWholePage(doc, opts) {
    const o = opts || {};
    let stats = statsOf(doc);
    if (!stats.blocks) return stats;
    let best = stats.translated;
    for (let pass = 0; pass < 4; pass++) {
      await scrollPass(doc, o);
      stats = await waitTranslationIdle(doc, {
        idleMs: o.idleMs || 4000,
        maxMs: o.waitMs || 15000,
        cancelled: o.cancelled
      });
      if (o.onPass) o.onPass(stats, pass + 1);
      if (o.cancelled && o.cancelled()) break;
      if (stats.translated <= best) break;   // 这一轮没有新译文 → 认为翻完了
      best = stats.translated;
    }
    return statsOf(doc);
  }

  /* ---------- 翻译插件：识别 / 开启页面翻译 ---------- */

  /**
   * 定位陪读蛙（read-frog）悬浮按钮里的「页面翻译开关」。
   * 用勾选徽标 .tabler-icon-check 定位，与界面语言无关。
   */
  function readFrogToggle() {
    let host = null;
    try { host = document.querySelector('read-frog'); } catch (e) { return null; }
    const sr = host && host.shadowRoot;
    if (!sr) return null;
    const btns = sr.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      const badge = btns[i].querySelector('.tabler-icon-check');
      if (badge) return { button: btns[i], badge: badge };
    }
    for (let i = 0; i < btns.length; i++) {
      const label = btns[i].getAttribute('aria-label') || '';
      if (/翻译|translate|翻訳|번역|traducir|traduire|übersetz/i.test(label)) {
        return { button: btns[i], badge: null };
      }
    }
    return null;
  }

  /** 陪读蛙页面翻译开关：true=已开 false=已关 null=读不到 */
  function readFrogEnabled() {
    const t = readFrogToggle();
    if (!t || !t.badge) return null;
    const cls = t.badge.getAttribute('class') || '';
    return /\bhidden\b/.test(cls) ? false : true;
  }

  function detectTranslationPlugin() {
    try {
      if (document.querySelector('read-frog') || document.querySelector('.read-frog-react-shadow-host')) {
        return 'read-frog';
      }
      if (document.querySelector('[class*="immersive-translate"],[class*="immersive_translate"]')) {
        return 'immersive-translate';
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  /**
   * 把陪读蛙的「页面翻译」开关切到指定状态。
   *
   * 注意这是个**开关**：读错状态再点一下就会切反（实测会让整页仍是英文），
   * 所以这里做成自纠正的：
   *   - 按钮或状态读不到时**宁可不点**，也不冒险乱切；
   *   - 点完必须看到徽标变成目标状态，否则再点一次（最多 3 次）。
   * @param {boolean} target 目标状态
   * @returns {Promise<boolean|null>} 是否达成；null = 认不出开关，没动它
   */
  async function setTranslationEnabled(target) {
    const toggle = readFrogToggle();
    if (!toggle || !toggle.badge) return null;           // 认不出开关就别乱点
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = readFrogEnabled();
      if (state === null) return null;
      if (state === target) return true;
      try { toggle.button.click(); } catch (e) { return null; }
      for (let i = 0; i < 14; i++) {
        await sleep(300);
        const now = readFrogEnabled();
        if (now === null) return null;
        if (now === target) return true;
        if (i >= 5) break;                               // 没生效 ⇒ 再点一次
      }
    }
    return readFrogEnabled() === target;
  }

  /**
   * 确认陪读蛙的「页面翻译」开关处于开启状态。
   * @returns {Promise<boolean>} 当前是否处于「开启」状态
   */
  async function ensureTranslationOn() {
    if (statsOf(document).translated > 0) return true;   // 已经有译文 ⇒ 开关是开的
    return (await setTranslationEnabled(true)) === true;
  }

  /**
   * 尽力让翻译插件开始翻译当前页。
   * 陪读蛙默认不会自动翻 deepwiki.com（自动翻译站点列表是空的），
   * 需要把「页面翻译」开关打开；开关是按标签页记的，打开后本标签页内
   * 后续翻到的页面都会自动翻译。
   */
  async function ensurePageTranslation() {
    const plugin = detectTranslationPlugin();
    if (plugin !== 'read-frog') return { plugin: plugin, on: null };
    return { plugin: plugin, on: await ensureTranslationOn() };
  }

  /**
   * 导出前：译文没翻完时，问一下要不要先把整页滚一遍补齐。
   * 阈值取 0.85 而不是「翻了一半」——按块统计天然会把图片节点标签、引用标记
   * 这类不参与翻译的内容算成未翻译，留一点余量，别让真正缺译文的情况溜过去。
   */
  const TRANSLATION_OK_RATIO = 0.85;

  async function ensureTranslationComplete(doc) {
    const tr = await ensurePageTranslation();
    let cov = translationHint(doc);
    if (!cov.blocks) return cov;                        // 没有正文块
    if (cov.ratio >= TRANSLATION_OK_RATIO) return cov;
    const plugin = tr.plugin || detectTranslationPlugin();
    if (!cov.translated && !plugin) return cov;         // 没装翻译插件，没什么可等的
    const pct = Math.round(cov.ratio * 100);
    const yes = confirm(
      '检测到页面只翻译了约 ' + pct + '%（' + cov.translated + '/' + cov.blocks + ' 处）。\n\n' +
      '陪读蛙这类插件是「滚动到哪翻到哪」，没滚到的部分还是英文。\n' +
      '是否先自动滚动整页、等翻译补齐后再导出？\n\n' +
      '（点「取消」＝ 直接按当前内容导出）'
    );
    if (!yes) return cov;
    toast('正在滚动页面以补齐译文…', 'info');
    cov = await translateWholePage(doc, {
      onPass: function (s, n) {
        toast('译文补齐中：第 ' + n + ' 轮，已译 ' + s.translated + '/' + s.blocks + ' 处', 'info');
      }
    });
    toast('译文已更新：' + cov.translated + '/' + cov.blocks + ' 处（约 ' +
      Math.round(cov.ratio * 100) + '%）', 'ok');
    return cov;
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
    await ensureTranslationComplete(document);
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
    const cov = statsOf(document);
    return Object.assign({}, res, {
      ok: !!dl.ok,
      downloaded: !!dl.ok,
      downloadError: dl.error || '',
      translations: cov.translated,
      translatedBlocks: cov.translated,
      blocks: cov.blocks,
      markdown: undefined,
      assets: undefined
    });
  }

  async function copyCurrent(kind, onlyIndexes) {
    const opts = await getOptions();
    await ensureTranslationComplete(document);
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
    await ensureTranslationComplete(document);
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

  /* ==================== 整站批量导出（在当前标签页自动翻页） ====================
   * 为什么不再用隐藏 iframe：
   *   陪读蛙（read-frog）只在顶级框架注入内容脚本（它的 iframe 注入被限制在
   *   极少数站点），所以在 iframe 里根本不存在翻译插件，抓到的永远是英文原文。
   * 现在的做法：
   *   在当前标签页里顺着侧边栏链接做「单页应用内跳转」，每页滚一遍触发懒翻译、
   *   等译文不再增长后再提取。页面可见、流程可控、随时能停。
   */

  /** 把绝对路径变成相对某个目录的路径（生成 00-目录.md 里的链接用） */
  function relativeTo(path, base) {
    if (!base) return path;
    const prefix = base.replace(/\/+$/, '') + '/';
    return path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path.split('/').pop();
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

  /**
   * 批量导出要跑的页面清单。
   * 侧边栏里没有指向「仓库首页」的导航链接，所以当前恰好停在首页时把它补在最前面
   * （此时人就在这一页，不需要跳转，直接抓就行）。
   */
  function batchPagePaths(repo) {
    const out = collectWikiLinks(repo);
    if (!repo) return out;
    const root = '/' + repo;
    const here = pathOf(location.pathname);
    if (here === root && out.indexOf(root) < 0) out.unshift(root);
    return out;
  }

  function pathOf(url) {
    try {
      const p = new URL(url, location.href).pathname.replace(/\/+$/, '');
      return p || '/';
    } catch (e) {
      return '';
    }
  }

  /** 当前文档里指向某个 wiki 路径的链接（侧边栏那一份） */
  function findWikiLink(path, doc) {
    const list = doc.querySelectorAll('a[href]');
    for (let i = 0; i < list.length; i++) {
      const raw = list[i].getAttribute('href') || '';
      if (!raw || /^[a-z]+:/i.test(raw) || raw.charAt(0) !== '/') continue;
      if (raw.replace(/[?#].*$/, '').replace(/\/+$/, '') === path) return list[i];
    }
    return null;
  }

  /** 当前正文的指纹：路由变化后判断新页面是否已经渲染出来 */
  function articleSignature(doc) {
    const root = doc.querySelector('div.prose-custom');
    if (!root) return '';
    const h1 = root.querySelector('h1');
    return norm(h1 ? h1.textContent : '') + '|' + norm(root.textContent).slice(0, 160);
  }

  /**
   * 单页应用内跳转到某个 wiki 页面（点侧边栏链接，不整页刷新）。
   * 必须不整页刷新：刷新会重载内容脚本，正在跑的批量任务会中断。
   */
  async function navigateSpa(path, doc) {
    const win = doc.defaultView || window;
    if (pathOf(win.location.pathname) === path) return true;
    const a = findWikiLink(path, doc);
    if (!a) return false;
    const before = articleSignature(doc);
    try { a.click(); } catch (e) { return false; }
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      await sleep(250);
      if (pathOf(win.location.pathname) !== path) continue;
      if (articleSignature(doc) !== before) return true;
    }
    return pathOf(win.location.pathname) === path;
  }

  /** 还有几张 Mermaid 图没渲染完（DeepWiki 把源码放 <pre> 里，渲染好后替换成 svg） */
  function pendingDiagrams(doc) {
    const root = doc.querySelector('div.prose-custom');
    if (!root) return 0;
    let n = 0;
    Array.prototype.forEach.call(root.querySelectorAll('pre'), function (pre) {
      if (pre.querySelector('svg')) return;
      const t = (pre.textContent || '').trim();
      if (/^(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram|gantt|mindmap|timeline|pie|journey|gitGraph|C4Context|block-beta|quadrantChart)/.test(t)) n++;
    });
    return n;
  }

  /**
   * 等这一页「渲染完整」：正文不再增长、Mermaid 图都渲染完。
   * 不滚动也能拿到完整正文与图表（实测 9 张图静置几秒即可全部渲染），
   * 所以原文模式下根本不需要滚页，这也是导出能快起来的关键。
   */
  async function waitForPageReady(doc, timeoutMs) {
    const limit = timeoutMs || 25000;
    const t0 = Date.now();
    let lastSig = '';
    let stable = 0;
    while (Date.now() - t0 < limit) {
      const root = doc.querySelector('div.prose-custom');
      const len = root ? norm(root.textContent).length : 0;
      const svg = root ? root.querySelectorAll('pre > svg').length : 0;
      const pending = pendingDiagrams(doc);
      const sig = len + '|' + svg + '|' + pending;
      if (len > 200 && pending === 0 && sig === lastSig) {
        stable++;
        if (stable >= 3) return true;
      } else {
        stable = 0;
      }
      lastSig = sig;
      await sleep(200);
    }
    return false;
  }

  let batchCancelled = false;

  async function batchExport(onProgress, batchOpts) {
    const opts = await getOptions();
    // original = 只导出原文（快，译文交给后续的大模型）；translated = 逐页等译文（慢）
    const mode = (batchOpts && batchOpts.mode) === 'translated' ? 'translated' : 'original';
    const wantTranslation = mode === 'translated';
    const info = DW.detectPage(document);
    const repo = info.repo;
    if (!repo) return { ok: false, error: '当前页面不是仓库 Wiki 页面' };

    const links = batchPagePaths(repo);
    if (!links.length) return { ok: false, error: '未在页面上找到可导出的 Wiki 页面链接' };

    const cancelled = function () { return batchCancelled; };
    const startPath = pathOf(location.pathname);
    batchCancelled = false;

    const plugin = detectTranslationPlugin();
    let translationOn = false;
    let restoreTranslation = false;   // 原文模式临时关掉翻译，结束后恢复

    if (wantTranslation) {
      // 陪读蛙不会自动翻这个站点，需要先把「页面翻译」开关打开（开关按标签页记）
      if (onProgress) onProgress(0, links.length, '检查翻译插件…');
      translationOn = await ensureTranslationOn();
    } else if (plugin === 'read-frog') {
      // 原文模式：翻译插件开着会把正文就地替换成中文（原文就没了），
      // 而后续要用大模型翻译又必须拿到原文，所以先临时关掉，结束后恢复。
      const was = readFrogEnabled();
      if (was === true) {
        if (onProgress) onProgress(0, links.length, '临时关闭翻译插件…');
        if ((await setTranslationEnabled(false)) === true) restoreTranslation = true;
      }
    }

    const index = [];
    const failed = [];
    const lowCoverage = [];
    let done = 0;
    let assetCount = 0;
    let translationCount = 0;
    let noTranslationPages = 0;
    let stillTranslated = 0;
    let dir = '';
    let dirReady = false;

    for (let i = 0; i < links.length; i++) {
      if (batchCancelled) break;
      const path = links[i];
      if (onProgress) onProgress(done, links.length, '翻页中：' + path);

      const ok = await navigateSpa(path, document);
      if (!ok) {
        failed.push(path + '（侧边栏里没有该页面的链接，可单独打开该页导出）');
        done++;
        if (onProgress) onProgress(done, links.length, path);
        continue;
      }
      await waitForPageReady(document, 25000);
      if (batchCancelled) break;

      let stats = statsOf(document);
      if (wantTranslation) {
        // 滚动 + 等译文，把整页翻完
        const pagePlugin = detectTranslationPlugin();
        if (pagePlugin) {
          if (!translationOn || !stats.translated) {
            translationOn = await ensureTranslationOn();
          }
          const onPass = function (s, n) {
            if (!onProgress) return;
            onProgress(done, links.length, '翻译中：' + path +
              '（第 ' + n + ' 轮，已译 ' + s.translated + '/' + s.blocks + ' 处）');
          };
          if (onProgress) onProgress(done, links.length, '翻译中：' + path);
          stats = await translateWholePage(document, { cancelled: cancelled, onPass: onPass });
          // 整页一处译文都没有：多半是上一页把「页面翻译」开关碰反了，
          // 重新对齐开关后再补一轮，别白白导出一页英文。
          if (!stats.translated && !batchCancelled) {
            translationOn = await ensureTranslationOn();
            if (translationOn) {
              stats = await translateWholePage(document, { cancelled: cancelled, onPass: onPass });
            }
          }
          translationCount += stats.translated;
          if (!stats.translated) noTranslationPages++;
          else if (stats.blocks && stats.ratio < 0.8) lowCoverage.push(path);
        }
      } else if (stats.translated > 0) {
        stillTranslated++;   // 原文模式：这一页仍带译文（插件没关掉 / 页面本来就是中文）
      }
      if (batchCancelled) break;

      let res = null;
      try { res = DW.buildWikiPage(document, opts); } catch (e) { res = null; }
      if (!res || !res.ok) {
        failed.push(path);
        done++;
        if (onProgress) onProgress(done, links.length, path);
        continue;
      }

      if (!dirReady) {
        dir = res.repoDir != null ? res.repoDir : dirOf(res.filename);
        dirReady = true;
      }
      const fileDir = res.dir != null ? res.dir : dirOf(res.filename);
      const files = [{
        filename: res.filename,
        content: res.markdown,
        mime: 'text/markdown;charset=utf-8'
      }];
      (res.assets || []).forEach(function (a) {
        assetCount++;
        files.push({
          filename: fileDir + '/' + a.dir + '/' + a.name,
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
        link: relativeTo(res.filename, dir),
        url: res.url
      });

      done++;
      if (onProgress) {
        onProgress(done, links.length, path +
          (wantTranslation ? '（已译 ' + stats.translated + '/' + stats.blocks + ' 处）' : ''));
      }
      await sleep(150);
    }

    // 回到开始时的页面（批量已结束，这里允许整页刷新兜底）
    if (!batchCancelled && startPath && pathOf(location.pathname) !== startPath) {
      if (findWikiLink(startPath, document)) {
        await navigateSpa(startPath, document);
      } else {
        try { location.assign(startPath); } catch (e) { /* ignore */ }
      }
    }

    // 原文模式下临时关掉的翻译开关，这里恢复回去
    if (restoreTranslation) await setTranslationEnabled(true);

    if (index.length) {
      const lines = [
        '# ' + repo + ' · DeepWiki 目录',
        '',
        '> 来源：https://deepwiki.com/' + repo,
        '> 导出时间：' + DW.nowLocalIso(),
        '> 共 ' + index.length + ' 个页面',
        '> 结构：每个页面一个独立文件夹（' + (opts.pageFileName || 'index') + '.md + assets/）',
        ''
      ];
      index.forEach(function (it) {
        // 页面名里可能有括号（如 2.6-core-engine-(segcore)），链接目标必须编码
        lines.push('- [' + it.title + '](' + DW.mdPath(encodeURI(it.link)) + ')');
      });
      await bg({
        type: 'DW_DOWNLOAD_BATCH',
        files: [{
          filename: (dir ? dir + '/' : '') + '00-目录.md',
          content: lines.join('\n') + '\n',
          mime: 'text/markdown;charset=utf-8'
        }]
      });
    }

    if (!index.length) {
      return {
        ok: false,
        error: batchCancelled ? '已停止（没有成功导出任何页面）' : '没有成功导出任何页面',
        failed: failed,
        cancelled: batchCancelled
      };
    }
    return {
      ok: true,
      mode: mode,
      pages: index.length,
      assets: assetCount,
      translations: translationCount,
      dir: dir,
      failed: failed,
      lowCoverage: lowCoverage,
      noTranslationPages: noTranslationPages,
      stillTranslated: stillTranslated,
      plugin: plugin,
      translationOn: translationOn,
      cancelled: batchCancelled
    };
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

  function translationTag() {
    const cov = translationHint(document);
    if (!cov.blocks) return '';
    return ' ｜ 译文 ' + cov.translated + '/' + cov.blocks + ' 处（约 ' + Math.round(cov.ratio * 100) + '%）';
  }

  function statusLine() {
    const info = DW.detectPage(document);
    if (info.type === 'search') {
      const ext = DW.extractSearch(document);
      const n = ext.ok ? ext.items.length : 0;
      return {
        kind: 'search',
        title: '问答页面',
        detail: (ext.ok ? ext.repo || '未知仓库' : '未识别仓库') + ' ｜ 检测到 ' + n + ' 组问答' + translationTag()
      };
    }
    if (info.type === 'wiki') {
      const ext = DW.extractWiki(document);
      return {
        kind: 'wiki',
        title: 'Wiki 页面',
        detail: info.repo + ' ｜ ' + (ext.ok ? ext.title : '正文未就绪') + translationTag()
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
      const links = batchPagePaths(info.repo);
      const b = mk('批量导出整个 Wiki（' + links.length + ' 页）', '', async function () {
        if (!links.length) { toast('未找到 Wiki 页面链接', 'info'); return; }
        const mode = askBatchMode(links.length);
        if (mode === null) return;
        progressEl.hidden = false;
        batchCancelled = false;
        let lastDone = 0;
        setProgress(0, links.length, mode === 'translated' ? '准备翻译插件…' : '准备中…', true);
        const r = await batchExport(function (done, total, path) {
          lastDone = done;
          setProgress(done, total, path, true);
        }, { mode: mode });
        setProgress(lastDone, links.length, '', false);
        if (r.ok) {
          const extra = [];
          if (r.failed.length) extra.push(r.failed.length + ' 个失败');
          if (r.mode === 'translated') {
            if (r.noTranslationPages) extra.push(r.noTranslationPages + ' 页没拿到译文');
            else if (r.lowCoverage && r.lowCoverage.length) extra.push(r.lowCoverage.length + ' 页译文不完整');
          } else if (r.stillTranslated) {
            extra.push(r.stillTranslated + ' 页仍带译文');
          }
          toast((r.cancelled ? '已停止，' : '') + '已导出 ' + r.pages + ' 个页面' +
            (r.mode === 'translated' ? ' · 共 ' + r.translations + ' 处译文' : '') +
            (extra.length ? '（' + extra.join('，') + '）' : ''),
            r.cancelled ? 'info' : 'ok');
          if (r.failed.length) console.warn('[DeepWiki→MD] 批量导出未完成的页面：', r.failed);
        } else {
          toast(r.cancelled ? '已停止批量导出' : '批量导出失败：' + r.error, r.cancelled ? 'info' : 'err');
        }
      });
      if (!links.length) b.disabled = true;
      const modeTip = (options.batchTranslation === 'translated')
        ? '当前设置：逐页等待译文（慢，直接出中文）。'
        : (options.batchTranslation === 'ask'
          ? '当前设置：每次导出前询问。'
          : '当前设置：只导出原文（快）——译文可以在导出后交给大模型处理。');
      const tip = el('div', 'dw-tip', '批量导出会在当前标签页里自动翻页：' +
        '顺着侧边栏逐页打开、等正文与架构图渲染完整后提取，每页存成一个独立文件夹' +
        '（含 ' + (options.pageFileName || 'index') + '.md 与 assets/ 图片），' +
        '并在仓库目录下生成 00-目录.md。完成后会自动回到起始页面。\n' +
        modeTip + '\n' +
        '全程页面可见、可随时「停止」；重复导出同名页面会直接覆盖旧文件。');
      actions.appendChild(tip);
    }
  }

  /**
   * 批量导出模式：由设置决定，'ask' 时弹窗询问。
   * @returns {'original'|'translated'|null} null = 用户取消导出
   */
  function askBatchMode(pageCount) {
    const setting = options.batchTranslation || 'original';
    if (setting !== 'ask') return setting;

    const cov = translationHint(document);
    const plugin = detectTranslationPlugin();
    const head = '将自动翻页导出 ' + pageCount + ' 个页面（会在当前标签页里逐页打开）。\n\n';
    const tail = '点「确定」＝ 只导出原文（快，译文后续交给大模型）\n' +
      '点「取消」＝ 逐页等待译文（慢，直接出中文）';
    if (plugin === 'read-frog') {
      return confirm(head + '已检测到陪读蛙（read-frog）。原文模式下会先临时关掉它的页面翻译' +
        '（否则正文会被就地替换成中文、原文就没了），导出结束再恢复。\n' +
        '本页当前译文 ' + cov.translated + '/' + cov.blocks + ' 处。\n\n' + tail)
        ? 'original' : 'translated';
    }
    if (plugin) {
      return confirm(head + '已检测到翻译插件（' + plugin + '）。\n\n' + tail)
        ? 'original' : 'translated';
    }
    return confirm(head + '没有检测到翻译插件，本来也只能导出原文。\n\n' +
      '点「确定」＝ 继续 ／ 点「取消」＝ 先不导出') ? 'original' : null;
  }

  /* 进度条：批量导出时额外挂一个「停止」按钮 */
  let stopTimer = null;

  function setProgress(done, total, path, running) {
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
    if (running) {
      const stop = el('button', 'dw-btn dw-btn-ghost', '停止');
      stop.addEventListener('click', function () {
        batchCancelled = true;
        stop.disabled = true;
        stop.textContent = '正在停止…';
      });
      progressEl.appendChild(stop);
    }
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
        const linkCount = batchPagePaths(info.repo).length;
        let lastDone = 0;
        const batchOpts = await getOptions();
        const mode = batchOpts.batchTranslation === 'translated' ? 'translated' : 'original';
        setProgress(0, linkCount, mode === 'translated' ? '准备翻译插件…' : '准备中…', true);
        const r = await batchExport(function (d, t, p) {
          lastDone = d;
          setProgress(d, t, p, true);
        }, { mode: mode });
        setProgress(lastDone, linkCount, '', false);
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
