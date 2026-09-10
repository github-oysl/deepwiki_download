# DeepWiki 转 Markdown ｜ 架构笔记导出

一个 Chrome 扩展（Manifest V3），把 **DeepWiki** 的内容一键导出成干净的 Markdown 文件，用来整理架构学习笔记。

- **Wiki 页面** → 带标题层级、表格、列表、代码块、Mermaid 架构图的 Markdown
- **问答页面**（`/search/...`）→ 问题 + 回答的 Markdown，可整页合集、也可逐条导出
- **支持翻译后的页面**：直接从实时 DOM 提取，翻译插件（沉浸式翻译、Google 翻译等）写回页面的译文会被原样导出
- **引用标记自动变成 GitHub 源码链接**：`milvus.yaml:17-18` → 可点击跳到 GitHub 对应行
- **笔记夹**：把不同问答页面的内容收集起来，最后汇总成一份笔记
- **整站批量导出**：一次导出某个仓库的全部 Wiki 页面 + 目录文件

---

## 一、安装（3 步）

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 打开右上角的 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本文件夹 `deepwiki-md-exporter`

装好后打开 `https://deepwiki.com/` 任意页面，右下角会出现一个紫色的 **MD** 悬浮按钮。

> 首次安装后，已经打开的 DeepWiki 页面需要刷新一次，扩展才会注入。

---

## 二、怎么用

### 1. 导出某个 Wiki 页面

打开例如 `https://deepwiki.com/milvus-io/milvus/1-overview`：

- **方式 A**：点右下角悬浮的 **MD** 按钮 → *下载 Markdown*
- **方式 B**：点浏览器工具栏的扩展图标 → *下载 Markdown*

导出内容包含：页面全部正文（标题层级、段落、列表、表格、代码块）、Mermaid 架构图、以及所有指向 GitHub 源码的引用链接。

### 2. 导出问答（重点）

打开例如 `https://deepwiki.com/search/etcd_2338b55c-...`：

- **整页导出**（默认）：把页面上所有问答按顺序合成一个文件，每条问答是一个 `## Q1. 问题…` 小节，结尾附该问答的来源文件清单
- **逐条导出**：在面板/弹窗的「本页问答」列表里，每条问答右侧有三个按钮
  - `MD` 下载这一条
  - `复制` 复制这一条到剪贴板
  - `＋` 加入笔记夹

### 3. 笔记夹（把多页问答合并成一份笔记）

在看问答页时，点 **＋ 加入笔记夹**，内容会暂存在扩展本地。收集够了以后：

- 面板底部 / 弹窗「笔记夹」区块 → **导出** 或 **复制**
- 会按仓库分组、按收集时间排序，输出一份完整的 `DeepWiki-问答笔记-日期.md`
- 扩展图标上的角标数字 = 当前收集的条数

### 4. 整站批量导出

在任意 Wiki 页面（不是问答页）的面板/弹窗里点 **批量导出整个 Wiki**：

- 自动读取左侧目录里的全部子页面，逐页抓取并导出到 `下载/DeepWiki/<仓库名>/`
- 同时生成 `00-目录.md`，里面是全部页面的本地链接，可直接作为笔记库的入口
- 过程中页面右下角会显示进度

> **注意**：批量导出用隐藏 iframe 抓取，**不包含翻译插件的译文**（翻译插件一般不会处理 iframe）。
> 需要译文时请逐个页面导出。

### 5. 使用翻译插件时

导出的是**页面上当前显示的内容**，所以：

1. 先用翻译插件翻译页面（沉浸式翻译默认的「双语对照」或「仅译文」都可以）
2. 等翻译完成
3. 再点导出

行为说明：

- 翻译插件把译文写进页面 DOM（沉浸式翻译的默认模式就是这样）→ 译文会被导出
- 扩展会**自动丢弃不可见元素**，所以「仅译文」模式下隐藏起来的英文原文不会混进来
- 想要中英对照笔记，就用「双语对照」模式导出，两种语言都会保留
- 代码块、文件名、GitHub 链接不会被翻译插件改写（它们本来就不参与翻译），导出后仍然可用

### 6. 设置项

点扩展图标 → 「设置」：

| 设置 | 说明 |
| --- | --- |
| 输出 front-matter | 文件开头加 YAML 元信息（标题、仓库、来源、导出时间） |
| 正文顶部显示来源 | 在正文最前面插入一行「仓库 / 来源 / 页面」 |
| Wiki 保留「相关源文件」 | 是否保留 DeepWiki 页首那个 *Relevant source files* 折叠列表（默认关闭，避免文件列表过长） |
| 问答保留「来源文件」 | 每条问答结尾列出引用的源文件（默认开启） |
| 引用标记转 GitHub 链接 | 把 `milvus.yaml:17-18` 变成可点击的 GitHub 链接（默认开启） |
| 忽略页面隐藏元素 | 丢弃 `display:none` 等不可见元素，配合翻译插件使用（默认开启） |
| 回答标题降一级 | 问答导出时把回答里的 `##` 降为 `###`，让问题标题独占一级（默认开启） |
| 图表 | `独立 .svg 文件`（默认，兼容 Obsidian / Typora / VS Code）／`内嵌 base64`（单文件自包含，体积大）／`忽略` |
| 下载子目录 | 默认 `DeepWiki`，可改成 `DeepWiki/{repo}` |
| 文件名模板 | 见下方变量 |

文件名模板可用变量：`{repo}` `{pageId}` `{title}` `{date}` `{time}` `{type}` `{count}`

---

## 三、导出的内容长什么样

Wiki 页面：

```markdown
---
title: "Overview"
repo: "milvus-io/milvus"
page: "1-overview"
source: "https://deepwiki.com/milvus-io/milvus/1-overview"
exported: "2026-09-10T17:30:00+08:00"
---

> 仓库：`milvus-io/milvus` ｜ 来源：https://deepwiki.com/milvus-io/milvus/1-overview

# Overview

Milvus is a high-performance vector database ... [README.md:18-20](https://github.com/milvus-io/milvus/blob/cfb604e7/README.md#L18-L20)

![System Architecture and Component Data Flow](milvus-io-milvus-1-overview.assets/milvus-io-milvus-1-overview-diagram-1.svg)

| Dependency Category | Technology / Library | Code Pointer |
| --- | --- | --- |
| **Metadata & KV** | etcd | [go.mod:36-37](https://github.com/...) |
```

问答页面：

```markdown
## Q1. etcd 是什么？在这个架构中起什么作用？

### 答案

**etcd** 是 Milvus 架构中的核心依赖组件 ...

### 详细说明

#### 1. 元数据存储（Metadata Storage）

... [milvus.yaml:17-18](https://github.com/milvus-io/milvus/blob/cfb604e7/configs/milvus.yaml#L17-L18)。

**来源文件**

- [`configs/milvus.yaml`](https://github.com/...)

---

## Q2. ...
```

---

## 四、下载目录结构

```
下载/
└── DeepWiki/
    ├── milvus-io-milvus-1-overview.md
    ├── milvus-io-milvus-1-overview.assets/
    │   ├── milvus-io-milvus-1-overview-diagram-1.svg
    │   └── milvus-io-milvus-1-overview-diagram-2.svg
    ├── milvus-io-milvus-问答合集-2026-09-10.md
    ├── milvus-io-milvus-问答-2026-09-10.md
    ├── DeepWiki-问答笔记-2026-09-10.md
    └── 00-目录.md            ← 批量导出时生成
```

Markdown 与 `.assets` 目录的相对位置是固定的，可以整个文件夹搬进笔记库（Obsidian / Typora / VS Code 均可正常显示架构图）。

---

## 五、权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存设置项与笔记夹内容 |
| `downloads` | 保存 Markdown / SVG 文件（支持子目录、无多文件下载弹窗） |
| `offscreen` | MV3 后台没有 `URL.createObjectURL`，用它生成大文件的下载链接 |
| `https://deepwiki.com/*` | 在 DeepWiki 页面上读取内容 |

扩展**不请求网络权限**，所有内容都在本地处理，不会上传到任何地方。

---

## 六、常见问题

**Q：点了下载但没反应？**
- 检查 Chrome 下载设置里是否允许该站点下载多个文件（批量导出会一次下载很多文件）
- 若浏览器拦截了自动下载，地址栏右侧会有提示，选「允许」再重试

**Q：问答页面导出说「未找到问答内容」？**
- 答案还在流式生成中，等它生成完再点一次

**Q：页面刚跳转过来，按钮没出现？**
- DeepWiki 是单页应用，刷新一次页面即可

**Q：导出后架构图在笔记软件里显示不出来？**
- 默认的「独立 .svg 文件」模式需要 `.md` 和同名 `.assets` 文件夹放在一起
- 只想拿一个文件就选「内嵌 base64」（注意：Obsidian 和 GitHub 不渲染 base64 图片，Typora / VS Code 可以）

**Q：译文没被导出？**
- 先确认页面上确实显示的是译文（翻译插件已生效）
- 如果翻译插件把译文放在 Shadow DOM 或浏览器原生翻译层里，读取可能不完整；沉浸式翻译的默认模式（把译文写进页面）是完整支持的

**Q：批量导出很慢 / 有些页面失败？**
- 每页需要重新渲染，正常约 1~2 秒/页，100 页大约 2~3 分钟
- 失败的页面会在结束提示里给出数量，可以单独打开那页再导出

---

## 七、目录结构与开发

```
deepwiki-md-exporter/
├── manifest.json
├── icons/                        图标（16/32/48/128）
├── src/
│   ├── lib/                      turndown.js / turndown-plugin-gfm.js（HTML→Markdown）
│   ├── common/extractor.js       核心：页面识别、内容提取、DOM 清洗、Markdown 组装
│   ├── content/                  内容脚本 + 页面内悬浮面板样式
│   ├── background/               Service Worker、offscreen 下载
│   └── popup/                    工具栏弹窗
└── tools/make_icons.py           用标准库重新生成图标
```

关键实现说明：

- **提取而不是请求**：所有内容都从实时 DOM 读取（先克隆再清洗），因此翻译结果、展开状态、渲染好的 Mermaid 图都在其中
- **DOM 清洗**：剔除按钮/图标/隐藏元素/翻译插件 UI，图表转成 SVG（序列化后内嵌或落地为文件）
- **引用标记**：把 DeepWiki 的行内引用小标签还原成 `文件:行号`，并用右侧源文件卡片里的 GitHub 链接补成可点击链接
- **批量导出**：在页面里创建一个隐藏 iframe 依次导航同源页面，读取其 `div.prose-custom` 后复用同一套提取逻辑

重新生成图标：

```bash
python tools/make_icons.py
```

调试：打开 `chrome://extensions/` → 本扩展 → *Service Worker* / *检查视图*，页面内的日志前缀为 `[DeepWiki→MD]`（按需在 `content.js` 中开启）。

---

## 八、开源协议

[MIT](LICENSE) © 2026 github-oysl

第三方依赖：[Turndown](https://github.com/mixmark-io/turndown)（MIT）、
[turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm)（MIT），均已随源码内置在 `src/lib/`。

