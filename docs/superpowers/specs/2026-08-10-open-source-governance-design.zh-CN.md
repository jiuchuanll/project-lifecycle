# 开源仓库治理设计

状态：已批准

日期：2026-08-10

仓库：`jiuchuanll/project-lifecycle`

英文原文：[2026-08-10-open-source-governance-design.md](./2026-08-10-open-source-governance-design.md)

## 目标

将现有 GitHub 仓库以 Apache-2.0 许可证对外开源，把 `develop` 设为默认贡献分支，并要求外部贡献进入任何受保护分支前必须经过仓库所有者审核。

## 已确认决策

- 使用 Apache License 2.0。
- 治理文件合入后，从当时最新的远端 `main` 创建 `develop`。
- 将 `develop` 设为 GitHub 默认分支。
- 使用一个仓库级规则集保护 `main`、`develop`、`release/*` 和 `hotfix/*`。
- 将 `@jiuchuanll` 设为整个仓库的 Code Owner。
- 仅允许仓库管理员在 Pull Request 内绕过规则。这样既保留 PR 记录，也能在 GitHub 不允许作者自我批准时，让唯一所有者处理自己的紧急或发布 PR。
- 保留 `package.json` 的 `"private": true`；公开 GitHub 仓库并不代表授权发布 npm 包。

## 范围

本次变更包括：

- 对当前代码树及 Git 历史进行公开前隐私与凭据审计；
- 添加 Apache-2.0 许可证文本；
- 配置覆盖全仓库的 CODEOWNERS；
- 添加中英文贡献指南；
- 让 CI 同时覆盖 `main` 和 `develop`；
- 创建 `develop`；
- 将仓库可见性改为公开；
- 启用分支规则集；
- 将默认分支改为 `develop`。

本次不发布 npm 包、不将仓库迁移至 Organization、不增加维护者、不在未经单独批准时重写 Git 历史，也不新增发布自动化。

## 公开顺序

1. 刷新并检查远端仓库状态，确认目标仍是 `jiuchuanll/project-lifecycle`、仓库仍为私有且默认分支仍为 `main`。
2. 审计当前 `main` 内容及其可达 Git 历史，检查凭据、私有路径、个人数据、意外归档、危险符号链接及未经批准的发布资产。
3. 运行现有发布门禁，包括 `npm run check`、夹具校验、隐私检查和 `git diff --check`。
4. 从最新 `origin/main` 建立分支，加入治理文件并调整 CI；运行测试、Codex Review 和范围受限的安全审查。
5. 在仓库仍为私有时，将治理 PR 合入 `main`。
6. 从更新后的远端 `main` 创建 `develop`，确保包含治理文件且不带入其他尚未合并的分支提交。
7. 将仓库可见性改为公开。
8. 立即创建并启用仓库规则集。
9. 将默认分支改为 `develop`。
10. 从 GitHub 重新读取仓库元数据、分支引用、CODEOWNERS、许可证识别结果及规则集状态。

如果审计发现尚未解决的敏感数据，或必要验证失败，必须在第 7 步之前停止。公开 Git 数据可能立即被他人复制，因此重新改回私有不能视为充分补救。

## 仓库文件

- `LICENSE`：未经修改的 Apache License 2.0 正式文本。
- `.github/CODEOWNERS`：`* @jiuchuanll`。
- `CONTRIBUTING.md`：英文贡献流程和受保护分支政策。
- `CONTRIBUTING.zh-CN.md`：保持同步的中文镜像。
- `.github/workflows/ci.yml`：让 push CI 同时覆盖 `main` 和 `develop`；Pull Request CI 继续覆盖所有目标分支。

贡献指南将要求普通外部贡献默认提交到 `develop`。稳定发布通过 `release/*` 进入 `main`；紧急生产修复使用 `hotfix/*`。对所有受保护分支的变更都必须使用 Pull Request。

## 规则集

使用一个启用状态的仓库级分支规则集，目标为：

- `main`
- `develop`
- `release/*`
- `hotfix/*`

规则集将：

- 要求合并前必须建立 Pull Request；
- 要求至少一次批准；
- 要求 Code Owner 审批；
- 新提交改变已审核差异时自动作废旧审批；
- 要求解决所有审核讨论；
- 要求现有 CI `check` 作业通过；
- 禁止强制推送；
- 禁止删除匹配分支；
- 仅向仓库管理员授予 Pull Request 内的绕过权限。

本次不要求签名提交或线性历史，因为这些约束不在用户请求内，并可能无必要地拒绝有效的外部贡献。

## 失败处理

- 如果当前 GitHub 身份验证无法执行管理操作，则停止并请求重新认证；不得改用其他账号或仓库。
- 如果当前 GitHub 方案不支持在私有状态创建规则集，则在仓库公开后立即创建，并在更改默认分支前完成验证。
- 如果无法识别必要的 CI 上下文，则先保持 PR 和审批保护生效，修复 CI 上下文识别问题，并且不得声称完整验收已通过。
- 如果 GitHub 变更只完成了一部分，则报告准确的远端实时状态，仅完成或安全撤销未完成的治理步骤。不得把本地命令成功当作远端成功。

## 验收标准

- GitHub 报告仓库可见性为 `public`。
- GitHub 报告默认分支为 `develop`。
- `develop` 创建时指向已包含治理变更的 `main` 提交。
- GitHub 识别 Apache-2.0 许可证。
- CODEOWNERS 将所有路径分配给 `@jiuchuanll`。
- 已启用的规则集覆盖已批准的四个分支名或模式。
- 进入受保护分支的 PR 必须通过 `check` 状态、一次批准、Code Owner 审批，并解决所有讨论。
- 新提交会作废旧审批。
- 无绕过权限的参与者不能直接更新、强推或删除受保护分支。
- 仓库管理员只能在 Pull Request 中绕过。
- 本地验证、Codex Review 和范围受限的安全审查均无尚未解决的阻塞发现。

## 安全边界

在本设计中，将仓库改为公开是唯一不可逆的发布边界。只有仓库内容审计和治理变更审查全部通过后才能执行。若在历史中发现密钥或私有数据，必须先明确修复并重新审计，之后才能公开。
