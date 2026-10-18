# 项目文档

本项目归档为两个可独立复用的部分：**招生信息网站**与**基于官方证据的追加更新工作流**。

| 想做什么 | 从这里开始 |
| --- | --- |
| 了解项目、查看效果、快速运行 | [项目 README](../README.md) |
| 理解界面、组件、状态与视觉规范 | [网站设计](website-design.md) |
| 接入自己的采集代理或定时器 | [自动化工作流](automation.md) |
| Fork、开发、测试、部署到自己的环境 | [复用指南](reuse.md) |
| 了解归档范围、分支处理和冻结数据 | [归档说明](../ARCHIVE.md) |

## 深入实现

- [追加更新输入与证据契约](operations/data-refresh.md)：v3 run、覆盖、字段证据、失败处理。
- [腾讯云 / Nginx 部署](operations/tencent-deploy.md)：独立部署账户、Environment、发布包与原子激活。包含原部署环境的高级维护记录；首次复用先看复用指南。
- [公开站点监控](operations/public-monitoring.md)：只读 HTTPS、TLS 与发布身份校验，归档后仅手动触发。
- [回滚与对账](operations/rollback.md)：发布失败、runner 中断后的恢复。
- [历史方案与设计](superpowers/)：保留当时的实现背景；当前行为以源码、测试和上面四份入口文档为准。

## 代码入口

| 路径 | 职责 |
| --- | --- |
| `src/` | 静态前端、组件、筛选与截止时间派生 |
| `data/approved/current.json` | 当前冻结的批准快照 |
| `src/data/legacy-schools.json` | 历史数据源 |
| `scripts/source/` | 院校注册表与重点哨兵配置 |
| `scripts/snapshot/` | 追加批准、校验、历史迁移工具 |
| `deploy/` | Nginx 模板、激活、回滚与公网 smoke |
| `.github/workflows/` | CI，以及手动部署、监控 |
| `tests/`、`e2e/` | 数据契约、部署边界和浏览器回归 |
