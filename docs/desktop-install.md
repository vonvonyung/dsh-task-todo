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
- 命令行里有 `dsh`（桌面版与 `dsh` CLI 共用 `%APPDATA%\npm` 或等价前缀下的同一份安装）。
- Node ≥ 22（只影响开发与门禁；跑插件本身由宿主运行时决定）。

确认 profile 与数据目录（PowerShell）：

```powershell
echo $env:DSH_HOME            # 例：C:\Users\<你>\.dsh
echo $env:DSH_PROFILE_DIR     # 例：C:\Users\<你>\.dsh\profiles\desktop
```

## 安装

### 方式 A：从 GitHub 安装（推荐）

桌面 profile 已支持 `github:` 依赖规范：

```sh
dsh plugin --profile desktop add "github:vonvonyung/dsh-task-todo"
```

### 方式 B：从本地目录安装（开发形态）

```sh
dsh plugin --profile desktop add "<插件目录的绝对路径>"
```

### 生效

`dsh plugin add` 只更新 profile 的依赖与 bundle 列表；**bundle 层只在启动时读取**，
所以装完后必须**完全退出并重启桌面版**。桌面版用自己的窗口加载客户端 bundle，
不需要像浏览器那样 `Ctrl+F5`。

安装会往 `<DSH_PROFILE_DIR>\package.json` 写入：

- `dependencies` 里一条 `"dsh-task-todo": "github:vonvonyung/dsh-task-todo"`（方式 B 则是路径）；
- `dsh.profile.bundles` 数组里一项 `"dsh-task-todo"`。

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

- 想换路径：设置 → 插件 → 待办任务 → 「数据文件」。
- 备份 / 恢复 / 复制路径：面板左侧栏「数据」分组有三个按钮。
- **卸载不会删除这个文件** —— 任务数据独立于安装。

> 注意：这是本插件（`dsh-task-todo`）的数据。另一个插件 `dsh-todos` 用的
> `~/.dsh/dsh-todos/todos.json` 是**另一份**数据，两者互不影响。

## 回滚

```sh
dsh plugin --profile desktop remove dsh-task-todo
```

然后**重启桌面版**。入口与工具随之消失；`<DSH_HOME>/todo/tasks.json` 保持原样，
重新装回即可继续使用（也方便回滚到旧版本：先 `remove`，再 `add` 指定版本或本地目录）。

只想临时停用、不想卸载：设置 → 插件 → 待办任务 → 关掉「启用」。

## 常见问题

**Q：装完提示 peer `@deepseek-ai/dsh-tools` 不满足？**
A：这是本插件要解除的依赖限制的历史症状。当前 `package.json` 的 peer 范围是
`^0.2.0-rc.2`（= `>=0.2.0-rc.2 <0.3.0-0`），覆盖在用的 `0.2.0-rc.2` 及其后的 0.2.x。
如果你装的是更旧的包，请更新到包含该范围的版本。

> 为什么不是更宽的 `>=0.1.0-rc.1 <0.3.0-0`？因为 semver 规定：**带 prerelease 的版本，
> 只有当比较器集合里存在同一个 `major.minor.patch` 元组上的 prerelease 比较器时才算满足**。
> 上面那个更宽的范围里，唯一带 prerelease 的下界是 `0.1.0-rc.1`，元组是 0.1.0，套不到
> `0.2.0-rc.2` 上，npm 会判为 invalid。`^0.2.0-rc.2` 的下界与在用版本同元组，才是正确的写法。

**Q：桌面版为什么不认 `platform: "web"` 之外的写法？**
A：桌面版与 `dsh web` 共用同一个客户端模块加载器，它只加载声明 `platform: "web"` 的
client 模块。所以「桌面可用」不是把 platform 改掉，而是保持 `"web"` 并放宽 peer。

**Q：`Ctrl+F5` 需要吗？**
A：桌面版不需要。浏览器（`dsh web`）会因为客户端 bundle 按包路径缓存而需要强刷。

**Q：安装时 npm 报 engine / node 版本？**
A：`engines.node >= 22` 约束的是开发与门禁所用的 Node；插件运行时跟随宿主。
把本机 Node 升到 22+ 即可（本仓库在 Node v24 上通过全部门禁）。
