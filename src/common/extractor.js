/*!
 * DeepWiki → Markdown  Exporter
 * 核心模块：页面识别 / 内容提取 / DOM 清洗 / Markdown 转换
 *
 * 设计要点：
 *  1) 全部基于「实时 DOM」提取，因此翻译插件（沉浸式翻译、陪读蛙 read-frog、
 *     Google 翻译等）写回页面的译文会被原样导出；
 *  2) 所有函数都以 document 为入参，便于对同源 iframe 复用（整站批量导出）；
 *  3) 依赖 TurndownService 与 turndownPluginGfm 两个全局变量。
 *
 * 陪读蛙（read-frog）适配说明：
 *  它把译文写进 <span class="notranslate read-frog-translated-content-wrapper">
 *  并插在原文元素内部（或紧随其后），译文正文在 .read-frog-translated-block-content
 *  / .read-frog-translated-inline-content 里；「仅译文」模式则是原文本地替换，
 *  并在元素上打 data-read-frog-translation-only（同时给元素加 lang="zh"）标记。
 *  因此本文件：保护译文节点不被清洗删掉、剔除它的加载态/报错 UI、
 *  把译文单独成段，并在统计译文覆盖率时同时认这两种形态。
 */
(function (global) {
  'use strict';

  /* ==================== 默认选项 ==================== */

  const DEFAULT_OPTIONS = {
    // 输出格式
    frontMatter: true,            // 输出 YAML front-matter
    sourceLine: true,             // 正文顶部插入来源链接
    qaSeparator: true,            // 问答之间插入 --- 分隔线
    qaHeadingPrefix: 'Q',         // 问答标题前缀（Q1. / Q2. ...）
    demoteAnswerHeadings: true,   // 回答内标题整体降一级
    // 内容取舍
    includeSourceFiles: false,    // wiki 页面保留「相关源文件」折叠列表
    includeQASources: true,       // 问答底部保留「来源文件」
    citationLinks: true,          // 引用标记 [file.go:12-34] 转成 GitHub 链接
    dropHidden: true,             // 丢弃页面上不可见的元素
    // 图表
    diagramMode: 'files',         // files（独立 svg 文件）| datauri（内嵌 base64）| skip
    diagramAlt: '架构图',
    // 文件名 / 目录
    folderPerPage: true,          // 一篇一个文件夹：<子目录>/<owner>/<repo>/<页面>/index.md
    pageFileName: 'index',        // 文件夹内的正文文件名（不含 .md）
    subfolder: 'DeepWiki',        // 下载根目录，留空表示直接下载到下载目录
    wikiFilename: '{repo}-{pageId}',
    qaFilename: '{repo}-问答-{date}',
    multiQaFilename: '{repo}-问答合集-{date}',
    // 批量导出的译文处理：
    //   original   只导出原文（快），译文交给后续的大模型处理
    //   translated 逐页滚动、等译文补齐再导出（慢）
    //   ask        每次导出前询问
    batchTranslation: 'original',
    // 其他
    timestamp: false              // 文件名追加时分秒
  };

  const VERSION = '1.2.0';

  /* ==================== 基础工具 ==================== */

  function mergeOptions(o) {
    return Object.assign({}, DEFAULT_OPTIONS, o || {});
  }

  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\n]+/g, ' ')
      .trim();
  }

  function textOf(el) {
    return el ? norm(el.textContent) : '';
  }

  function docBase(doc) {
    try {
      return (doc.location && doc.location.href) || (global.location && global.location.href) || '';
    } catch (e) {
      return (global.location && global.location.href) || '';
    }
  }

  function absolute(url, base) {
    if (!url) return url;
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url;
    }
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function nowLocalIso() {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60)
    );
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function timeStr() {
    const d = new Date();
    return pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function base64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function sanitizeSegment(seg) {
    return String(seg == null ? '' : seg)
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=\[\]\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/-{2,}/g, '-')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .slice(0, 100) || 'untitled';
  }

  function renderTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] == null ? '' : String(vars[k]);
    });
  }

  /* ==================== 页面识别 ==================== */

  function detectPage(doc) {
    const base = docBase(doc);
    let u;
    try {
      u = new URL(base);
    } catch (e) {
      return { type: 'unknown', url: base };
    }
    const parts = u.pathname.split('/').filter(Boolean);
    const origin = u.origin;
    if (parts[0] === 'search') {
      return {
        type: 'search',
        url: origin + u.pathname,
        searchId: parts[1] || '',
        repo: '',
        pageId: ''
      };
    }
    if (parts.length >= 2) {
      const repo = parts[0] + '/' + parts[1];
      const pageId = parts.slice(2).join('/');
      return {
        type: 'wiki',
        url: origin + u.pathname,
        repo: repo,
        pageId: pageId || 'overview'
      };
    }
    return { type: 'home', url: origin + u.pathname, repo: '', pageId: '' };
  }

  /* ==================== 译文检测（陪读蛙 / 沉浸式翻译等） ====================
   * 译文落到 DOM 里有两种形态：
   *  1) 另外插一个译文容器（read-frog 双语模式、沉浸式翻译默认模式）——
   *     形如 <span class="read-frog-translated-content-wrapper">…</span>
   *  2) 直接把原文就地替换成译文（read-frog「仅译文」模式）——
   *     元素上带 data-read-frog-translation-only / lang="zh"，没有译文容器
   * 早期实现只数第 1 种容器，于是「仅译文」模式下覆盖率恒为 0，
   * 界面会误报「没有译文」、也不会触发滚动补齐。
   * 现在统一按「正文块里的中文是否已占多数」来判定，两种形态与其它插件都覆盖。
   */

  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
  const CJK_ALL_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g;
  const LATIN_ALL_RE = /[A-Za-z]/g;
  const TRANSLATABLE_SEL = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,td,th';
  // 译文目标语言（这些 lang 值说明该块已被就地替换成译文）
  const TRANSLATED_LANGS = /^(zh|cmn|yue|ja|ko)/i;

  function proseRoot(doc) {
    return doc.querySelector(SEL.prose) || doc.querySelector(SEL.proseFallback);
  }

  function cjkCount(s) {
    const m = String(s == null ? '' : s).match(CJK_ALL_RE);
    return m ? m.length : 0;
  }

  function latinCount(s) {
    const m = String(s == null ? '' : s).match(LATIN_ALL_RE);
    return m ? m.length : 0;
  }

  /**
   * 这段文字像不像「该被翻译的正文」。
   * 用来排除文件名（minio.Client…）、代码标识符（segcore::Segcore）、
   * 图表节点标签这类本来就不参与翻译的内容，避免把覆盖率算低。
   */
  function isProseText(t) {
    if (!t) return false;
    if (CJK_RE.test(t)) return true;
    // 真实句子/标题一定有「小写单词 + 空白或标点」，而 minio.Client…、segcore::Segcore
    // 这类标识符没有；两个方向都试，短句 / 单句结尾也能认出来。
    return /[a-z]{2,}[\s,;!?)]/.test(t) || /\s[a-z]{2,}/.test(t);
  }

  /** 正文里「本该被翻译」的块 */
  function translatableBlocks(doc) {
    const root = proseRoot(doc);
    if (!root) return [];
    let all;
    try {
      all = root.querySelectorAll(TRANSLATABLE_SEL);
    } catch (e) {
      return [];
    }
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.closest && el.closest(RF.wrapper)) continue;  // 译文容器内部不算
      if (el.closest && el.closest('details')) continue;   // 「相关源文件」文件清单不参与翻译
      const t = norm(el.textContent);
      if (t.length < 8) continue;
      if (!isProseText(t)) continue;
      out.push(el);
    }
    return out;
  }

  /** 这个正文块是否已经有译文（两种译文形态都覆盖） */
  function isTranslatedBlock(el) {
    if (!el) return false;
    if (el.querySelector && el.querySelector(RF.wrapper)) return true;   // 双语：块里插了译文容器
    const lang = (el.getAttribute && el.getAttribute('lang')) || '';
    if (TRANSLATED_LANGS.test(lang)) return true;                        // 仅译文：就地替换并打了 lang
    if (el.hasAttribute && el.hasAttribute('data-read-frog-translation-only')) return true;
    const t = norm(el.textContent);                                      // 通用兜底：中文占多数
    const c = cjkCount(t);
    const l = latinCount(t);
    return (c + l) > 0 && c / (c + l) > 0.3;
  }

  /** 译文统计：blocks=正文块数，translated=已有译文的块数 */
  function translationStats(doc) {
    const blocks = translatableBlocks(doc);
    let translated = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (isTranslatedBlock(blocks[i])) translated++;
    }
    let only = 0;
    try {
      only = doc.querySelectorAll('[data-read-frog-translation-only]').length;
    } catch (e) { only = 0; }
    return {
      blocks: blocks.length,
      translated: translated,
      ratio: blocks.length ? translated / blocks.length : 0,
      wrappers: countTranslations(doc),
      only: only
    };
  }

  /** 当前文档里已经写进 DOM 的译文容器条数（加载中的占位不算） */
  function countTranslations(doc) {
    let list;
    try {
      list = doc.querySelectorAll(RF.wrapper);
    } catch (e) {
      return 0;
    }
    let n = 0;
    Array.prototype.forEach.call(list, function (w) {
      if ((w.textContent || '').replace(/\s+/g, '').length) n++;
    });
    return n;
  }

  /** 正文里「本该被翻译」的块数 */
  function countTranslatableBlocks(doc) {
    return translatableBlocks(doc).length;
  }

  /** 译文覆盖率（0~1），用于导出前提示用户「还没翻译完」 */
  function translationCoverage(doc) {
    const s = translationStats(doc);
    return {
      count: s.translated,
      blocks: s.blocks,
      ratio: s.ratio,
      wrappers: s.wrappers,
      only: s.only
    };
  }

  /* ==================== 页面结构常量 ==================== */

  const SEL = {
    prose: 'div.prose-custom',
    proseFallback: 'div.prose, article, main',
    qaBlock: '[data-query-display="true"]',
    question: 'span.text-xl, [class*="text-xl"]',
    sourceCard: '[id^="file-"]'
  };

  /* 陪读蛙（read-frog）译文节点 */
  const RF = {
    wrapper: '.read-frog-translated-content-wrapper',
    block: '.read-frog-translated-block-content',
    inline: '.read-frog-translated-inline-content',
    // 加载态 / 报错 UI：必须剔除，它们不是译文
    ui: [
      '.read-frog-spinner',
      '.read-frog-react-shadow-host',
      '.read-frog-translation-error-container',
      '[class*="read-frog-translation-error"]'
    ]
  };

  /** 元素自身是否带陪读蛙标记（译文节点、原文被替换的锚点等） */
  function isReadFrogMarked(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls && cls.indexOf('read-frog-') >= 0) return true;
    if (el.hasAttribute && (el.hasAttribute('data-read-frog-translation-only') ||
        el.hasAttribute('data-read-frog-translation-mode'))) return true;
    return false;
  }

  /** 是否是承载译文的容器 */
  function isTranslationNode(el) {
    if (!el || el.nodeType !== 1 || !el.classList) return false;
    return el.classList.contains('read-frog-translated-content-wrapper') ||
      el.classList.contains('read-frog-translated-block-content') ||
      el.classList.contains('read-frog-translated-inline-content');
  }

  /** 需要从导出结果中剔除的「界面元素」 */
  const REMOVE_SELECTORS = [
    'button', 'script', 'style', 'noscript', 'template', 'link', 'meta',
    'iframe', 'canvas', 'video', 'audio', 'dialog', 'form', 'input',
    'select', 'textarea', 'svg', 'path',
    '[role="dialog"]', '[role="tooltip"]', '[role="menu"]', '[role="menubar"]',
    '[role="navigation"]', '[role="banner"]', '[role="tablist"]', '[role="tab"]',
    '[aria-hidden="true"]', '.sr-only', '.notranslate-ui',
    '[data-radix-popper-content-wrapper]', '[data-state="closed"][data-slot="dialog-trigger"]',
    // 翻译插件的界面（保留 target 即译文本身）
    '[class*="immersive-translate"]:not([class*="target"])',
    '[class*="immersive_translate"]:not([class*="target"])',
    '[class*="translation-widget"]', '[class*="translate-button"]',
    // 陪读蛙的加载态与报错 UI（译文本身不在此列）
    '.read-frog-spinner', '.read-frog-react-shadow-host',
    '.read-frog-translation-error-container', '[class*="read-frog-translation-error"]',
    '.dw-md-export-ui'
  ];

  const HIDDEN_ATTR = 'data-dw-hidden-tmp';

  /* ==================== DOM 清洗 ==================== */

  function markHidden(root, win) {
    const marked = [];
    let all;
    try {
      all = root.querySelectorAll('*');
    } catch (e) {
      return marked;
    }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      let cs = null;
      try {
        cs = win.getComputedStyle(el);
      } catch (e) {
        continue;
      }
      if (!cs) continue;
      if (cs.display === 'none') {
        try {
          el.setAttribute(HIDDEN_ATTR, '1');
        } catch (e) { /* ignore */ }
        marked.push(el);
        continue;
      }
      // 译文节点可能被翻译插件的样式预设调成半透明 / 模糊后再淡入，
      // 这类「暂时不可见」不等于「不该导出」，不能按隐藏元素丢掉。
      if (isTranslationNode(el) || isReadFrogMarked(el)) continue;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') {
        try {
          el.setAttribute(HIDDEN_ATTR, '1');
        } catch (e) { /* ignore */ }
        marked.push(el);
      }
    }
    return marked;
  }

  function unmarkHidden(marked) {
    for (let i = 0; i < marked.length; i++) {
      try {
        marked[i].removeAttribute(HIDDEN_ATTR);
      } catch (e) { /* ignore */ }
    }
  }

  function serializeSvg(svg, doc) {
    const c = svg.cloneNode(true);
    if (!c.getAttribute('xmlns')) c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!c.getAttribute('xmlns:xlink')) c.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    let w = 0, h = 0;
    const vb = (c.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      w = Math.round(vb[2]);
      h = Math.round(vb[3]);
    }
    if (!w || !h) {
      w = parseFloat(c.getAttribute('width')) || 900;
      h = parseFloat(c.getAttribute('height')) || 600;
    }
    c.setAttribute('width', String(w));
    c.setAttribute('height', String(h));
    c.removeAttribute('style');
    c.removeAttribute('tabindex');
    try {
      return new XMLSerializer().serializeToString(c);
    } catch (e) {
      return c.outerHTML;
    }
  }

  /**
   * Markdown 链接目标里出现的 `(` `)` 和空格必须百分号编码，
   * 否则像 `2.6-core-engine-(segcore)` 这种页面名会把链接截断：
   * `![图](assets/2.6-core-engine-(segcore)-diagram-1.svg)` 会被解析成
   * 目标 `assets/2.6-core-engine-(segcore`。
   */
  function mdPath(p) {
    return String(p == null ? '' : p).replace(/[()\s]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  /** DeepWiki 会在图表前放一个 `<p>Title: xxxxx</p>`，把它变成图片说明 */
  function takeDiagramCaption(container) {
    const prev = container.previousElementSibling;
    if (!prev) return '';
    const t = textOf(prev);
    const m = /^(?:Title|Figure|图\s*表?标题|标题)\s*[:：]\s*(.+)$/i.exec(t);
    if (!m) return '';
    const caption = m[1].trim();
    try {
      prev.remove();
    } catch (e) { /* ignore */ }
    return caption;
  }

  function isDiagramSvg(svg) {
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') return false;
    const id = svg.getAttribute('id') || '';
    if (/^mermaid/i.test(id)) return true;
    const role = (svg.getAttribute('aria-roledescription') || '').toLowerCase();
    if (role && role !== 'image' && role !== 'graphics-document' && role !== 'img') return true;
    const cls = (typeof svg.className === 'string' ? svg.className : '') || '';
    return /flowchart|sequence|classdiagram|erdiagram|statediagram|gantt|mindmap|timeline|pie/i.test(cls);
  }

  /**
   * 抽取图表，替换成占位 token，返回 [{token, svg, svgMarkdown}]
   */
  function extractDiagrams(clone, doc, opts, ctx) {
    const found = [];
    const seen = new Set();

    function push(container, svg) {
      if (!svg || seen.has(svg)) return;
      seen.add(svg);
      found.push({ container: container, svg: svg });
    }

    // 1) mermaid 一般放在 pre 里
    Array.prototype.forEach.call(clone.querySelectorAll('pre'), function (pre) {
      const svg = pre.querySelector('svg');
      if (svg && isDiagramSvg(svg)) push(pre, svg);
    });
    // 2) 兜底：不在 pre 里的 mermaid
    Array.prototype.forEach.call(clone.querySelectorAll('svg'), function (svg) {
      if (!isDiagramSvg(svg)) return;
      if (svg.closest('pre')) return;
      push(svg, svg);
    });

    const diagrams = [];
    found.forEach(function (item, i) {
      const caption = takeDiagramCaption(item.container);
      let svgText = '';
      try {
        svgText = serializeSvg(item.svg, doc);
      } catch (e) {
        svgText = '';
      }
      const token = 'DWDIAGRAMTOKEN' + i + 'Z';
      const holder = doc.createElement('p');
      holder.textContent = token;
      try {
        item.container.replaceWith(holder);
      } catch (e) { /* ignore */ }

      if (svgText && opts.diagramMode !== 'skip') {
        let src;
        const name = ctx.assetBase + '-diagram-' + (i + 1) + '.svg';
        if (opts.diagramMode === 'files') {
          ctx.assets.push({
            name: name,
            content: svgText,
            mime: 'image/svg+xml',
            dir: ctx.assetDir
          });
          src = ctx.assetDir + '/' + name;
        } else {
          src = 'data:image/svg+xml;base64,' + base64Utf8(svgText);
        }
        const alt = caption || (opts.diagramAlt + ' ' + (i + 1));
        diagrams.push({
          token: token,
          markdown: '![' + alt.replace(/[\[\]]/g, '') + '](' + mdPath(src) + ')',
          svg: svgText
        });
      } else {
        // 忽略图表 / 序列化失败：把占位符替换成空内容，避免残留 token
        diagrams.push({ token: token, markdown: '', svg: '' });
      }
    });
    return diagrams;
  }

  function buildSourceIndex(sources, base) {
    const index = {};
    (sources || []).forEach(function (s) {
      const base0 = (s.label || '').split('/').pop();
      if (base0 && !index[base0]) index[base0] = s.url;
      // 兼容 url 里带 hash 的情况
      try {
        const u = new URL(s.url, base);
        const b = u.pathname.split('/').pop();
        if (b && !index[b]) index[b] = u.href;
      } catch (e) { /* ignore */ }
    });
    return index;
  }

  function citationUrl(index, fileName, l1, l2) {
    if (!index) return null;
    let url = index[fileName];
    if (!url) {
      // 尝试最长后缀匹配
      const keys = Object.keys(index);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].endsWith(fileName)) { url = index[keys[i]]; break; }
      }
    }
    if (!url) return null;
    const clean = url.replace(/#L\d+(-L\d+)?$/, '');
    return clean + '#L' + l1 + (l2 ? '-L' + l2 : '');
  }

  const CITATION_RE = /^([^\s:：]+?)\s*[:：]\s*(\d+)(?:\s*[-–—~]\s*(\d+))?$/;

  function convertCitations(clone, doc, opts, sourceIndex) {
    if (!opts.citationLinks) return;
    Array.prototype.forEach.call(
      clone.querySelectorAll('span[role="link"], span[role="button"], sup'),
      function (span) {
        const t = textOf(span);
        const m = CITATION_RE.exec(t);
        if (!m) return;
        const url = citationUrl(sourceIndex, m[1], m[2], m[3]);
        const node = doc.createElement(url ? 'a' : 'code');
        if (url) node.setAttribute('href', url);
        node.textContent = t;
        try {
          span.replaceWith(node);
        } catch (e) { /* ignore */ }
      }
    );
  }

  function normalizeCodeBlocks(clone, doc) {
    Array.prototype.forEach.call(clone.querySelectorAll('pre'), function (pre) {
      const code = pre.querySelector('code');
      if (!code) return;
      const lang = code.getAttribute('data-lang') ||
        ((code.className || '').match(/language-([\w+#-]+)/) || [])[1] || '';
      if (pre.firstChild !== code || pre.childNodes.length > 1) {
        const fresh = doc.createElement('pre');
        fresh.appendChild(code);
        try {
          pre.replaceWith(fresh);
        } catch (e) { return; }
        pre = fresh;
      }
      if (lang) code.setAttribute('class', 'language-' + lang);
      else code.removeAttribute('class');
    });
  }

  /** 行内引用标记：DeepWiki 渲染为 "README.md18-20"，补上冒号更易读。
   *  文件名取自可见文字（保留目录），行号取自结尾数字，并用 href 里的文件名做校验。 */
  const CHIP_TEXT_RE = /^(.*\.[A-Za-z0-9_]+?)(\d+(?:-\d+)?)$/;

  function hrefBasename(href) {
    try {
      const u = new URL(href, 'https://github.com/');
      let p = u.pathname;
      const i = p.indexOf('/blob/');
      if (i >= 0) {
        p = p.slice(i + 6);
        const slash = p.indexOf('/');
        p = slash >= 0 ? p.slice(slash + 1) : p;
      }
      p = decodeURIComponent(p);
      return p.split('/').pop();
    } catch (e) {
      return '';
    }
  }

  function fixCitationLabels(clone) {
    Array.prototype.forEach.call(
      clone.querySelectorAll('a[href*="github.com/"][href*="#L"]'),
      function (a) {
        const t = textOf(a);
        if (!t || /[:：]/.test(t)) return;
        const m = CHIP_TEXT_RE.exec(t);
        if (!m) return;
        const base = hrefBasename(a.getAttribute('href') || '');
        if (base && !m[1].endsWith(base)) return;
        a.textContent = m[1] + ':' + m[2];
      }
    );
  }

  function absolutizeLinks(clone, base) {
    Array.prototype.forEach.call(clone.querySelectorAll('a[href]'), function (a) {
      const href = a.getAttribute('href');
      if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) return;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        a.setAttribute('href', absolute(href, base));
      }
    });
  }

  function demoteHeadings(clone, doc) {
    const map = { h1: 'h2', h2: 'h3', h3: 'h4', h4: 'h5', h5: 'h6' };
    ['h5', 'h4', 'h3', 'h2', 'h1'].forEach(function (tag) {
      Array.prototype.forEach.call(clone.querySelectorAll(tag), function (h) {
        const nh = doc.createElement(map[tag]);
        while (h.firstChild) nh.appendChild(h.firstChild);
        for (let i = 0; i < h.attributes.length; i++) {
          nh.setAttribute(h.attributes[i].name, h.attributes[i].value);
        }
        try {
          h.replaceWith(nh);
        } catch (e) { /* ignore */ }
      });
    });
  }

  function prune(clone) {
    const tags = 'p,div,section,span,li,ul,ol,blockquote,details,strong,em';
    for (let pass = 0; pass < 4; pass++) {
      let removed = 0;
      Array.prototype.forEach.call(clone.querySelectorAll(tags), function (el) {
        if (el.querySelector('img,pre,code,table,svg,hr,br,a,picture,iframe')) return;
        if (textOf(el) === '') {
          el.remove();
          removed++;
        }
      });
      if (!removed) break;
    }
  }

  /**
   * 克隆并清洗正文节点。
   * @returns {{node: Element, diagrams: Array, stats: Object}}
   */
  function prepareRoot(root, doc, opts, ctx) {
    const win = doc.defaultView || global;
    const marked = opts.dropHidden ? markHidden(root, win) : [];
    let clone;
    try {
      clone = root.cloneNode(true);
    } catch (e) {
      clone = root.cloneNode(true);
    }
    if (marked.length) unmarkHidden(marked);

    // 1) 丢弃隐藏元素
    if (opts.dropHidden) {
      Array.prototype.forEach.call(clone.querySelectorAll('[' + HIDDEN_ATTR + ']'), function (el) {
        el.remove();
      });
    }
    // 2) 抽取图表（必须在删除 svg 之前）
    const diagrams = extractDiagrams(clone, doc, opts, ctx);
    // 3) 删除界面元素
    REMOVE_SELECTORS.forEach(function (sel) {
      let list;
      try {
        list = clone.querySelectorAll(sel);
      } catch (e) {
        return;
      }
      Array.prototype.forEach.call(list, function (el) {
        // svg 可能已被图表逻辑带走，这里只删剩下的
        el.remove();
      });
    });
    // 4) 「相关源文件」折叠块
    if (!opts.includeSourceFiles) {
      Array.prototype.forEach.call(clone.querySelectorAll('details'), function (el) {
        el.remove();
      });
    }
    // 5) 正文细节
    normalizeCodeBlocks(clone, doc);
    convertCitations(clone, doc, opts, ctx.sourceIndex);
    absolutizeLinks(clone, ctx.base);
    fixCitationLabels(clone);
    if (opts.demoteHeadings) demoteHeadings(clone, doc);
    prune(clone);

    const stats = {
      codeBlocks: clone.querySelectorAll('pre').length,
      tables: clone.querySelectorAll('table').length,
      links: clone.querySelectorAll('a[href]').length,
      diagrams: diagrams.length,
      translations: clone.querySelectorAll(RF.wrapper).length
    };
    return { node: clone, diagrams: diagrams, stats: stats };
  }

  /* ==================== Turndown ==================== */

  function createTurndown() {
    const td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      fence: '```',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      linkReferenceStyle: 'full',
      br: '  ',
      blankReplacement: function (content, node) {
        return node.isBlock ? '\n\n' : '';
      }
    });
    td.use(turndownPluginGfm.gfm);

    // 分隔线统一成 ---
    td.addRule('dwHr', {
      filter: 'hr',
      replacement: function () { return '\n\n---\n\n'; }
    });
    // 标题：去掉尾部残留空白
    td.addRule('dwHeading', {
      filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      replacement: function (content, node, options) {
        const level = Number(node.nodeName.charAt(1));
        const text = String(content || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return '\n\n' + '#'.repeat(level) + ' ' + text + '\n\n';
      }
    });
    // summary（如 Relevant source files）转成加粗小标题
    td.addRule('dwSummary', {
      filter: 'summary',
      replacement: function (content) {
        const t = String(content || '').replace(/\s+/g, ' ').trim();
        return t ? '\n\n**' + t + '**\n\n' : '';
      }
    });
    // 代码块：确保语言标识正确、内容原样
    td.addRule('dwFenced', {
      filter: function (node) {
        return node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE';
      },
      replacement: function (content, node, options) {
        const code = node.firstChild;
        const cls = code.getAttribute('class') || '';
        const lang = (cls.match(/language-([\w+#.-]+)/) || [])[1] || '';
        let text = code.textContent.replace(/\n$/, '');
        let fence = options.fence;
        const longest = (text.match(/`{3,}/g) || []).reduce(function (a, b) {
          return b.length > a.length ? b : a;
        }, '');
        if (longest.length >= fence.length) fence = '`'.repeat(longest.length + 1);
        return '\n\n' + fence + lang + '\n' + text + '\n' + fence + '\n\n';
      }
    });
    // 陪读蛙译文：整段译文另起一段，避免导出后中文和英文粘在同一行
    td.addRule('dwTranslation', {
      filter: function (node) {
        return !!(node.classList &&
          node.classList.contains('read-frog-translated-content-wrapper'));
      },
      replacement: function (content, node) {
        const text = String(content || '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        // 行内译文（跟着词组/小片段）保持内联，整段译文单独成段
        const isInline = !!node.querySelector(RF.inline) && !node.querySelector(RF.block);
        return isInline ? ' ' + text + ' ' : '\n\n' + text + '\n\n';
      }
    });
    // 表格单元格里的换行使用 <br>
    td.addRule('dwTableBr', {
      filter: function (node) {
        return node.nodeName === 'BR' && !!node.closest && !!node.closest('th,td');
      },
      replacement: function () { return '<br>'; }
    });
    return td;
  }

  let _td = null;
  function getTurndown() {
    if (!_td) _td = createTurndown();
    return _td;
  }

  function toMarkdown(node, doc, opts) {
    const td = getTurndown();
    const wrap = doc.createElement('div');
    wrap.appendChild(node);
    let md = '';
    try {
      md = td.turndown(wrap);
    } catch (e) {
      md = '';
    }
    return md;
  }

  function postProcess(md, diagrams) {
    (diagrams || []).forEach(function (d) {
      md = md.split(d.token).join(d.markdown);
    });
    // 列表项缩进统一为 "- "
    md = md.replace(/^([ \t]*)[-*+][ \t]{2,}/gm, '$1- ');
    // 链接文字里的 \_ 转义去掉，保持可读
    md = md.replace(/\[([^\]\n]*)\]\(/g, function (m, label) {
      return '[' + label.replace(/\\_/g, '_') + '](';
    });
    // 标题里 "1\. " 的转义去掉（标题内不会触发有序列表）
    md = md.replace(/^(#{1,6} \d+[.)]?)\\\./gm, '$1.');
    // 中文标点前的多余空格
    md = md.replace(
      /([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef)\]`）】》」』]) +([\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u201d\u2019\uff09\u3011\u300b\u300d\u300f])/g,
      '$1$2'
    );
    // 收尾清理
    md = md.replace(/[ \t]+\n/g, '\n');
    md = md.replace(/\n{4,}/g, '\n\n\n');
    md = md.trim();
    return md;
  }

  /* ==================== 提取：wiki 页面 ==================== */

  function extractWiki(doc) {
    const info = detectPage(doc);
    let root = doc.querySelector(SEL.prose);
    if (!root) root = doc.querySelector(SEL.proseFallback);
    if (!root) {
      return { ok: false, error: '未找到正文容器（div.prose-custom），请确认页面已加载完成' };
    }
    const h1 = root.querySelector('h1') || doc.querySelector('h1');
    let title = h1 ? textOf(h1) : '';
    if (!title) {
      title = (doc.title || '').replace(/\s*[|·-]\s*DeepWiki\s*$/i, '').trim();
    }
    return {
      ok: true,
      type: 'wiki',
      info: info,
      root: root,
      doc: doc,
      title: title || info.pageId,
      repo: info.repo,
      pageId: info.pageId,
      url: info.url
    };
  }

  /* ==================== 提取：search 问答页面 ==================== */

  function extractSources(scope, base) {
    const out = [];
    const seen = {};
    Array.prototype.forEach.call(scope.querySelectorAll(SEL.sourceCard), function (card) {
      const anchors = Array.prototype.slice.call(card.querySelectorAll('a[href]'));
      const blob = anchors.filter(function (a) {
        return /github\.com\/[^/]+\/[^/]+\/blob\//.test(a.getAttribute('href') || '');
      })[0];
      if (!blob) return;
      const url = absolute(blob.getAttribute('href'), base);
      if (seen[url]) return;
      seen[url] = 1;
      const repoA = anchors.filter(function (a) {
        return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(a.getAttribute('href') || '');
      })[0];
      let repo = repoA ? textOf(repoA) : '';
      if (!repo) {
        const m = /github\.com\/([^/]+\/[^/]+)\/blob\//.exec(url);
        repo = m ? m[1] : '';
      }
      out.push({ label: textOf(blob) || url, url: url, repo: repo });
    });
    return out;
  }

  function extractSearch(doc) {
    const info = detectPage(doc);
    const base = docBase(doc);
    let nodes = Array.prototype.slice.call(doc.querySelectorAll(SEL.qaBlock));
    if (!nodes.length) {
      return { ok: false, error: '未找到问答内容，可能答案还在生成中，请稍后重试' };
    }
    nodes.sort(function (a, b) {
      const ai = parseInt(a.getAttribute('data-query-index'), 10);
      const bi = parseInt(b.getAttribute('data-query-index'), 10);
      if (isNaN(ai) && isNaN(bi)) return 0;
      if (isNaN(ai)) return 1;
      if (isNaN(bi)) return -1;
      return ai - bi;
    });

    const items = [];
    nodes.forEach(function (node, i) {
      const answerEl = node.querySelector(SEL.prose);
      if (!answerEl) return;
      let questionEl = node.querySelector('span.text-xl') || node.querySelector('.text-xl');
      const repoA = node.querySelector('a[href^="/"]');
      const sources = extractSources(node, base);
      items.push({
        index: i,
        node: node,
        answerEl: answerEl,
        questionEl: questionEl,
        question: textOf(questionEl) || ('问题 ' + (i + 1)),
        repo: (repoA ? repoA.getAttribute('href').slice(1) : '') || (sources[0] && sources[0].repo) || '',
        sources: sources
      });
    });
    if (!items.length) {
      return { ok: false, error: '未找到可导出的回答内容' };
    }
    const repo = items[0].repo || info.repo || '';
    return {
      ok: true,
      type: 'search',
      info: info,
      doc: doc,
      items: items,
      title: '问答笔记',
      repo: repo,
      url: info.url
    };
  }

  /* ==================== Markdown 组装 ==================== */

  function escapeLabel(s) {
    return String(s == null ? '' : s).replace(/[\[\]]/g, '\\$&');
  }

  function frontMatter(fields) {    const lines = ['---'];
    Object.keys(fields).forEach(function (k) {
      const v = fields[k];
      if (v == null || v === '') return;
      lines.push(k + ': ' + JSON.stringify(String(v)));
    });
    lines.push('---', '');
    return lines.join('\n');
  }

  function filenameVars(ext, opts) {
    return {
      repo: (ext.repo || 'deepwiki').replace(/\//g, '-'),
      repoPath: ext.repo || '',
      pageId: ext.pageId || 'overview',
      title: ext.title || '',
      date: todayStr(),
      time: timeStr(),
      type: ext.type || 'page',
      count: ext.items ? ext.items.length : 1
    };
  }

  /**
   * 计算导出路径。
   * folderPerPage 打开时（默认）：<子目录>/<owner>/<repo>/<页面>/index.md，
   * 图片统一放该页文件夹下的 assets/；关闭时退回旧的平铺行为。
   * @returns {{filename:string, dir:string, repoDir:string, assetDir:string, segment:string, fileName:string}}
   */
  function buildPaths(ext, opts, nameTemplate) {
    const vars = filenameVars(ext, opts);
    let base = renderTemplate(nameTemplate, vars);
    if (opts.timestamp) base += '-' + vars.time;
    base = sanitizeSegment(base);

    const segs = [];
    if (opts.subfolder) {
      String(opts.subfolder).split('/').forEach(function (s) {
        const t = sanitizeSegment(renderTemplate(s, vars));
        if (t) segs.push(t);
      });
    }

    if (!opts.folderPerPage) {
      const flat = segs.concat([base + '.md']).join('/');
      const dir = flat.replace(/[^/]*$/, '');
      return {
        filename: flat,
        dir: dir,
        repoDir: dir,
        assetDir: base + '.assets',
        segment: base,
        fileName: base + '.md'
      };
    }

    // 仓库目录：<owner>/<repo>
    String(ext.repo || '').split('/').forEach(function (s) {
      const t = sanitizeSegment(s);
      if (t) segs.push(t);
    });
    const repoDir = segs.join('/');

    // 页面目录：Wiki 用 pageId（如 1-overview），问答用文件名模板
    const segment = ext.type === 'wiki'
      ? sanitizeSegment(ext.pageId || 'overview')
      : sanitizeSegment(base);
    const dir = (repoDir ? repoDir + '/' : '') + segment;
    const fileName = sanitizeSegment(opts.pageFileName || 'index') + '.md';

    return {
      filename: dir + '/' + fileName,
      dir: dir,
      repoDir: repoDir,
      assetDir: 'assets',
      segment: segment,
      fileName: fileName
    };
  }

  function makeCtx(ext, opts, doc, paths) {
    const segment = typeof paths === 'string' ? sanitizeSegment(paths) : paths.segment;
    const assetDir = typeof paths === 'string' ? segment + '.assets' : paths.assetDir;
    return {
      base: docBase(doc),
      assets: [],
      assetBase: segment,
      assetDir: assetDir,
      sourceIndex: null,
      doc: doc
    };
  }

  function renderAnswerBlock(answerEl, doc, opts, ctx, demote) {
    const eff = Object.assign({}, opts, { demoteHeadings: !!demote });
    const prepared = prepareRoot(answerEl, doc, eff, ctx);
    const md = postProcess(toMarkdown(prepared.node, doc, eff), prepared.diagrams);
    return { markdown: md, stats: prepared.stats };
  }

  /** 导出单个 wiki 页面 */
  function buildWikiPage(doc, options) {
    const opts = mergeOptions(options);
    const ext = extractWiki(doc);
    if (!ext.ok) return ext;
    const paths = buildPaths(ext, opts, opts.wikiFilename);
    const ctx = makeCtx(ext, opts, doc, paths);
    const r = renderAnswerBlock(ext.root, doc, opts, ctx, false);
    const filename = paths.filename;

    const head = [];
    if (opts.frontMatter) {
      head.push(frontMatter({
        title: ext.title,
        repo: ext.repo,
        page: ext.pageId,
        source: ext.url,
        exported: nowLocalIso(),
        tool: 'DeepWiki 转 Markdown v' + VERSION
      }));
    }
    if (opts.sourceLine) {
      head.push('> 仓库：`' + ext.repo + '` ｜ 来源：' + ext.url + ' ｜ 页面：' + ext.title);
      head.push('');
    }
    const markdown = (head.join('\n') + '\n' + r.markdown + '\n').replace(/\n{4,}/g, '\n\n\n');

    return {
      ok: true,
      type: 'wiki',
      title: ext.title,
      repo: ext.repo,
      pageId: ext.pageId,
      url: ext.url,
      filename: filename,
      dir: paths.dir,
      repoDir: paths.repoDir,
      segment: paths.segment,
      assets: ctx.assets,
      markdown: markdown,
      stats: r.stats
    };
  }

  /**
   * 导出 search 问答页面
   * @param {number[]} [onlyIndexes] 仅导出指定的问答序号（0 起）
   */
  function buildSearchPage(doc, options, onlyIndexes) {
    const opts = mergeOptions(options);
    const ext = extractSearch(doc);
    if (!ext.ok) return ext;

    let items = ext.items;
    if (onlyIndexes && onlyIndexes.length) {
      items = items.filter(function (it) {
        return onlyIndexes.indexOf(it.index) >= 0;
      });
    }
    if (!items.length) return { ok: false, error: '未匹配到要导出的问答' };

    const single = items.length === 1;
    const template = single ? opts.qaFilename : opts.multiQaFilename;
    const paths = buildPaths(ext, opts, template);
    const ctx = makeCtx(ext, opts, doc, paths);

    // 先用第一个回答里出现的源文件卡片建立索引（引用标记 -> GitHub 链接）
    const idx = {};
    items.forEach(function (it) {
      Object.assign(idx, buildSourceIndex(it.sources, ctx.base));
    });
    ctx.sourceIndex = idx;

    const level = single ? '#' : '##';
    const blocks = [];
    const totalStats = { codeBlocks: 0, tables: 0, links: 0, diagrams: 0, translations: 0 };
    items.forEach(function (it, i) {
      const r = renderAnswerBlock(it.answerEl, doc, opts, ctx, opts.demoteAnswerHeadings);
      Object.keys(totalStats).forEach(function (k) {
        totalStats[k] += r.stats[k] || 0;
      });
      const lines = [];
      const qn = single ? '' : (opts.qaHeadingPrefix || 'Q') + (i + 1) + '. ';
      lines.push(level + ' ' + qn + it.question.replace(/\s+/g, ' ').trim());
      lines.push('');
      lines.push(r.markdown);
      if (opts.includeQASources && it.sources.length) {
        lines.push('');
        lines.push('**来源文件**');
        lines.push('');
        it.sources.forEach(function (s) {
          lines.push('- [`' + escapeLabel(s.label) + '`](' + s.url + ')');
        });
      }
      blocks.push(lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim());
    });

    const head = [];
    if (opts.frontMatter) {
      head.push(frontMatter({
        title: ext.repo ? ext.repo + ' 架构问答笔记' : 'DeepWiki 问答笔记',
        repo: ext.repo,
        source: ext.url,
        questions: items.length,
        exported: nowLocalIso(),
        tool: 'DeepWiki 转 Markdown v' + VERSION
      }));
    }
    if (opts.sourceLine) {
      head.push('> 来源：' + ext.url + (ext.repo ? ' ｜ 仓库：`' + ext.repo + '`' : '') +
        ' ｜ 共 ' + items.length + ' 组问答');
      head.push('');
    }

    const sep = '\n\n---\n\n';
    const markdown = (head.join('\n') + '\n' + blocks.join(sep) + '\n').replace(/\n{4,}/g, '\n\n\n');

    return {
      ok: true,
      type: 'search',
      title: ext.repo ? ext.repo + ' 问答' : 'DeepWiki 问答',
      repo: ext.repo,
      url: ext.url,
      count: items.length,
      questions: items.map(function (it) { return it.question; }),
      filename: paths.filename,
      dir: paths.dir,
      repoDir: paths.repoDir,
      segment: paths.segment,
      assets: ctx.assets,
      markdown: markdown,
      stats: totalStats
    };
  }

  /** 列出当前问答页面上的问答（供弹窗/行内按钮使用） */
  function listQuestions(doc) {
    const ext = extractSearch(doc);
    if (!ext.ok) return ext;
    return {
      ok: true,
      repo: ext.repo,
      url: ext.url,
      items: ext.items.map(function (it) {
        return {
          index: it.index,
          question: it.question,
          sources: it.sources.length,
          node: it.node,
          questionEl: it.questionEl
        };
      })
    };
  }

  /* ==================== 保存到笔记夹用的片段 ==================== */

  function buildNoteFragment(item, ext, opts) {
    const doc = item.answerEl.ownerDocument;
    const ctx = makeCtx(ext, opts, doc, 'note');
    ctx.sourceIndex = buildSourceIndex(item.sources, ctx.base);
    const r = renderAnswerBlock(item.answerEl, doc, opts, ctx, opts.demoteAnswerHeadings);
    const lines = [];
    lines.push('## ' + item.question.replace(/\s+/g, ' ').trim());
    lines.push('');
    lines.push(r.markdown);
    if (opts.includeQASources && item.sources.length) {
      lines.push('');
      lines.push('**来源文件**');
      lines.push('');
      item.sources.forEach(function (s) {
        lines.push('- [`' + escapeLabel(s.label) + '`](' + s.url + ')');
      });
    }
    return { markdown: lines.join('\n').trim(), assets: ctx.assets, stats: r.stats };
  }

  /* ==================== 笔记夹汇总导出 ==================== */

  function buildNotesMarkdown(notes, options) {
    const opts = mergeOptions(options);
    const list = (notes || []).slice();
    const lines = [];
    if (opts.frontMatter) {
      lines.push(frontMatter({
        title: 'DeepWiki 问答笔记',
        notes: list.length,
        exported: nowLocalIso(),
        tool: 'DeepWiki 转 Markdown v' + VERSION
      }));
    }
    const byRepo = {};
    const order = [];
    list.forEach(function (n) {
      const k = n.repo || '其他';
      if (!byRepo[k]) {
        byRepo[k] = [];
        order.push(k);
      }
      byRepo[k].push(n);
    });
    order.forEach(function (repo) {
      lines.push('# ' + repo);
      lines.push('');
      const group = byRepo[repo].sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      group.forEach(function (n, i) {
        lines.push('## ' + (n.type === 'wiki' ? n.question : 'Q' + (i + 1) + '. ' + n.question));
        lines.push('');
        lines.push(n.markdown || '');
        lines.push('');
        if (n.url) {
          lines.push('> 来源：' + n.url + (n.ts ? ' ｜ 收集于 ' + new Date(n.ts).toLocaleString() : ''));
          lines.push('');
        }
        lines.push('---');
        lines.push('');
      });
    });
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
  }

  /* ==================== 导出 ==================== */

  global.DW = {
    version: VERSION,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    mergeOptions: mergeOptions,
    detectPage: detectPage,
    extractWiki: extractWiki,
    extractSearch: extractSearch,
    listQuestions: listQuestions,
    buildWikiPage: buildWikiPage,
    buildSearchPage: buildSearchPage,
    buildNoteFragment: buildNoteFragment,
    buildNotesMarkdown: buildNotesMarkdown,
    buildPaths: buildPaths,
    countTranslations: countTranslations,
    countTranslatableBlocks: countTranslatableBlocks,
    translationCoverage: translationCoverage,
    translationStats: translationStats,
    translatableBlocks: translatableBlocks,
    isTranslatedBlock: isTranslatedBlock,
    frontMatter: frontMatter,
    sanitizeSegment: sanitizeSegment,
    mdPath: mdPath,
    renderTemplate: renderTemplate,
    filenameVars: filenameVars,
    nowLocalIso: nowLocalIso,
    todayStr: todayStr,
    textOf: textOf,
    norm: norm,
    absolute: absolute
  };
})(typeof window !== 'undefined' ? window : self);
