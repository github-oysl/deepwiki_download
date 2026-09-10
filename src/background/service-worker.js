/*!
 * DeepWiki → Markdown  Exporter
 * 后台服务：下载（通过 offscreen 文档创建 blob URL，避免 data URL 体积限制）、
 *           笔记夹角标、消息路由。
 */
'use strict';

const OFFSCREEN_PATH = 'src/background/offscreen.html';
const NOTES_KEY = 'dw_notes';
const OPT_KEY = 'dw_options';

/* ---------------- offscreen 文档管理 ---------------- */

let creatingOffscreen = null;

async function hasOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    try {
      return await chrome.offscreen.hasDocument();
    } catch (e) {
      return false;
    }
  }
  // 老版本 Chrome 用运行时错误兜底
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification: '导出 Markdown / SVG 文件时需要创建 blob 下载链接'
      })
      .catch(() => null)
      .then(() => {
        creatingOffscreen = null;
        return true;
      });
  }
  await creatingOffscreen;
  return await hasOffscreen();
}

/* ---------------- 下载 ---------------- */

/* 同名文件用 overwrite：重复导出同一页面时直接覆盖旧文件，
   Chrome 不会再生成「xxx (1).md」这种副本。 */
const CONFLICT_ACTION = 'overwrite';

function dataUrl(content, mime) {
  return (
    'data:' + (mime || 'text/markdown;charset=utf-8') + ',' +
    encodeURIComponent(content)
  );
}

async function downloadOne(file, saveAs) {
  const filename = file.filename;
  const mime = file.mime || 'text/markdown;charset=utf-8';
  const content = file.content == null ? '' : String(file.content);

  // 方案一：offscreen 里创建 blob URL，再回后台下载（无体积限制）
  const ok = await ensureOffscreen();
  if (ok) {
    try {
      const made = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'MAKE_BLOB_URL',
        content: content,
        mime: mime
      });
      if (made && made.ok && made.url) {
        try {
          const id = await chrome.downloads.download({
            url: made.url,
            filename: filename,
            saveAs: !!saveAs,
            conflictAction: CONFLICT_ACTION
          });
          return { ok: true, id: id };
        } catch (e) {
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'REVOKE_BLOB_URL',
            url: made.url
          }).catch(function () { /* ignore */ });
        }
      }
    } catch (e) {
      /* 落到 data URL 兜底 */
    }
  }

  // 方案二：data URL 兜底
  if (content.length <= 4 * 1024 * 1024) {
    const id = await chrome.downloads.download({
      url: dataUrl(content, mime),
      filename: filename,
      saveAs: !!saveAs,
      conflictAction: CONFLICT_ACTION
    });
    return { ok: true, id: id };
  }
  return { ok: false, error: '内容过大，且无法创建后台下载上下文' };
}

async function downloadBatch(files, saveAs) {
  const results = [];
  for (let i = 0; i < files.length; i++) {
    try {
      const r = await downloadOne(files[i], saveAs && i === 0);
      results.push(Object.assign({ filename: files[i].filename }, r));
    } catch (e) {
      results.push({ filename: files[i].filename, ok: false, error: String((e && e.message) || e) });
    }
    if (i + 1 < files.length) {
      await new Promise(function (r) { setTimeout(r, 70); });
    }
  }
  const failed = results.filter(function (r) { return !r.ok; });
  return { ok: failed.length === 0, total: results.length, failed: failed.length, results: results };
}

/* ---------------- 未读数量角标 ---------------- */

async function refreshBadge() {
  try {
    const r = await chrome.storage.local.get([NOTES_KEY]);
    const n = (r[NOTES_KEY] || []).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  } catch (e) { /* ignore */ }
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes[NOTES_KEY]) refreshBadge();
});

chrome.runtime.onInstalled.addListener(function () {
  refreshBadge();
});
chrome.runtime.onStartup.addListener(function () {
  refreshBadge();
});

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.target === 'offscreen') return false; // 交给 offscreen 文档处理

  if (msg.type === 'DW_DOWNLOAD_BATCH') {
    downloadBatch(msg.files || [], !!msg.saveAs).then(sendResponse).catch(function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;
  }

  if (msg.type === 'DW_OPEN_PAGE') {
    chrome.tabs.create({ url: msg.url }).then(function () {
      sendResponse({ ok: true });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (msg.type === 'DW_PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  return false;
});
