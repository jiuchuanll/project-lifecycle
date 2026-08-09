# Project Lifecycle

Project Lifecycle 是一个共享、宿主中立的插件，用于构建低噪声、可追溯的项目知识，
并运行与知识库分离的 PRD 交付生命周期。项目源代码和私有知识始终留在项目仓库中。

## 共享 Skills

- `maintain-project-knowledge` 在固定的 `docs/project-lifecycle/` 下完成项目知识的
  初始化、路由、物化、更新与归档检索。
- `run-prd-lifecycle` 将反馈与交付工作路由到 PRD、架构、开发指导、实现批次、
  测试、闭环以及知识差异吸收。

共享 Skills 是权威行为来源。Codex、Claude Code、Cursor、Kimi Code 与 ZCode 的
集成只包含安装方式和工具映射差异。

## 候选状态

版本 `0.1.0` 是私有的**非发布候选**。包、内置验证器、清单、Skills 与保留的
一致性证据已经具备，但目前没有任何原生宿主满足发布支持门禁，因此不能据此创建
首次发布 tag。

## 支持矩阵

下表绑定 `tests/harnesses/support-matrix.json`；如果 README 与保留证据不一致，
打包会失败。

| 宿主 | 状态 | 实测版本 | 证据 |
| --- | --- | --- | --- |
| codex | FAILED | 0.147.0-alpha.6.5 | invariant-failures:codex:8, targeted-regression:codex:4of4, trace-set:codex:ae5b5ad |
| claude | NOT_TESTED | — | availability:claude:unavailable |
| cursor | NOT_TESTED | — | availability:cursor:unavailable |
| kimi | FAILED | 0.29.2 | invariant-failures:kimi:15, targeted-regression:kimi:6of6, trace-set:kimi:ae5b5ad |
| zcode | NOT_TESTED | — | availability:zcode:unavailable |

`FAILED` 表示已测试的原生宿主违反了一个或多个封闭 Gold 不变量；`NOT_TESTED`
表示没有可用的原生可执行程序参与测试。静态一致性或仅发现 Skill 都不能产生
`SUPPORTED` 结论。

## 安装证据与宿主说明

发布压缩包面向 Node.js 22+ 自包含：其中包含 `dist/project-lifecycle.mjs` 内置
验证器，托管插件副本无需安装依赖。

- [Codex 安装与移除](integrations/codex/README.md)
- [Claude Code 安装与移除](integrations/claude/README.md)
- [Cursor 安装与移除](integrations/cursor/README.md)
- [Kimi Code 安装与移除](integrations/kimi/README.md)
- [ZCode 安装与移除](integrations/zcode/README.md)

这些是安装说明，不是支持声明。重新运行原生一致性测试时，应使用矩阵里的精确宿主
版本。

## 固定项目资产

项目知识使用固定根目录：

```text
docs/project-lifecycle/
```

交付运行时文件继续与 PRD 绑定并在闭环时清理；已接受知识通过显式差异吸收，
不会直接复制 PRD 正文。

## 已知限制

- Codex 与 Kimi 在完整保留运行集中的原生一致性仍为失败，主要因为生成结果频繁离开
  封闭路由词表；另有一次 Kimi 运行遗漏了必需的选中方案。后续有界整改回归中，
  Codex 受影响场景 4/4、Kimi 受影响场景 6/6 通过，但不能替代完整支持门禁。
- Claude Code、Cursor 与 ZCode 尚无保留的原生运行证据。
- 外部审批真实性与恶意并发文件系统修改仍属于宿主责任，并受已记录的单写入者边界约束。
- KnowledgeVault 消费端迁移保持只读审计，直到至少一个宿主受支持且两个共享 Skill
  均被原生发现。详见[迁移方案](docs/migrations/knowledgevault-agent-app.md)。

0.1.0 候选范围见 [RELEASE-NOTES.md](RELEASE-NOTES.md)。
