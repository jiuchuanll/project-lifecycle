# Project Lifecycle

[English](README.md)

[![CI](https://github.com/jiuchuanll/project-lifecycle/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/jiuchuanll/project-lifecycle/actions/workflows/ci.yml?query=branch%3Adevelop)
[![许可证：Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![状态：预发布](https://img.shields.io/badge/status-pre--release-orange.svg)](#项目状态)

Project Lifecycle 是一个共享、宿主中立的插件，用于构建低噪声、可追溯的项目知识，
并运行与知识库相互关联但彼此分离的 PRD 交付生命周期。它把长期知识保留在项目仓库
中，同时避免交付过程内容未经确认就成为项目当前事实。

## 项目状态

> [!IMPORTANT]
> 本仓库已经开源，但版本 `0.1.0` 仍是**预发布评估候选**。它尚未发布到 npm，且目前
> 没有任何原生宿主满足发布支持门禁。安装说明仅用于评估，不代表生产支持承诺。

源代码、确定性发布压缩包和保留的一致性证据均已公开，可供检查和贡献。所有支持声明
仍以[基于证据的支持矩阵](#支持矩阵)为准。

## 插件提供什么

Project Lifecycle 将两条相互关联的工作流明确分开：

| 需要完成的工作 | 共享 Skill | 结果 |
| --- | --- | --- |
| 构建或更新长期项目知识 | `maintain-project-knowledge` | 在 `docs/project-lifecycle/` 下形成经确认的项目地图、中英文领域能力知识、有界待审变更和低噪声上下文路由 |
| 把反馈转化为可开发、可测试的交付 | `run-prd-lifecycle` | 形成 Feedback、PRD、架构、开发指导、实现批次、测试证据、闭环记录以及显式知识差异 |

共享 Skills 是权威行为来源。Codex、Claude Code、Cursor、Kimi Code 与 ZCode 的
集成只包含安装方式和工具映射差异。

核心规则：

- 项目地图是紧凑的路由和归属索引，不是第二份知识正文。
- 中文和英文资产是一个逻辑整体，必须同步演进。
- 只有经过验证和接受的事实才能进入当前知识；交付文稿不会被自动复制进知识库。
- 重要的拓扑、约束 ID、基线、冲突以及并行交付决策必须经过用户明确审核。
- Agent 先读取满足任务所需的最小上下文；只有通过显式、收据绑定的请求才能访问归档。

## 快速开始

前置条件：

- 内置验证器要求 Node.js 22 或更高版本。
- 使用五个目标宿主之一；当前版本仍是非发布候选，建议使用一次性测试 Profile。
- 项目仓库允许创建 `docs/project-lifecycle/`。

1. 按照[安装与宿主说明](#安装与宿主说明)选择对应的原生安装方式。
2. 重新加载宿主，确认 `maintain-project-knowledge` 和
   `run-prd-lifecycle` 都可以被发现。
3. 验证内置 CLI：

   ```text
   bin/project-lifecycle version
   bin/project-lifecycle help
   ```

4. 使用自然语言开始工作，例如：

   ```text
   对这个项目进行有界证据勘察，提出初版领域能力地图，并在正式物化知识前邀请我校准。
   ```

   ```text
   记录这条用户反馈，结合当前项目知识进行路由，并帮助我判断是否需要进入 PRD 交付流程。
   ```

在新项目中，知识工作流会先进行轻量证据勘察，提出领域能力地图，并等待用户校准后再
批量物化。在已有项目中，它会根据当前地图路由，只读取任务真正需要的上下文。

## 项目资产

生命周期根目录固定，不允许用户自定义：

```text
docs/project-lifecycle/
├── project-map.json        # 机器可读的路由与归属地图
├── pending-changes.json    # 有界待审账本，不属于当前事实
├── INDEX.md                # 生成的中文导航镜像
├── INDEX-en.md             # 生成的 Agent 默认导航
├── knowledge/              # 中英文成对的长期领域能力知识
└── delivery/               # 与 PRD 绑定的交付资产及运行记录
```

领域能力知识可以先按用户容易理解的领域划分，再按具体能力细分。如果前端、后端、测试
或其他实现事项拥有独立事实、负责人或演进节奏，可以分别形成成对文档；
`project-map.json` 负责建立关联，而不是把它们的正文合并在一起。

典型生命周期如下：

```text
反馈 -> 路由 -> PRD/交付资产 -> 开发与测试 -> 闭环
     -> 经审核的知识差异 -> 已接受项目知识
```

交付运行时文件继续与 PRD 绑定，并按保留策略在闭环时清理。历史交付资产可以作为
证据保留，但不会进入默认检索上下文。

## 验证器 CLI

发布压缩包包含 `dist/project-lifecycle.mjs` 和可执行文件
`bin/project-lifecycle`；托管插件副本无需安装依赖。CLI 每次输出一个 JSON 结果
对象，并提供以下命令：

- `collect-evidence`
- `validate-json`
- `validate-pair`
- `parse-facts`
- `validate-fixtures`
- `version` 与 `help`

使用 `bin/project-lifecycle help` 查看命令集合。验证器负责结构性契约，例如 Schema、
ID、引用、中英文配对、Fact 区块和 fixture 完整性；它不能替代 Agent 对产品语义的判断，
也不能替代用户审核。

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

## 安装与宿主说明

- [Codex 安装与移除](integrations/codex/README.md)
- [Claude Code 安装与移除](integrations/claude/README.md)
- [Cursor 安装与移除](integrations/cursor/README.md)
- [Kimi Code 安装与移除](integrations/kimi/README.md)
- [ZCode 安装与移除](integrations/zcode/README.md)

重复原生一致性测试时，应使用矩阵中的精确宿主版本。安装说明只描述发现与安装方式，
不会覆盖上面的证据状态。

## 开发与验证

```text
npm ci
npm run check
npm run check:bundle
```

`npm run check` 会运行契约和行为测试、验证 fixture，并执行隐私门禁；
`npm run check:bundle` 会重建和验证自包含验证器。在干净的候选工作树上，
`node scripts/package-release.mjs` 会重建确定性压缩包和校验和。

## 参与贡献

欢迎参与贡献。发起拉取请求前请先阅读[贡献指南](CONTRIBUTING.zh-CN.md)；如需报告可复现
问题或提出边界明确的功能建议，请使用
[Issue 列表](https://github.com/jiuchuanll/project-lifecycle/issues)。

- 常规贡献以 `develop` 为目标分支。
- 行为或面向用户的说明发生变化时，请同步补充测试并更新中英文文档。
- 请勿提交凭据、私有数据、本地生成状态或与特定机器绑定的路径。
- 受保护分支要求 `check` 状态通过、获得所有者审核，并解决全部审核对话后才能合并。

## 许可证

Project Lifecycle 使用 [Apache License 2.0](LICENSE) 开源。

## 信任边界与已知限制

- Codex 与 Kimi 当前仍未通过完整保留的原生运行集。后续有界整改回归中，Codex 受影响
  场景 4/4、Kimi 受影响场景 6/6 通过，但不能替代完整支持门禁。
- Claude Code、Cursor 与 ZCode 尚无保留的原生运行证据。
- 宿主负责验证外部审批的真实性，并控制任何模型或网络传输。引用、收据和哈希可以绑定
  本地决策，但自身不能验证某个真实用户的身份。
- 恶意并发文件系统修改与崩溃持久性不属于已记录的单写入者边界。
- KnowledgeVault 消费端迁移保持只读审计，直到至少一个宿主受支持且两个共享 Skill
  均被原生发现。详见[迁移方案](docs/migrations/knowledgevault-agent-app.md)。

0.1.0 候选范围见 [RELEASE-NOTES.md](RELEASE-NOTES.md)。
