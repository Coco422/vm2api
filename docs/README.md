# 文档

- [PRODUCTION_STATUS.md](PRODUCTION_STATUS.md) — 当前定制生产状态、本地工作目录、主机/七台VM、镜像与备份核验快照；接手先读
- [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) — 从189恢复主控或单台worker的操作手册、验收及分场景耗时
- [DEPLOY.md](DEPLOY.md) — 安装与升级（含 `deploy/install.sh` 一键安装 / 更新）
- [nginx-shell.md](nginx-shell.md) — 集群 / 槽运维终端 WebSocket 连不上时查 nginx Upgrade
- [FORMAT.md](FORMAT.md) — 本地与 CI 同一套格式（Biome / gofmt / Prettier，LF）
- [API.md](API.md) — `/v1`
- [RISK.md](RISK.md) — 封控拦截（蒸馏 → 硬正则 → 拒答缓存 → 决策模型 → 放行出站）
- [PANEL_API.md](PANEL_API.md) — 管理台 API
- [COMPANY_SUBSCRIPTIONS.md](COMPANY_SUBSCRIPTIONS.md) — 当前原生租户权限说明、定制分支历史及本地沙箱
- [BILLING_RETENTION.md](BILLING_RETENTION.md) — 计费摘要长期保留与调试正文清理边界
- [VM_EGRESS_AUDIT.md](VM_EGRESS_AUDIT.md) — 出口四项基准、真实检测记录及未通过事项
- [ISSUE_BACKLOG.md](ISSUE_BACKLOG.md) — open issue 复核后暂不修复的清单（2026-10-28）
- 抄本：[deploy/env.example](deploy/env.example) · [deploy/vm2api.service](deploy/vm2api.service)

总览：[README](../README.md)。版本：[CHANGELOG.md](../CHANGELOG.md)

入门站：[vm2api.fkcodex.com/zh](https://vm2api.fkcodex.com/zh/)（对照 1.3.133）。

Telegram：[t.me/VM2API](https://t.me/VM2API)
