# CS 保研 DDL · 及时版

这是基于 [CS-BAOYAN-DDL](https://github.com/CS-BAOYAN/CS-BAOYAN-DDL) 的及时更新版本，保留原项目的列表、截止日历、筛选、搜索和倒计时体验，并补充经过官方来源核验的活动形式、活动时间、地点与申请材料信息。

本版本将保研通知网、CS-BAOYAN 和 BoardCaster 作为发现源，并回到院校官网、官方报名系统、官方公众号或官方附件核验后再发布。页面不保证覆盖所有院校，临近截止时请再次打开官方通知确认。

公开页面只读取版本化批准快照。扫描候选、个人投递状态、待核实条目和本地证据不会提交到公开仓库。

## 技术栈

- **Svelte 5**（runes 模式）+ **Vite 6** + **Tailwind CSS v4**
- TypeScript
- 全部数据于构建时打包进 bundle，运行时无 API 调用
- 单一 1Hz 时钟驱动全部倒计时（不再 1 秒重 fetch JSON）

## 主要功能

- 按批准快照动态展示当前周期与历史归档数据源
- 学校档次（TOP2 / 港三 / 华五 / C9 / 985 / 211 / 双非 / 四非 / 研究院 / 联培）OR 筛选
- 状态（开放 / 已结束）和活动形式（线上 / 线下 / 混合 / 未核验）筛选
- 按院校所在地筛选；院校所在地不会冒充活动举办地点
- 即时搜索（学校 + 学院 + 项目 + 活动类型）
- 实时倒计时（紧迫度色阶：红 / 琥珀 / 青 / 翠）
- **列表 / 截止日历** 双视图；密集日期可展开完整项目列表
- 详情侧滑面板展示官方通知、活动安排、食宿交通、推荐信与材料要求
- URL 状态同步（筛选条件可分享、刷新不丢失）
- 键盘快捷键：`/` 聚焦搜索 · `j/k` 上下移动 · `Enter` 详情 · `Esc` 关闭 · `?` 帮助
- 深色 / 浅色主题切换 · 移动端筛选抽屉

## 本地开发

```bash
pnpm install   # 或 npm i / bun i
pnpm run dev   # http://localhost:5180
pnpm run build # → dist/
pnpm run preview
```

`predev` / `prebuild` 钩子会从 `scripts/source/universities.json` 抽取 logo 映射，写入 `src/data/logos.json`，避免完整的学校排名数据进入 bundle。

生产发布仅通过受保护的 GitHub Actions 工作流进行，并且必须在快照验证、隐私检查、构建和 E2E 全部通过后执行。

## 数据贡献

欢迎在本仓库提交 Issue，并附上院校官网、官方报名系统、官方公众号或官方附件等官方来源。BoardCaster 等聚合源和 Issue 仅作为发现线索；条目通过官方核验后才会发布。

## 上游与许可

界面基于 MIT 许可的 [CS-BAOYAN/CS-BAOYAN-DDL](https://github.com/CS-BAOYAN/CS-BAOYAN-DDL)。原版权声明和许可证保留在 [LICENSE](LICENSE)。
