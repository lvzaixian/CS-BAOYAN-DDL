# 腾讯云静态部署手册

## 当前边界

本仓库只提供部署工具，不代表腾讯云已配置完成。本次实现没有连接腾讯云、写入 GitHub Secrets、执行 bootstrap，也没有修改防火墙、`sshd`、DNS 或 TLS。

仓库保留标准 HTTP 模板，并提供两份版本化的宝塔模板：`cs-baoyan-ddl-bt-http.conf` 只用于受控 HTTP 验收，`cs-baoyan-ddl-bt-tls.conf` 用于域名与证书路径获批后的最终 HTTPS 配置。TLS 与 public launch 仍是生产 stop gate（停止门）：完成域名、备案、证书路径和 TLS 终止方案验收前，production required reviewer 不应批准真实上线；模板存在不代表已经授权修改真实主机、DNS 或证书资产。

## 一次性服务器准备

1. 创建专用部署用户。该用户不得是腾讯云主账号，不得持有扫描数据或个人申请资料，不加入 `sudoers`，也不得获得通用 sudo：

   ```bash
   sudo groupadd --system cs-baoyan-deploy
   sudo useradd --system --create-home --shell /bin/bash \
     --gid cs-baoyan-deploy cs-baoyan-deploy
   ```

   bootstrap 明确要求部署用户的 primary group 名称与 `DEPLOY_USER` 完全相同；上面的 `--gid cs-baoyan-deploy` 满足该约束。不要复用一个 primary group 名称不同的既有账号。

2. 安装并确认这些命令可用：`python3`、`curl`、`nginx`、`flock`、`sha256sum`、`tar`。安装系统包属于管理员动作，不要授权部署用户代为执行。

   执行 bootstrap 前还必须读取真实 Nginx 构建和 include 路径：

   ```bash
   nginx -V 2>&1
   nginx -T 2>/dev/null | awk '/^[[:space:]]*include[[:space:]]/{print}'
   ```

   默认 `NGINX_CONFIG=/etc/nginx/conf.d/cs-baoyan-ddl.conf` 只适用于该目录真实存在且被主配置 include 的标准安装。宝塔或自定义 `--prefix` 构建常使用另一套 vhost 目录；这种主机必须先停下，评审一个明确的 `NGINX_CONFIG` 路径和回滚方式，不能创建一个 Nginx 根本不会读取的文件。

   标准模板声明了一个 HTTP `default_server` 用于拒绝未知 Host。若真实主机已经有同地址同端口的 `default_server`，直接安装会产生冲突，禁止绕过 `nginx -t` 或删除现有站点。宝塔模板不声明第二个 `default_server`，而是在本站 vhost 内校验精确 Host；最终 TLS 模板同时检查 Host 和 `$ssl_server_name` SNI 域名，缺失或不匹配都返回 444。只能在确认现有默认路由会接管其他 Host 后使用。

   bootstrap 对已有 `NGINX_CONFIG` 使用严格的受支持契约：该路径不能是符号链接，现有对象必须是单链接普通文件、`0644`，所有者 UID 与属组 GID 都必须匹配 bootstrap 的有效进程。扩展属性只允许 SELinux 的 `security.selinux` allowlist 项，其余 xattr 一律 fail closed；脚本不调用 xattr 写入或删除操作，不主动删除或改写安全标签，也不会静默修改权限、所有权或链接。任一条件不满足都会在备份和发布前停止，管理员必须先独立审查并显式迁移不受支持的既有配置。

   每次运行都使用持久的 `${NGINX_CONFIG}.lock` 路径；该路径不能是符号链接，脚本以非阻塞方式获取 `flock`，并把锁持有到验证、reload 和任何恢复流程全部结束。锁已被其他进程持有时，本次运行会在备份或修改目标配置前失败。

3. 把部署公钥加入该用户的 `~/.ssh/authorized_keys`，至少禁止转发和 PTY。OpenSSH 支持 `restrict` 时建议使用：

   ```text
   restrict,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <PUBLIC_KEY> github-actions-cs-baoyan-ddl
   ```

   工作流需要在限定目录内执行 `mkdir`、部署脚本和清理 staging，因此这里不配置一个会阻断这些命令的任意 forced command。该专用账号仍有通用命令能力；`restrict`、禁止转发/PTY 和无 sudo 只能缩小影响面，不能把账号视为只能运行单一部署命令。安全边界还依赖受保护 main、production approval、最小目录权限、脚本路径校验和服务器侧 `flock`。

4. 以管理员身份审阅仓库中的 bootstrap 和 Nginx 模板。标准 Nginx 安装可继续使用默认模板；重复执行是幂等的：

   ```bash
   sudo env \
     DEPLOY_USER=cs-baoyan-deploy \
     SERVER_NAME=ddl.example.com \
     DEPLOY_ROOT=/srv/cs-baoyan-ddl \
     bash deploy/bootstrap-server.sh
   ```

   `DEPLOY_USER` 和 `SERVER_NAME` 都是必填项。`SERVER_NAME` 必须替换为实际小写域名或 IPv4 地址，不能保留 `_` 或模板占位符。脚本创建：

   ```text
   /srv/cs-baoyan-ddl/
     releases/
     shared/
       staging/
     transactions/
   ```

   `/srv/cs-baoyan-ddl` 由 `root:cs-baoyan-deploy` 以 `0775` 管理，使部署用户通过同名专用组更新 `current`；发布目录由部署用户拥有，Nginx 只需读取和遍历。脚本渲染明确的 `server_name`，通过在目标配置同一目录创建临时文件并原子重命名来发布新配置，然后依次运行选定的 `NGINX_BIN -t` 和 `NGINX_BIN -s reload`；不通过服务名切换到另一套 Nginx 实例。`-s reload` 返回 0 只表示 reload signal command accepted/sent，不表示配置已应用、worker 已换代或站点已开始提供新内容。

   首次 `nginx -t` 失败或 reload signal command 被拒绝时，如果存在旧配置，脚本会用同样的同目录原子重命名恢复旧配置，并使用同一个选定的 `NGINX_BIN -t` 重新验证；恢复分支再次调用 `NGINX_BIN -s reload` 时也只记录 signal command 是否被接受，不宣称恢复配置已经应用。原先不存在配置时，脚本会删除本次新配置并重新验证剩余 Nginx 配置，不会把这种情况描述为“恢复了旧配置”。无论选择 HTTP 还是 TLS 模板，脚本只承诺没有修改 firewall、`sshd`、DNS 和 certificate files；安装 TLS 模板本身会改变站点的 TLS 配置，但不会创建、复制或修改证书文件。

### Task 14 主机身份、备份与执行窗口门禁

以下门禁只允许在 Task 14 已批准的主机维护窗口内由 root 执行；本手册不授权当前任务连接主机。执行窗口开始后必须冻结宝塔站点配置保存、应用、重载和证书面板动作，直到 worker、日志、SELinux 与本机探针全部验收完成。先在同一个 root shell 固定真实路径：

```bash
test -n "${SELECTED_DOMAIN:?user-approved domain is required}"
NGINX_BIN=/www/server/nginx/sbin/nginx
NGINX_CONFIG="/www/server/panel/vhost/nginx/$SELECTED_DOMAIN.conf"
NGINX_PID_FILE=/www/server/nginx/logs/nginx.pid
NGINX_ERROR_LOG=/www/server/nginx/logs/error.log
test -x "$NGINX_BIN"
test -r "$NGINX_PID_FILE"
test -r "$NGINX_ERROR_LOG"
```

bootstrap 前必须把 PID file、运行中 master 和所选二进制绑定，并审查构建、完整配置与 include 证据：

```bash
MASTER_PID=$(cat "$NGINX_PID_FILE")
case "$MASTER_PID" in ''|*[!0-9]*) exit 1 ;; esac
test -d "/proc/$MASTER_PID"
test "$(readlink -f "/proc/$MASTER_PID/exe")" = "$(readlink -f "$NGINX_BIN")"
MASTER_CMDLINE=$(tr '\0' ' ' < "/proc/$MASTER_PID/cmdline")
case "$MASTER_CMDLINE" in *nginx*master*process*) ;; *) exit 1 ;; esac

"$NGINX_BIN" -V 2>&1
NGINX_T_OUTPUT=$("$NGINX_BIN" -T 2>&1) || exit 1
printf '%s\n' "$NGINX_T_OUTPUT" | grep -F 'include'
printf '%s\n' "$NGINX_T_OUTPUT" | grep -F "# configuration file $NGINX_CONFIG:"

WORKERS_BEFORE=$(ps -o pid= --ppid "$MASTER_PID" | awk '{$1=$1};1' | sort -n)
test -n "$WORKERS_BEFORE"
ERROR_BYTES_BEFORE=$(stat -c '%s' "$NGINX_ERROR_LOG")
```

vhost 文件的全部祖先必须由 root 拥有，且 group/other 不可写；以下检查也拒绝祖先符号链接：

```bash
python3 - "$NGINX_CONFIG" <<'PY'
import os
import pathlib
import stat
import sys

directory = pathlib.Path(sys.argv[1]).parent
for ancestor in (directory, *directory.parents):
    metadata = os.lstat(ancestor)
    mode = stat.S_IMODE(metadata.st_mode)
    if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0 or mode & 0o022:
        raise SystemExit(f"unsafe vhost ancestor: {ancestor}")
PY
```

不能只依赖 fake lock 测试。Task 14 必须先在 root-only scratch 文件上证明真实 util-linux `flock` 会拒绝第二个非阻塞持有者：

```bash
flock --version
umask 077
SCRATCH_LOCK=$(mktemp /root/cs-baoyan-ddl-flock.XXXXXX)
exec 8<>"$SCRATCH_LOCK"
flock -n 8
if flock -n "$SCRATCH_LOCK" -c true; then
  exit 1
fi
flock -u 8
exec 8>&-
rm -f -- "$SCRATCH_LOCK"
```

SELinux 检查不修改标签。bootstrap 前记录状态；bootstrap 后重复执行并要求 `restorecon -n` 不提示需要修复：

```bash
getenforce
ls -lZ "$NGINX_CONFIG" "${NGINX_CONFIG}.lock" 2>/dev/null || true
restorecon -n -v "$NGINX_CONFIG" "${NGINX_CONFIG}.lock" 2>/dev/null || true
```

bootstrap 前必须制作 root-only 持久备份或“首次安装”缺失标记，并分别记录 SHA-256。临时脚本内备份不能代替该证据：

```bash
BACKUP_ROOT=/root/cs-baoyan-ddl-nginx-backups
install -d -m 0700 -o root -g root "$BACKUP_ROOT"
BACKUP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
if test -e "$NGINX_CONFIG"; then
  BACKUP_CONFIG="$BACKUP_ROOT/$SELECTED_DOMAIN.$BACKUP_STAMP.conf"
  install -m 0600 -o root -g root "$NGINX_CONFIG" "$BACKUP_CONFIG"
  sha256sum "$BACKUP_CONFIG" > "$BACKUP_CONFIG.sha256"
  chmod 0600 "$BACKUP_CONFIG.sha256"
else
  FIRST_INSTALL_MARKER="$BACKUP_ROOT/$SELECTED_DOMAIN.$BACKUP_STAMP.absent"
  printf 'absent:%s\n' "$NGINX_CONFIG" > "$FIRST_INSTALL_MARKER"
  chmod 0600 "$FIRST_INSTALL_MARKER"
  sha256sum "$FIRST_INSTALL_MARKER" > "$FIRST_INSTALL_MARKER.sha256"
  chmod 0600 "$FIRST_INSTALL_MARKER.sha256"
fi
```

bootstrap 返回后，仍在同一冻结窗口内确认 master 身份不变、至少出现一个新 worker，并审查本次窗口新增的 error log：

```bash
MASTER_PID_AFTER=$(cat "$NGINX_PID_FILE")
test "$MASTER_PID_AFTER" = "$MASTER_PID"
test "$(readlink -f "/proc/$MASTER_PID_AFTER/exe")" = "$(readlink -f "$NGINX_BIN")"
MASTER_CMDLINE_AFTER=$(tr '\0' ' ' < "/proc/$MASTER_PID_AFTER/cmdline")
test "$MASTER_CMDLINE_AFTER" = "$MASTER_CMDLINE"

WORKERS_AFTER=$(ps -o pid= --ppid "$MASTER_PID_AFTER" | awk '{$1=$1};1' | sort -n)
NEW_WORKERS=$(comm -13 \
  <(printf '%s\n' "$WORKERS_BEFORE") \
  <(printf '%s\n' "$WORKERS_AFTER"))
test -n "$NEW_WORKERS"

ERROR_BYTES_AFTER=$(stat -c '%s' "$NGINX_ERROR_LOG")
test "$ERROR_BYTES_AFTER" -ge "$ERROR_BYTES_BEFORE"
if test "$ERROR_BYTES_AFTER" -gt "$ERROR_BYTES_BEFORE"; then
  ERROR_LOG_DELTA=$(tail -c "+$((ERROR_BYTES_BEFORE + 1))" "$NGINX_ERROR_LOG")
  printf '%s\n' "$ERROR_LOG_DELTA"
  if printf '%s\n' "$ERROR_LOG_DELTA" | grep -Eiq '\[(emerg|alert|crit|error)\]'; then
    exit 1
  fi
fi

getenforce
ls -lZ "$NGINX_CONFIG" "${NGINX_CONFIG}.lock"
RESTORECON_PREVIEW=$(restorecon -n -v "$NGINX_CONFIG" "${NGINX_CONFIG}.lock" 2>&1 || true)
test -z "$RESTORECON_PREVIEW" || { printf '%s\n' "$RESTORECON_PREVIEW" >&2; exit 1; }
```

最后必须运行对应小节中的 Host、SNI 和内容探针。只有 master 身份、worker 换代、error log、SELinux 和本机探针全部通过，Task 14 才能判定新配置已应用；bootstrap 自身不作该声明。

#### 已有配置中断恢复

仅当持久备份与 checksum 都存在时执行；恢复仍须持有同一 vhost lock，并在 signal command 被接受后重新执行上述 Task 14 后置门禁：

```bash
test -f "$BACKUP_CONFIG"
test -f "$BACKUP_CONFIG.sha256"
sha256sum -c "$BACKUP_CONFIG.sha256"
exec 9<>"${NGINX_CONFIG}.lock"
flock -n 9
RECOVERY_TEMP=$(mktemp "${NGINX_CONFIG}.recovery.XXXXXX")
install -m 0644 -o root -g root "$BACKUP_CONFIG" "$RECOVERY_TEMP"
mv -f -- "$RECOVERY_TEMP" "$NGINX_CONFIG"
"$NGINX_BIN" -t
"$NGINX_BIN" -s reload
printf '%s\n' 'recovery reload signal command accepted/sent; application not yet verified'
```

#### 首次安装中断恢复

仅当缺失标记与 checksum 证明 bootstrap 前没有该 vhost 时执行；删除本次文件后重新验证并发送 reload signal，再执行 Task 14 后置门禁：

```bash
test -f "$FIRST_INSTALL_MARKER"
test -f "$FIRST_INSTALL_MARKER.sha256"
sha256sum -c "$FIRST_INSTALL_MARKER.sha256"
grep -Fx "absent:$NGINX_CONFIG" "$FIRST_INSTALL_MARKER"
exec 9<>"${NGINX_CONFIG}.lock"
flock -n 9
rm -f -- "$NGINX_CONFIG"
"$NGINX_BIN" -t
"$NGINX_BIN" -s reload
printf '%s\n' 'recovery reload signal command accepted/sent; application not yet verified'
```

以上是受控人工中断恢复，不在 bootstrap 中新增事务控制面。

### 宝塔 HTTP 受控验收

以下命令必须从仓库根目录运行。`SELECTED_DOMAIN` 只能填写用户在生产变更评审中明确批准的小写域名；验证失败立即停止：

```bash
test -n "${SELECTED_DOMAIN:?user-approved domain is required}"
case "$SELECTED_DOMAIN" in *[!a-z0-9.-]*|.*|*..*|*.) exit 1 ;; esac

sudo env \
  DEPLOY_USER=cs-baoyan-deploy \
  SERVER_NAME="$SELECTED_DOMAIN" \
  DEPLOY_ROOT=/srv/cs-baoyan-ddl \
  NGINX_BIN=/www/server/nginx/sbin/nginx \
  NGINX_TEMPLATE="$PWD/deploy/nginx/cs-baoyan-ddl-bt-http.conf" \
  NGINX_CONFIG="/www/server/panel/vhost/nginx/$SELECTED_DOMAIN.conf" \
  bash deploy/bootstrap-server.sh
```

bootstrap 返回 0 只证明配置已写入、选定的 Nginx 二进制通过 `-t`，且同一二进制接受了 `-s reload` signal command；不证明配置已应用。只有 Task 14 已确认 worker 换代和 error log，并且后续获批的发布步骤已经创建 `current/release.json`，才执行内容与 Host 路由检查：

```bash
test -f /srv/cs-baoyan-ddl/current/release.json
curl --fail --silent --show-error \
  --resolve "$SELECTED_DOMAIN:80:127.0.0.1" \
  "http://$SELECTED_DOMAIN/release.json"

rejected_status=$(
  curl --silent --output /dev/null --write-out '%{http_code}' \
    --header 'Host: rejected.invalid' http://127.0.0.1/ || true
)
test "$rejected_status" = 000
```

这一步只验证本机宝塔 include、精确 Host 拒绝、静态文件路由和 HTTP vhost，不授权创建 DNS 记录、开放公网发布或把 HTTP 写入 `PUBLIC_BASE_URL`。如果 `nginx -t`、reload signal command、选定域名请求或错误 Host 拒绝中的任一项失败，应保留 stop gate，并按 bootstrap 错误信息区分“旧配置已恢复且重新验证”“旧配置恢复但重新验证或 reload signal command 被拒绝”和“首次安装的新配置已删除”；不得笼统宣称回滚成功，也不得绕过验证继续上线。

### 宝塔最终 TLS 配置

只有 Task 14 已批准 `SELECTED_DOMAIN`、证书与私钥的精确绝对路径，并且证书资产已由获批流程放置到主机后，才可运行最终命令。不要使用示例路径，不要让 bootstrap 创建、复制或修改证书：

```bash
test -n "${SELECTED_DOMAIN:?user-approved domain is required}"
case "$SELECTED_DOMAIN" in *[!a-z0-9.-]*|.*|*..*|*.) exit 1 ;; esac
test -n "${TLS_CERTIFICATE:?Task 14 approved certificate path is required}"
test -n "${TLS_CERTIFICATE_KEY:?Task 14 approved certificate key path is required}"

sudo env \
  DEPLOY_USER=cs-baoyan-deploy \
  SERVER_NAME="$SELECTED_DOMAIN" \
  DEPLOY_ROOT=/srv/cs-baoyan-ddl \
  NGINX_BIN=/www/server/nginx/sbin/nginx \
  NGINX_TEMPLATE="$PWD/deploy/nginx/cs-baoyan-ddl-bt-tls.conf" \
  NGINX_CONFIG="/www/server/panel/vhost/nginx/$SELECTED_DOMAIN.conf" \
  TLS_CERTIFICATE="$TLS_CERTIFICATE" \
  TLS_CERTIFICATE_KEY="$TLS_CERTIFICATE_KEY" \
  bash deploy/bootstrap-server.sh
```

最终发布完成且 `current/release.json` 存在后，再做本机 HTTPS 内容、错误 Host、SNI 不匹配和无 SNI 检查。下面三个负向结果必须都是 000；这些是真实 Task 14 门禁，不能由模板结构测试替代：

```bash
test -f /srv/cs-baoyan-ddl/current/release.json
curl --fail --silent --show-error \
  --resolve "$SELECTED_DOMAIN:443:127.0.0.1" \
  "https://$SELECTED_DOMAIN/release.json"

rejected_host_status=$(
  curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
    --resolve "$SELECTED_DOMAIN:443:127.0.0.1" \
    --header 'Host: rejected.invalid' \
    "https://$SELECTED_DOMAIN/" || true
)
test "$rejected_host_status" = 000

mismatched_sni_status=$(
  curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
    --resolve "rejected.invalid:443:127.0.0.1" \
    --header "Host: $SELECTED_DOMAIN" \
    https://rejected.invalid/ || true
)
test "$mismatched_sni_status" = 000

absent_sni_status=$(
  curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
    --header "Host: $SELECTED_DOMAIN" \
    https://127.0.0.1/ || true
)
test "$absent_sni_status" = 000
```

最终 TLS bootstrap 和本机 HTTPS 验证成功仍不等于 public launch 已获批准。production reviewer 必须继续核对 DNS、证书域名与有效期、公开 smoke 身份三元组和回滚命令，再单独批准公网发布。

## SSH 主机密钥外部核验

严禁用 `ssh-keyscan` 生成 `TENCENT_KNOWN_HOSTS`，因为它只能取回网络当下返回的密钥，不能证明密钥属于目标主机。

应通过腾讯云控制台、串行控制台或另一条已经可信的管理通道读取服务器主机公钥，并在服务器本机查看指纹，例如：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

把得到的公钥行在离线或可信终端再次计算指纹，确认与控制台/服务器显示一致后，才写入 GitHub production environment：

```bash
printf '%s\n' '<verified known_hosts line>' | ssh-keygen -lf -
```

- SSH 端口为 22 时，记录形如 `host ssh-ed25519 ...`。
- 自定义端口必须使用 `[host]:port ssh-ed25519 ...`，例如 `[203.0.113.10]:2222 ssh-ed25519 ...`。
- `TENCENT_HOST` 使用域名时，known_hosts 中必须有同一域名；使用 IP 时必须有同一 IP。

工作流固定启用 `BatchMode=yes`、`IdentitiesOnly=yes`、`StrictHostKeyChecking=yes`、专用 `UserKnownHostsFile` 和 `ConnectTimeout=10`，不会回退到交互式确认或其他本机密钥。

## GitHub production environment

创建名为 `production` 的 Environment，只配置以下五个 environment secrets：

```text
TENCENT_HOST
TENCENT_PORT
TENCENT_USER
TENCENT_SSH_KEY
TENCENT_KNOWN_HOSTS
```

再配置一个非 secret environment variable：

```text
PUBLIC_BASE_URL
```

`PUBLIC_BASE_URL` 必须是最终可访问站点的 HTTP 或 HTTPS 根 origin：不得带凭据、非根路径、query 或 fragment。HTTP 只可用于 TLS 完成前的受控验收；production approval 必须把 TLS stop gate 纳入批准条件。

production environment 应设置 required reviewer，并把 deployment branches 限制为受保护的 `main`。仓库 `main` 还应启用 branch protection：禁止 force push，要求名为 `CI` 的检查成功后才能合并。受保护 main 与 production approval 共同构成部署代码和 release artifact 的信任边界；required reviewer 不是对任意仓库内容的安全背书，批准前仍应核对目标 SHA、artifact 来源与 TLS stop gate。

## 发布行为

工作流只接受两种来源：

- 本仓库 `main` push 触发且成功结束的 `CI` workflow run；
- 从 `refs/heads/main` 发起的手动 dispatch。

工作流分成三个 job，其中生产部署使用全新 runner：

- `prepare` 没有 environment 或 secrets；它 checkout 对应完整 SHA，依次完成安装、全部 unit tests、快照验证、Svelte 检查、生产构建和公开边界检查。它只上传 archive、archive checksum 和 identity metadata，build artifact 不包含任何部署脚本。
- `package-control-plane` 没有 environment 或 secrets；它只做固定 SHA 的 pinned checkout，用系统命令复制固定的三个部署脚本、生成 SHA-256 manifest 并上传 control-plane artifact。该 job 不安装 package、不运行 test/build，也不执行任何仓库脚本。
- `deploy` 同时依赖前两个 job，只有二者成功后才进入 `production` environment；required reviewer 批准后，它在新 runner 分别下载两个明确 artifact 并严格核对文件清单。三个脚本必须全部来自 control-plane artifact，且其 SHA-256 必须与 manifest 逐项一致；该 job 不 checkout 仓库、不安装依赖、不执行 package script 或构建。两个 artifact 下载并校验完成、目标仍确认为最新 main 后才写入 SSH 私钥。

部署前会查询远端 `refs/heads/main`，并在 archive 上传完成、activation 紧邻之前再次查询；若 `RELEASE_SHA` 已不是最新 main，旧 CI 即使晚完成也会被拒绝。两个 artifact 都来自受保护 main，但这不取代 production approval；受保护 main 与 production approval 共同定义部署代码和 release artifact 的信任边界。

构建后生成 `dist/release.json`：

```json
{"releaseSha":"<40-char commit>","snapshotId":"<approved snapshot>","dataHash":"<64-char hash>"}
```

归档使用确定性的 USTAR/gzip，上传到 `shared/staging/<run-id>-<attempt>/`，并在服务器端重新校验 SHA-256。解压前先按 512-byte 原始 tar header 流式预检，只接受普通文件和目录；GNU LongName/LongLink、PAX/global PAX、sparse、硬链接、符号链接及其他扩展或特殊类型一律在读取其 payload 前拒绝。原始预检与后续流式提取各自独立重验成员数量、单文件、累计展开、路径长度、路径逃逸和类型；不使用 `getmembers()` 或 `extractall()`。

服务器强制执行以下默认硬边界：压缩 archive 64 MiB、最多 10,000 个成员、单文件 16 MiB、总展开 128 MiB、成员路径最多 256 bytes，以及“64 MiB 保留量加本次总展开尺寸”的磁盘余量。`ARCHIVE_MAX_*` 环境变量只能把上限收紧，`ARCHIVE_MIN_FREE_BYTES` 只能提高下限；脚本把有效值设为只读并严格拒绝零、负数、非十进制和试图放宽硬边界的值。

解包和 pre-activation smoke 成功后，脚本先把严格的 `.archive-sha256` 写入提取目录，再原子移动为最终 `releases/<sha>` 并设置只读权限。这里的只读只用于防误改，不抵御已攻陷的 deploy 用户；该用户拥有 releases 与部署命令能力，不能把权限位表述为安全意义上的不可变。最终目录不覆盖；同 SHA 只有在其内部 marker 与上传归档 checksum 完全一致时才复用，否则部署失败。Nginx 拒绝所有 dotfile 请求，因此该内部 marker 不可通过站点读取。

服务器在 `flock` 内原子创建严格的 `transactions/<run-token>/` 记录，再原子替换 `current`。发布内容与 marker、release rename、transaction 文件与目录 rename、`current` 替换和 state 替换都按先写入、再 fsync 文件/目录、最后发布名称并 fsync 父目录的顺序执行；任何 fsync 失败都会停止。fsync 只能缩小崩溃窗口，不能替代主机断电后的 rollback/reconcile 对账和运维验证。

脚本仍在执行时，首次发布的失败处理会删除失败的 `current`；后续发布会尝试恢复该 run token 绑定的 previous，并再次执行本地 smoke。仅当 GitHub runner 仍可执行且能够重新连接主机时，workflow 才会自动补偿 public smoke 或 activation step 的失败。

如果 runner 丢失或不可用，必须使用持久 transaction 执行显式 `rollback-release.sh` 对账；如果主机断电，也必须在主机恢复后根据同一 run token 执行 rollback/reconcile 对账。cleanup 的 `if: always()` 会在 runner 仍可执行时删除本地密钥并尝试清理 staging，但不能覆盖 runner 被强制终止的情形。public smoke 不跟随重定向，只接受精确 200、同源根相对 JavaScript asset，并精确核对 release SHA、snapshot ID、data hash、首页标题、SPA 深链和缺失 asset 的 404。

常规脚本测试使用 fake `flock` 只验证脚本行为，不证明真实互斥。Linux/CI 必须运行使用 util-linux 真实 `flock` 的并发门禁；macOS 因系统没有兼容的 `flock` 而明确跳过该单项测试。

## 上线前检查

- `production` required reviewer 和 main deployment branch 已配置。
- main branch protection 要求完整 `CI`。
- 五个 secrets 和 `PUBLIC_BASE_URL` 已放在 production environment，而不是写入仓库。
- `TENCENT_KNOWN_HOSTS` 已通过带外渠道核验；没有使用 `ssh-keyscan`。
- 专用部署用户没有 sudo，authorized_keys 已禁止转发和 PTY。
- 专用部署用户的 primary group 名称与用户名相同。
- 已确认用户批准的 `SELECTED_DOMAIN`、Host 拒绝、HTTP 受控验收、宝塔 Nginx 二进制和 vhost 目标路径。
- 域名、备案、精确证书路径、TLS 与 public launch stop gate 已分别通过 production reviewer 确认。
- 首次真实发布须由用户批准；本手册本身不授权连接或修改腾讯云。

真实发布成功后，可以从当前 release 读取三元身份并再次执行外部 smoke：

```bash
CURRENT=/srv/cs-baoyan-ddl/current
RELEASE_SHA=$(basename "$(readlink -f "$CURRENT")")
EXPECTED_SNAPSHOT_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshotId"])' "$CURRENT/release.json")
EXPECTED_DATA_HASH=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dataHash"])' "$CURRENT/release.json")
SMOKE_URL=https://ddl.example.com \
EXPECTED_RELEASE_SHA="$RELEASE_SHA" \
EXPECTED_SNAPSHOT_ID="$EXPECTED_SNAPSHOT_ID" \
EXPECTED_DATA_HASH="$EXPECTED_DATA_HASH" \
bash deploy/smoke.sh
```

把 URL 改成实际已确认的 HTTP/HTTPS 地址；未确认 TLS 时不要照抄 `https://`。
