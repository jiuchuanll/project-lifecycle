# 分层知识目录与索引设计

状态：已批准

日期：2026-08-11

仓库：`jiuchuanll/project-lifecycle`

目标插件版本：`0.2.0`

已选方案：`solution:unified-layout-planner`

英文原文：[2026-08-11-hierarchical-knowledge-index-design.md](./2026-08-11-hierarchical-knowledge-index-design.md)

## 目标

将平铺的 `docs/project-lifecycle/knowledge/*.md` 改为完全由 `project-map.json.parent_id` 派生的确定性递归布局，并逐层生成双语索引，使生命周期根索引不会随着领域数量和深度增长而无限膨胀。

此变更继续保留 Project Lifecycle 的知识门禁：已确认父领域可以存在目录或派生 INDEX，但这并不表示父领域已经拥有获批的 current 知识正文。

## 已确认决策

- `project-map.json` 继续作为唯一权威垂直拓扑来源。
- canonical project-map Schema 升级为版本 `2`；版本 `1` 不作为常规运行 Schema 长期注册。
- 插件版本升级为 `0.2.0`。
- 使用一个纯布局规划器、一个双语索引渲染器、一个验证器和一个事务应用器。
- 不公开新增面向用户的迁移 CLI。Agent 负责勘察、解释和确认，内部 `migrateKnowledgeLayout()` 操作负责确定性原子执行。
- 真实项目迁移需要一次明确批准，批准后完整执行，不逐文件询问。
- 不在旧 locator 保留正文、redirect stub 或 symlink。
- 不增加持久迁移回执文件。Agent 结果、Git diff、提交历史和保留的任务证据共同构成迁移审计轨迹。
- 为验证计算完整期望 manifest，但只发布字节或存在状态确实需要变化的文件。
- 叶子提升为父目录与父领域降级为叶子采用对称行为。
- 多仓项目集中治理和全局导航，知识正文继续位于 canonical repository。
- 本机全局 Codex 插件 marketplace 始终绑定 `develop`。只有 PR 合并且用户确认 `develop` 已包含 `0.2.0` 后才升级全局插件。

## 范围

此变更包括：

- v2 project-map、locator、约束引用与所有权契约；
- 递归 canonical locator 规划；
- 生命周期根、Knowledge 根、仓库分片和领域目录 INDEX；
- 在递归布局中物化知识；
- 确定性的叶子提升和父领域降级；
- 子树 reparent 和受控 domain ID replacement；
- 合法 `0.1.0` 平铺知识树的显式迁移；
- 带回滚的双语与多文件原子发布；
- 集中治理下的仓库本地知识分片；
- 增量 INDEX 发布；
- validators、fixtures、自然语言行为场景、发布元数据和双语文档。

此变更不迁移真实外部项目，不迁移 KnowledgeVault Agent App，不保留旧外部 Markdown 链接，不创建第二套拓扑来源，不发布 npm 包，不自动合并 PR，也不会在 PR 合并前更新本机全局插件。

## 权威与状态边界

`project-map.json` v2 保存领域身份、`parent_id`、生命周期状态、仓库所有权、路由关系、约束和 canonical 资产 locator。目录和 INDEX 都是派生视图，不能提供缺失的拓扑或知识事实。

边界确认不等于事实验证。生成父目录或父级 INDEX 不会物化父领域知识。只有边界、至少一条耐久事实、权威证据、canonical owner、主要依赖、限制、unknowns 和 current 事实批准全部满足现有物化门禁时，父领域正文才允许存在。

拓扑、所有权、ID、父子关系或影响路由的变化继续遵守 pending change、影响分析和明确人工批准规则。文件移动器具备搬迁能力，不代表它可以绕过语义门禁。

## Canonical 仓库所有权

每个领域有且只有一个 canonical repository：

1. `repositories[].domain_ids` 中唯一出现的仓库负责该领域。
2. 未被任何注册仓库声明的领域属于权威 project map 所在治理仓，以 `repository_id: null` 表示。
3. 已物化领域的 `paired_assets.repository_id` 必须与上述归属一致。
4. 英文与中文资产必须位于同一仓库。
5. `repositories[].domain_ids`、`repositories[].knowledge_asset_locators` 与 `paired_assets` 不一致时验证失败。

v2 paired-assets 结构为：

```json
{
  "paired_assets": {
    "repository_id": null,
    "en": "knowledge/runtime/loop-en.md",
    "zh-CN": "knowledge/runtime/loop.md"
  }
}
```

Map locator 相对于所属仓库的 `docs/project-lifecycle/` 根。Capability Frontmatter 中的 `paired_asset` 继续使用同目录双语文件之间的相对链接。

## Canonical Locator 算法

规划器先验证领域 ID 唯一、父领域存在、parent 图无循环、仓库所有权确定且 locator 输入安全，然后把已接受的全局树投影到各 canonical repository。

对领域 `D`：

1. 从 `D.parent_id` 开始向根遍历。
2. 只保留与 `D` 属于同一 canonical repository 的连续祖先。
3. 遇到第一个跨仓边界立即停止；不得在 `D` 所在仓镜像远端祖先目录。
4. 按从根到直接父级的顺序使用这些祖先作为目录片段。
5. 如果 `D` 在全局 map 中有任意直接子领域，则追加 `D.id` 目录并把自身正文放进该目录。
6. 如果 `D` 是叶子，则把正文放在保留的同仓直接父目录中。

因此：

```text
顶级叶子：
knowledge/search.md
knowledge/search-en.md

顶级父领域：
knowledge/runtime/runtime.md
knowledge/runtime/runtime-en.md
knowledge/runtime/INDEX.md
knowledge/runtime/INDEX-en.md

嵌套父领域与叶子：
knowledge/runtime/loop/loop.md
knowledge/runtime/loop/loop-en.md
knowledge/runtime/loop/tools.md
knowledge/runtime/loop/tools-en.md
knowledge/runtime/loop/INDEX.md
knowledge/runtime/loop/INDEX-en.md
```

跨仓子领域从其仓库的 `knowledge/` 根开始一个仓库本地分片。全局父级 INDEX 通过已注册 portable repository locator 链接该分片。

同一个已验证 map 和仓库注册必须永远生成相同 locator manifest。现有目录不能影响计算结果。

## INDEX 职责

每个生成 INDEX 都有中英文对应文件，使用稳定 code-point 排序，并标明它由 Project Lifecycle 派生、不得手工维护。

### 生命周期根 INDEX

`docs/project-lifecycle/INDEX.md` 与 `INDEX-en.md` 只包含：

- 项目标识和用途；
- 当前知识 baseline；
- Knowledge 入口；
- Delivery 入口；
- active change、archive 和 identity lineage 的轻量入口。

它们不枚举领域或后代。

### 治理仓 Knowledge INDEX

治理仓 `knowledge/INDEX.md` 与 `INDEX-en.md` 只列全局顶级领域，并通过 portable locator 包含仓库所有的顶层根。每项包含本地化名称、ID、领域状态、已物化 knowledge state；当 owner 分片的已接受 Frontmatter 有意不在本地提供时标记为 `remote`，未物化时标记为 `not-materialized`。每项还包含一句边界，以及领域目录 INDEX 或叶子正文链接。不展开后代。

### 仓库分片 Knowledge INDEX

实现仓的 Knowledge INDEX 只列该仓分片入口，即父领域不存在或父领域属于其他 canonical repository 的领域。它不复制治理仓的完整顶级清单。

### 领域目录 INDEX

每个包含直接子领域的领域在其 canonical repository 拥有一个目录 INDEX，内容包括：

- 当前领域名称、ID、状态和简短边界；
- 已物化时的自身正文链接；
- 尚无获批正文时明确标注 `not materialized`；
- 仅直接子领域及其状态，以及正文、下一级 INDEX 或 portable 跨仓链接；
- 仅当前层适用的 `depends_on`、`governed_by` 和 `coordinates_with` 导航。

它不复制能力正文、事实块、证据正文、unknowns 或全部后代。

retired、merged 和正文 superseded 的直接子领域保留在紧凑的“历史直接子领域”小节并显示 successor。它们不作为活跃入口，也不递归展开。

## 组件架构

### 布局规划器

纯规划器接收已验证的 v2 project map 和仓库注册，返回包含期望目录、本地化正文、INDEX、canonical locator、跨仓链接和失效派生路径的确定性 manifest。它不读写文件系统。

### INDEX 渲染器

渲染器只接收规划结果和已验证本地化元数据，生成三类 INDEX，不重新推断拓扑，也不读取任意 Markdown 正文。

基于文件系统的生成按仓库分片限定。`generateIndexesFromRoot()` 接收当前 `repository_id`，只读取归属该分片的能力文档对，也只输出该分片的 INDEX 文件。治理分片使用 `null`。其他分片的元数据绝不会相对当前 lifecycle root 解析。

### 布局验证器

验证器检查 Schema、图完整性、所有权、安全路径、双语配对、Frontmatter 与事实一致性、链接目标，以及期望 manifest 和实际文件树是否一致。结构验证成功不代表产品事实真实。

### 事务应用器

应用器比较期望 manifest 与有界当前树，只暂存必要变更，验证完整 candidate，然后通过现有 lifecycle-root staging/backup 事务发布。它支持失败注入和回滚。

### 操作集成

Bootstrap、materialization、已接受拓扑应用、knowledge absorption、INDEX 生成和迁移都消费规划器结果，任何操作都不得单独实现 locator 算法。

## 物化与拓扑变化

物化子领域可以创建所需祖先目录和 INDEX，但不能创建未获批准的祖先正文。

叶子首次产生子领域时，中英文正文从父目录移动到 `<domain-id>/<domain-id>.md` 和 `<domain-id>/<domain-id>-en.md`。父领域失去最后一个子领域时执行逆向移动，并删除失效 INDEX 和空派生目录。两种转换都保持事实、revision、baseline、evidence 和 knowledge state 不变。

子树 reparent 必须先具备已接受 pending change 和后代影响分析。事务移动 canonical 双语正文，更新旧祖先链、新祖先链以及受路径变化影响的所有 locator 和精确插件管理引用，不相关分支保持字节不变。

本地化名称变化不改变路径。domain ID replacement 会创建新路径并要求明确 predecessor/successor 处理。事实本身没有独立获批的 replacement、split 或 merge 时，fact ID 保持不变。

## 旧版 `0.1.0` 迁移

版本 `1` 是 legacy 迁移输入，不是注册的常规运行 Schema。v2 写操作遇到 `schema_version: 1` 时返回 `KNOWLEDGE_LAYOUT_MIGRATION_REQUIRED`。

Skill 指示 Agent 识别旧布局，在不写入的情况下勘察，解释完整影响并请求一次批准。批准后，内部 `migrateKnowledgeLayout()` 操作：

1. 只接受严格合法的 `0.1.0` 平铺结构；
2. 验证完整中英文对和不变机器字段；
3. 拒绝新旧布局混合、重复正文、缺失语言、非法父级、循环、不安全路径和所有权歧义；
4. 根据 `parent_id` 和 canonical repository 计算完整 v2 manifest；
5. 把双语正文作为一个单元迁移；
6. 把 map Schema 升级为版本 `2`；
7. 更新 paired assets、Frontmatter、constraint refs、repository locators、精确插件管理 Markdown 链接和所有派生 INDEX；
8. 发布前验证完整 v2 candidate；
9. 返回新旧 locator 映射、变更路径、外部链接风险和验证结果。

迁移不增加 redirect stub、symlink、重复正文或迁移回执文件，也不会广泛改写任意仓库 Markdown 或源码文件。Git diff、提交和保留的 Agent 结果构成审计轨迹。

第二次执行返回 `already-v2`，不写文件、不产生差异。

## 多仓事务

多仓迁移或拓扑变化时，每个仓在已接受 baseline 和 write lease 下准备并验证 staged candidate。只有所有分片和治理 candidate 全部通过后才开始发布，治理 map 最后发布。

内部迁移调用为每个非治理 owner 提供显式 `repository_roots` 映射。勘察会将所有参与的 lifecycle tree 指纹绑定为一个已批准输入。仓库分片在治理发布成功前保留回滚备份；任一分片或治理发布失败都会恢复所有已发布分片。

任一仓失败时恢复所有已发布分片。如果恢复本身失败，操作返回阻断性恢复错误并保留明确标识的恢复资产；它不能推进治理 Schema 或声称成功。

## 安全路径与恢复边界

每个规划路径都必须是所属仓 lifecycle root 下的标准化相对路径。拒绝绝对路径、盘符路径、反斜杠、把 URL 当路径、`..`、符号链接目标和 realpath 越界。

英文与中文文件是一个发布单元。Map、正文、插件管理引用和受影响 INDEX 组成一个已接受写集合。任何写入、rename、验证或发布失败都恢复原始完整树。成功操作不留下 stage、backup、重复正文、失效生成 INDEX 或空派生目录。

## 增量 INDEX 发布

规划器始终计算并验证完整期望 manifest。应用器把期望字节和存在状态与磁盘比较，只发布变化。

不改变导航的正文更新不重写 INDEX。Materialization 通常只影响当前目录、必要祖先链、仓库 Knowledge INDEX，以及实际发生变化的轻量生命周期根元数据。Reparent 只影响旧祖先链、新祖先链和被移动子树 locator，不影响无关分支。

No-change 运行零写入。测试同时验证无关 INDEX 的字节和修改时间不变。

## Skill 与上下文路由行为

新项目直接 bootstrap 为 v2。读取旧项目本身不触发迁移。对旧布局提出持久写请求时，自动产生迁移规划并经过一次人工确认，然后 Agent 调用内部迁移操作。

通过 portable locator 完成发现后，上下文选择会接收已接受的治理 map 与已验证的 `currentRepositoryId`。只有当所有已选领域都归属当前分片时才继续；否则返回下一个所需仓库的 portable locator。这同时防止跨 root 读取与无限的 repository-required 循环。

上下文选择从轻量生命周期根 INDEX 开始，进入相关 Knowledge 或仓库分片 INDEX，只加载目标领域、适用祖先约束和必要直接依赖。不能通过根 INDEX 预加载所有领域。

自然语言请求必须能够触发 Skill，不要求显式写出 `$maintain-project-knowledge`。没有耐久知识影响的临时问题不得规划或执行迁移。

共享 Skill 与脚本继续作为 Codex、Claude Code、Cursor、Kimi Code 和 ZCode 的权威实现。宿主适配器保持轻量，不实现宿主专用布局。

## Schema 与版本变化

Canonical project-map Schema 要求 `schema_version: 2`。`paired_assets` 必须包含 `repository_id`、`en` 和 `zh-CN`。递归 constraint refs 与 repository knowledge locators 使用共享有界 locator 验证器，不再使用只允许平铺布局的正则。

Map 不增加目录路径或祖先列表字段；父子关系仍只由 `parent_id` 表示。

版本 `0.2.0` 必须在 `package.json`、lockfile、所有宿主 manifest、集成说明、中英文 README、Release Notes、构建产物、checksum 和版本断言中同步。

## TDD 与验证

实施从失败测试开始，覆盖：

1. 单个顶级叶子；
2. 一个父领域和多个叶子子领域；
3. 三级或更深递归；
4. 未物化父领域下的已物化子领域；
5. 叶子提升；
6. 父领域降级；
7. 子树 reparent；
8. 受控 domain ID replacement；
9. 合法 `0.1.0` 平铺迁移；
10. 中英文原子迁移；
11. 根 INDEX 只包含轻量入口；
12. 治理与仓库 Knowledge INDEX 只包含各自入口领域；
13. 领域 INDEX 只列直接子级；
14. 确定性排序和重复运行零差异；
15. Materialization 后自动重建受影响 INDEX；
16. 不重写无关 INDEX；
17. paired assets 与实际路径完全一致；
18. 拒绝缺失语言、机器字段不一致、非法父级、循环、重复所有权和混合布局；
19. 拒绝路径穿越、绝对路径、反斜杠、URL 路径和 symlink 逃逸；
20. 写入、rename、验证和发布失败注入后的完整回滚；
21. 多仓 pointer 和仓库本地 locator 解析；
22. 迁移后完整 Schema、pair、fact、link 和 index 验证；
23. Bootstrap 和 materialization 幂等；
24. 升降级与 reparent 保持 fact ID、revision、baseline 和 evidence refs。

测试检查拓扑、实际路径、链接目标、机器字段、保留事实和恢复后的文件树，不能只依赖字符串快照。

行为验证至少包含以下自然语言场景：

- 新项目首次构建两级知识地图并逐步物化；
- 已有平铺知识库迁移到递归布局；
- 在三级领域中路由上下文且不加载全部根 INDEX；
- 普通临时问题不得触发迁移或耐久写入。

## 验收与审查门禁

发布工作前必须通过：

```text
npm test
npm run validate:fixtures
npm run check:privacy
npm run check:bundle
npm run conformance:static
git diff --check
```

还必须完成：

- fixture validation；
- Skill structural validation；
- 保留行为场景证据；
- 双语文档一致性；
- 没有本任务范围外变更；
- 没有修改缓存或外部项目；
- 没有临时、备份、生成垃圾或重复正文残留；
- 对当前 diff 运行 Codex 内置审查；
- 针对文件移动、symlink containment、仓库边界和回滚进行最窄范围 Codex Security diff review；
- 修复有效发现并重跑相关测试和完整门禁。

历史测试数量或支持声明不属于当前证据。只有保留的原生验证证据才能改变宿主支持状态。

## Push、PR 与本机安装

实施、验证、审查和修复全部完成后，提交范围内变更，使用已确认审查门禁 push `codex/hierarchical-knowledge-index`，并创建目标为 `develop` 的 ready-for-review PR。不得自动合并。

创建 PR 时不更新全局已安装插件。用户确认 PR 已合入 `develop` 后，在 marketplace 继续绑定 `develop` 的前提下刷新 `project-lifecycle` marketplace，通过 Codex 原生插件命令安装 `0.2.0`，并验证已安装版本、CLI 和两个 Skill 的发现状态。禁止直接编辑 `~/.codex/plugins/cache/`。
