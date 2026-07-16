# 腾讯云静态部署手册

## 当前边界

本仓库只提供部署工具，不代表腾讯云已配置完成。本次实现没有连接腾讯云、写入 GitHub Secrets、执行 bootstrap，也没有修改防火墙、`sshd`、DNS 或 TLS。

当前 Nginx 模板只监听 HTTP 80，用于 bootstrap 和受控验收，不是完整生产 TLS 配置。正式域名、备案、证书路径和 TLS 终止方式必须在真实主机与域名确认后另行评审，不能在未知条件下套用示例证书配置。TLS 是生产发布的 stop gate（停止门）：完成域名与证书方案验收前，production required reviewer 不应批准真实上线。

## 一次性服务器准备

1. 创建专用部署用户。该用户不得是腾讯云主账号，不得持有扫描数据或个人申请资料，不加入 `sudoers`，也不得获得通用 sudo：

   ```bash
   sudo groupadd --system cs-baoyan-deploy
   sudo useradd --system --create-home --shell /bin/bash \
     --gid cs-baoyan-deploy cs-baoyan-deploy
   ```

   bootstrap 明确要求部署用户的 primary group 名称与 `DEPLOY_USER` 完全相同；上面的 `--gid cs-baoyan-deploy` 满足该约束。不要复用一个 primary group 名称不同的既有账号。

2. 安装并确认这些命令可用：`python3`、`curl`、`nginx`、`systemctl`、`flock`、`sha256sum`、`tar`。安装系统包属于管理员动作，不要授权部署用户代为执行。

   执行 bootstrap 前还必须读取真实 Nginx 构建和 include 路径：

   ```bash
   nginx -V 2>&1
   nginx -T 2>/dev/null | awk '/^[[:space:]]*include[[:space:]]/{print}'
   ```

   默认 `NGINX_CONFIG=/etc/nginx/conf.d/cs-baoyan-ddl.conf` 只适用于该目录真实存在且被主配置 include 的标准安装。宝塔或自定义 `--prefix` 构建常使用另一套 vhost 目录；这种主机必须先停下，评审一个明确的 `NGINX_CONFIG` 路径和回滚方式，不能创建一个 Nginx 根本不会读取的文件。

   模板还声明了一个 HTTP `default_server` 用于拒绝未知 Host。若真实主机已经有同地址同端口的 `default_server`，直接安装会产生冲突，禁止绕过 `nginx -t` 或删除现有站点。应先单独评审现有默认路由和本站的 Host 隔离方案，再决定是否使用主机专属模板；这属于生产配置变更停止门，不由本仓库手册自动处理。

3. 把部署公钥加入该用户的 `~/.ssh/authorized_keys`，至少禁止转发和 PTY。OpenSSH 支持 `restrict` 时建议使用：

   ```text
   restrict,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <PUBLIC_KEY> github-actions-cs-baoyan-ddl
   ```

   工作流需要在限定目录内执行 `mkdir`、部署脚本和清理 staging，因此这里不配置一个会阻断这些命令的任意 forced command。该专用账号仍有通用命令能力；`restrict`、禁止转发/PTY 和无 sudo 只能缩小影响面，不能把账号视为只能运行单一部署命令。安全边界还依赖受保护 main、production approval、最小目录权限、脚本路径校验和服务器侧 `flock`。

4. 以管理员身份审阅仓库中的 bootstrap 和 Nginx 模板，然后只执行一次；重复执行是幂等的：

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

   `/srv/cs-baoyan-ddl` 由 `root:cs-baoyan-deploy` 以 `0775` 管理，使部署用户通过同名专用组更新 `current`；发布目录由部署用户拥有，Nginx 只需读取和遍历。脚本渲染明确的 `server_name`，并用 default server 和 `$host` 检查拒绝不匹配的 Host；运行 `nginx -t` 后才重载，失败时恢复旧配置。它不会触碰防火墙、`sshd`、DNS 或 TLS。若系统已有其他 `default_server`，管理员必须先处理冲突并以 `nginx -t` 为准。

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
- 已确认 `SERVER_NAME`、Host 拒绝、HTTP 受控验收和 Nginx 配置；域名、备案与 TLS stop gate 已通过 production reviewer 确认。
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
