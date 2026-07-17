# 腾讯云静态站回滚手册

## 原则

人工回滚必须选择一个明确的 40 位 release SHA，不按时间、不按目录顺序、不根据 `previous` 文件猜目标。`previous` 只用于某次 workflow run 失败时的事务补偿；人工操作可以明确选择任一已核验 release。

回滚只改变 `/srv/cs-baoyan-ddl/current` 原子 symlink，不修改或覆盖 `releases/<sha>`。目标路径必须是 `/srv/cs-baoyan-ddl/releases/<40 位小写十六进制 SHA>` 下的真实目录，不能是 symlink。

## 1. 只读盘点

在腾讯云主机上使用专用无 sudo 部署用户查看当前版本和候选版本：

```bash
DEPLOY_ROOT=/srv/cs-baoyan-ddl
readlink -f "$DEPLOY_ROOT/current" || true
find "$DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -print | sort
```

人工从列表中选择一个明确 SHA，并逐项核验。不要使用 `head`、`ls -t` 或“上一个目录”自动决定：

```bash
TARGET_RELEASE_SHA=<人工选择的40位小写commit-sha>
TARGET="$DEPLOY_ROOT/releases/$TARGET_RELEASE_SHA"
test "${#TARGET_RELEASE_SHA}" -eq 40
case "$TARGET_RELEASE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
test -d "$TARGET" && test ! -L "$TARGET"
cat "$TARGET/release.json"
cat "$TARGET/.archive-sha256"
```

确认 `release.json.releaseSha` 等于所选 SHA，并记录其中的 `snapshotId`、`dataHash`。内部 `.archive-sha256` 必须是普通非 symlink 文件，且正文只能是一行 64 位小写十六进制 SHA-256；该 marker 绑定 release 与归档 checksum。目录只读权限用于防误改，不抵御已攻陷的 deploy 用户。缺失 marker、格式错误或身份不一致时停止，不要修补后强行切换。

## 2. 准备已审阅脚本

workflow staging 会在结束后删除，因此不要假设服务器永久保留回滚脚本。从当前仓库提交中把这两个文件复制到部署用户可写的唯一临时目录，并沿用部署手册中的严格 SSH 选项：

```text
deploy/smoke.sh
deploy/rollback-release.sh
```

例如临时目录可使用 `/srv/cs-baoyan-ddl/shared/manual-rollback-<operator-token>/`。完成后删除该临时目录。不要把部署用户加入 sudoers。

## 3. 执行明确目标回滚

在服务器上执行已审阅副本；`SMOKE_HOST_HEADER` 使用 bootstrap 时配置的实际 `SERVER_NAME`：

```bash
DEPLOY_ROOT=/srv/cs-baoyan-ddl \
TARGET_RELEASE_SHA=<人工选择的40位小写commit-sha> \
RUN_TOKEN=manual-<唯一操作编号> \
SMOKE_URL=http://127.0.0.1 \
SMOKE_HOST_HEADER=ddl.example.com \
bash /srv/cs-baoyan-ddl/shared/manual-rollback-<operator-token>/rollback-release.sh
```

脚本在服务器侧获取 `flock`，验证目标严格位于 `DEPLOY_ROOT/releases`，原子替换 `current`，并从目标自己的 `release.json` 读取三元身份执行本地 smoke。若新目标 smoke 失败，脚本恢复操作前的 current；有原 current 时还会再次对其执行本地 smoke。

`current` 与 transaction state 的临时项会先落盘并 fsync，再原子替换并 fsync 父目录；任何 fsync 错误都会停止。fsync 不替代主机断电后的 rollback/reconcile 对账，恢复供电后仍须核验 `current`、transaction、内部 checksum marker 和 smoke 结果。

如果所选 release 已经是 current，脚本不会猜另一个目标，只会重新核验该 release。

## 4. 外部确认

本地 smoke 成功后，再使用实际 `PUBLIC_BASE_URL` 从外部运行 `deploy/smoke.sh`，精确核对 release SHA、snapshot ID 和 data hash。命令格式见 `tencent-deploy.md`。HTTP 与 HTTPS 都受支持；只有真实域名和证书已确认后才能把 HTTPS 结果视为 TLS 验收。

记录：操作人、时间、原 release、明确选择的目标 release、`snapshotId`、`dataHash`、本地 smoke 和外部 smoke 结果。不要删除旧 release 或其内部 `.archive-sha256`；清理策略应作为独立、经确认的运维任务。

## workflow 自动补偿与人工回滚的区别

- activate 后本地 smoke 失败：同一脚本 trap 使用 run token 的 transaction；首发删除失败 current，后续恢复 transaction previous，并在有 previous 时再次本地 smoke。
- runner 仍可执行且主机可连接时：activation step 或 public smoke 失败会触发 workflow 的 transaction 补偿，只接受同一 `RUN_TOKEN` 和失败 SHA，不读取全局 previous；重复执行只做幂等对账和 smoke。
- runner 丢失或不可用、SSH 长时间中断：不要假设 workflow 已恢复 previous；读取持久 transaction，并用同一 `RUN_TOKEN` 和失败 SHA 显式运行 `rollback-release.sh` 完成 reconcile/对账。
- 主机断电：主机恢复后先检查 `current` 与 transaction，再执行同一显式 rollback/reconcile，不根据目录时间猜目标。
- 人工回滚：只接受操作者明确填写的 `TARGET_RELEASE_SHA`，绝不推断“上一版”。

任何补偿失败、current 指向 `releases/` 外、release 是 symlink、内部 checksum marker 冲突或目标 smoke 失败都应停止并保留证据，不要用手工 `ln -sfn` 绕过脚本校验。
