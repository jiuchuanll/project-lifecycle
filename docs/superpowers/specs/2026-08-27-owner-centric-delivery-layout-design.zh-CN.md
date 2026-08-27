# 以 Owner 为中心的交付目录设计

状态：设计已确认；等待书面文档审阅

日期：2026-08-27

仓库：`jiuchuanll/project-lifecycle`

主路线：`NON_PRD_DELIVERY`

已选方案 ID：`solution-owner-centric-delivery-layout-v2`

英文原文：[2026-08-27-owner-centric-delivery-layout-design.md](./2026-08-27-owner-centric-delivery-layout-design.md)

## 目标

用以 Owner 为中心的层级结构替代扁平的 `docs/project-lifecycle/delivery/` 命名空间，使 Feedback、PRD、非 PRD、架构、指导、批次、测试和关闭资产持续增加时仍然易读且可以确定性导航。同时保留 Feedback 与 Owner 的多对多关系、中英文配对、证据保留、归档门禁，以及从旧布局进行原子迁移的能力。

## 问题

当前物化器把每个持久交付资产都直接写到 `docs/project-lifecycle/delivery/` 下，文件名为 `<artifact-id>-en.md` 和 `<artifact-id>.md`。这种结构保留了“知识与交付分离”的边界，却丢失了单次交付内部的结构。随着 PRD 数量增长，不同 Owner 和阶段共享同一个目录，人工浏览越来越嘈杂，Agent 必须从大量文件中重新拼装所有权，保留或迁移逻辑也无法围绕一个有界 Owner 子树工作。

第一版 `docs-workflow` 曾区分需求、架构、开发指导、批次日志、测试报告、变更记录和 Feedback。新生命周期需要恢复这种清晰度，同时保留后来引入的更严格持久 Owner 模型。纯粹按文档类型组织仍会迫使一次 PRD 续跑跨多个全局目录读取。因此，已选设计把 Feedback 和生成视图作为全局类别，把交付过程资产聚合到唯一的 PRD 或非 PRD 物理 Owner 下。

## 已确认原则

- 每个交付过程资产有且只有一个物理持久 Owner。
- PRD 或非 PRD 交付是其架构、指导、批次、测试报告和关闭资产的物理 Owner。
- Feedback 保持物理独立，因为 Feedback 与交付 Owner 是多对多关系。
- 跨 Owner 的语义关系继续保存在 Frontmatter 中，不创建多个物理副本。
- 稳定的跨 PRD 事实通过已接受的 Knowledge Diff 流程离开交付区，而不是成为永久共享交付文档。
- 生成型活动视图与权威资产或人工维护资产隔离。
- 目录名使用稳定 ID，不使用本地化标题、日期或可变生命周期状态。
- 英文继续作为 Agent 默认资产；中英文逻辑对同步变更并保存在同一目录。
- 现有项目只通过显式、预览过且原子的操作迁移。

## 规范目录

规范活动目录为：

```text
docs/project-lifecycle/delivery/
├── layout.json
├── INDEX.md
├── INDEX-en.md
├── feedback/
│   ├── feedback-<id>.md
│   └── feedback-<id>-en.md
├── prds/
│   └── prd-<id>/
│       ├── INDEX.md
│       ├── INDEX-en.md
│       ├── prd-<id>.md
│       ├── prd-<id>-en.md
│       ├── architecture/
│       ├── guidance/
│       ├── batches/
│       ├── test-reports/
│       └── closure/
├── non-prd/
│   └── <delivery-id>/
│       ├── INDEX.md
│       ├── INDEX-en.md
│       ├── <delivery-id>.md
│       ├── <delivery-id>-en.md
│       ├── architecture/
│       ├── guidance/
│       ├── batches/
│       ├── test-reports/
│       └── closure/
└── views/
    ├── alignment-review.md
    └── alignment-review-en.md
```

不要求创建空的可选阶段目录；只有 Owner 具有对应的合理资产时才创建。根目录和 Owner 的 `INDEX` 中英文对根据已验证 Frontmatter 与文件系统清单生成，不由用户或 Agent 手工维护。

### 确定性放置规则

| 资产类型 | 规范活动位置 |
| --- | --- |
| `feedback` | `delivery/feedback/<artifact-id>{-en,}.md` |
| `prd` | `delivery/prds/<artifact-id>/<artifact-id>{-en,}.md` |
| `non-prd-delivery` | `delivery/non-prd/<artifact-id>/<artifact-id>{-en,}.md` |
| `architecture` | `<owner-root>/architecture/<artifact-id>{-en,}.md` |
| `guidance` | `<owner-root>/guidance/<artifact-id>{-en,}.md` |
| `batch` | `<owner-root>/batches/<artifact-id>{-en,}.md` |
| `test-report` | `<owner-root>/test-reports/<artifact-id>{-en,}.md` |
| `closure-summary` | `<owner-root>/closure/<artifact-id>{-en,}.md` |
| 生成型对齐视图 | `delivery/views/alignment-review{-en,}.md` |

物化器根据已验证机器字段计算这些路径，调用方不能自行传入任意目标定位符。

## 物理所有权契约

向交付 Frontmatter 增加 `owner_artifact_id`。

- `prd` 或 `non-prd-delivery` 根 Owner 的 `owner_artifact_id` 等于自身 `artifact_id`。
- `architecture`、`guidance`、`batch`、`test-report` 和 `closure-summary` 必须填写唯一的 PRD 或非 PRD Owner ID。
- `feedback` 不得填写 `owner_artifact_id`，因为它的物理位置与 Owner 无关。
- `relationships.prd_ids` 继续表达语义关系并可包含多个 ID，但不再决定物理位置。
- 子资产的 Owner 不存在、类型错误、关闭转换无效或与关系字段冲突时，必须在任何写入前拒绝。

唯一物理 Owner 不禁止跨 Owner 引用。被多个 PRD 使用的变更契约可以归属于引入它的 PRD，并由依赖 PRD 引用。如果该契约成为已接受的当前事实，关闭阶段将其移交给 `maintain-project-knowledge`；交付区不保留重复的共享权威来源。

## 活动、关闭与归档状态

Owner 活动期间，其根文档和所有合理的阶段资产都保存在规范 Owner 目录内。生成的 Owner 索引展示状态、Feedback 覆盖、已有资产和下一合法生命周期动作。

Owner 被接受、拒绝、取消或撤回后：

1. 规范 Owner 目录继续保留在同一个稳定路径。
2. 默认交付检索中只保留生成索引和精简的中英文 Closure Summary。
3. 根 Owner 正文和详细阶段证据移动到镜像归档子树：

   ```text
   docs/project-lifecycle/archive/delivery/prds/<prd-id>/
   docs/project-lifecycle/archive/delivery/non-prd/<delivery-id>/
   ```

4. 保留的 Closure Summary 和生成索引记录归档定位符、结果、验收、准确证据、Feedback 覆盖、剩余风险和 Knowledge Diff 处置。
5. 后续读取详细归档正文前必须取得 archive receipt。

这样既保留可见的稳定 Owner 身份，又不会让已完成的过程正文污染默认检索。生命周期状态永远不进入 Owner 目录名。

活动、暂缓或仍被 Owner 覆盖的 Feedback 保留在 `delivery/feedback/`。所有必要 Owner 都已接受关闭且对应 Knowledge Diff 或无变更结果已解决后，Feedback 对移动到 `archive/delivery/feedback/`。已完成 Feedback 不进入生成的对齐活动视图。

## 布局版本契约

`docs/project-lifecycle/delivery/layout.json` 是机器维护的物理布局声明：

```json
{
  "schema_version": 1,
  "layout_version": 2
}
```

它不记录迁移进度、聊天历史、Owner 状态或执行时间线。

- 没有布局文件且存在扁平交付 Markdown 时，识别为旧布局。
- `layout_version: 2` 只允许规范层级结构。
- 新旧扁平与层级写入混合存在时视为无效。
- 只有全部移动、受管引用改写、索引和验证成功后，迁移才发布 `layout.json`。
- `project-map.json` 继续负责项目身份、领域、知识拓扑和路由，不增加交付文件系统状态。

## 显式迁移

迁移是独立授权操作，不得成为插件升级、资产创建、索引生成或普通生命周期续跑的自动副作用。

### 预览

迁移首先对活动交付根和归档交付根执行只读、有界清点，返回：

- 准确旧定位符与建议新定位符；
- 资产 ID、类型、语言和建议物理 Owner；
- 能够确定性改写的受管引用；
- 需要风险审阅的外部 Markdown 引用；
- 不完整双语对、重复 ID、无效 Frontmatter、不安全路径和模糊 Owner；
- 准确的写入、移动与移除集合。

预览不创建目录、布局标记、索引、备份或文档变更。

### 旧资产 Owner 推导

只允许有证据支持的映射：

- `feedback` 映射到 `delivery/feedback/`。
- `prd` 在 `delivery/prds/<artifact-id>/` 下归属于自身。
- `non-prd-delivery` 在 `delivery/non-prd/<artifact-id>/` 下归属于自身。
- 只有一个合法 `relationships.prd_ids` 条目的过程子资产可以使用该 PRD 作为 Owner。
- Closure Summary 使用已验证关闭载荷中的 `owner_artifact_id`。
- 生成型对齐视图映射到 `delivery/views/`。
- Owner 候选缺失、多个或相互矛盾时返回 `NEEDS_USER`；文件名相似不是证据。

执行前，用户必须明确确认完整迁移计划，包括每一项人工补充的 Owner 映射。

### 原子执行

执行阶段在有界临时位置暂存已验证文件，只改写已验证的受管引用，生成全部必要索引，并验证完整的目标树。只有这些步骤全部成功后，才发布层级结构和 `layout.json`，并移除旧规范副本。任何失败都恢复迁移前的准确状态并报告未完成阶段。

迁移不创建符号链接、重定向占位文件、永久重复正文或无限期双写兼容。旧归档中的扁平资产在同一次操作中迁移，避免活动区和归档区采用不同物理契约。

## 读写兼容边界

新运行时可以检测并清点旧扁平布局，以生成迁移预览，但不能向旧布局增加新资产。针对尚未迁移的旧项目发起生命周期请求时，必须先停止在迁移要求上，再进行持久交付写入。

存在 `layout_version: 2` 后，所有物化、更新、索引、保留、归档发现、对齐投影和关闭逻辑只使用层级解析器。兼容范围刻意限定为“为迁移而读取”，而不是永久双写。

## 索引与检索行为

交付根索引分别展示：

- 活动 PRD Owner；
- 活动非 PRD Owner；
- 保留的已关闭 Owner 摘要；
- 活动 Feedback；
- 生成型活动视图。

每个 Owner 索引只链接物理归属于该 Owner 的已验证资产，以及 Frontmatter 中的跨 Owner 和 Feedback 语义关系。递归发现具有明确的最大深度、文件数量、文件大小、真实路径包含和符号链接拒绝限制。受管交付目录中的未知 Markdown 或 JSON 文件会导致验证失败，不能被静默忽略。

默认上下文选择只读取根索引、已选 Owner 索引和最少必要的活动资产，不递归加载同级 Owner 或归档正文。

## 失败处理与安全

- 拒绝半创建的双语对和机器字段分歧。
- 在路径计算前拒绝缺失、模糊或类型不兼容的 Owner ID。
- 拒绝路径穿越、绝对资产定位符、受管根符号链接、真实路径逃逸、重复 ID 和超量清单。
- 拒绝混合布局版本以及与文件系统不一致的布局标记。
- 迁移时保留来源哈希、资产 ID、关系、证据引用和受管链接目标。
- 新文件对和所有受影响索引验证前，不删除旧文件。
- 预览和验证保持只读。
- 把设计确认、迁移计划确认、迁移执行、交付验收和知识回写视为独立门禁。

## 验证与验收

实现至少必须覆盖：

1. 每种资产类型和两种语言的确定性路径。
2. 根 Owner 自我拥有，每个过程子资产解析到一个合法 Owner。
3. Feedback 多对多关系不改变其独立路径。
4. 跨 Owner 语义引用不创建重复物理文件。
5. 中英文对位于同一目录且机器字段完全一致。
6. 根索引和 Owner 索引展示活动 Owner、关闭摘要、Feedback 和视图，不把无关正文扫描进上下文。
7. 关闭保留精简摘要，同时把详细正文移动到镜像归档。
8. 读取归档详情需要有效 archive receipt。
9. 旧布局预览不写文件并报告准确的建议变更集合。
10. 模糊的旧 Owner 归属停止在 `NEEDS_USER`。
11. 显式迁移保留 ID、关系、正文、哈希和受管引用。
12. 强制制造迁移中途失败时恢复逐字节相同的旧目录，并且不发布布局标记。
13. 混合布局、路径穿越、符号链接逃逸、重复 ID、深度超限、未知受管文件和不完整双语对被拒绝。
14. 对齐视图只生成到 `delivery/views/`，且不包含已完成历史。
15. 安装缓存入口不依赖仓库 `node_modules`，仍可执行检测、预览、迁移、验证、物化、关闭和索引。
16. 现有路由、Feedback 不可变性、关闭、保留、Knowledge Diff 和双语行为测试继续通过。

## 实现边界

实现应引入一个共享交付路径解析器并由所有命令复用，不能在多个命令中复制路径规则。它可以更新交付 Frontmatter schema、物化、索引发现、对齐投影、关闭与保留、归档发现、夹具、行为场景、安装版 CLI 接口、README 目录树和两个生命周期 Skill 的参考文档。

本次变更不得重新设计路线词表、Feedback 语义、Knowledge Diff 权威边界、project-map 拓扑、obligation 行为或人工验收门禁。仓库测试或插件安装期间不得迁移任何用户项目。

## 恢复

在真实项目执行迁移前，必须在目标树之外保留已验证、可恢复的快照，或使用仓库已有的可恢复版本控制状态。迁移结果必须报告备份或恢复引用、布局版本、准确移动路径、验证结果和所有未解决外部链接。恢复只还原迁移前目录并移除未发布或无效的 v2 布局标记，不改写无关项目资产。
