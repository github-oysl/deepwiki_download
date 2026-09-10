/*!
 * DeepWiki → Markdown  Exporter
 * offscreen 文档：MV3 的 Service Worker 里没有 URL.createObjectURL，
 * 因此在这里把文本内容转成 blob URL，再交回后台调用 chrome.downloads 下载，
 * 从而绕开 data URL 的体积限制，支持大文件与多文件导出。
 */
'use strict';

const liveUrls = new Set();

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'MAKE_BLOB_URL') {
    try {
      const blob = new Blob([msg.content == null ? '' : String(msg.content)], {
        type: msg.mime || 'text/markdown;charset=utf-8'
      });
      const url = URL.createObjectURL(blob);
      liveUrls.add(url);
      // 兜底：3 分钟后自动释放，避免长期占用内存
      setTimeout(function () { revoke(url); }, 180000);
      sendResponse({ ok: true, url: url });
    } catch (e) {
      sendResponse({ ok: false, error: '无法创建下载内容：' + String((e && e.message) || e) });
    }
    return false;
  }

  if (msg.type === 'REVOKE_BLOB_URL') {
    revoke(msg.url);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function revoke(url) {
  if (!url || !liveUrls.has(url)) return;
  try {
    URL.revokeObjectURL(url);
  } catch (e) { /* ignore */ }
  liveUrls.delete(url);
}
