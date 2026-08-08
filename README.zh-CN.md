# Project Lifecycle

Project Lifecycle 是一个共享、平台中立的插件包，用于维护项目知识与交付生命周期，
不会将项目源代码或私有知识移出项目仓库。

## Skill 边界

该包包含两个互补的 Skill：

- `docs-workflow` 负责持久产品文档的路由、命名、索引与验证。
- `run-prd-lifecycle` 将负责在项目知识与 PRD 交付工作之间路由生命周期请求。

各宿主集成仅作为轻量入口；共享 Skill 是权威的行为来源。

## 状态与安装

本仓库当前提供 Node.js 22+ 验证器包基线与 `docs-workflow` Skill。CLI 列出的
生命周期验证命令会在 Phase 1 中逐步实现。

发布渠道可用后，请从该渠道安装此包。在此之前，开发时请使用仓库检出，并运行
`npm install` 后再运行 `npm test`。

## 项目资产

Project Lifecycle 将固定的生命周期资产存放在：

```text
docs/project-lifecycle/
```

该路径是插件契约的一部分，不能按项目配置。

## 支持矩阵

| 范围 | 当前支持 |
| --- | --- |
| Node.js 验证器 harness | 基线（Node.js 22+） |
| 共享 `docs-workflow` Skill | 已提供 |
| 共享 `run-prd-lifecycle` Skill | 计划中 |
| Codex、Claude Code、Cursor、Kimi Code、ZCode 适配器 | 计划中 |
