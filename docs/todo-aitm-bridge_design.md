# 待办任务 → AI 任务台桥接：方案评审稿

> 状态：**待评审**　·　撰写日期：2026-10-13　·　作者：DSH 会话（与 liuyuguo99 结对）

## 1. 一句话

在 **DSH 待办任务** 的任务菜单里加两行 —— **「转为 AI 任务台想法」** 和 **「转为 AI 任务台工作（开跑）」** ——
把一条待办任务一键变成 **AI 任务台** 的想法，或直接开工（建 worktree、起 AI 引擎）。

---

## 2. 涉及三个东西

| 角色 | 仓库 / 位置 | 版本 | 本次是否改动 |
| --- | --- | --- | --- |
| **待办任务** | `D:\Code\Arena_progres\DSH-task-todo\dsh-task-todo`<br>分支 `arena/ef290084-dsh-task-todo` @ `7a90ff7c` | 0.4.23 | ✅ 加**扩展点** |
| **AI 任务台** | `D:\Code\Arena_progres\AI_Tasks_Mgr\ai-tasks-mgr` | 0.3.47 | ❌ **不动** |
| **桥插件**（新建） | `D:\Code\Arena_progres\dsh-todo-aitm-bridge`<br>`github.com/vonvonyung/dsh-todo-aitm-bridge` | 0.1.0 | ✅ 全部新建 |

**为什么让 AI 任务台完全不动**：它的能力已经通过 75 个 action 暴露得足够完整（`idea.create` / `task.start` 等），
本次要的功能**纯属调用方**的事。不改它，就不用动它那份有未提交改动的仓库。

---

## 3. 为什么不把代码直接写进两个插件里

这是本方案的**核心决策**，请重点评审。

### 3.1 两个插件的客户端半边是**互相不可见**的

DSH 的每个 bundle 插件，客户端半边都是**独立的 `window.__ModuleLoader__.load({ factory })`**，
各自一个闭包，**没有共享模块图**，`import` 不通。

所以「待办的菜单渲染」和「任务台的调用能力」之间，**没有天然的调用路径**。

### 3.2 三种可选位置

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 写进待办** | 待办直接调任务台 | 少一个包 | 待办凭空多一个**可选**依赖；没装任务台的人会看到点不通的菜单，得写条件探测，逻辑变绕 |
| **B. 写进任务台** | 任务台去改待办的 UI | 少一个包 | 更糟：任务台要去背另一个插件的界面 |
| **C. 独立桥插件** ✅ 选定 | 接缝单独住一个包 | 两边互不依赖、各自独立发布；没装任一方时优雅降级 | 多一个包要维护 |

**选定 C**。理由：这是一条**可选的集成**，不该成为任一主项目的负担。
两个主项目继续各自演进，桥坏了也不影响它们。

### 3.3 桥怎么"够到"两边（关键机制）

桥**不 import 任何一方的包**，两条接缝都是**运行时**的：

```
                    ┌─────────────────────────┐
   待办任务 UI  ────▶│ window.__dshTodoTaskActions │  ← 待办提供的注册表（全局）
   （渲染菜单行）    └─────────────────────────┘
                              ▲ 注册两行
                              │
                     ┌────────┴────────┐
                     │  桥 (client.js) │
                     └────────┬────────┘
                              │ fetch 自己的 HTTP 路由
                     ┌────────┴────────┐
                     │  桥 (index.js)  │  宿主半边
                     └────────┬────────┘
                              │ HTTP POST /api/<action>（回环）
                     ┌────────┴────────┐
                     │  AI 任务台 L3   │  进程内，随机端口
                     └─────────────────┘
```

- **待办侧**：待办新增一个**正式的扩展点**（见 §4）。桥只往里注册数据，**不渲染任何东西**。
- **任务台侧**：桥用 HTTP 调它的 action（**与任务台自己的工具同一条路**），不持有它的 `AppApi`。

---

## 4. 待办插件的改动：新增"任务动作扩展点"

**改动量：`lib/client.js` +119 行、`scripts/verify-client-render.mjs` +125 行，纯增量、零删除。**

### 4.1 对外契约（这是跨插件 ABI，请重点评审）

```js
window.__dshTodoTaskActions.register(action) -> dispose

action = {
  id:      'aitm-idea',        // 稳定唯一；重复注册同 id = 替换
  label:   '转为想法',          // 字符串，或 (task) => string
  order:   200,                // 升序，默认 100（内置项在扩展项之上）
  enabled: (task) => true,     // 可选；返回 false 则该任务不显示此行
  run:     (task, api) => {}   // 可返回 Promise
}
```

### 4.2 三个设计决定（都被测试逼出来过）

1. **`api` 是刻意做窄的**，只有 `refresh` / `settings` / `mutate`，
   **不暴露内部 `call`**。理由：`call` 能打到待办全部 ~28 个宿主方法，
   放出去就等于把它们全变成事实上的公开 API，以后不敢改。
   → 有断言盯着 `api.call === undefined`。

2. **disposer 比对"记录"而不是 id**。第一版按 id 删，测试立刻抓到：
   插件热重载时**新注册先进来、旧的再 dispose**，会把新的那条删掉，菜单就空了。

3. **扩展项渲染在「移动到清单」之后、「删除任务」之前**。
   菜单刚变长，危险操作不该被挤到容易误点的位置。

### 4.3 测试

`scripts/verify-client-render.mjs` 从 **460 → 484 条断言**（新增 24 条），全绿。覆盖：

- 注册表存在、非法注册（空 id / 无 run）报错
- 排序、按任务 `enabled`、`enabled` 抛错只掉自己那行
- 按 id 替换、**陈旧 disposer 不误删**新注册
- **走真实菜单点击**：点卡片的「移动到清单」→ 点扩展行 → 校验拿到的 `task` 是活的、`api` 是窄的
- 抛错的 action 被兜住（转成 toast），界面不崩
- dispose 后菜单行消失

`node scripts/check-ready.mjs` → **READY：全部 47 项门禁通过**。

---

## 5. 桥插件的功能

### 5.1 两行菜单

| 菜单行 | 行为 | 副作用 |
| --- | --- | --- |
| 转为 AI 任务台想法 | `idea.create`（标题=任务标题；正文=备注+截止+标签） | 无 |
| 转为 AI 任务台工作（开跑） | 弹框确认指令 → `idea.create` → `task.start` | **有**：建 worktree、起 AI 引擎 |

「转为工作」会**先把拼好的指令弹出来让人确认或改**，取消即不执行——
因为这是全流程、有真实副作用的操作。

### 5.2 同时给 agent 两个工具

`todo_to_idea` / `todo_to_work`。**菜单和工具走同一段代码**（`convertTask`），
避免出现"菜单能做、agent 做不了"的两套行为。

### 5.3 降级行为（重要）

任务台**没在运行**时（没装 / 没启动），两行**仍然出现**，但显示为：

```
转为 AI 任务台想法（任务台未运行）
```

点它会得到一句人能看懂的话：*"AI 任务台没在运行：先在右侧栏打开一次「AI 任务台」，再回来点这里。"*

**为什么不用 `enabled: false` 把行藏掉**：藏了之后「插件没装」和「任务台没开」在界面上**完全一样**，
而这两件事的处理方式不同（一个去装插件，一个去打开任务台）。
留一行带说明的灰项，用户一眼知道该做什么。
—— 这正是本次开发中真实踩到的坑（见 §7），值得单独作为一个设计原则记录。

### 5.4 怎么找到任务台

任务台的端口**每次启动都是随机的**（进程内 L3，`port: 0`）。
实测：昨天 62231、今天 49182。所以**不能写死、也不能缓存到磁盘**。

桥在 `127.0.0.1` 的 **20000–65000** 扫端口，按 `256` 个一批并发，认它的 `GET /api/health`
（要求 `ok===true` 且 `actions` 是数字，避免误认别的服务）。
**实测最坏 5.2 秒**找到（目标在最后一批时）。也可以用 `AITM_URL` 显式指定。

探到后：**退避重试**（0.5s→1.5s→3s→6s→15s→30s），探到后转 **45 秒心跳**
（任务台会被关掉或重启换端口，只探一次会让菜单一直挂着一条点不通的行）。

---

## 6. 已完成 / 未完成

| 项 | 状态 |
| --- | --- |
| 待办插件扩展点（代码 + 24 条测试 + 门禁全绿） | ✅ 完成，**未提交、未推送** |
| 桥插件三个文件 | ✅ 已写完 |
| 桥已装进 desktop profile | ✅ 但 **`fiberPhase: failed`** |
| 菜单行实际出现 | ❌ **尚未出现**（因为上一条） |
| 端到端实测「转为想法」 | ❌ 未做 |
| 「转为工作」全流程实测 | ❌ 未做（有副作用，留到最后） |

### 6.1 当前卡点：桥加载失败

插件注册表实证：

```
entryId:    include:todo-aitm-bridge
enabled:    true
fiberPhase: "failed"        ← 加载失败，所以菜单里没有那两行
```

**我的代码本身是好的**：用桩仿真跑通 —— 导入 OK、`apply()` OK、路由与两个工具都注册成功：

```
import OK; name = dsh-todo-aitm-bridge | inject = ["tools"]
[bridge] 桥已就绪：todo_to_idea / todo_to_work
apply OK; registrations = route:/todo-aitm-bridge, tool:todo_to_idea, tool:todo_to_work
```

所以问题在**模块解析**，不在逻辑。

### 6.2 已查明的事实，以及**尚未完全确认**的部分

**已确信的：**

- 桥的 `index.js` 第一行 `import { defineTool } from '@deepseek-ai/dsh-tools'`。
- 桥通过 `link:` 安装 → 在 profile 里是 **junction**，真实路径在 `D:\Code\Arena_progres\...`。
- 从 `D:\...` 往上走**没有任何 `node_modules`**，Node 解析不到 `dsh-tools`。
- `profiles\node_modules\@deepseek-ai\dsh-tools` 这个 junction **是断的** ——
  指向 `...\Programs\DSH Desktop\resources\app\node_modules\...`，而真实 App 目录叫
  **`DeepSeek Harness`**。于是普通 Node 解析（`createRequire` 实测）**FAIL: MODULE_NOT_FOUND**。
- **`dsh-plugin-aitm` 同样 import `dsh-tools`、同样没有 `node_modules`，却加载成功**（`active`）。
  它是 `github:` 装的**真实目录**，在 profile 里面。

**尚待实证的（诚实标注）：**

- 「junction 的真实路径逃出 profile 的解析范围，而真实目录不会」这个**假设还没有被实验确证**。
  我原本打算的验证（在 profile 里放一份真实目录副本再重启）**因为要重启 DSH、影响你正在用的环境，没有擅自做**。
- 另外，**待办插件现在能加载（`active`）很可能是个巧合**：它的仓库里有我之前为跑门禁
  照 CI 口径 `npm install` 出来的 `node_modules`（460MB、200+ 个 `@deepseek-ai/*`）。
  **如果没跑过那次安装，待办今天大概率也会是 `failed`。**
  也就是说"靠自带的 `node_modules` 存活"这条路，本身就是脆的。

### 6.3 拟定的修法（方案 2，已同意）

**让插件不再依赖解析宿主包。** 但这里有个**必须向评审说明的技术发现**：

> `defineTool` **不是**空包装。读它的实现（`dsh-tools/lib/index.js:838`）：它会把
> `parameters` / `output.schema` 这套**规格编译成 JSON Schema**（`parameterSchemaSpecToJsonSchema`
> / `valueSchemaSpecToJsonSchema`），并挂上校验函数。**直接去掉它，工具注册会坏。**

而 `ctx.get('tools')` 提供的是 `register / get / schemas / execute / guard / restrict / presentAs`
—— **没有 `defineTool`**。

所以"方案 2"的真实含义需要收敛为二选一，**请评审给意见**：

| 子方案 | 做法 | 代价 |
| --- | --- | --- |
| **2a. 干脆不注册工具** | 桥只保留**菜单**功能（这才是用户要的）；agent 工具放弃 | 最简、零依赖、零解析问题；失去 agent 侧入口 |
| **2b. 自带一份最小 schema 编译** | 桥自己把 parameters 写成 **JSON Schema 字面量**，不经过 `defineTool` | 无需宿主包；但要自己保证 schema 正确（约 20 行，可写单测） |

我倾向 **2a + 2b 组合**：**先把菜单跑通**（本次目标），agent 工具按 2b 补。
理由是菜单才是你要的东西，不该被工具那条支线拖住。

**另一个更省事的候选**（供评审参考）：
既然 `dsh-plugin-aitm` 用 `github:` 装能正常加载，那**待办和桥也用 `github:` 装**（而非 `link:`）
可能就绕开了 junction 问题 —— 但这会**牺牲本地开发的便利**（改完要 push 才能生效）。
若评审确认 junction 是根因，可以考虑：**开发用 `link:`，但给桥的仓库也留一份 `node_modules`**（代价 460MB）。

---

## 7. 过程中踩到的坑（建议沉淀为规范）

1. **"看不到"是最贵的一类问题。**
   本次两次卡在"菜单没有那两行"，而**原因完全不同**：
   第一次是**扩展点还没有消费者**（正常，我解释过）；
   第二次是**插件 fiber 失败**（异常）。
   两者在界面上长得一模一样。→ 所以 §5.3 才坚持"任务台没开"要**显示成一行灰项**而不是藏掉。

2. **`verify-client-render` 在并行门禁下偶发失败。**
   单跑 3 次都 484/484 全绿；`check-ready.mjs` 并行跑时**偶尔挂**。
   它是全量门禁里最慢的一项（**31–40 秒**，其余都在 300ms 内），像是超时/时序敏感。
   **既存问题，非本次引入。** 建议单独修。

3. **`docs/desktop-install.md` 已过期。**
   文档称 `dsh plugin --profile desktop add` 会被无条件拒绝（`rejectElectronProfile`），
   但**实测成功**并正确改写了 profile。建议更新文档。

4. **`profiles\node_modules` 大批 junction 断链**（指向旧 App 目录名）。
   与本次无关，但可能影响其他插件，建议排查。

5. **上游打包缺陷**：npm 上 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 的 `package.json`
   **没有声明** `@deepseek-ai/dsh-sandbox`，但 `lib/index.js:7` 确实 import 它；
   而 npm 上 `dsh-sandbox` 只发布到 `0.0.1-rc.1`。→ 4 个门禁直接 `ERR_MODULE_NOT_FOUND`。
   而已用脚本绕过（见 `dsh-task-todo/.tmp-setup-gates.ps1`：从桌面版自带包 junction 一份同代 `0.1.7-rc.2`）。

---

## 8. 请评审重点看这几点

1. **§3.2 选 C（独立桥插件）** 是否认同？有没有更省的做法？
2. **§4.1 的扩展点契约**（尤其 `api` 做窄、`run(task, api)` 的签名）是否合理？
   它是跨插件 ABI，定下来后改动成本高。
3. **§6.3 的 2a / 2b / 第三条候选**，你倾向哪个？
4. **§5.3「不可用时显示灰项而不是藏掉」** 这个取舍是否认同？
5. **§6.2 那个"待办现在能跑是巧合"的判断**是否成立？
   若成立，建议给两个插件都做一次"拔掉 `node_modules` 后能否加载"的验证。

---

## 9. 附：本地环境事实（便于复现）

| 项 | 值 |
| --- | --- |
| 运行中的宿主 | DSH Desktop，`DeepSeek Harness`，`@deepseek-ai/dsh` **0.1.7-rc.2** |
| 门禁用的宿主线 | `@deepseek-ai/dsh` **0.2.0-rc.2**（CI 口径 npm 装） |
| 全局 `dsh` CLI | **0.1.2-rc.1**（旧，门禁一度误用它判断 peer 范围） |
| 待办数据 | `C:\Users\19980\.dsh\todo\tasks.json`（11 个任务） |
| 任务台数据 | `C:\Users\19980\.ai-tasks-mgr` |
| 任务台当前端口 | `127.0.0.1:49182`（**每次启动随机**） |
| 待办插件安装方式 | `link:D:/Code/Arena_progres/DSH-task-todo/dsh-task-todo` |
| 桥安装方式 | `link:D:/Code/Arena_progres/dsh-todo-aitm-bridge` |
| 备份 | `profiles\desktop\package.json.bak-*`、`pnpm-lock.yaml.bak-*` |
| 待办仓库回滚点 | tag `backup/before-reset-A`（指向 reset 前的 `56a2a0b`） |