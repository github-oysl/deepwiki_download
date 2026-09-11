---
name: deepwiki-to-md
description: 把 DeepWiki（deepwiki.com）的 Wiki 全文页或 AI 问答页在线拉取并转成 Markdown 写入本地笔记目录，一条命令通吃两种页面，支持整站批量；内置环境初始化（--init 自检/装依赖）与导出后的中文翻译入库流程。当用户要求「抓取/下载/导出 deepwiki 页面为 markdown」「把 deepwiki 内容入库/存成中文笔记」「批量导出某个仓库的 deepwiki」时使用。
agent_created: true
---

# DeepWiki → Markdown 入库

把 deepwiki.com 的 **Wiki 全文页** 或 **AI 问答页（/search/...）** 转成干净 Markdown
（front-matter、标题层级、表格、代码块、GitHub 源码引用链接、Mermaid 架构图），
按「一篇一个文件夹」落盘，两种页面**同一条命令**，脚本自动识别：

```
<out>/DeepWiki/<owner>/<repo>/<页面>/index.md + assets/     ← Wiki 页
<out>/DeepWiki/<owner>/<repo>/<仓库>-问答合集-<日期>/index.md ← 问答页
```

核心提取器来自 Chrome 扩展 deepwiki-md-exporter（vendor/ 内置）。

## 标准管线：初始化 → 抓取导出 → 翻译 → 入库

完整入库为中文笔记的流程分四步，初始化每台机器只需一次，其余每篇执行：

1. **初始化**：`--init` 自检环境（见下节），缺失依赖自动安装
2. **抓取导出**：跑导出命令，得到英文原文 `index.md`
3. **翻译**：把 `index.md` 译为中文，写 `index.zh-CN.md`（规则见「翻译入库」节）
4. **入库**：同文件夹保留英文原文 + 中文译文双份，批量时同步更新 `00-目录.md`

## 初始化（每台机器首次使用前执行一次）

```bash
NODE=C:/Users/sloy/.workbuddy/binaries/node/versions/22.22.2-2/node.exe
WS=C:/Users/sloy/.workbuddy/binaries/node/workspace/node_modules
SCRIPT=C:/Users/sloy/.workbuddy/skills/deepwiki-to-md/scripts/deepwiki2md.cjs

NODE_PATH=$WS $NODE $SCRIPT --init             # 自检 curl / jsdom / playwright
NODE_PATH=$WS $NODE $SCRIPT --init --install    # 缺失时自动装进托管 workspace
```

- 自检项：`curl`（网络抓取必需）、`jsdom`（转换必需）、`playwright`（仅问答页/SPA 浏览器兜底需要）
- `--install` 会用 `npm install --prefix <NODE_PATH 上级目录>` 把缺失包装进托管 node workspace
- 浏览器兜底另需 chromium：`npx playwright install chromium`（通常已装）
- 默认走本地代理 `socks5h://127.0.0.1:2334`，失败自动回退直连；`--proxy` 改地址、`--no-proxy` 关闭、环境变量 `DW_PROXY`

## 抓取导出

```bash
# Wiki 全文页 或 问答页：URL / owner/repo[/page] 均可，自动识别
NODE_PATH=$WS $NODE $SCRIPT https://deepwiki.com/milvus-io/milvus/1-overview --out D:/notes
NODE_PATH=$WS $NODE $SCRIPT https://deepwiki.com/search/etcd_2338b55c-xxxx --out D:/notes

# 整站批量：顺目录逐页抓取 + 生成 00-目录.md（注意系统负载，问答页不宜批量）
NODE_PATH=$WS $NODE $SCRIPT milvus-io/milvus --all --out D:/notes

# 离线转换已保存的 HTML（浏览器手动兜底用）
NODE_PATH=$WS $NODE $SCRIPT page.html --from-file --url "https://deepwiki.com/<owner>/<repo>/<page>" --out D:/notes
```

选项：`--out` 输出根目录（默认 ./DeepWiki）；`--flat` 平铺；`--no-frontmatter`；
`--no-browser` 禁用浏览器兜底；`--delay <ms>` 批量间隔（默认 1500）；`--timeout <s>`（默认 40）。

## 页面类型与抓取策略（脚本自动处理，无需区分）

| 页面 | 内容位置 | 脚本行为 |
| --- | --- | --- |
| Wiki 全文页 | SSR HTML 直出；Mermaid 图在 RSC payload 里 | 直接解析；从 RSC 数据提取 `​```mermaid` 源码块追加为文末「架构图（Mermaid 源码）」章节 |
| 问答页 | 客户端流式生成（约 20s 后到齐），HTML 是空壳 | 先试解析；失败自动用 playwright 无头浏览器渲染（轮询等正文稳定），再转换 |

## 翻译入库（导出后执行）

无头模式没有翻译插件，导出为英文原文；由 WorkBuddy 在导出完成后翻译并入库：

1. **读取**：读导出的 `index.md`
2. **翻译规则**：
   - **不译**：代码块与行内代码、URL 及链接目标、Mermaid 源码、HTML 标签、front-matter 字段名、GitHub 引用标记（如 `README.md18-20`）
   - **译**：标题、正文、表格单元格文字、图表 caption；专有名词（Milvus、etcd、gRPC 等）保留英文
   - 保持 Markdown 结构不变（标题层级、列表、表格列数、链接语法）
3. **长文分块**：按 H2/H3 切块翻译，单块建议 ≤300 行；逐块写入，避免超长输出被截断
4. **落盘**：译文写到同目录 `index.zh-CN.md`，front-matter 追加 `lang: zh-CN` 与 `translated: <日期>`，保留原 `source` 等字段；assets 共用，不复制
5. **入库**：同一文件夹保留英文原文 + 中文译文；用户明确只要中文时，才把译文写回 `index.md` 并移除英文原文件
6. **目录同步**：批量模式下更新 `00-目录.md`——每页两行（`标题（中文）/ index.zh-CN.md`、`Title (EN) / index.md`），或按用户偏好只列中文

## 问答页兜底（脚本自动失败时的手动方案）

系统负载高时无头浏览器可能被环境终止，此时改用 agent-browser：

```bash
agent-browser open "<问答页URL>" && sleep 25 && \
agent-browser get html "body" > qa-rendered.html
NODE_PATH=$WS $NODE $SCRIPT qa-rendered.html --from-file --url "<问答页URL>" --out D:/notes
```

注意：`agent-browser` 的 open/eval/get 必须**在同一条命令**里（daemon 不跨 Bash 调用保持）。
拿到的英文 markdown 同样走上面的「翻译入库」流程。

## 已知限制

- **译文质量**：翻译由大模型完成，专业术语保留英文；如需浏览器翻译插件的译文，改用
  deepwiki-md-exporter 扩展在有翻译插件的浏览器里手动导出
- **Wiki 页图表**：默认追加 mermaid 源码块（Obsidian/VS Code/Typora 可直接渲染）；
  若浏览器渲染路径成功，图表会是渲染好的 SVG 资源文件
- **批量模式依赖目录链接在 HTML 里**；若为 SPA 空壳会警告并退化为单页模式
- **批量抓取保留 `--delay`** 防限流；失败页可在报告中列出后单独重试
- 长时间运行的无头浏览器在系统负载极高时可能被终止——问答页抓取失败时优先用上面的手动兜底方案
