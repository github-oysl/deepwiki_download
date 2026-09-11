#!/usr/bin/env node
/*!
 * deepwiki2md — DeepWiki 页面 → Markdown 入库脚本（无浏览器，Node + jsdom）
 *
 * 复用 Chrome 扩展 deepwiki-md-exporter 的核心提取器（vendor/extractor.js），
 * 把 https://deepwiki.com/<owner>/<repo>[/<page>] 或 /search/<id> 页面
 * 转成 Markdown 并按「一篇一个文件夹」写入目标目录。
 *
 * 依赖：jsdom（通过 NODE_PATH 提供）；网络走 curl（支持 socks5h 代理）。
 *
 * 用法示例：
 *   node deepwiki2md.cjs https://deepwiki.com/milvus-io/milvus/1-overview --out D:/notes
 *   node deepwiki2md.cjs milvus-io/milvus --all --out D:/notes          # 整站批量
 *   node deepwiki2md.cjs --init                            # 环境自检（curl/jsdom/playwright）
 *   node deepwiki2md.cjs --init --install                  # 自检并自动安装缺失依赖
 *   node deepwiki2md.cjs page.html --from-file --url https://deepwiki.com/... --out D:/notes
 * 选项：
 *   --out <dir>      输出根目录（默认 ./DeepWiki）
 *   --all            顺着目录批量抓取整个 Wiki
 *   --proxy <url>    代理地址（默认 env DW_PROXY 或 socks5h://127.0.0.1:2334）
 *   --no-proxy       直连
 *   --flat           平铺模式（不建每篇子文件夹）
 *   --no-frontmatter 不输出 YAML front-matter
 *   --from-file      第一个参数是本地 HTML 文件而非 URL（配合浏览器渲染兜底）
 *   --url <u>        与 --from-file 搭配，提供页面真实 URL
 *   --delay <ms>     批量模式下每页间隔（默认 1500）
 *   --timeout <s>    curl 超时（默认 40）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
// jsdom 惰性加载：依赖缺失时 --init 也能正常运行自检/安装
let JSDOM;
function getJSDOM() {
  if (!JSDOM) JSDOM = require('jsdom').JSDOM;
  return JSDOM;
}

/* ---------- 参数解析 ---------- */
const args = process.argv.slice(2);
const opt = {
  out: './DeepWiki', all: false, proxy: process.env.DW_PROXY || 'socks5h://127.0.0.1:2334',
  useProxy: true, flat: false, frontMatter: true, fromFile: false, noBrowser: false, url: '',
  delay: 1500, timeout: 40, init: false, install: false
};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opt.out = args[++i];
  else if (a === '--all') opt.all = true;
  else if (a === '--proxy') { opt.proxy = args[++i]; opt.useProxy = true; }
  else if (a === '--no-proxy') opt.useProxy = false;
  else if (a === '--flat') opt.flat = true;
  else if (a === '--no-frontmatter') opt.frontMatter = false;
  else if (a === '--from-file') opt.fromFile = true;
  else if (a === '--no-browser') opt.noBrowser = true;
  else if (a === '--url') opt.url = args[++i];
  else if (a === '--delay') opt.delay = parseInt(args[++i], 10);
  else if (a === '--timeout') opt.timeout = parseInt(args[++i], 10);
  else if (a === '--init') opt.init = true;
  else if (a === '--install') opt.install = true;
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else positional.push(a);
}
function printHelp() { console.log(fs.readFileSync(__filename, 'utf8').split('用法示例：')[0] + '见文件头注释。'); }
if (!positional.length && !opt.init) { console.error('错误：缺少页面 URL（或用 --init 做环境自检，或 --from-file 的 HTML 文件）'); process.exit(1); }

/* ---------- 环境初始化（--init） ---------- */
function initEnv() {
  const problems = [];
  try {
    const v = execFileSync('curl', ['--version'], { encoding: 'utf8' });
    console.log('[init] curl OK：' + v.split('\n')[0]);
  } catch { problems.push('curl 不可用（网络抓取必需）'); }

  let jsdomOk = true; try { require('jsdom'); } catch { jsdomOk = false; }
  let pwOk = true; try { require('playwright'); } catch { pwOk = false; }
  console.log('[init] jsdom ' + (jsdomOk ? 'OK' : '缺失'));
  console.log('[init] playwright ' + (pwOk ? 'OK' : '缺失（仅问答页 / SPA 浏览器兜底需要）'));

  const npDirs = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  const wsRoot = npDirs.length ? path.dirname(npDirs[0]) : '';
  if (!jsdomOk || !pwOk) {
    const pkgs = [...(jsdomOk ? [] : ['jsdom']), ...(pwOk ? [] : ['playwright'])];
    if (opt.install) {
      if (!wsRoot) {
        problems.push('未设置 NODE_PATH，无法定位 node workspace；请在托管 workspace 下手动执行: npm install ' + pkgs.join(' '));
      } else {
        console.log('[init] 安装缺失依赖到 ' + wsRoot + ' ...');
        try {
          execSync('npm install --prefix "' + wsRoot + '" ' + pkgs.join(' '), { stdio: 'inherit' });
          console.log('[init] 安装命令执行完毕，建议重跑 --init 复查');
        } catch (e) { problems.push('npm 安装失败：' + String(e.message || '').split('\n')[0]); }
      }
    } else {
      console.log('[init] 提示：加 --install 可自动安装缺失依赖；或手动执行：');
      console.log('  cd "' + (wsRoot || '<node-workspace>') + '" && npm install ' + pkgs.join(' '));
    }
  }
  const ready = !problems.length;
  console.log(ready ? '\n[init] 环境就绪。' : '\n[init] 未就绪：\n  - ' + problems.join('\n  - '));
  return ready;
}

/* ---------- 网络 ---------- */
function fetchHtml(url) {
  const tries = [];
  if (opt.useProxy) tries.push(['proxy', ['--socks5-hostname', proxyHostPort()]]);
  tries.push(['direct', []]);
  for (const [name, extra] of tries) {
    try {
      const argv = ['-s', '-L', '--max-time', String(opt.timeout),
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeepWiki2MD/1.0', ...extra, url];
      const html = execFileSync('curl', argv, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
      if (html && html.length > 500) { console.error(`[fetch] ${url} OK via ${name} (${html.length} bytes)`); return html; }
      console.error(`[fetch] ${name} 返回内容过小(${html ? html.length : 0}B)，尝试下一通道`);
    } catch (e) {
      console.error(`[fetch] ${name} 失败：${(e.stderr || e.message || '').split('\n')[0]}`);
    }
  }
  throw new Error(`无法下载 ${url}（代理与直连均失败）。若代理故障，可先用浏览器打开页面并保存 HTML，再用 --from-file 转换。`);
}
function proxyHostPort() {
  // socks5h://127.0.0.1:2334 -> --socks5-hostname 需要 host:port
  const m = /^[a-z0-9]+:\/\/(.+)$/.exec(opt.proxy);
  return m ? m[1] : opt.proxy;
}

/* ---------- DOM + 提取器 ---------- */
function makeDom(html, url) {
  const dom = getJSDOM()(html, { url });
  const win = dom.window;
  // jsdom 新版：eval 作用域里没有 window/self 标识符，用 globalThis 补挂
  win.eval('globalThis.window = globalThis; globalThis.self = globalThis;');
  return { dom, win };
}
function loadExtractor(win) {
  const vendor = path.join(__dirname, '..', 'vendor');
  for (const f of ['turndown.js', 'turndown-plugin-gfm.js', 'extractor.js']) {
    win.eval(fs.readFileSync(path.join(vendor, f), 'utf8'));
  }
  const DW = win.eval('DW');
  if (!DW || !DW.buildWikiPage) throw new Error('extractor 加载失败');
  return DW;
}
/** 抓取/读取一个页面并转 Markdown，返回 {res, doc, type}；提取不出内容时抛错 */
function convertPage(html, url, DW) {
  // 片段（无 <html>）包进插件识别的 div.prose-custom；完整页面原样解析
  const full = /<html[\s>]/i.test(html) ? html
    : `<!doctype html><html><head><title>t</title></head><body><div class="prose-custom">${html}</div></body></html>`;
  const { dom, win } = makeDom(full, url);
  const DW2 = loadExtractor(win);
  const det = DW2.detectPage(win.document);
  const opts = { frontMatter: opt.frontMatter, sourceLine: true, folderPerPage: !opt.flat, diagramMode: 'files' };
  let res;
  if (det.type === 'search') res = DW2.buildSearchPage(win.document, opts);
  else res = DW2.buildWikiPage(win.document, opts);
  if (!res || res.ok === false) {
    throw new Error(res && res.error ? res.error : `页面识别为 ${det.type}，但提取结果为空`);
  }
  // 无浏览器渲染时，Mermaid 图表留在 Next.js RSC 数据里（DOM 没有 SVG），
  // 从原始 HTML 的 payload 中把 ```mermaid 源码块找回来，追加到文末
  if (det.type !== 'search' && !(res.assets || []).length && !opt.fromFile) {
    const blocks = extractMermaidBlocks(html);
    if (blocks.length) res.markdown += appendMermaidSection(blocks);
  }
  return { res, doc: win.document, type: det.type };
}

/* ---------- RSC payload 里的 Mermaid 恢复 ---------- */
function unescapeRsc(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t')
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
function extractMermaidBlocks(rawHtml) {
  // Next.js RSC payload 里，第一个以 "# " 开头的长字符串是「当前页面」的正文
  // markdown（后续候选是预载的其他页面，不能要，否则会混入整站图表）。
  const re = /"((?:[^"\\]|\\.){200,}?)"/g;
  let m;
  while ((m = re.exec(rawHtml))) {
    const s = m[1];
    if (!s.startsWith('# ')) continue;
    const text = unescapeRsc(s);
    if (!text.includes('```mermaid')) continue;
    const blocks = [];
    const bre = /(?:^|\n)(?:Title:\s*([^\n]+)\n+)?```mermaid\n([\s\S]*?)\n```/g;
    let b; const seen = new Set();
    while ((b = bre.exec(text))) {
      const src = b[2].trim();
      if (!src || seen.has(src)) continue;
      seen.add(src);
      blocks.push({ caption: (b[1] || '').trim(), src });
    }
    return blocks;
  }
  return [];
}
function appendMermaidSection(blocks) {
  const lines = ['', '', '## 架构图（Mermaid 源码）', ''];
  blocks.forEach((b, i) => {
    if (b.caption) lines.push(`**图 ${i + 1}：${b.caption}**`, '');
    else lines.push(`**图 ${i + 1}**`, '');
    lines.push('```mermaid', b.src, '```', '');
  });
  return lines.join('\n');
}

/* ---------- 浏览器渲染兜底（问答页 / SPA 空壳） ---------- */
async function renderWithBrowser(url, waitMs) {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { throw new Error('未找到 playwright（需在 NODE_PATH 的 node_modules 中），无法浏览器兜底'); }
  // 与 fetchHtml 一致：先走代理，失败自动直连
  const attempts = opt.useProxy
    ? [{ server: opt.proxy.replace(/^socks5h:/, 'socks5:') }, undefined]
    : [undefined];
  let lastErr;
  for (const proxy of attempts) {
    const browser = await chromium.launch({ headless: true, proxy });
    try {
      console.error(`[browser] 开始渲染 ${url}${proxy ? '（经代理）' : '（直连）'} t=${Date.now()}`);
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.error(`[browser] goto 完成 t=${Date.now()}`);
    // 问答内容由前端流式生成（实测 ~20s 才到齐），不能过早判定稳定：
    // 最短等 12s，之后要求「实质正文(>3000字)连续 4 轮(8s)稳定」才提前返回
    const minWait = 12000;
    const t0 = Date.now();
    const deadline = t0 + Math.max(waitMs, 20000);
    let last = -1, stable = 0;
    while (Date.now() - t0 < deadline) {
      await page.waitForTimeout(2000);
      const len = await page.evaluate(() => {
        const el = document.querySelector('div.prose-custom') || document.body;
        return (el.textContent || '').replace(/\s+/g, '').length;
      });
      const eligible = Date.now() - t0 >= minWait && len > 3000;
      if (eligible && len === last) { if (++stable >= 4) break; } else stable = 0;
      last = len;
    }
    const out = await page.content();
    console.error(`[browser] 渲染完成，HTML ${out.length} 字节`);
    await browser.close();
    return out;
    } catch (e) {
      lastErr = e;
      console.error(`[browser] 本次尝试失败：${e.message.split('\n')[0]}`);
      await browser.close().catch(() => {});
    }
  }
  throw new Error('浏览器兜底失败（' + (lastErr ? lastErr.message.split('\n')[0] : '未知') + '）');
}

/* ---------- 落盘 ---------- */
function writeResult(res) {
  const root = path.resolve(opt.out);
  const mdPath = path.join(root, ...res.filename.split('/'));
  const mdDir = path.dirname(mdPath);
  fs.mkdirSync(mdDir, { recursive: true });
  fs.writeFileSync(mdPath, res.markdown, 'utf8');
  let assetCount = 0;
  for (const a of res.assets || []) {
    // 资源相对 md 所在目录（与扩展行为一致：fileDir + a.dir + a.name）
    const ap = path.join(mdDir, ...a.dir.split('/'), a.name);
    fs.mkdirSync(path.dirname(ap), { recursive: true });
    fs.writeFileSync(ap, a.content, 'utf8');
    assetCount++;
  }
  return { mdPath, assetCount };
}

/* ---------- 批量：目录链接 ---------- */
function collectSidebarLinks(html, baseUrl, DW) {
  const { win } = makeDom(html, baseUrl);
  const u = new URL(baseUrl);
  const prefix = u.pathname.replace(/\/[^/]*\/?$/, ''); // /owner/repo
  const seen = new Set(); const links = [];
  win.document.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (!href.startsWith(prefix + '/')) return;
    const rest = href.slice(prefix.length + 1);
    if (!rest || rest.startsWith('search') || seen.has(rest)) return;
    seen.add(rest);
    links.push({ pageId: rest, title: (a.textContent || '').trim() || rest, url: u.origin + href });
  });
  return links;
}

/* ---------- 主流程 ---------- */
async function main() {
  if (opt.init) process.exit(initEnv() ? 0 : 1);
  const DW = null; // extractor 在每个页面各自的 jsdom 里加载（避免跨文档状态）
  let html, firstUrl;
  if (opt.fromFile) {
    html = fs.readFileSync(path.resolve(positional[0]), 'utf8');
    firstUrl = opt.url || 'https://deepwiki.com/unknown/unknown';
  } else {
    firstUrl = normalizeUrl(positional[0]);
    html = fetchHtml(firstUrl);
  }

  const pages = []; // [{url, title}]
  if (opt.all && !opt.fromFile) {
    const m = /^https:\/\/deepwiki\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/.exec(firstUrl);
    if (!m) { console.error('错误：--all 需要 https://deepwiki.com/<owner>/<repo>[/<page>] 形式的 URL'); process.exit(1); }
    const links = collectSidebarLinks(html, firstUrl, DW);
    console.error(`[batch] 从目录页收集到 ${links.length} 个页面`);
    if (!links.length) console.error('[batch] 警告：未在 HTML 里找到目录链接（可能是 SPA 空壳），改用单页模式');
    pages.push(...links.map(l => ({ url: l.url, title: l.title })));
  } else {
    pages.push({ url: firstUrl, title: '' });
  }

  const index = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    try {
      let pageHtml = (i === 0 && (!opt.all || pages.length === 1)) || opt.fromFile ? html : fetchHtml(p.url);
      let result;
      try {
        result = convertPage(pageHtml, p.url, DW);
      } catch (e1) {
        // 直接解析失败（问答页空壳 / SPA 未渲染）→ 自动浏览器渲染兜底
        if (opt.fromFile || opt.noBrowser) throw e1;
        console.error(`[${i + 1}/${pages.length}] 直接解析失败（${e1.message}），自动转浏览器渲染兜底...`);
        pageHtml = await renderWithBrowser(p.url, 25000);
        try { fs.writeFileSync(path.join(path.resolve(opt.out), '.fallback-dump.html'), pageHtml); } catch (e) {}
        result = convertPage(pageHtml, p.url, DW);
      }
      const { res } = result;
      const { mdPath, assetCount } = writeResult(res);
      ok++;
      console.log(`[${i + 1}/${pages.length}] ${res.filename}  (图表 ${assetCount} 个)`);
      index.push({ pageId: res.segment || p.title, title: p.title || res.title || p.pageId, rel: res.filename });
    } catch (e) {
      fail++;
      console.error(`[${i + 1}/${pages.length}] 失败：${p.url} — ${e.message}`);
    }
    if (i < pages.length - 1 && !opt.fromFile) await sleep(opt.delay);
  }

  // 批量时生成仓库级目录
  if (opt.all && index.length) {
    const root = path.resolve(opt.out);
    const m = /^https:\/\/deepwiki\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/.exec(firstUrl);
    const idxDir = path.join(root, 'DeepWiki', m[1], m[2]);
    fs.mkdirSync(idxDir, { recursive: true });
    const lines = ['# ' + m[2] + ' — DeepWiki 目录', '',
      ...index.map(it => `- [${it.title}](./${it.rel.split('/').slice(3).join('/')})`)];
    fs.writeFileSync(path.join(idxDir, '00-目录.md'), lines.join('\n') + '\n', 'utf8');
    console.log(`[batch] 目录已写入 ${path.join(idxDir, '00-目录.md')}`);
  }
  console.log(`\n完成：成功 ${ok}，失败 ${fail}。输出根目录：${path.resolve(opt.out)}`);
  process.exit(fail && !ok ? 1 : 0);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizeUrl(s) {
  if (/^https?:\/\//.test(s)) return s;
  if (/^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?$/.test(s)) return 'https://deepwiki.com/' + s;
  console.error(`无法识别的地址：${s}`); process.exit(1);
}
main().catch(e => { console.error('致命错误：' + e.message + '\n' + (e.stack || '')); process.exit(1); });
