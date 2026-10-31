> 公开脱敏记录：真实出口地址与供应商映射仅存私有运维台账。

# VM 出口环境检测

> 2026-10-30：控制面 1.4.025 已保存两台生产 VM 的真实公网检测记录与每次四张原始截图。两台均不能认证四项合格：ray-vm 首次 Claude 72 分，复测无评分；188 节点 84 分；两台 Ping0 空白未确认。临时检测运行时按用户要求在检测后清理，原有检测入口与报告保留；再次运行需要按需准备运行时。

管理员打开 VM 详情 →「代理」→「出口环境检测」，点击「一键检测并截图」。后台任务自动刷新进度，可查看最近五次记录及各站 PNG。普通用户、super 和托管调用 Key 都不能运行或读取检测及截图。

## 验收基准

| 检测项 | 地址 | 达标条件 |
| --- | --- | --- |
| Claude 信任评分 | https://ip.net.coffee/claude/ | ≥90 分 |
| DNS / WebRTC | 同上 | 两项绿色、无泄露，且分别有 DNS / UDP IP 观测结果 |
| 纯净度 / AI 适用性 | https://ping0.cc/ | 两项均为绿色 |
| 浏览器环境风险 | https://fuck-claude.com/ | <30 分，必须实际完成扫描 |

四项全部达标、两站出口一致且四张截图完整（Net.Coffee 评分、DNS/WebRTC 专项、Ping0、环境风险）才通过。网络错误、验证码、超时、页面无法解析、扫描未完成或缺少截图，不会通过。Net.Coffee 的「DNS 加密或未暴露出口」「WebRTC 已禁用或无泄露」虽然可能显示绿色，但没有观测证据时标为「未确认」，比仅看颜色更严格。Ping0 只接受明确识别出的对应字段及颜色，未知布局不猜测。fuck-claude 的初始 0 分不算结果。

各项为第三方诊断指标，不代表 Anthropic 的官方风控或账号可用性结论。网站会看到被测公网 IP 及相应浏览器环境信号。

## 执行环境

通过 `slotHost(vm)` 与 `slotExecArgv()` 进入目标 Docker 槽或 KVM guest，复用实际透明出站网络、DNS、时区、语言与字体。远程节点走现有 SSH/Docker 通道，不回落到控制面出网。不把代理密码传给浏览器或写入报告。

每次创建独立临时浏览器目录，退出后清理，不读取账号登录资料。不会为了绿灯改时区、语言、DNS、WebRTC、UDP 或代理设置；仅固定截图视口 1440×1000。浏览器环境诊断不能替代 CLI 的全部信号。macOS 原生节点暂不支持。

VM 内需要标准 Node.js 18+ 及 Chromium / Chrome。Docker 槽镜像补充官方 Node 22；KVM 初始化尝试安装发行版 Node。`cc-node` / `cli-node` 是 CLI 产物，不能充当 Node 解释器。执行器按 `/usr/local/bin/node`、`/usr/local/lib/nodejs/current/bin/node`、`/usr/bin/node`、PATH 的 node 逐个验证，拒绝 Bun 包装器与旧版本。缺少标准运行时返回 `audit_node_missing`。浏览器识别 `/usr/bin/chromium`、`/usr/bin/chromium-browser`、`/usr/bin/google-chrome`、`/opt/google/chrome/chrome`。

源码中的 Debian/Fedora/Arch Docker 槽镜像包含发行版 Chromium，Ubuntu amd64 使用 Google 官方 Chrome（Ubuntu 的 chromium-browser 是 Snap）；Ubuntu arm64 保持原有构建，但不自动安装该 amd64 包，需另行提供兼容浏览器。KVM 首次初始化尝试安装浏览器，安装失败不阻断开机，检测报告运行环境缺失。新增依赖会增加镜像体积及检测时内存/进程占用。

**已有槽位、缓存镜像和上游预构建镜像不会自动获得浏览器。** 发布前需构建并验证带浏览器的基础镜像、重建对应派生槽镜像，然后按既有流程更新目标槽。已有 KVM 需单独安装浏览器。不要仅拉上游旧镜像来判断功能已就绪；只读 Docker 根文件系统不能临时 apt 安装。

检测器在 VM 内存在 `/usr/bin/Xvfb` 时，自动启动独立虚拟显示并运行正常模式 Chromium；没有 Xvfb 则使用无头模式。不会伪造 UA、隐藏自动化标识或代答验证码。Ping0 可能对无头 UA 返回 HTTP 200 空正文，也可能要求 Turnstile；后者等待站点自行验证，仍未完成时记录 `challenge_required`，不推断为 IP 被封。当前页面从 `.line-risk .riskcurrent` 的背景色读取纯净度，从“AI 应用”卡片 `.advice` 的文字色读取适用性，仅使用可见 DOM。每站观测记录 `browser_mode` 与文档响应状态，不保存验证 Cookie 或请求头。虚拟显示与浏览器均在任务结束后退出。

默认启用 Chromium 沙箱。禁止 user namespace 的容器可能启动失败；检测不会自动关闭沙箱或改宿主机安全设置。管理员可在面板显式勾选「容器兼容模式」重试（请求体 `{ "no_sandbox": true }`），仅依赖现有 VM/容器隔离，报告记录 `browser_sandbox: false`。未勾选时不覆盖控制面默认值；部署也可显式设置 `KIN_EGRESS_AUDIT_NO_SANDBOX=true`。接口只接受布尔值，且仍仅限管理员。

## 管理员接口和存储

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| POST | `/api/panel/vms/:id/egress-audit` | 202 `{ ok: true, data: report }` |
| GET | `/api/panel/vms/:id/egress-audit` | `{ ok: true, data: { criteria, reports } }` |
| GET | `/api/panel/vms/:id/egress-audit/:job/screenshots/:site` | 已鉴权 PNG，`Cache-Control: private, no-store` |

`site` 仅接受 `net-coffee`（评分全页）、`net-coffee-leaks`（DNS/WebRTC 专项）、`ping0`、`fuck-claude`，不接受自定义网址、命令、凭证或文件路径。每 VM 同时一次、控制面总计两次。任务通常 1–3 分钟，guest 截止时间 150 秒，控制面执行上限 165 秒。验证码只记为 `challenge_required`。

报告含 state（running/completed/error/interrupted）、verdict（pass/fail/unknown）、四项 results、`evidence_complete`、站点原始观测、截图文件名、时间、VM/代理/节点 ID。重启遗留任务为 interrupted；代理配置、时区或运行位置变更后 `stale: true`、总体结论 unknown。不自动停止 VM 或改调度。

产物位于配置数据目录的 `egress-audits/<vm>/<job>/`，目录 0700、文件 0600。每次新任务保留五次，只清理本功能拥有的旧任务目录。单张 PNG 上限 5 MiB。截图与报告可能包含公网 IP、节点标识及设备环境信息，故仅管理员可读。

## 本地验证

Node 22，测试及构建产物进入现有受管沙箱：

```bash
node scripts/company-local.mjs test egress-audit panel-acl panel-route-coverage
node scripts/company-local.mjs build
```

覆盖边界分数、初始零分、无观测假绿灯、不同出口、互斥、重启、配置过期、截图鉴权和产物保留。合成站点/截图不能替代真实 VM 联网验收；发布前须在目标 Docker/KVM 验证浏览器启动、真实出口、三站提取与截图。

本地 Docker 集成验收已覆盖 Linux ARM64 / Node 22.22.1 / Chromium 156：真实 `kin-egress`、槽内 NAT 与 SOCKS5 路径，三个合成页面的提取/PNG/面板预览，阈值不达标、代理关闭时不直连、沙箱启动失败以及标准 Node 缺失。测试使用独立容器、网络和数据目录，不加载真实账号。兼容模式由管理员显式选择，报告保留该模式。

amd64 Debian 浏览器基础镜像及标准 Node 运行时层可构建（本地因默认包镜像连接中断，使用签名校验仍开启的 USTC Debian 镜像完成构建，未改变生产源配置）。ARM Colima 下 amd64 Chromium 启动器因 `/proc/cpuinfo` 没有 SSE3 标记拒绝启动，故不计为 amd64 浏览器运行验收通过；原生 amd64 与 KVM 仍需目标环境验证。公网 Ping0 当前无法连接，真实网页布局与公网评分仍未确认，不能将合成验收分数当作真实出口合格证明。


## 2026-10-30 生产验收记录

使用既有检测器进入原 VM 的网络、挂载、UTS、IPC、PID namespace，复用透明出口。在独立的临时 systemd cgroup 中以 UID 65534、无 capabilities、NoNewPrivileges 和 Chromium 沙箱运行，业务容器不重启。任务限制为 CPU 50%、内存 768 MiB、进程 512；运行时在已有只读 guest-bin 挂载内的独立新增目录，不覆盖业务程序，不读取账号 home。

| VM | 当前出口 | Claude 信任评分 | DNS / WebRTC | Ping0 | 环境风险 |
| --- | --- | --- | --- | --- | --- |
| ray-vm | CONTROL_EXIT_IP（本机出口） | 首次 72，复测无数据 | 两项绿色，有 DNS 与同出口 UDP 观测 | 空白，未确认 | 完成扫描 18，达标 |
| vm-rn188-hy2-01 | WORKER188_EXIT_IP（既有 SOCKS5/Mihomo） | 84，未达标 | DNS 绿色；WebRTC 绿色但没有 UDP 观测，未确认 | 空白，未确认 | 完成扫描 18，达标 |

ray-vm 首次任务 `d9e42837-8d12-4766-a414-1c4d368d93a7`、复测 `8be40ef0-d662-45b9-9b3a-126aa7461a0a`；188 最终任务 `3f0ff42e-5675-4487-9572-91792214200e`。不得把两次不同任务拼成一份全部达标的报告。Ping0 的空白截图是实际浏览器响应，不是成功的纯净度/AI 适用性截图。环境评分包含临时浏览器所用 Noto CJK 字体信号（+15）与 Linux emoji 信号（+3），不能视为 CLI 全部环境的评分。

这次现有 VM 采用运维临时运行时，并通过已有报告存储器落盘；没有把自动下载/安装/卸载运行时接入面板按钮，也没有新增自动建 VM 检测后台任务。后续交付 VM 按项目规则执行检测与清理。

清理范围仅包含本次新增 Node/Chromium/字体/库目录、传输包、临时 profile/缓存、所属检测进程与提取容器；原有服务、代理、镜像缓存、备份、检测功能源码与结果保留。运维记录位于 `release/vm2api/20261029-production-egress-audit/`（仓库相邻发布目录）。


## Ping0 空白响应排查（2026-10-30）

对两台生产 VM 的同出口 HTTP 请求作对照：curl 默认请求返回实际公网 IP；HeadlessChrome UA 返回 HTTP 200、HTML 正文 0 字节；正常 Chrome UA 在主节点取得 Turnstile 页面，188 节点有时取得完整 IP 查询页。此证据不支持“所有机房 IP 均不响应”的结论，也不排除出口信誉影响验证码策略。

正常 Chromium 的真实浏览器复测已在一次性容器中完成，容器共享 188 VM 的网络 namespace，沿用原透明出口，未挂载账号资料。观察到出口 WORKER188_EXIT_IP、Claude 84；Ping0 在站点自行验证等待后仍返回 Turnstile（`challenge_required`），因此没有完成纯净度/AI 的浏览器验收。该容器的浏览器和字体环境独立，环境分数不是原 VM 全部 CLI 信号的结论。

已在源码加入 Xvfb 正常模式、当前 Ping0 DOM 解析、空正文和无文字验证码识别，并允许站点自身验证完成；不会代答验证码或伪造通过。对应改动通过本地真实浏览器 DOM 回归、接口规则测试、构建及类型检查，未重启/替换正在运行的生产控制面代码。后续若要在面板按钮生效，需随下一次授权发布部署，目标执行环境还需具备 Xvfb 和可用浏览器沙箱。

复测记录 `9ad69e74-41db-475f-b3a1-ee24657204dd` 与等待验证后的 `4d8e9b15-662f-4289-aee5-ee5e7340ad4f` 已写入生产检测记录，均不能判定四项达标。排查产物位于相邻发布目录 `release/vm2api/20261030-ping0-diagnosis/`。


用户已选择不接入 Ping0 的付费 API。官方公开说明（2026-10-30 核查，https://ping0.cc/ip/api）：基础出口/地理信息接口免费；指定 IP 详细查询 0.1 元/次、1 万次起购，返回示例含 `iprisk`，未列“AI 应用适用性”。不以免费地理信息接口替代本基准，也不自动降低四项通过要求。现阶段 Ping0 遇到验证仍记未确认，不能当作通过。
