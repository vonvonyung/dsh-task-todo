# 在 DSH 桌面版安装 dsh-task-todo

这份文档只讲一件事：把本插件装进 **DSH 桌面版**（Electron）的 `desktop` profile，
让入口、四视图、浮窗、6 个工具与 `/todo` 全部可用，并知道数据落在哪里、怎么回滚。

> 背景：DSH 桌面版的客户端加载器只接受 `dsh.client.platform === "web"`
> （`@deepseek-ai/dsh-client-modules` 会直接忽略其它取值），所以本插件**保持
> `platform: "web"` 不变** —— 它本来就是给桌面版用的声明，不是限制。
> 唯一需要解除的是 peer 依赖范围：旧范围把桌面版在用的 `@deepseek-ai/dsh-tools`
> 现行线排除在外，安装时会得到「peer 不满足」的结果。详见「常见问题」。

## 前置

- 已安装 DSH 桌面版，且能正常启动（本机实测线：`@deepseek-ai/dsh` 0.2.0-rc.2）。
- 命令行里有 `dsh`（用来查版本、跑门禁；**注意它管不了 desktop profile**，见「安装」）。
- Node ≥ 22（只影响开发与门禁；跑插件本身由宿主运行时决定）。

确认 profile 与数据目录（PowerShell）：

```powershell
echo $env:DSH_HOME            # 例：C:\Users\<你>\.dsh
echo $env:DSH_PROFILE_DIR     # 例：C:\Users\<你>\.dsh\profiles\desktop
```

## 安装

**命令行装不了桌面 profile —— 这是宿主的设计，不是缺步骤。**

```console
$ dsh plugin --profile desktop add "github:vonvonyung/dsh-task-todo"
error: profile "desktop" is managed exclusively by the Electron application
```

启动器对 `desktop` 这个 profile 名无条件拒绝（`@deepseek-ai/dsh/lib/bin.js` 里的
`rejectElectronProfile`：没有开关、没有环境变量）。桌面 profile 的依赖只能由
**应用自身的插件管理器**改；`dsh plugin --profile web …` 不受影响。

### 在应用内安装

1. 打开桌面版 → **设置 → 插件**（市场 / 插件管理器）。
2. 添加插件，来源填其一：
   - `github:vonvonyung/dsh-task-todo`（桌面 profile 里已有三个 `github:` 依赖，这种规范它认）；
   - 本地目录的绝对路径（开发形态）；
   - 本地产出的 `dsh-task-todo-<版本>.tgz`（`npm pack` 的结果，profile 里也有 `file:` 先例）。
3. 装完**完全退出并重启桌面版**：bundle 层只在启动时读取。桌面版用自己的窗口加载
   客户端 bundle，不需要像浏览器那样 `Ctrl+F5`。

安装完成后 `<DSH_PROFILE_DIR>\package.json` 里应有两处变化，这也是「到底装上了没」的判据
（重启前就能查）：

- `dependencies` 增加一条，如 `"dsh-task-todo": "github:vonvonyung/dsh-task-todo"`；
- `dsh.profile.bundles` 数组增加一项 `"dsh-task-todo"`。

## 验证

按「宿主层 → 界面层」两段验证，任一段不通都能定位。

### 1. 宿主侧：工具与斜杠命令

重启桌面版后，新开一个会话：

| 要验证的 | 怎么做 | 期望 |
| --- | --- | --- |
| 工具注册 | 让 agent 调 `task_list` | 返回任务列表 + 计数 + 清单 |
| 斜杠命令 | 输入 `/todo help` | 打印语法速查 |
| 写入 | 输入 `/todo add 明天 15:00 交周报` | 新建任务并回显 |

### 2. 界面侧：入口 / 四视图 / 浮窗

- **入口**：左侧栏「新建会话」与「工作区」之间出现「待办任务」，图标右上角有未完成徽标。
- **四视图**：面板左侧「视图」分组切 列表 / 看板 / 日历 / 甘特图，各切一次确认有内容。
- **浮窗**：面板头部点「⇱ 浮动」出现可拖拽、右下角可拉伸的小窗口；再点「⇤ 停靠」收回。
- **同一份数据**：桌面版里 `/todo add` 的任务，应立刻出现在面板与浮窗里。

## 数据文件

任务数据默认写在：

```
<DSH_HOME>/todo/tasks.json
```

`DSH_HOME` 默认 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`）。**web 与 desktop 两套 profile
共用同一个 `DSH_HOME`**，因此两种形态读到、写到的是**同一份数据**：桌面版加的任务，
`dsh web` 里也在。不需要迁移，也不按 profile 分库。

- 想换路径：设置 → 待办任务 → 「数据文件」。
- 备份 / 恢复 / 复制路径：面板左侧栏「数据」分组有三个按钮。
- **卸载不会删除这个文件** —— 任务数据独立于安装。

> 注意：这是本插件（`dsh-task-todo`）的数据。另一个插件 `dsh-todos` 用的
> `~/.dsh/dsh-todos/todos.json` 是**另一份**数据，两者互不影响。

## 插件设置

插件自己有一页设置：**设置 → 待办任务**（与「插件市场」「AI 任务台」并列；桌面版和
`dsh web` 都一样）。里面是插件开关、数据文件、日历周起始、徽标口径、全局快捷键，以及
**飞书同步**整组（App ID / App Secret / app_token / table_id / 自动同步…）。

它的值写在 **`<DSH_HOME>/todo/settings.json`**，和 `tasks.json` 分开，所以卸载、回滚、
删任务文件都不会动它；改完立即生效，不需要重启。

> 为什么不是 DSH 的「内置插件」页？那一页只挂**插件自己注册的标签页**，而这一版 DSH 的
> `settings` 服务（`SettingsForms`）没有 `register(scope, schema)` 这种接口，插件的 schema
> 不会被自动渲染。所以本插件自带设置页 —— 这也是「插件市场 / AI 任务台 / 风格图库」同一
> 条路子。

## 回滚

在**应用内的插件管理器**里移除 `dsh-task-todo`（同样不能用 `dsh plugin --profile desktop remove`，
理由见「安装」），然后**重启桌面版**。入口与工具随之消失；`<DSH_HOME>/todo/tasks.json`
保持原样，重新装回即可继续使用（回滚到旧版本：先移除，再装指定版本或本地目录）。

命令行兜底（不推荐，且可能被应用下次启动纠正）：在 `<DSH_PROFILE_DIR>\package.json` 里
删掉那条依赖与 `dsh.profile.bundles` 里那一项，再在 `<DSH_PROFILE_DIR>` 里跑一次
`pnpm install`。

只想临时停用、不想卸载：设置 → 待办任务 → 关掉「启用插件」。

## 常见问题

**Q：装完提示 peer `@deepseek-ai/dsh-tools` 不满足？**
A：这是本插件要解除的依赖限制的历史症状。当前 `package.json` 的 peer 范围是
`^0.2.0-rc.2`（= `>=0.2.0-rc.2 <0.3.0-0`），覆盖在用的 `0.2.0-rc.2` 及其后的 0.2.x。
如果你装的是更旧的包，请更新到包含该范围的版本。

> 为什么不是更宽的 `>=0.1.0-rc.1 <0.3.0-0`？因为 semver 规定：**带 prerelease 的版本，
> 只有当比较器集合里存在同一个 `major.minor.patch` 元组上的 prerelease 比较器时才算满足**。
> 上面那个更宽的范围里，唯一带 prerelease 的下界是 `0.1.0-rc.1`，元组是 0.1.0，套不到
> `0.2.0-rc.2` 上，npm 会判为 invalid。`^0.2.0-rc.2` 的下界与在用版本同元组，才是正确的写法。

**Q：`dsh plugin --profile desktop add …` 报 “managed exclusively by the Electron application”？**
A：设计如此。启动器对 `desktop` 这个 profile 名无条件拒绝（`@deepseek-ai/dsh/lib/bin.js` 里的
`rejectElectronProfile`），桌面 profile 的依赖只能由 Electron 应用自己的插件管理器改 ——
所以本文档的安装与回滚都走应用内界面。`dsh plugin --profile web …` 不受影响。

**Q：桌面版为什么不认 `platform: "web"` 之外的写法？**
A：桌面版与 `dsh web` 共用同一个客户端模块加载器，它只加载声明 `platform: "web"` 的
client 模块。所以「桌面可用」不是把 platform 改掉，而是保持 `"web"` 并放宽 peer。

**Q：`Ctrl+F5` 需要吗？**
A：桌面版不需要。浏览器（`dsh web`）会因为客户端 bundle 按包路径缓存而需要强刷。

**Q：安装时 npm 报 engine / node 版本？**
A：`engines.node >= 22` 约束的是开发与门禁所用的 Node；插件运行时跟随宿主。
把本机 Node 升到 22+ 即可（本仓库在 Node v24 上通过全部门禁）。
