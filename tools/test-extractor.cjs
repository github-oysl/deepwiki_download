/*!
 * extractor 回归测试
 * 用 jsdom 构造一个带陪读蛙（read-frog）译文节点的 DeepWiki 页面，验证：
 *   - 「一篇一个文件夹」的路径与资源目录
 *   - 译文节点被保留、UI 节点被剔除、译文单独成段
 *   - 隐藏元素规则不会误删淡入中的译文
 *   - 译文统计同时认「双语容器」和「仅译文就地替换」两种形态
 *   - 覆盖率不会把文件名 / 代码标识符算成「待翻译正文」
 *   - 平铺模式（folderPerPage=false）保持旧行为
 *
 * 用法：
 *   npm i jsdom                                   # 仅测试需要，扩展本身零依赖
 *   NODE_PATH=<jsdom 所在 node_modules> node tools/test-extractor.cjs
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

const HTML = `<!doctype html><html><body>
<nav><a href="/milvus-io/milvus/2-architecture">2 Architecture</a></nav>
<div class="prose-custom">
  <h1>Overview</h1>
  <p>Milvus is a high-performance vector database built for scale.<span class="notranslate read-frog-translated-content-wrapper" data-read-frog-translation-mode="bilingual" lang="zh"><span class="read-frog-translated-block-content">Milvus 是一个为大规模场景构建的高性能向量数据库。</span></span></p>
  <p>Second paragraph that has no translation at all.</p>
  <pre><code class="language-go">func main() {}</code></pre>
  <p>Title: System Architecture</p>
  <pre><svg id="mermaid-1" viewBox="0 0 100 50"><text>x</text></svg></pre>
  <div class="read-frog-spinner"></div>
  <p>Third paragraph.</p>
  <span class="notranslate read-frog-translated-content-wrapper" lang="zh"><span class="read-frog-translated-block-content">第三段的译文。</span></span>
  <table><thead><tr><th>Dep</th></tr></thead><tbody><tr><td>etcd</td></tr></tbody></table>
  <p style="opacity:0">SHOULD_BE_DROPPED</p>
  <p style="display:none">SHOULD_BE_DROPPED_TOO</p>
  <p data-read-frog-translation-only="true">仅译文模式：这段是原文本地替换后的中文。</p>
  <p>Fifth paragraph<span class="notranslate read-frog-translated-content-wrapper" style="opacity:0"><span class="read-frog-translated-block-content">半透明淡入中的译文。</span></span></p>
  <details><summary>Relevant source files</summary>
    <ul><li>internal/distributed/proxy/service.go</li></ul>
  </details>
  <p>grpcproxy.Server.Start</p>
  <p>segcore::Segcore</p>
</div>
</body></html>`;

const dom = new JSDOM(HTML, {
  url: 'https://deepwiki.com/milvus-io/milvus/1-overview',
  runScripts: 'dangerously'
});
const win = dom.window;

for (const f of [
  'src/lib/turndown.js',
  'src/lib/turndown-plugin-gfm.js',
  'src/common/extractor.js'
]) {
  win.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

const DW = win.DW;
const doc = win.document;

const res = DW.buildWikiPage(doc, {});
const cov = DW.translationCoverage(doc);
const stats = DW.translationStats(doc);

const checks = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  checks.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : `\n      got: ${JSON.stringify(actual)}\n      exp: ${JSON.stringify(expected)}`));
};

console.log('--- filename ---');
console.log(res.filename);
console.log('--- repoDir / dir / segment ---');
console.log(res.repoDir, '|', res.dir, '|', res.segment);
console.log('--- assets ---');
console.log(JSON.stringify(res.assets.map(a => a.dir + '/' + a.name)));
console.log('--- stats ---');
console.log(JSON.stringify(res.stats));
console.log('--- markdown ---');
console.log(res.markdown);
console.log('--- coverage ---');
console.log(JSON.stringify(cov));
console.log(JSON.stringify(stats));

check('filename', res.filename, 'DeepWiki/milvus-io/milvus/1-overview/index.md');
check('repoDir', res.repoDir, 'DeepWiki/milvus-io/milvus');
check('segment', res.segment, '1-overview');
check('asset dir', res.assets[0] && res.assets[0].dir, 'assets');
check('asset name', res.assets[0] && res.assets[0].name, '1-overview-diagram-1.svg');
check('img link', res.markdown.includes('![System Architecture](assets/1-overview-diagram-1.svg)'), true);
check('译文条数 stats', res.stats.translations, 3);
check('译文容器数', stats.wrappers, 3);
check('译文正文块数', stats.blocks, 6);
check('已翻译块数（含仅译文模式）', stats.translated, 3);
check('「仅译文」标记数', stats.only, 1);
check('coverage count 与 stats 一致', cov.count, stats.translated);
check('覆盖率', cov.ratio, 0.5);
check('文件名不算待翻译正文', stats.blocks, 6);
check('「相关源文件」清单不参与统计',
  DW.translatableBlocks(doc).some(el => el.closest('details')), false);
check('代码标识符不参与统计',
  DW.translatableBlocks(doc).some(el => /grpcproxy|segcore/.test(el.textContent)), false);
check('仅译文块被判为已翻译',
  DW.isTranslatedBlock(doc.querySelector('[data-read-frog-translation-only]')), true);
check('普通隐藏元素被丢弃', res.markdown.includes('SHOULD_BE_DROPPED'), false);
check('display:none 被丢弃', res.markdown.includes('SHOULD_BE_DROPPED_TOO'), false);
check('半透明淡入中的译文不被丢弃', res.markdown.includes('半透明淡入中的译文。'), true);
check('仅译文模式内容保留', res.markdown.includes('仅译文模式'), true);
check('无 read-frog UI 残留', /read-frog-(spinner|react-shadow-host)/.test(res.markdown), false);
check('英文与译文未粘在同一行', /vector database built for scale\.Milvus/.test(res.markdown), false);
check('译文单独成段', /\n\nMilvus 是一个为大规模场景构建的高性能向量数据库。/.test(res.markdown), true);
check('第三段译文保留', res.markdown.includes('第三段的译文。'), true);
check('代码块保留', res.markdown.includes('```go'), true);
check('表格保留', res.markdown.includes('| Dep |'), true);
check('侧边栏未混入', res.markdown.includes('2 Architecture'), false);

// 平铺模式回归
const flat = DW.buildWikiPage(doc, { folderPerPage: false });
check('平铺模式文件名', flat.filename, 'DeepWiki/milvus-io-milvus-1-overview.md');
check('平铺模式资源目录', flat.assets[0].dir, 'milvus-io-milvus-1-overview.assets');

console.log('\n=== 检查结果 ===');
console.log(checks.join('\n'));
const failed = checks.filter(c => c.startsWith('FAIL'));
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' 通过');
process.exit(failed.length ? 1 : 0);
