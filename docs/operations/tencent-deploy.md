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

本节只允许在已批准的主机维护窗口内由 root 执行，不授权当前任务连接主机。窗口内冻结宝塔的保存、应用、重载和证书动作。为降低误操作面，正常变更只复制一个主门禁块；另有两个互斥的中断恢复块。三个块都独立启用 fail-fast，并在使用任何路径前校验 SELECTED_DOMAIN。

当前只读事实是全局 error_log /www/wwwlogs/nginx_error.log crit;，master cmdline 使用 -c /www/server/nginx/conf/nginx.conf。主门禁不信任历史 PID 或 FD 编号：它把 master cmdline 的显式 -c 参数（没有该参数时为合法默认配置）与 nginx -T 的首个 configuration marker 绑定，把推导出的主配置原样传给 bootstrap，并遍历 /proc 下 master 的全部 FD 证明至少一个 FD 打开同一日志 dev/inode。已有配置才要求精确配置 marker，并要求 restorecon -n 无待修复；首次安装要求锚定的非注释 include /www/server/panel/vhost/nginx/*.conf;，bootstrap 后再要求新 vhost 的精确 marker。持久备份使用唯一 mktemp 目录与 cp -a，保留内容、mode、owner、timestamps 和允许的 security.selinux 标签。

#### HTTP/TLS 单块主门禁

从仓库根目录执行。先显式设置 TASK14_TEMPLATE_MODE=http；最终 TLS 窗口改为 tls，并额外导出已批准的 TLS_CERTIFICATE 与 TLS_CERTIFICATE_KEY 绝对路径。块内依次完成 preflight、持久备份、bootstrap、master/worker/error-log/SELinux 复验及本机 Host/SNI 虚拟主机路由探针。选定路由在尚无发布内容时预期 404；错误 Host、错误 SNI 和无 SNI 必须被拒绝。reload signal command accepted/sent 只代表命令被接受，不表示配置已应用；只有后续 worker、日志与路由门禁全部通过才接受本次主机变更。

```bash
set -Eeuo pipefail
: "${SELECTED_DOMAIN:?user-approved domain is required}"
case "$SELECTED_DOMAIN" in *[!a-z0-9.-]*|.*|*..*|*.) exit 1 ;; esac
: "${TASK14_TEMPLATE_MODE:?set http or tls}"
umask 077
NGINX_BIN=/www/server/nginx/sbin/nginx
NGINX_CONFIG="/www/server/panel/vhost/nginx/$SELECTED_DOMAIN.conf"
NGINX_PID_FILE=${NGINX_PID_FILE:-/www/server/nginx/logs/nginx.pid}
BACKUP_ROOT=${BACKUP_ROOT:-/root/cs-baoyan-ddl-nginx-backups}
PROC_ROOT=${PROC_ROOT:-/proc}
case "$TASK14_TEMPLATE_MODE" in
  http) NGINX_TEMPLATE="$PWD/deploy/nginx/cs-baoyan-ddl-bt-http.conf" ;;
  tls)
    : "${TLS_CERTIFICATE:?Task 14 approved certificate path is required}"
    : "${TLS_CERTIFICATE_KEY:?Task 14 approved certificate key path is required}"
    NGINX_TEMPLATE="$PWD/deploy/nginx/cs-baoyan-ddl-bt-tls.conf"
    ;;
  *) exit 1 ;;
esac
test -x "$NGINX_BIN"
test -r "$NGINX_PID_FILE"
case "$NGINX_CONFIG:$BACKUP_ROOT" in /*:/*) ;; *) exit 1 ;; esac

MASTER_PID=$(cat "$NGINX_PID_FILE")
case "$MASTER_PID" in ''|*[!0-9]*) exit 1 ;; esac
NGINX_REAL=$(readlink -f "$NGINX_BIN")
test "$(readlink -f "$PROC_ROOT/$MASTER_PID/exe")" = "$NGINX_REAL"
MASTER_CMDLINE=$(tr '\0' ' ' < "$PROC_ROOT/$MASTER_PID/cmdline")
MASTER_CMDLINE=${MASTER_CMDLINE% }
case "$MASTER_CMDLINE" in *nginx*master*process*) ;; *) exit 1 ;; esac

# BEGIN ACTIVE_MASTER_CONFIG_GATE
master_config_argument() {
  python3 - "$1" <<'PY'
import os, re, sys
command = sys.argv[1]
flags = re.findall(r"(?:^|\s)-c(?=\s|$)", command)
matches = re.findall(r"(?:^|\s)-c\s+(\S+)", command)
if len(flags) != len(matches) or len(matches) > 1:
    raise SystemExit("ambiguous master -c argument")
if matches:
    path = matches[0]
    if not os.path.isabs(path) or any(part in (".", "..") for part in path.split("/")):
        raise SystemExit("unsafe master -c path")
    print(path)
PY
}
first_config_marker() {
  sed -n 's/^# configuration file \(\/.*\):$/\1/p' | sed -n '1p'
}
active_main_config_from() {
  local master_config=$1 nginx_t_output=$2 main_config
  main_config=$(printf '%s\n' "$nginx_t_output" | first_config_marker)
  case "$main_config" in /*) ;; *) return 1 ;; esac
  if test -n "$master_config" && test "$master_config" != "$main_config"; then
    printf '%s\n' 'master -c path does not match the first nginx -T marker' >&2
    return 1
  fi
  printf '%s\n' "$main_config"
}
active_nginx_t() {
  if test -n "$MASTER_CONFIG_ARGUMENT"; then
    "$NGINX_BIN" -T -c "$MASTER_CONFIG_ARGUMENT" 2>&1
  else
    "$NGINX_BIN" -T 2>&1
  fi
}
# END ACTIVE_MASTER_CONFIG_GATE

MASTER_CONFIG_ARGUMENT=$(master_config_argument "$MASTER_CMDLINE")
NGINX_V_OUTPUT=$("$NGINX_BIN" -V 2>&1)
printf '%s\n' "$NGINX_V_OUTPUT"
NGINX_T_OUTPUT=$(active_nginx_t)
NGINX_MAIN_CONFIG=$(active_main_config_from "$MASTER_CONFIG_ARGUMENT" "$NGINX_T_OUTPUT")
NGINX_MAIN_MARKER="# configuration file $NGINX_MAIN_CONFIG:"
if test -e "$NGINX_CONFIG"; then
  test ! -L "$NGINX_CONFIG"
  printf '%s\n' "$NGINX_T_OUTPUT" | grep -Fx "# configuration file $NGINX_CONFIG:"
  RESTORECON_PREVIEW=$(restorecon -n -v "$NGINX_CONFIG" 2>&1)
  test -z "$RESTORECON_PREVIEW"
else
  printf '%s\n' "$NGINX_T_OUTPUT" | grep -E '^[[:space:]]*include[[:space:]]+/www/server/panel/vhost/nginx/\*\.conf;[[:space:]]*$'
fi

python3 - "$NGINX_CONFIG" <<'PY'
import os, pathlib, stat, sys
directory = pathlib.Path(sys.argv[1]).parent
for ancestor in (directory, *directory.parents):
    value = os.lstat(ancestor)
    mode = stat.S_IMODE(value.st_mode)
    if stat.S_ISLNK(value.st_mode) or value.st_uid != 0 or mode & 0o022:
        raise SystemExit(f"unsafe vhost ancestor: {ancestor}")
PY

flock --version
SCRATCH_LOCK=$(mktemp /root/cs-baoyan-ddl-flock.XXXXXX)
trap 'rm -f -- "${SCRATCH_LOCK:-}"' EXIT
exec 8<>"$SCRATCH_LOCK"
flock -n 8
if flock -n "$SCRATCH_LOCK" -c true; then exit 1; fi
flock -u 8
exec 8>&-
rm -f -- "$SCRATCH_LOCK"
SCRATCH_LOCK=
trap - EXIT

# BEGIN VALIDATED_WORKER_GATE
canonical_path() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}
collect_valid_workers() {
  local status_path pid parent_pid worker_cmdline worker_exe
  for status_path in "$PROC_ROOT"/[0-9]*/status; do
    test -e "$status_path" || continue
    pid=${status_path%/status}; pid=${pid##*/}
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    parent_pid=$(awk '$1 == "PPid:" { print $2; exit }' "$status_path")
    test "$parent_pid" = "$MASTER_PID" || continue
    test -r "$PROC_ROOT/$pid/cmdline" || continue
    worker_cmdline=$(tr '\0' ' ' < "$PROC_ROOT/$pid/cmdline")
    worker_cmdline=${worker_cmdline% }
    test "$worker_cmdline" = 'nginx: worker process' || continue
    worker_exe=$(canonical_path "$PROC_ROOT/$pid/exe") || continue
    test "$worker_exe" = "$NGINX_REAL" || continue
    printf '%s\n' "$pid"
  done
}
wait_for_new_worker() {
  local before_workers=$1 attempt=1 current_new_workers previous_new_workers= pid
  while test "$attempt" -le "$WORKER_POLL_ATTEMPTS"; do
    current_new_workers=
    while IFS= read -r pid; do
      test -n "$pid" || continue
      case " $before_workers " in *" $pid "*) continue ;; esac
      current_new_workers="${current_new_workers:+$current_new_workers }$pid"
    done < <(collect_valid_workers)
    for pid in $current_new_workers; do
      case " $previous_new_workers " in *" $pid "*) printf '%s\n' "$pid"; return 0 ;; esac
    done
    previous_new_workers=$current_new_workers
    attempt=$((attempt + 1))
    test "$attempt" -gt "$WORKER_POLL_ATTEMPTS" || sleep "$WORKER_POLL_INTERVAL_SECONDS"
  done
  printf '%s\n' 'no stable new nginx worker survived two consecutive polls' >&2
  return 1
}
# END VALIDATED_WORKER_GATE

# BEGIN MASTER_LOG_FD_GATE
path_dev_inode() {
  python3 - "$1" <<'PY'
import os, sys
value = os.stat(sys.argv[1])
print(f"{value.st_dev}:{value.st_ino}")
PY
}
master_has_log_inode() {
  local fd_path fd_dev_inode
  for fd_path in "$PROC_ROOT/$MASTER_PID/fd"/*; do
    test -e "$fd_path" || continue
    fd_dev_inode=$(path_dev_inode "$fd_path" 2>/dev/null) || continue
    if test "$fd_dev_inode" = "$ERROR_LOG_DEV_INODE"; then
      return 0
    fi
  done
  printf '%s\n' 'master does not hold the active error log inode' >&2
  return 1
}
# END MASTER_LOG_FD_GATE

global_error_log_from_t() {
  awk -v main_marker="$NGINX_MAIN_MARKER" '
    BEGIN { depth=0; count=0; in_main=0; seen_main=0 }
    $0 == main_marker { in_main=1; seen_main++; next }
    in_main && /^# configuration file / { in_main=0 }
    !in_main { next }
    {
      line=$0; sub(/[[:space:]]*#.*/, "", line)
      if (depth == 0 && $1 == "error_log") {
        if ($3 != "crit;") exit 2
        path=$2; count++
      }
      opens=gsub(/{/, "{", line); closes=gsub(/}/, "}", line)
      depth += opens - closes
      if (depth < 0) exit 3
    }
    END {
      if (seen_main != 1 || count != 1 || depth != 0) exit 4
      print path
    }
  '
}

WORKER_POLL_ATTEMPTS=${WORKER_POLL_ATTEMPTS:-20}
WORKER_POLL_INTERVAL_SECONDS=${WORKER_POLL_INTERVAL_SECONDS:-1}
case "$WORKER_POLL_ATTEMPTS:$WORKER_POLL_INTERVAL_SECONDS" in *[!0-9:]*) exit 1 ;; esac
test "$WORKER_POLL_ATTEMPTS" -ge 2
test "$WORKER_POLL_ATTEMPTS" -le 60
test "$WORKER_POLL_INTERVAL_SECONDS" -ge 1; test "$WORKER_POLL_INTERVAL_SECONDS" -le 10
WORKERS_BEFORE=$(collect_valid_workers | tr '\n' ' ')
WORKERS_BEFORE=${WORKERS_BEFORE% }
test -n "$WORKERS_BEFORE"

GLOBAL_ERROR_LOG=$(printf '%s\n' "$NGINX_T_OUTPUT" | global_error_log_from_t)
test "$GLOBAL_ERROR_LOG" = /www/wwwlogs/nginx_error.log
NGINX_ERROR_LOG=$GLOBAL_ERROR_LOG
ERROR_LOG_DEV_INODE=$(path_dev_inode "$NGINX_ERROR_LOG")
ERROR_LOG_OFFSET=$(stat -Lc '%s' "$NGINX_ERROR_LOG")
master_has_log_inode
printf 'error log dev:inode=%s offset=%s\n' "$ERROR_LOG_DEV_INODE" "$ERROR_LOG_OFFSET"
getenforce
test ! -e "$NGINX_CONFIG" || ls -lZ "$NGINX_CONFIG"

install -d -m 0700 -o root -g root "$BACKUP_ROOT"
BACKUP_DIR=$(mktemp -d "$BACKUP_ROOT/$SELECTED_DOMAIN.XXXXXX")
chmod 0700 "$BACKUP_DIR"
if test -e "$NGINX_CONFIG"; then
  BACKUP_CONFIG="$BACKUP_DIR/site.conf"
  cp -a -- "$NGINX_CONFIG" "$BACKUP_CONFIG"
  cmp -s -- "$BACKUP_CONFIG" "$NGINX_CONFIG"
  python3 - "$NGINX_CONFIG" "$BACKUP_CONFIG" <<'PY'
import errno, os, stat, sys
def label(path):
    try:
        return os.getxattr(path, "security.selinux", follow_symlinks=False)
    except (AttributeError, TypeError):
        return None
    except OSError as error:
        if error.errno in {getattr(errno, "ENODATA", -1), errno.ENOTSUP}: return None
        raise
def metadata(path):
    value = os.lstat(path)
    return stat.S_IMODE(value.st_mode), value.st_uid, value.st_gid, value.st_mtime_ns, label(path)
if metadata(sys.argv[1]) != metadata(sys.argv[2]): raise SystemExit("backup metadata mismatch")
PY
  BACKUP_CONFIG_SHA256="$BACKUP_CONFIG.sha256"
  sha256sum "$BACKUP_CONFIG" > "$BACKUP_CONFIG_SHA256"
  printf 'export BACKUP_CONFIG=%q\nexport BACKUP_CONFIG_SHA256=%q\nexport NGINX_MAIN_CONFIG=%q\n' "$BACKUP_CONFIG" "$BACKUP_CONFIG_SHA256" "$NGINX_MAIN_CONFIG"
else
  FIRST_INSTALL_MARKER="$BACKUP_DIR/site.absent"
  printf 'absent:%s\n' "$NGINX_CONFIG" > "$FIRST_INSTALL_MARKER"
  FIRST_INSTALL_MARKER_SHA256="$FIRST_INSTALL_MARKER.sha256"
  sha256sum "$FIRST_INSTALL_MARKER" > "$FIRST_INSTALL_MARKER_SHA256"
  printf 'export FIRST_INSTALL_MARKER=%q\nexport FIRST_INSTALL_MARKER_SHA256=%q\nexport NGINX_MAIN_CONFIG=%q\n' "$FIRST_INSTALL_MARKER" "$FIRST_INSTALL_MARKER_SHA256" "$NGINX_MAIN_CONFIG"
fi

if test "$TASK14_TEMPLATE_MODE" = http; then
  sudo env DEPLOY_USER=cs-baoyan-deploy SERVER_NAME="$SELECTED_DOMAIN" \
    DEPLOY_ROOT=/srv/cs-baoyan-ddl NGINX_BIN="$NGINX_BIN" \
    NGINX_TEMPLATE="$NGINX_TEMPLATE" NGINX_CONFIG="$NGINX_CONFIG" NGINX_MAIN_CONFIG="$NGINX_MAIN_CONFIG" \
    bash deploy/bootstrap-server.sh
else
  sudo env DEPLOY_USER=cs-baoyan-deploy SERVER_NAME="$SELECTED_DOMAIN" \
    DEPLOY_ROOT=/srv/cs-baoyan-ddl NGINX_BIN="$NGINX_BIN" \
    NGINX_TEMPLATE="$NGINX_TEMPLATE" NGINX_CONFIG="$NGINX_CONFIG" NGINX_MAIN_CONFIG="$NGINX_MAIN_CONFIG" \
    TLS_CERTIFICATE="$TLS_CERTIFICATE" TLS_CERTIFICATE_KEY="$TLS_CERTIFICATE_KEY" \
    bash deploy/bootstrap-server.sh
fi

MASTER_PID_AFTER=$(cat "$NGINX_PID_FILE")
test "$MASTER_PID_AFTER" = "$MASTER_PID"
test "$(readlink -f "$PROC_ROOT/$MASTER_PID/exe")" = "$NGINX_REAL"
MASTER_CMDLINE_AFTER=$(tr '\0' ' ' < "$PROC_ROOT/$MASTER_PID/cmdline")
test "${MASTER_CMDLINE_AFTER% }" = "$MASTER_CMDLINE"
WORKERS_AFTER=$(collect_valid_workers | tr '\n' ' ')
WORKERS_AFTER=${WORKERS_AFTER% }
NEW_WORKERS=$(wait_for_new_worker "$WORKERS_BEFORE")
test -n "$WORKERS_AFTER:$NEW_WORKERS"

NGINX_T_OUTPUT_AFTER=$(active_nginx_t)
test "$(active_main_config_from "$MASTER_CONFIG_ARGUMENT" "$NGINX_T_OUTPUT_AFTER")" = "$NGINX_MAIN_CONFIG"
printf '%s\n' "$NGINX_T_OUTPUT_AFTER" | grep -Fx "# configuration file $NGINX_CONFIG:"
test "$(printf '%s\n' "$NGINX_T_OUTPUT_AFTER" | global_error_log_from_t)" = "$NGINX_ERROR_LOG"
ERROR_LOG_DEV_INODE_AFTER=$(path_dev_inode "$NGINX_ERROR_LOG")
test "$ERROR_LOG_DEV_INODE_AFTER" = "$ERROR_LOG_DEV_INODE"
master_has_log_inode
test "$(stat -Lc '%s' "$NGINX_ERROR_LOG")" -ge "$ERROR_LOG_OFFSET"
ERROR_OBSERVE_SECONDS=${ERROR_OBSERVE_SECONDS:-5}
case "$ERROR_OBSERVE_SECONDS" in ''|*[!0-9]*) exit 1 ;; esac
test "$ERROR_OBSERVE_SECONDS" -ge 1; test "$ERROR_OBSERVE_SECONDS" -le 30
sleep "$ERROR_OBSERVE_SECONDS"
test "$(path_dev_inode "$NGINX_ERROR_LOG")" = "$ERROR_LOG_DEV_INODE"
master_has_log_inode
ERROR_LOG_SIZE_OBSERVED=$(stat -Lc '%s' "$NGINX_ERROR_LOG")
test "$ERROR_LOG_SIZE_OBSERVED" -ge "$ERROR_LOG_OFFSET"
if test "$ERROR_LOG_SIZE_OBSERVED" -gt "$ERROR_LOG_OFFSET"; then
  ERROR_LOG_DELTA=$(tail -c "+$((ERROR_LOG_OFFSET + 1))" "$NGINX_ERROR_LOG")
  printf '%s\n' "$ERROR_LOG_DELTA"
  ! printf '%s\n' "$ERROR_LOG_DELTA" | grep -Eiq '\[(emerg|alert|crit)\]'
fi
ls -lZ "$NGINX_CONFIG" "${NGINX_CONFIG}.lock"
RESTORECON_PREVIEW=$(restorecon -n -v "$NGINX_CONFIG" "${NGINX_CONFIG}.lock" 2>&1)
test -z "$RESTORECON_PREVIEW"

if test "$TASK14_TEMPLATE_MODE" = http; then
  HTTP_HEADERS=$(mktemp); trap 'rm -f -- "$HTTP_HEADERS"' EXIT
  selected_status=$(curl --silent --show-error --output /dev/null --dump-header "$HTTP_HEADERS" \
    --write-out '%{http_code}' --resolve "$SELECTED_DOMAIN:80:127.0.0.1" \
    "http://$SELECTED_DOMAIN/__task14_pre_activation__")
  test "$selected_status" = 404
  grep -Eiq '^X-Content-Type-Options:[[:space:]]*nosniff' "$HTTP_HEADERS"
  rejected_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header 'Host: rejected.invalid' http://127.0.0.1/ || true)
  test "$rejected_status" = 000
else
  TLS_HEADERS=$(mktemp); trap 'rm -f -- "$TLS_HEADERS"' EXIT
  selected_tls_status=$(curl --silent --show-error --output /dev/null --dump-header "$TLS_HEADERS" \
    --write-out '%{http_code}' --resolve "$SELECTED_DOMAIN:443:127.0.0.1" \
    "https://$SELECTED_DOMAIN/__task14_pre_activation__")
  test "$selected_tls_status" = 404
  grep -Eiq '^X-Content-Type-Options:[[:space:]]*nosniff' "$TLS_HEADERS"
  redirect_location=$(curl --silent --show-error --output /dev/null --write-out '%{redirect_url}' \
    --resolve "$SELECTED_DOMAIN:80:127.0.0.1" "http://$SELECTED_DOMAIN/__task14_pre_activation__")
  test "$redirect_location" = "https://$SELECTED_DOMAIN/__task14_pre_activation__"
  rejected_host_status=$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
    --resolve "$SELECTED_DOMAIN:443:127.0.0.1" --header 'Host: rejected.invalid' \
    "https://$SELECTED_DOMAIN/" || true)
  test "$rejected_host_status" = 000
  mismatched_sni_status=$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
    --resolve "rejected.invalid:443:127.0.0.1" --header "Host: $SELECTED_DOMAIN" \
    https://rejected.invalid/ || true)
  test "$mismatched_sni_status" = 000
  absent_sni_status=$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
    --header "Host: $SELECTED_DOMAIN" https://127.0.0.1/ || true)
  test "$absent_sni_status" = 000
fi
printf '%s\n' 'reload signal command accepted/sent; master, worker, error-log, SELinux, Host/SNI routing gates passed'
```

块打印的 BACKUP_CONFIG/BACKUP_CONFIG_SHA256 或 FIRST_INSTALL_MARKER/FIRST_INSTALL_MARKER_SHA256，以及同次打印的精确 NGINX_MAIN_CONFIG，是唯一恢复输入，必须保存到 root-only 变更记录。HTTP 验收不授权 DNS 或公网；最终 TLS 与 public launch 继续保持 stop gate，由 production reviewer 单独批准。Task 14 不读取发布内容；release.json、SPA、asset 和 release identity 只在 Task 16 activation 后检查。

#### 已有配置中断恢复

仅使用同一次主门禁打印的持久备份。checksum 与非阻塞 flock 在目标修改前完成；任一失败都保留目标。恢复以 cp -a 复制到同目录临时文件后原子重命名，并比较内容、mode、owner、mtime 与 security.selinux。最后的 signal command accepted/sent 仍不证明恢复配置已应用，恢复后保持 stop gate。

```bash
set -Eeuo pipefail
: "${SELECTED_DOMAIN:?user-approved domain is required}"
case "$SELECTED_DOMAIN" in *[!a-z0-9.-]*|.*|*..*|*.) exit 1 ;; esac
: "${BACKUP_CONFIG:?export the exact BACKUP_CONFIG printed by preflight}"
: "${NGINX_MAIN_CONFIG:?export the exact NGINX_MAIN_CONFIG printed by preflight}"
BACKUP_CONFIG_SHA256=${BACKUP_CONFIG_SHA256:-$BACKUP_CONFIG.sha256}
NGINX_BIN=${NGINX_BIN:-/www/server/nginx/sbin/nginx}
NGINX_CONFIG=${NGINX_CONFIG:-/www/server/panel/vhost/nginx/$SELECTED_DOMAIN.conf}
case "$BACKUP_CONFIG:$BACKUP_CONFIG_SHA256:$NGINX_CONFIG:$NGINX_MAIN_CONFIG" in /*:/*:/*:/*) ;; *) exit 1 ;; esac
case "$NGINX_MAIN_CONFIG" in /|*//*|*/../*|*/..|*/./*|*/.|*/|*[!A-Za-z0-9._/-]*) exit 1 ;; esac
test -f "$BACKUP_CONFIG"
test -f "$BACKUP_CONFIG_SHA256"
sha256sum -c "$BACKUP_CONFIG_SHA256"
exec 9<>"${NGINX_CONFIG}.lock"
flock -n 9

RECOVERY_TEMP=
trap 'test -z "${RECOVERY_TEMP:-}" || rm -f -- "$RECOVERY_TEMP"' EXIT
RECOVERY_TEMP=$(mktemp "${NGINX_CONFIG}.recovery.XXXXXX")
rm -f -- "$RECOVERY_TEMP"
cp -a -- "$BACKUP_CONFIG" "$RECOVERY_TEMP"
mv -f -- "$RECOVERY_TEMP" "$NGINX_CONFIG"
RECOVERY_TEMP=
cmp -s -- "$BACKUP_CONFIG" "$NGINX_CONFIG"
python3 - "$BACKUP_CONFIG" "$NGINX_CONFIG" <<'PY'
import errno, os, stat, sys
def label(path):
    try:
        return os.getxattr(path, "security.selinux", follow_symlinks=False)
    except (AttributeError, TypeError):
        return None
    except OSError as error:
        if error.errno in {getattr(errno, "ENODATA", -1), errno.ENOTSUP}: return None
        raise
def metadata(path):
    value = os.lstat(path)
    return stat.S_IMODE(value.st_mode), value.st_uid, value.st_gid, value.st_mtime_ns, label(path)
if metadata(sys.argv[1]) != metadata(sys.argv[2]): raise SystemExit("restored metadata mismatch")
PY
"$NGINX_BIN" -t -c "$NGINX_MAIN_CONFIG"
"$NGINX_BIN" -s reload -c "$NGINX_MAIN_CONFIG"
printf '%s\n' 'recovery reload signal command accepted/sent; application not yet verified'
flock -u 9
```

#### 首次安装中断恢复

仅使用同一次主门禁打印的缺失标记。checksum、标记内容和非阻塞 flock 都在删除目标前完成；任一失败都不修改目标。删除后验证剩余配置并发送 signal，仍保持 stop gate。

```bash
set -Eeuo pipefail
: "${SELECTED_DOMAIN:?user-approved domain is required}"
case "$SELECTED_DOMAIN" in *[!a-z0-9.-]*|.*|*..*|*.) exit 1 ;; esac
: "${FIRST_INSTALL_MARKER:?export the exact FIRST_INSTALL_MARKER printed by preflight}"
: "${NGINX_MAIN_CONFIG:?export the exact NGINX_MAIN_CONFIG printed by preflight}"
FIRST_INSTALL_MARKER_SHA256=${FIRST_INSTALL_MARKER_SHA256:-$FIRST_INSTALL_MARKER.sha256}
NGINX_BIN=${NGINX_BIN:-/www/server/nginx/sbin/nginx}
NGINX_CONFIG=${NGINX_CONFIG:-/www/server/panel/vhost/nginx/$SELECTED_DOMAIN.conf}
case "$FIRST_INSTALL_MARKER:$FIRST_INSTALL_MARKER_SHA256:$NGINX_CONFIG:$NGINX_MAIN_CONFIG" in /*:/*:/*:/*) ;; *) exit 1 ;; esac
case "$NGINX_MAIN_CONFIG" in /|*//*|*/../*|*/..|*/./*|*/.|*/|*[!A-Za-z0-9._/-]*) exit 1 ;; esac
test -f "$FIRST_INSTALL_MARKER"
test -f "$FIRST_INSTALL_MARKER_SHA256"
sha256sum -c "$FIRST_INSTALL_MARKER_SHA256"
grep -Fx "absent:$NGINX_CONFIG" "$FIRST_INSTALL_MARKER"
exec 9<>"${NGINX_CONFIG}.lock"
flock -n 9
rm -f -- "$NGINX_CONFIG"
test ! -e "$NGINX_CONFIG"
"$NGINX_BIN" -t -c "$NGINX_MAIN_CONFIG"
"$NGINX_BIN" -s reload -c "$NGINX_MAIN_CONFIG"
printf '%s\n' 'recovery reload signal command accepted/sent; application not yet verified'
flock -u 9
```

以上恢复是受控人工中断路径，不在 bootstrap 中新增持久事务控制面。

### Task 16 activation 后内容与身份验收

只有 Task 16 已运行 `activate-release.sh` 并成功切换 `current` 后，才验证 `release.json`、SPA、JavaScript asset 和 release identity。Task 14 不读取这些文件，因此不会等待尚未 activation 的内容。下面的 `smoke.sh` 同时验证精确三元身份、首页、同源 asset、SPA 深链和缺失 asset 的 404：

```bash
set -Eeuo pipefail
: "${SELECTED_DOMAIN:?user-approved domain is required}"
case "$SELECTED_DOMAIN" in *[!a-z0-9.-]*|.*|*..*|*.) exit 1 ;; esac

: "${EXPECTED_RELEASE_SHA:?Task 16 release identity SHA is required}"
: "${EXPECTED_SNAPSHOT_ID:?Task 16 snapshot identity is required}"
: "${EXPECTED_DATA_HASH:?Task 16 data hash is required}"
test -f /srv/cs-baoyan-ddl/current/release.json
SMOKE_URL="https://$SELECTED_DOMAIN" \
EXPECTED_RELEASE_SHA="$EXPECTED_RELEASE_SHA" \
EXPECTED_SNAPSHOT_ID="$EXPECTED_SNAPSHOT_ID" \
EXPECTED_DATA_HASH="$EXPECTED_DATA_HASH" \
bash deploy/smoke.sh
```

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
