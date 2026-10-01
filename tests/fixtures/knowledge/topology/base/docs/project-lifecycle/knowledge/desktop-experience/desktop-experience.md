---
id: desktop-experience
knowledge_state: current
paired_asset: desktop-experience.md
last_verified_baseline: baseline-1
implementation_refs: ["repo:src/desktop"]
verification_refs: ["test:desktop"]
---

# 桌面体验

## 用途与当前边界

负责已验收的桌面交互。

## 当前事实

### `desktop-shell-fact`

<!-- project-lifecycle:fact
fact_id: desktop-shell-fact
revision: 1
evidence_refs: ["repo:src/desktop", "test:desktop"]
last_verified_baseline: "baseline-1"
-->

桌面壳负责工作区框架。

#### 已知限制

工作区专属内容仍由各领域拥有。

<!-- /project-lifecycle:fact -->

## 系统与数据关系

负责桌面边界。

## 实现与资源地图

桌面入口点。

## 质量状态

已在 baseline-1 验证。

## 依赖

无已声明依赖。

## 已知限制与未知项

运行时专属布局保持受限。

## 来源与沿革

已验收项目证据。

<a id="constraint-desktop-privacy"></a>
<!-- project-lifecycle:constraint id=desktop-privacy revision=1 -->
桌面隐私约束适用于全部后代。
<!-- /project-lifecycle:constraint -->

<a id="constraint-desktop-shell"></a>
<!-- project-lifecycle:constraint id=desktop-shell revision=1 -->
桌面壳约束仅适用于自身。
<!-- /project-lifecycle:constraint -->
