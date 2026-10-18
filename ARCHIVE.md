# 归档说明 · 2026-10-18

本次将项目整理为可展示、可复用、可继续开发的公开归档。GitHub 仓库保持可 Fork、可提 Issue、可提交 PR；不启用 GitHub 的只读 archived 标志。

## 完成范围

| 部分 | 归档结果 |
| --- | --- |
| 网站 | 完整 Svelte 前端、历史数据源、视觉与交互设计说明、真实页面截图 |
| 自动化 | 当前 v3 追加批准器、官方证据契约、代理交接说明、CI 与发布/回滚工具 |
| 复用 | 固定 pnpm 版本、锁文件、启动与部署指南、可配置父快照 URL |
| 主线 | 以 2026-09-19 最后批准的 main 为基底，整合配置与文档；旧代码逐项对照去重 |
| 历史 | 原分支仍保留，额外 legacy 记录独立留档，不覆盖批准数据 |
| 调度 | 去掉监控 cron 与自动部署触发；CI 保留，部署/监控仅手动；原本机两个扫描任务保持暂停 |

整个项目包含“静态网站 + 离线数据管线 + 可选生产部署”，没有独立 API 后端，也没有随仓库交付的自动浏览/OCR/采集服务。恢复运营需自行接入可信执行器。

## 冻结的数据身份

本次归档没有重新扫描招生通知，也没有改写任何批准记录。

```text
approvedAt: 2026-09-19T15:15:29.338Z
snapshotId: 2026-09-19T15:15:29.338Z-1beb78bdaea0
dataHash:   1beb78bdaea0b44966281f786851e3e872ed1890f1868a74df3c5a15fb3c7228
records:    847
```

批准时间和记录数是历史属性。页面依据实际截止时间派生当前状态，因此今天看到的开放数量可以与当年的保存计数不同。

## 分支整合取舍

对照归档前的 main 与本地历史/恢复分支后，没有发现缺失的另一套 UI、部署或扫描批准功能。旧的官方来源/日期解析修复已经进入主线，且主线包含更多兼容性与测试；再合并旧文件反而会丢失这些改进。

因此主线整合采用**已有功能去重、补入安全配置、保留独立历史资料**的方式。没有将每个过时快照逐一覆盖到当前数据，也没有把私有运行记录带进主线。

| 保留的公开恢复分支 | 内容及本次处理 |
| --- | --- |
| [history-college-snapshot](https://github.com/lvzaixian/CS-BAOYAN-DDL/tree/archive/recovery-20261018/history-college-snapshot) | 相同最终代码已在 main；额外 30 条 legacy 记录留作下述历史附录 |
| [stash-20260809](https://github.com/lvzaixian/CS-BAOYAN-DDL/tree/archive/recovery-20261018/stash-20260809) | 早期工作约定、部署/更新文档和数据草稿；保留原状态，使用当前版本说明 |
| [root-build-config](https://github.com/lvzaixian/CS-BAOYAN-DDL/tree/archive/recovery-20261018/root-build-config) | 提取 pnpm 安全构建配置；旧控制台状态不作为主线 |
| [national-active-sweep-20260831-081503](https://github.com/lvzaixian/CS-BAOYAN-DDL/tree/archive/recovery-20261018/national-active-sweep-20260831-081503) | 旧数据草稿；其 projectId 与最终批准模型存在差异，不重新认定为新增 |
| [national-sweep-20260827-193529](https://github.com/lvzaixian/CS-BAOYAN-DDL/tree/archive/recovery-20261018/national-sweep-20260827-193529) | 来源格式修复已由主线覆盖，旧数据保留在原分支 |
| [national-sweep-final-20260827-1247](https://github.com/lvzaixian/CS-BAOYAN-DDL/tree/archive/recovery-20261018/national-sweep-final-20260827-1247) | 旧数据草稿，不覆盖较新的最终批准快照 |

额外 30 条记录保存于 [`docs/archive/legacy-camp2026-additions.json`](docs/archive/legacy-camp2026-additions.json)。它们来自公开历史分支的 legacy 差异，部分与当前数据重叠，未重新核验；仅作历史附录，不被网站 import，也不是可直接批准的 additions。

原始抓取、个人信息、私有运行状态及主机凭据不属于公开归档。完整的本地历史恢复包另行保存，未作为网页资料上传。

## 项目整理方案

1. **统一入口**：README 展示实际页面、两部分能力与启动方式；docs/README 提供文档索引。
2. **交付可复用结构**：保留现有源码布局，补网站设计、自动化、复用三份指南，避免为了归档重写运行架构。
3. **核对并整合历史**：对照分支代码与测试，保留历史分支索引，独立保存额外旧数据；批准快照保持原字节。
4. **停止持续运营**：保留 CI 与人工入口，删除周期触发和 main 合入后的自动部署，不改现有线上服务或凭据。
5. **验证并冻结**：运行单元、快照、类型、构建、公开边界与隔离浏览器检查；通过受保护 main 的必需 CI 后合入，创建 `archive-2026-10-18` 标签。

## 从归档继续

- 只复用网站：按[快速复用](docs/reuse.md)启动和静态托管，无需生产 Secret。
- 接入更新：按[自动化工作流](docs/automation.md)实现采集器，使用自己的父快照 URL，并保留数据与隐私约束。
- 需要部署：配置自己的 Environment 与服务器后，从 main 手动触发工作流；归档标签不会自动部署。
- 需要比较旧版本：从上表分支读取历史文件；不要对 current.json 做无差别回滚。

MIT 代码许可与原上游署名持续保留。本归档不承诺实时招生信息、完整全国覆盖或未来生产服务可用性。
