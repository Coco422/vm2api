# vm2api 异机备份与恢复

生产控制端在64，worker在188和23。备份机189主动直连三台服务器，在 `/data2/vm2api-bak` 保存恢复材料；备份连接不使用跳板、代理或笔记本中转。操作人员登录189的 `ssh -J ray@172.16.99.204 mckj@192.168.100.189` 仅用于管理189。

## 备份内容与边界

- 控制端：SQLite在线一致性完整副本（含计费历史）、原 `.env` 和加密密钥、Compose、配置、七台VM记录、持久化目录、共享二进制及精确运行镜像。
- worker：VM持久化目录、身份与账号文件、运行所需二进制和镜像；188还包含其现有Mihomo配置及缓存。
- SSH备份公钥强制执行 `dr-export.py`，只开放清单、快照、已列入清单的镜像导出，以及这些归档的受限分块读取；不允许shell、任意路径读取、转发或SFTP。私钥只在189的受限目录。
- 每个节点的压缩包及文件逐一验证SHA-256。每日数据库和文件是完整副本，镜像按不可变摘要复用；镜像目录必须和每日目录一并保留。
- 北京时间04:00执行。只有三台都成功且校验通过，才发布当天完整集合并轮转七个自然日之前的完整集合。失败保留上次成功副本，也保留本次成功节点的恢复包，检查 `status.json`、`last-failure.json` 和 `logs/`。
- SQLite本身是同一时点的有效快照；三台机器的文件不是跨节点事务，清单记录各自采集时间。故障最多可能损失自上次成功备份后的数据，通常小于24小时；失败未处理时会更久。
- 面板内置备份用于快速恢复控制数据；仅有这个压缩包不足以恢复worker和精确运行环境。

手动拉取（在189）：

```sh
python3 /data2/vm2api-bak/bin/dr-pull.py --config /data2/vm2api-bak/config/pull.json
cat /data2/vm2api-bak/status.json
```

`pull.json` 中的三个目标通过正常路由直连TCP22。当前189仅为这三个地址设置经192.168.1.1、enp6s18的/32直连路由，已验证ARP和真实SSH；默认网关192.168.100.254保持。NetworkManager的 `/etc/NetworkManager/dispatcher.d/90-vm2api-backup-direct` 在接口上线后重建三条路由；不依赖Docker启动，不使用ProxyJump。局域网或网卡变更时应先验证再更新此受限脚本，不要强行替换默认网关。源端可通过 `image_cache` 复用已校验的不可变镜像归档，缓存损坏或无匹配摘要时回退到重新导出。

对丢包较多的直连链路，来源配置可设 `chunk_workers: 8`（允许1至8）。分块为2MiB，各块及合并结果均校验SHA；只读取导出器登记的归档摘要，单次读取最多8MiB，来源暂存归档保留两天。已完成的镜像和分块可复用，单连接失败最多重试三次；恢复当天被中断的任务时增加 `--resume /data2/vm2api-bak/daily/.partial-当天-任务ID`。只有完整校验成功才发布，不能把 `.partial` 当作完成。未完成目录不会随完整集合轮转而删除，排障后按任务标记清理；它们不算七天完整副本。

控制端还通过 `extra_paths` 保存专属Nginx站点、snippet、TLS选项、续期配置及对应Certbot账户；通过显式 `recovery_links` 保存启用站点和两个域名当前证书链接的真实目标。所有私钥仍只在来源和189。归档内没有可自动落地的软链，清单的 `recovery_links` 记录重建关系；恢复时只恢复本服务对应配置，核对链接和目标后重建，执行 `nginx -t` 成功后再reload。新的公网IP或域名仍需调整DNS与重新核实证书续期方式。

## 先验证，再恢复

下列示例的日期需替换为实际成功日期。先在189或独立恢复机验证、解压到空目录，生产原目录保持不动：

```sh
python3 /data2/vm2api-bak/bin/dr-restore.py \
  --daily /data2/vm2api-bak/daily/2026-10-30 --role control \
  --images /data2/vm2api-bak/images \
  --destination /data2/vm2api-bak/recovery-check --apply --load-images
```

单台机器离线导致全组备份失败时，可审阅 `.partial-*/run.json` 的节点采集时间，将 `--daily` 指向该目录并增加 `--allow-partial`，恢复其中已成功且完整校验的节点。失败节点不可选择，文件和镜像校验仍然强制执行。

`--role` 可改成 `worker188` 或 `worker23`。`--load-images` 只加载 `vm2api-dr:<摘要>` 私有标签，校验镜像层和运行配置，不覆盖开发机上的现有标签，也不会启动VM。解压目录、镜像及证据均包含敏感材料，禁止上传仓库或复制到笔记本。

## 控制机故障

1. 隔离或确认旧控制机已关停，避免双主继续记账。准备相同架构的Linux、Docker及Compose；确认磁盘空间和原监听端口无冲突。
2. 将成功日期目录、整个镜像目录和工具直接复制到替代控制机的受限目录，放在 `/opt/vm2api` 之外。
3. 以root执行下面命令。工具拒绝覆盖运行中的原名容器；旧应用目录存在时必须明确加 `--overwrite`，整目录会改名保留，旧DB及WAL不会混入恢复库。不要单独覆盖线上kin.db。

```sh
python3 /srv/vm2api-recovery/tools/dr-restore.py \
  --daily /srv/vm2api-recovery/daily/2026-10-30 --role control \
  --images /srv/vm2api-recovery/images --destination / \
  --apply --load-images --confirm-live-target --start-control
```

4. 原加密密钥、用户、Key、计费与VM身份一起恢复。检查健康、账单总量、租户登录和Key限制，恢复原反向代理/TLS及DNS或公网IP绑定。若公网IP变化，必须核实原本地出口是否仍正确，再开放接单；备份不能保留失效公网IP。
5. 在替代控制机用原生恢复接口重建原先运行的本地VM：先不加 `--confirm-resume` 查看清单，确认后执行。原先停止的VM不会被启动。

```sh
python3 /srv/vm2api-recovery/tools/dr-resume.py \
  --control-url http://127.0.0.1:8787 --control-env /opt/vm2api/.env
# 确认清单后，重复命令并加 --confirm-resume
```

## 单台worker故障

1. 确认旧worker已隔离，准备同架构Docker主机，保留原SSH用户名、UID/GID和持久化绝对路径。
2. 按上面的 `dr-restore.py` 示例恢复对应worker，使用root、`--destination / --apply --load-images --confirm-live-target`；恢复188时再加 `--start-dependencies` 重建其专用Mihomo。其他项目不在恢复范围。
3. 原控制机SSH公钥随worker恢复并与替代机管理员公钥合并。先验证控制机能用原节点账号直连新worker、Docker可用；独立核实新worker主机指纹。
4. 地址或主机密钥改变时，在控制机先运行以下命令查看计划，再加 `--confirm-rebind` 应用。该工具保留node ID、VM ID、账号、代理和用户归属，只更新节点地址/指纹并丢弃失效的运行句柄；应用前保留本地回滚材料。原节点仍在线时必须先隔离，不能把 `--confirm-retired-source` 当作跳过隔离的快捷方式。

```sh
python3 /srv/vm2api-recovery/tools/dr-rebind-node.py \
  --node-id node-458204a6 --host NEW_WORKER_IP \
  --expected-host-key SHA256:INDEPENDENTLY_VERIFIED_FINGERPRINT
```

188节点为 `node-458204a6`，23节点为 `node-41430ff2`。主机指纹示例是占位，须替换成真实校验值。

5. 在控制机执行 `dr-resume.py`，增加 `--node-id` 指定原节点；先审阅清单，再增加 `--confirm-resume`。核实账号身份、出口和诊断后才恢复业务流量。恢复不等于自动更换账号/代理，也不会把原先停止、未配置的VM启动。

恢复耗时取决于替代机准备、镜像传输、DNS和出口恢复。必须做隔离恢复演练并保留真实结果，不能仅凭备份存在就声称能够快速恢复。

## 定向回归

```sh
node scripts/company-local.mjs test disaster-recovery request-auth responses-ws billing-retention panel-acl
```

覆盖账单还原、损坏归档、越界路径/软链拒绝、七天轮转、在线WAL快照、SSH公钥合并、旧库与WAL隔离、worker身份保留及备份直连参数。
