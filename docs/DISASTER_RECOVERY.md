# vm2api 故障恢复手册

适用范围：主控64或worker188/23宕机，从189恢复到同架构替代机。最后核对工具及生产状态：**2026-10-31 12:33，北京时间**。主机地址、当前VM分配、实际镜像和备份现状统一见 [当前生产部署状态](PRODUCTION_STATUS.md)。

生产控制端在64，worker在188和23。备份机189主动直连三台服务器，在 `/data2/vm2api-bak` 保存恢复材料；备份连接不使用跳板、代理或笔记本中转。操作人员登录189的 `ssh -J ray@172.16.99.204 mckj@192.168.100.189` 仅用于管理189。189是开发/备份机，默认恢复到准备好的替代生产机，不在189上直接覆盖 `/opt` 或接管公网业务。

## 本轮发布后的备份差异

2026-10-31的租户代理隐私镜像已上线，但按用户要求，189本轮暂记待同步。最近一次已核验的异机集合完成于12:51:44，仍包含发布前鉴权镜像。恢复该集合不会自动得到新的隐私过滤；主控恢复后，在向租户重新开放控制台前，应重新发布已验证的隐私补丁。单台worker恢复且主控健康时，保持当前主控，不回退其镜像或数据库。

控制机`/opt/vm2api-backups/20261031-tenant-proxy-privacy`保存本轮发布前的本机回滚材料；旧环境仅用于镜像回滚，不能用旧数据库覆盖发布后新账单。候选代码、静态资源及校验清单位于主工作目录相邻`release/vm2api/20261031-tenant-proxy-privacy/`，不含真实数据库或凭证。189恢复连接后须直连拉取新完整集合并核验镜像摘要，再更新本节和部署状态。

2026-10-31 16:26完成新增十个普通租户并将vm-03至vm-12一对一分配，本次未发布代码。主控`/opt/vm2api-backups/20261031-tenant-provision-10`保存分配前一致性库、分配后`kin.after.db.gz`及`after-state.private.tar.gz`（VM归属和受限交付资料）。189仍按用户要求待同步：12:51:44集合不包含这十户及新归属，不能据此宣称新账户已有异机保障。主控盘尚在时优先保全最新库与本机备份；若主控盘丢失且189尚未更新，这部分新增数据不能从旧集合恢复。后续189补拉须核对用户总数12及十台VM归属；不能为了恢复账号直接倒灌旧库覆盖新账单。

## 先判断故障，不要一律倒灌备份

| 故障 | 处理顺序 | 影响 |
| --- | --- | --- |
| 主控进程/主机短暂故障，原盘完好 | 恢复原机网络、Docker和原控制服务，检查原库和原VM，再恢复接单 | 保留最新账单，不必回退数据库 |
| 主控磁盘丢失或原机无法及时回来 | 隔离旧主控 → 取189完整备份 → 替代机恢复主控和本地VM → 重连两台worker → 验证入口与账单 | 控制/API入口中断；远程容器仍在不代表API业务可用 |
| 单台worker故障，主控健康 | 隔离旧worker → 只恢复该worker → 必要时改原节点地址/指纹 → 恢复该节点原VM | 该节点VM受影响，其余可用VM可继续；绑定故障VM的租户不会自动借用别人账号 |
| 主控和worker同时损坏 | 同一成功集合先恢复主控，再逐台恢复worker | 以该集合各节点采集时间为准，不混用未知时间的文件 |

旧主机未确认停机/隔离前，不允许替代机与其同时对同一批账号接单。原盘还在时优先救原盘；主控最新 `kin.db` 及其WAL整体保留，不能用旧库试探覆盖。worker故障时**不恢复或覆盖健康主控的数据库**。

## 大概多久恢复

以下是人工操作的工程预估，不是已验证SLA；以可用业务请求恢复为终点，不以容器启动为终点。

| 条件 | 主控恢复业务 | 单台worker恢复业务 |
| --- | --- | --- |
| 原盘完好，仅重启/恢复连接 | 通常5—15分钟，根因未消除则另计 | 通常5—15分钟，根因未消除则另计 |
| 替代机、Docker/Compose、SSH已准备，材料已在目标机，入口及出口不变 | 预估20—60分钟 | 预估15—45分钟 |
| 必须从189重新经公网传输 | 上述时间加传输时间，慢链路可能数小时 | 上述时间加传输时间，慢链路可能数小时 |

新机器采购、系统安装、IP/DNS/反代和证书变更、代理白名单以及上游账号异常不计入上述准备好条件。当前没有热备控制机，也没有自动故障切换。

10月30日隔离演练已实际完成：三台包与七份镜像在本地已有镜像缓存时，校验/解压/加载30.55秒，原生控制器启动3.14秒；14,032条计费记录、七台VM身份和两台worker文件权限保持，worker二进制缺配置保护路径可执行。演练未做真实业务切流、worker整机接管或上游调用，因此不能承诺“几十秒恢复业务”。

只传故障角色所需的包和镜像，以下按2026-10-31 12:51:44北京时间完成的12台VM集合计算：

| 角色 | 需要传输约数（十进制） | 实际1MB/s | 实际100KB/s | 实际20KB/s |
| --- | ---: | ---: | ---: | ---: |
| control | 749MB | 13分钟 | 2.1小时 | 10.4小时 |
| worker188 | 453MB | 8分钟 | 1.3小时 | 6.3小时 |
| worker23 | 216MB | 4分钟 | 36分钟 | 3.0小时 |

这是按字节/实际速率计算的**纯传输时间**，另加校验和恢复。189首次拉取曾有明显丢包；23的158MB预取实测约27分钟，188单连接曾仅约18KiB/s。189向替代机的反向链路没有测速，不能把拉取速度当成恢复上传速度。若要求稳定在30分钟内恢复，应另行准备替代机并预置镜像、验证公网入口切换；本手册没有自动创建这些设施。

数据可恢复到最后一次成功采集的时间，不是集合传完的时间。每日04:00成功时数据损失窗口通常不到24小时；备份失败未处理会更久。尤其主控丢盘后，快照之后的计费记录不能凭空补回，正式结算前核对差额。worker单机恢复不回退健康主控上的账单。

## 从189取材料并直传替代机

先从本机登录189：

```sh
ssh -J ray@172.16.99.204 mckj@192.168.100.189
```

在189检查最后成功日期：

```sh
cat /data2/vm2api-bak/status.json
tail -n 20 /data2/vm2api-bak/logs/schedule.log
```

以 `status.json` 和相应日期的 `complete.json` 为准。10月31日首次04:00定时任务已于04:03:24成功；后续扩容后的备份时间与VM数见部署状态页，不能用旧集合证明新配置已备份。

替代机通过机房控制台准备：Linux amd64、Python3、Docker Engine、Compose插件，磁盘应留足解压及Docker镜像空间；主控还需Nginx及与原配置兼容的TLS环境。确认189能**直接**SSH到替代机，使用运维登录凭证，先从可信控制台核对SSH主机指纹并登记到189的known_hosts。备份专用密钥仅允许源端导出，不能拿它登录替代机执行命令。

以下在189的独立Bash会话执行。将 `DR_ROLE` 改为故障角色，`DR_TARGET` 改为已准备好的替代机root登录地址；日期从最后成功状态读取。传输只发送该角色所需的包和镜像，其他角色的包不必发送。

```bash
set -euo pipefail
DR_BASE=/data2/vm2api-bak
DR_ROLE=control  # 也可 worker188 或 worker23
DR_TARGET=root@REPLACEMENT_IP  # 必须替换；这里只操作替代机
DR_DATE="$(python3 - "$DR_BASE/status.json" <<'PY'
import datetime,json,sys
print(datetime.date.fromisoformat(json.load(open(sys.argv[1]))['date']).isoformat())
PY
)"
DR_SSH='ssh -F /dev/null -o StrictHostKeyChecking=yes -o ProxyJump=none -o ProxyCommand=none'
python3 "$DR_BASE/bin/dr-restore.py" \
  --daily "$DR_BASE/daily/$DR_DATE" --role "$DR_ROLE" \
  --images "$DR_BASE/images"

ssh -F /dev/null -o StrictHostKeyChecking=yes -o ProxyJump=none -o ProxyCommand=none \
  "$DR_TARGET" "install -d -m 700 /srv/vm2api-recovery /srv/vm2api-recovery/daily /srv/vm2api-recovery/daily/$DR_DATE /srv/vm2api-recovery/images /srv/vm2api-recovery/tools"
rsync -rtp --partial --append-verify -e "$DR_SSH" \
  "$DR_BASE/daily/$DR_DATE/complete.json" "$DR_BASE/daily/$DR_DATE/$DR_ROLE.tar.gz" \
  "$DR_TARGET:/srv/vm2api-recovery/daily/$DR_DATE/"
rsync -rtp --partial --append-verify -e "$DR_SSH" \
  "$DR_BASE/daily/$DR_DATE/tools/" "$DR_TARGET:/srv/vm2api-recovery/tools/"
while IFS= read -r image; do
  rsync -rtp --partial --append-verify -e "$DR_SSH" \
    "$DR_BASE/images/$image" "$DR_TARGET:/srv/vm2api-recovery/images/"
done < <(python3 - "$DR_BASE/daily/$DR_DATE/complete.json" "$DR_ROLE" <<'PY'
import json,re,sys
for image in json.load(open(sys.argv[1]))['nodes'][sys.argv[2]]['images']:
    name=image['file']; assert re.fullmatch(r'[a-f0-9]{64}\.tar\.gz',name)
    print(name)
PY
)
```

直接传189→替代机，不经过本机或登录跳板。新目标没有原三条备份路由时要先验证直连可达性，不自动继承源地址的路由。网络中断可重跑rsync，目标恢复工具仍会核对完整SHA。源端验证不加 `--apply` 不写入应用目录、不启动服务，会在该集合的 `restore-evidence/` 保存校验计划；镜像校验在目标 `--load-images` 时强制执行。

下面命令在**替代机root**会话执行，`DR_DATE` 必须改成刚复制的日期，不要自动取系统当天日期。先在目标验证并加载该角色镜像：

```sh
DR_DATE=2026-10-30
DR_ROLE=control
python3 /srv/vm2api-recovery/tools/dr-restore.py \
  --daily "/srv/vm2api-recovery/daily/$DR_DATE" --role "$DR_ROLE" \
  --images /srv/vm2api-recovery/images --load-images
```

后续同一目标都使用这个日期。失败保留错误日志，不跳过校验；本步骤仍未写入应用目录。

## 备份内容与边界

- 控制端：SQLite在线一致性完整副本（含计费历史）、原 `.env` 和加密密钥、Compose、配置、当前全部VM记录、持久化目录、共享二进制及精确运行镜像。
- worker：VM持久化目录、身份与账号文件、运行所需二进制和镜像；188还包含其现有Mihomo配置及缓存。
- SSH备份公钥强制执行 `dr-export.py`，只开放清单、快照、已列入清单的镜像导出，以及这些归档的受限分块读取；不允许shell、任意路径读取、转发或SFTP。私钥只在189的受限目录。
- 每个节点的压缩包及文件逐一验证SHA-256。每日数据库和文件是完整副本，镜像按不可变摘要复用；镜像目录必须和每日目录一并保留。
- 北京时间04:00执行。只有三台都成功且校验通过，才发布当天完整集合并轮转七个自然日之前的完整集合。失败保留上次成功副本，也保留本次成功节点的恢复包，检查 `status.json`、`last-failure.json` 和 `logs/`。
- SQLite本身是同一时点的有效快照；三台机器的文件不是跨节点事务，清单记录各自采集时间。故障最多可能损失自上次成功备份后的数据，通常小于24小时；失败未处理时会更久。
- 面板内置备份用于快速恢复控制数据；仅有这个压缩包不足以恢复worker和精确运行环境。
- `/run/kin` 的配置、内部令牌和套接字由 `dr-resume.py` 调用原生恢复流程重建，不直接复用。已审查当前四个运行槽位的容器差异，均为身份挂载或运行目录；其余持久挂载均在归档内。镜像归档本身不包含任意容器可写层，后续手动安装的组件应固化进镜像或纳入持久目录。

手动拉取（在189）：

```sh
python3 /data2/vm2api-bak/bin/dr-pull.py --config /data2/vm2api-bak/config/pull.json
cat /data2/vm2api-bak/status.json
```

`pull.json` 中的三个目标通过正常路由直连TCP22。当前189仅为这三个地址设置经192.168.1.1、enp6s18的/32直连路由，已验证ARP和真实SSH；默认网关192.168.100.254保持。NetworkManager的 `/etc/NetworkManager/dispatcher.d/90-vm2api-backup-direct` 在接口上线后重建三条路由；不依赖Docker启动，不使用ProxyJump。局域网或网卡变更时应先验证再更新此受限脚本，不要强行替换默认网关。源端可通过 `image_cache` 复用已校验的不可变镜像归档，缓存损坏或无匹配摘要时回退到重新导出。

对丢包较多的直连链路，来源配置可设 `chunk_workers: 8`（允许1至16，握手同时最多4个，避免触发SSH登录限制）。分块为2MiB，各块及合并结果均校验SHA；只读取导出器登记的归档摘要，单次读取最多8MiB，来源暂存归档保留两天。已完成的镜像和分块可复用，每块连接最多180秒、失败最多重试三次；恢复当天被中断的任务时增加 `--resume /data2/vm2api-bak/daily/.partial-当天-任务ID`。只有完整校验成功才发布，不能把 `.partial` 当作完成。未完成目录不会随完整集合轮转而删除，排障后按任务标记清理；它们不算七天完整副本。每个完整集合也保留当时的恢复工具与说明文档。

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

1. 确认旧主控隔离；替代机在验收前关闭公网业务入口或只允许运维访问，尤其不要直接向公网开放8787。不能只靠“不改DNS”阻止接单。按前节从189直传 `control` 角色材料并校验。
2. 使用替代机root执行下列命令。工具拒绝覆盖运行中的原名容器；新的 `/opt/vm2api` 应不存在。已有应用目录时先确认它的用途，只有明确需要替换才加 `--overwrite`；工具将旧应用整目录改名保留，旧DB及WAL不会混入恢复库。该参数还会允许覆盖归档涉及的其他同名文件，不能当作通用重试开关。

```sh
python3 /srv/vm2api-recovery/tools/dr-restore.py \
  --daily "/srv/vm2api-recovery/daily/$DR_DATE" --role control \
  --images /srv/vm2api-recovery/images --destination / \
  --apply --load-images --confirm-live-target --start-control
curl --fail --silent --show-error --noproxy '*' http://127.0.0.1:8787/health
```

3. 原加密密钥、用户、Key、计费与VM身份一起恢复。不要执行上游安装器、生成新DB_SECRET或重新导入账号覆盖原身份。原控制器的节点SSH凭据在加密数据库中恢复；检查188和23 SSH link为ready，健康worker不需要还原目录或重建容器。
4. 在替代主控用原生恢复接口重建原先运行的**本地**VM。先dry-run核对清单；10月30日快照应为 `ray-vm`、`vm-03`，后续以选中快照的实际状态为准。确认后再加开关执行。

```sh
python3 /srv/vm2api-recovery/tools/dr-resume.py \
  --control-url http://127.0.0.1:8787 --control-env /opt/vm2api/.env
python3 /srv/vm2api-recovery/tools/dr-resume.py \
  --control-url http://127.0.0.1:8787 --control-env /opt/vm2api/.env \
  --confirm-resume
```

脚本按控制面当前 `status=running` 筛选；若dry-run清单为空或与快照不符，停止执行并检查启动对账状态，不能把空清单当作恢复成功，也不能启动全部VM补数。对仍健康的远程worker不执行这一步。本地VM公网IP变了时必须核实原本地出口，备份不能保留失效的公网地址。

5. 核验原VM ID、账号身份、代理绑定、用户归属、并发12及原接单状态；核对账单与清单快照数量，再与事故前的最近记录核账。旧token可能已在快照后刷新，凭据失效时先核对仍健康worker的现存资料，不盲目覆盖。
6. 恢复本服务Nginx/TLS链接。工具还原了文件，但**不自动创建软链**。以下仅从该归档生成待审阅命令，不读取或打印私钥正文：

```sh
python3 - "$DR_DATE" <<'PY'
from pathlib import Path
import shlex,sys
sys.path.insert(0,'/srv/vm2api-recovery/tools')
from dr_common import read_manifest
m=read_manifest(Path('/srv/vm2api-recovery/daily')/sys.argv[1]/'control.tar.gz')
for link,target in m.get('recovery_links',{}).items():
    p=Path(link)
    assert link.startswith(('/etc/nginx/sites-enabled/','/etc/letsencrypt/live/'))
    assert (p.parent/target).resolve().exists(), 'Missing link target'
    print(shlex.join(['mkdir','-p','--',str(p.parent)]))
    print(shlex.join(['ln','-s','--',target,str(p)]))
PY
```

逐条审阅输出后在替代机root执行。已有链接先核对，不加 `-f` 盲目覆盖。执行 `nginx -t` 成功后，Nginx已运行则 `systemctl reload nginx`，未运行则 `systemctl start nginx`。地址或域名改变时更新本服务配置、证书续期方式及对应DNS/反代源站；不要改同机其他服务。

7. 按下方验收清单验证，再切公网入口、开放接单。保留旧机和备份，防止旧主控意外回归。入口切换后更新189的备份目标、已核实主机指纹及必要的定向路由，做一次新目标备份验证，更新状态文档。

## 单台worker故障

1. 确认旧worker隔离，主控保持运行；不要重启主控、还原主控库或删除原节点/VM。原节点不可用时调度器跳过它，但故障VM的专属租户不能自动改用别人的账号。
2. 从189发送故障角色材料至替代机。188保持SSH用户root及根目录 `/root/.vm2api`；23保持SSH用户ray、UID/GID **1000:1000**、home `/home/ray`，将ray加入新机docker组并用新SSH会话检查 `docker ps` 权限。若新机UID1000已属其他账号，先处理冲突，不强行改现有用户。
3. 在替代worker以root恢复原文件所有权和目录；不能用ray普通用户解压后将所有文件改为同一属主。188命令：

```sh
python3 /srv/vm2api-recovery/tools/dr-restore.py \
  --daily "/srv/vm2api-recovery/daily/$DR_DATE" --role worker188 \
  --images /srv/vm2api-recovery/images --destination / \
  --apply --load-images --confirm-live-target --start-dependencies
```

23命令：

```sh
python3 /srv/vm2api-recovery/tools/dr-restore.py \
  --daily "/srv/vm2api-recovery/daily/$DR_DATE" --role worker23 \
  --images /srv/vm2api-recovery/images --destination / \
  --apply --load-images --confirm-live-target
```

同样只在审查已有目录后决定是否加 `--overwrite`。188的 `--start-dependencies` 重建专用 `vm2api-mihomo-188` 及其配置/缓存，不启动其他项目；脚本随后不自动启动VM。不能换成空Mihomo配置或重新采购/替换代理。

**23节点从2026-10-31扩容后的集合恢复时，还需在替代worker root会话恢复出口权限和固定网段，再启动VM：**

```sh
visudo -cf /home/ray/.vm2api-backup-export/vm2api-egress-ray.sudoers
install -o root -g root -m 440 \
  /home/ray/.vm2api-backup-export/vm2api-egress-ray.sudoers \
  /etc/sudoers.d/vm2api-egress-ray
visudo -c
python3 /home/ray/.vm2api-backup-export/restore-egress-networks.py
sudo -u ray sudo -n true
```

这份权限仅允许探测`true`及vm-06、vm-07、vm-11、vm-12原生出口的具体iptables参数，没有通用免密sudo。四个网段依次为`10.253.23.0/28`、`.16/28`、`.32/28`、`.48/28`，保存在同目录`egress-networks.json`。脚本遇到同名但不同网段的网络会停止，不改已有网络；替代机若与其他网络冲突，应先规划并同步规则，不能删其他项目网络。旧集合不含这三个文件时不执行本段，按旧快照恢复。

4. 原主控SSH公钥随worker归档恢复并与新机管理员authorized_keys合并。23的ray账户/家目录及docker组权限需在前一步准备。通过新机可信控制台取得 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 指纹，核实主控能用原节点账号连接、Docker可用。
5. 地址或主机密钥改变时，在**主控root**执行下列dry-run，再执行确认命令。工具可从189日期目录的tools直接传到主控 `/srv/vm2api-recovery/tools/`；只需工具，不传worker归档或覆盖健康主控数据库。示例使用188节点，替换新地址和真实SHA256指纹：

```sh
python3 /srv/vm2api-recovery/tools/dr-rebind-node.py \
  --node-id node-458204a6 --host NEW_WORKER_IP \
  --expected-host-key SHA256:INDEPENDENTLY_VERIFIED_FINGERPRINT
python3 /srv/vm2api-recovery/tools/dr-rebind-node.py \
  --node-id node-458204a6 --host NEW_WORKER_IP \
  --expected-host-key SHA256:INDEPENDENTLY_VERIFIED_FINGERPRINT \
  --confirm-rebind --confirm-retired-source
```

工具保留node ID、VM ID、账号、代理和用户归属，仅改节点地址/指纹、清理失效运行句柄并重连；应用前在 `/opt/vm2api/data/recovery-rollback/` 留存回滚材料。`--confirm-retired-source` 表示已确认旧worker隔离，不能当作跳过隔离的快捷方式。旧机同IP重新安装也会变主机密钥，需要重新核实。

188节点为 `node-458204a6`，23节点为 `node-41430ff2`。示例的IP、指纹都必须替换。

6. 在主控等待该节点SSH link ready，然后恢复该节点原来运行的VM，先看清单再确认：

```sh
python3 /srv/vm2api-recovery/tools/dr-resume.py \
  --control-url http://127.0.0.1:8787 --control-env /opt/vm2api/.env \
  --node-id node-458204a6
python3 /srv/vm2api-recovery/tools/dr-resume.py \
  --control-url http://127.0.0.1:8787 --control-env /opt/vm2api/.env \
  --node-id node-458204a6 --confirm-resume
```

10月30日状态下188清单应为 `vm-rn188-hy2-01`、`vm-04`；23清单应为空，因为 `vm-06`、`vm-07` 原本停止。不要为了验收启动原来停止或未配置的VM。dry-run与事故前实际状态不符先调查，`diagnosis_ok`非true不能当作业务恢复。保持账号、代理、归属与原接单状态，不自动换号或打开原先不接单的VM。

7. 验收故障节点及其租户业务；其他健康worker不操作。更新189的对应SSH来源、已验证主机指纹、导出器配置和必要的目标/32路由及其dispatcher，再做一次新目标备份验证。只改主控节点地址而不改备份来源，会导致后续04:00备份继续找旧服务器。

## 恢复完成的验收标准

- 主控 `/health`、公网入口及原生租户登录正常；根路径仍进 `/cc`，租户只看到自己VM，布局保持。
- 所选备份中的全部VM记录、原ID/机器身份、账号和代理绑定、用户/Key归属及并发12正确；原来停止和不接单的状态保持。不以“容器running”代替内核及出口诊断。
- 控制库 `PRAGMA quick_check` 为ok，账单数量/费用与选中快照一致；worker恢复时主控现有账单继续保留。恢复前后的数据损失窗口和事故后新增记录单独核账，不覆盖或合成账单。
- 面板Cookie单独调用协议接口仍401，真实Key执行其权限限制；实际业务请求需由运维在确认会产生上游用量后做最小验证，观察入账一次、无重复。此前隔离演练未替代这一步。
- 两台远程节点连接和受影响VM诊断正常；代理仍走原配置。新的宿主IP涉及本地出口或白名单时重新确认，不能把身份文件存在视为出口未变。
- 入口切换后检查新流量记账、错误率和租户可用性；新主控生效后旧主控持续隔离。
- 189能备份新目标，生成新的成功状态；同步 [PRODUCTION_STATUS.md](PRODUCTION_STATUS.md) 的主机、镜像、VM状态和成功备份时间。临时恢复目录含真实凭据，只在恢复确认后按明确路径清理；正式备份保留。

## 定向回归

```sh
node scripts/company-local.mjs test disaster-recovery request-auth responses-ws billing-retention panel-acl
```

覆盖账单还原、损坏归档、越界路径/软链拒绝、七天轮转、在线WAL快照、SSH公钥合并、旧库与WAL隔离、worker身份保留及备份直连参数。
