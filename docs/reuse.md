# Fork 与复用指南

你可以只运行网站，也可以复用“官方证据 → 批准快照 → CI → 静态发布”的流程。仓库已按项目归档保存，停止定时更新；仍可 Fork 和提 Issue。维护者不承诺继续更新历史招生数据。

| 目标 | 需要什么 | 从哪里开始 |
| --- | --- | --- |
| 本地浏览或修改网站 | Node.js、pnpm | 下方快速启动；不需要 Secret、服务器或扫描器 |
| 发布自己的静态站 | 上述工具与静态托管空间 | 构建 `dist/`，配置自己的域名与资源路径 |
| 维护自己的招生数据 | 官方来源、私有扫描运行记录、批准工具 | [自动化工作流](automation.md)；扫描执行器需要自行接入 |
| 复用原生产发布方案 | 自己的服务器、GitHub Environments 与 Secrets | [腾讯云部署说明](operations/tencent-deploy.md)与[回滚说明](operations/rollback.md) |

## 1. 快速启动

CI 使用 **Node.js 20** 与 **pnpm 10.28.2**。优先按这一组合复现；`package.json` 固定包管理器版本，`pnpm-lock.yaml` 固定依赖解析结果。请先安装 Node.js，并确保 Corepack 可用。

先在 GitHub Fork 本仓库，再克隆自己的副本：

```bash
git clone https://github.com/YOUR_ACCOUNT/CS-BAOYAN-DDL.git
cd CS-BAOYAN-DDL
corepack enable
corepack prepare pnpm@10.28.2 --activate
pnpm install --frozen-lockfile
pnpm run dev
```

开发服务默认使用 `http://localhost:5180`，端口被占用时 Vite 会另选端口，请以终端输出为准。首次运行会自动生成被 Git 忽略的 `src/data/logos.json`，无需手工建立。

```bash
pnpm run build       # 生产静态文件写入 dist/
pnpm run preview     # 默认 http://localhost:4173
```

开发、构建和预览不需要 `.env`、云端凭据或外部扫描服务。页面数据在构建时打包，更新数据后需要重新构建。外部字体与学校图片可能发起网络请求；无法加载时页面有字体和简称回退。生产发布工具额外使用 Bash、Python 3 与 curl，按对应操作文档准备。

## 2. 先选择复用范围

### 只复用网站

保留当前批准快照即可运行；把它作为历史示例展示时，应保留归档标记和数据时效说明。页面结构、颜色、组件和扩展入口见 [网站设计与实现](website-design.md)。

替换品牌时，核对 `index.html` 的标题、描述、favicon，以及 `Header.svelte` 的站名和仓库链接；学校图片映射在 `scripts/build-logos.ts` 与 `src/lib/logos.ts`。不要把“院校所在地”改名成“活动地点”，这两个字段的含义不同。

### 继续维护数据

批准快照在 `data/approved/current.json`，历史数据在 `src/data/legacy-schools.json`。公开快照有 schema、`snapshotId` 和 `dataHash` 等完整性约束，不能只改项目数组而保留原来的身份字段。

日常追加应接入 [`snapshot:approve-additive`](../scripts/snapshot/approve-additive-snapshot.ts)，遵循“当前公开父本 + 经官方核验的新增项”。仓库提供契约、注册表、批准、验证和发布工具；**不附带可以直接启动的全国招生网站扫描器，也不附带原作者的外部智能体配置、私有证据和凭据**。使用自己的采集器或人工整理工具生成符合契约的私有运行记录，再调用批准器。完整说明见 [自动化工作流](automation.md)。

Fork 后开始自己的维护周期前，要明确自己的公开父本来源。批准器默认仍使用原项目的公开快照地址；维护自己的站点时，显式传入 `--parent-url https://example.org/data/current.json`，并让私有运行文件的 `parent.url` 与它完全一致。先从该端点下载本轮父快照并冻结原始字节哈希，再生成新增候选。程序调用对应 `expectedParentUrl` 选项。这个设置选择的是批准器核验的父本地址；GitHub 变量 `PUBLIC_BASE_URL` 只配置部署与监控目标，不能替代它。

需要更换数据领域、重建初始快照、纠正或删除历史条目时，先建立独立维护迁移并验证，不要把历史 `snapshot:approve` 或 `scan:build-release` 链路当作日常追加入口。

私有运行目录应放在仓库外或明确忽略的目录。只提交代码、文档和批准后的公开数据；原始证据、个人申请信息、主机地址、私钥和 Secret 值不得提交。校验器能发现部分违规内容，不能替代提交前检查。

## 3. 静态部署

对纯网站展示，执行 `pnpm run build` 后，把 `dist/` 发布到支持静态文件的托管服务即可；没有额外后端进程。默认配置面向域名根路径，例如 `https://example.org/`。

部署到 GitHub Pages 的仓库子路径（例如 `https://YOUR_ACCOUNT.github.io/CS-BAOYAN-DDL/`）需要另行配置：

1. 在 `vite.config.ts` 设置对应 `base`。
2. 检查 `index.html` 的 favicon、`src/lib/logos.ts` 中的 `/university_logos/` 等根相对资源，并按部署基路径调整。
3. 实际预览该子路径，核对资源、列表、详情、筛选 URL 与刷新行为。

本仓库未预先实现通用子路径发布。原 `deploy/` 与监控脚本以根 origin 为契约，不能仅修改 `base` 就假定整套生产发布工具也支持子路径。

普通 `pnpm run build` 产生可运行网站。原生产工作流还负责复制公开快照、生成 release identity、打包、原子激活和公网 smoke；如需 `/data/current.json`、`/data/release.json` 等运维端点，请复用该流程或在自己的发布系统中实现相同契约。

## 4. 本地验证与 CI

在提交代码或数据前运行与 CI 对应的检查：

```bash
pnpm run snapshot:validate
pnpm run check:public
pnpm run test:unit
pnpm run check
pnpm run build
git diff --check
```

需要验证界面时，先安装浏览器，再运行 E2E：

```bash
pnpm exec playwright install chromium
pnpm run test:e2e
```

Linux CI 使用 `pnpm exec playwright install --with-deps chromium` 安装浏览器与系统依赖。E2E 会构建独立的 `dist-e2e/`，使用固定测试快照、时钟场景和 `Asia/Shanghai` 时区；生产 `dist/` 仍使用真实批准数据，并由隔离检查验证。测试启动默认占用 `4173`，已运行的预览应先停止，或使用 `E2E_PORT=4183 pnpm run test:e2e` 指定空闲端口。

浏览器报告位于 `playwright-report/`，失败截图和 trace 位于 `test-results/`；这些都是本地生成物，不需要提交。自动化检查覆盖主要交互与溢出风险，正式对外使用前仍应在目标设备上检查。

## 5. GitHub 与原生产方案

归档版保留 PR / `main` 的 CI 和手动操作入口，停止周期扫描与周期监控；**合并代码不自动部署到原站点**。在自己的 Fork 中，先保持这一状态，按需接入自己的环境，再显式执行发布。

如果采用原生产方案，先阅读操作文档，再配置自己的 GitHub Environments、分支限制与凭据。`PUBLIC_BASE_URL` 必须指向自己的公开根 origin；公共监控要求 HTTPS。Secrets 的名称可以复用，但值必须由自己提供，不能引用原作者服务器或账号。原部署流程保留不可变发布身份、SSH 主机密钥校验、发布前复核、原子切换与失败回滚。

定时采集原本由外部调度器发起，不会因为 Fork 仓库就自动获得。若以后启用自己的更新服务，需要同时配置采集执行器、调度、官方证据处理、批准与发布，而不是只添加一个 cron。恢复更新前也应修改归档声明，让使用者知道哪些数据在继续维护。

高级步骤和历史运行设计集中在：

- [自动化工作流](automation.md)：当前推荐的数据与发布边界。
- [数据刷新操作](operations/data-refresh.md)：追加批准契约与日常操作细节。
- [腾讯云部署](operations/tencent-deploy.md)：原服务器方案的配置和故障处理。
- [回滚](operations/rollback.md)：已有发布的对账与恢复。
- [公网监控](operations/public-monitoring.md)：独立的可用性和公开身份检查。
- [`docs/superpowers/`](superpowers/)：历史设计与实施计划，阅读时以当前归档状态和源码为准。

## 6. 许可与署名

代码按 [MIT License](../LICENSE) 提供，保留原作者 **Axi404** 的版权声明；界面来源为 [CS-BAOYAN/CS-BAOYAN-DDL](https://github.com/CS-BAOYAN/CS-BAOYAN-DDL)。复制、修改或分发代码时，请一并保留许可证与上游署名。

院校通知、校徽与外部字体等材料有各自的来源与权利边界，MIT 代码许可不等于这些第三方材料的统一再许可。招生安排应以院校官方最新通知为准。
