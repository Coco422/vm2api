# 文档

- [PRODUCTION_STATUS.md](PRODUCTION_STATUS.md) — 当前定制生产状态、本地工作目录、主控/worker与VM规模、镜像和189备份核验快照；接手先读
- [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) — 从189恢复主控或单台worker的操作手册、验收及分场景耗时
- [双主控生产交接](ROLLING_GATEWAY.md#生产日常交接) · [发布验收门禁](ROLLING_GATEWAY_RELEASE_GATE.md#现网切换门禁) — 切前名单、排空、切后验收与同库回退
- [CONTROL_MIGRATION_PLAN.md](CONTROL_MIGRATION_PLAN.md) — 旧主控到期前迁入新134节点的计划、同机worker容量与切换/回退边界；尚未执行
- [DEPLOY.md](DEPLOY.md) — 安装与升级（含 `deploy/install.sh` 一键安装 / 更新）
- [托管节点内核排障与验收](managed-kernel-troubleshooting.md) — CRAG 缺包、控制面连接、单槽重装、Claude 版本与账号状态的分层检查
- [nginx-shell.md](nginx-shell.md) — 集群 / 槽运维终端 WebSocket 连不上时查 nginx Upgrade
- [DEVELOPMENT.md](DEVELOPMENT.md) — 分支（dev 开发 / main 发布）、工作树、验证、CI 触发与发版流程
- [开发验证与 CI](../README.md#开发验证与-ci) — 核心集、指定测试文件、按目录触发与手动全量 / ARM 检查
- [CRAG 面板历史复用](performance/crag-panel-history-reuse.md) — 入站优化过程、CPU 对照、长会话回放和缓存边界
- [FORMAT.md](FORMAT.md) — 仅格式化改动文件；手动全量 CI 使用同一套 Biome / gofmt / Prettier 配置（LF）
- [API.md](API.md) — `/v1`
- [RISK.md](RISK.md) — 封控拦截（蒸馏 → 硬正则 → 拒答缓存 → 决策模型 → 放行出站）
- [PANEL_API.md](PANEL_API.md) — 管理台 API
- [COMPANY_SUBSCRIPTIONS.md](COMPANY_SUBSCRIPTIONS.md) — 当前原生租户权限说明、定制分支历史及本地沙箱
- [TENANT_CAPACITY_STANDARD.md](TENANT_CAPACITY_STANDARD.md) — 下一批Claude用户12并发/12席位、按VM叠加容量的交付规范；现有批次不改
- [MULTI_VM_DELIVERY.md](MULTI_VM_DELIVERY.md) — 多VM/Key/用户并发交付、席位排队与内核不可用诊断、本地1.4.038整合边界
- [BILLING_RETENTION.md](BILLING_RETENTION.md) — 计费摘要长期保留与调试正文清理边界
- [VM_EGRESS_AUDIT.md](VM_EGRESS_AUDIT.md) — 出口四项基准、真实检测记录及未通过事项
- [AFO_INTEGRATION.md](AFO_INTEGRATION.md) — AFO 平台对接的 `/api/v1` 兼容层规格（未实现）
- [redaction/README.md](redaction/README.md) — 可启停内容脱敏：默认关闭；helper 未就绪时阻断，不发明文
- [ISSUE_BACKLOG.md](ISSUE_BACKLOG.md) — open issue 复核后暂不修复的清单（2026-10-28）
- 抄本：[deploy/env.example](deploy/env.example) · [deploy/vm2api.service](deploy/vm2api.service)

总览：[README](../README.md)。版本：[CHANGELOG.md](../CHANGELOG.md)

入门站：[vm2api.fkcodex.com/zh](https://vm2api.fkcodex.com/zh/)（对照 1.3.133）。

Telegram：[t.me/VM2API](https://t.me/VM2API)
