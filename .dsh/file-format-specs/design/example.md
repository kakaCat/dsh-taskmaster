---
title: 内容格式规则引擎 设计文档
status: approved
owner: 插件组
reviewers: 架构组、宿主组、文档组
prd: examples/file-format-specs/prd/example.md
serves: FR-1、FR-2、FR-3、FR-4、FR-5、FR-6、NFR-1、NFR-2、NFR-3
created: 2026-10-14
updated: 2026-10-15
---

# 内容格式规则引擎 设计文档  serves: FR-1

## 摘要  serves: 全文

- **问题**：文档结构判据写死在插件代码里，项目想加一条自己的判据就要改代码、重新构建，于是要求都退化成 prompt 里靠模型自觉的一句话。
- **方案**：把判据从代码搬进项目自己的 `.dsh/file-format-specs/<type>/spec.yaml`——文档解析成事实，规则写成条件树，内置原语与用户脚本都只是引擎里的函数；校验挂在 write/edit 落盘之后的 post-execute 钩子上。
- **影响面**：新增 `src/content-format/`（匹配、解析、原语、规则引擎、脚本沙箱、反馈渲染）；只读宿主的 `tools/post-execute`，不改宿主、不改工具入参、不回滚已落盘文件。

## 背景与问题  serves: 全文

### 需求来源

| 需求编号 | 原始诉求 | 本设计如何回应 |
|---|---|---|
| FR-1 | 「项目想加一条判据，必须改插件发版」 | 规则数据化：类型目录 = 文档类型，`spec.yaml` 声明规则；mtime 签名缓存失效，改文件即生效 |
| FR-2 | 「只报缺章节，不说为什么、也不给形状」 | 条件树求值（`all/any/not/path/each/count/fn`）保住表达力，违规带 rule id、行号与 message |
| FR-3 | 「同一条判据要在多处重复计算」 | 前向链 `derive`：派生事实一次算好，后续规则直接引用；后一条可见前一条 |
| FR-4 | 「每加一条判据就加一段代码」 | 内置原语以 `fn` 形式暴露（`sectionsRequired` / `tableRequired` / `idDetails` / `ids` …），规则只声明参数 |
| FR-5 | 「有些判据机器判不了，但项目自己判得了」 | `functions` 里写 `expr` / `script` 逃生舱，`node:vm` 白名单上下文 + 1s 超时 |
| FR-6 | 「被拒之后不知道改成什么样」 | 打回文本附目标模板全文（无模板则按规则反推骨架）+ 填写参考指针 + 剩余次数 |
| NFR-2 | 「一份 spec 写坏不能拖垮全部校验」 | 单类型加载失败只告警并跳过；脚本抛错只产出一条「函数执行失败」 |
| NFR-3 | 「用户脚本不能变成任意代码执行」 | `vm` 白名单注入 + 1s 超时；上下文里没有 `require`、`process`、文件系统 |

### 现状与代价

今天加一条判据的路径是：改 `src/` 里的检查函数 → 构建 → 重新安装 bundle → 重启会话。
代价是三点：接入周期以天计；回归风险高（改的是所有人共用的代码）；判定口径只有一个版本，项目差异只能塞进 prompt。

### 为什么是现在

`tools/post-execute` 钩子已经提供了落盘后的 `after` 全文与 `PostToolDecision`，校验所需的全部输入已经就位；
而试点项目 3 周内 17 次因结构问题被打回、6 条自定义判据全部搁置——继续把判据留在代码里的成本已经高于把引擎做出来。

## 目标与非目标  serves: 全文

### 目标

- 项目**不改插件代码**即可声明判据：`spec.yaml` 保存后，下一次写文档即按新规则校验；
- 校验失败给出**可执行的形状**：目标模板 / 骨架 + 违规清单 + 剩余重试次数，目标是一轮改对；
- 引擎本身可自证：每份示例 spec 的模板都必须通过自己的规则（模板落笔即合规）。

### 非目标

- **不做内容好坏评审**：「这段话写得对不对、清不清楚」机器判不了，硬做会制造误报，交给评审人；
- **不做跨文档一致性**：本期只看单份文档的形状，不比对两份文档之间的口径（如 PRD 指标名与指标方案是否一一对应）；
- **不改写文档**：插件只判断与提示，不替 agent 修改正文——写文档的责任留在 agent；
- **不追溯存量文档**：`diff_mode=delta` 只拦本次新增的违规，旧文件的历史问题不算在本次操作头上。

## 方案总览  serves: FR-2、FR-4

**一句话方案**：把「文档该长什么样」表达成一份 YAML 规则数据，文档解析成事实（标题、表格、正文行、front-matter），规则是事实上的条件树，内置原语与用户脚本都只是引擎里可调用的函数；校验发生在 write/edit 落盘之后，输出 accept / warn / block 三态。

```text
宿主 write/edit 落盘成功
  |
  +-- post-check（tools/post-execute）
      |
      +-- match：按文件名 + match_path 选 spec（priority 降序，首个命中）
      |     |
      |     +-- 未命中 --> accept（零正文）
      |
      +-- validateDocument
      |     |
      |     +-- parse：标题 / 表格 / 正文行 / front-matter（跳过代码围栏）
      |     +-- derive：前向链派生事实（countIds / 用户函数）
      |     +-- rules：条件树求值 --> 违规列表（聚合，带行号）
      |     +-- delta：减去 before 已有的违规 key
      |
      +-- report：accept | warn+指引 | block+差异清单+目标模板
```

**关键概念**

- **事实 Facts**：解析结果铺开的一层只读数据（`doc` / `frontmatter` / `headings` / `tables` / `bodyLines` / `text` / `fileName` / `relPath` / `specName`），派生事实也写回这一层。
- **条件树**：`{ path | each | count | fn | all | any | not }` 的递归结构，叶子产出 `{ ok, failures }`；一个 rule 的 `assert` 就是一棵树。
- **内置原语**：`PRIMITIVES` 表里的纯函数（`ParsedDoc + 参数 → 失败列表`），只判机器能证伪的结构事实。
- **delta 归责**：违规的 `key` 是稳定标识；`before` 里已存在的 key 不再计入本次新增违规。

## 架构与依赖  serves: FR-1、FR-2

- **模块划分**
  - `spec.ts`：类型目录加载（`spec.yaml` + 约定 `template.md` / `example.md`）、`normalizeSpec`、mtime 签名缓存；
  - `match.ts`：glob 与关键词匹配、priority 排序、首个命中；
  - `parse.ts`：行扫描解析（标题层级、表格、代码围栏跳过、front-matter）；
  - `primitives.ts`：内置原语，每条失败带 `key` 与行号；
  - `rules/`：条件求值（`condition.ts`）、规则引擎（`engine.ts`）、路径解析（`path.ts`）、运算符（`operators.ts`）、函数注册（`builtin.ts`）；
  - `script.ts`：`node:vm` 沙箱，跑 `expr` 与 `script`；
  - `report.ts` / `skeleton.ts`：打回文本渲染；无模板时从规则反推骨架；
  - `post-check.ts`：钩子装配（匹配 → 校验 → 决策），与宿主 `PostToolDecision` 的唯一接触面。
- **依赖方向**：`post-check → validate → engine → {condition, primitives, script}`，`report` 只读 `validate` 的结果；`spec` 是数据来源，不被反向依赖。**无环**——这是可单测的前提：`validateDocument` 不碰文件系统。
- **外部依赖**：宿主 `tools/post-execute` 与 `PostToolDecision`（阻塞项）；`js-yaml`（解析 spec）；`node:vm`（脚本沙箱，可选降级为「不支持 script」）。
- **与既有架构的差异**：校验不再写死在 `src/`，运行时读用户工作区的 YAML——插件行为开始依赖工作区数据，因此缓存失效必须按文件 mtime 而不是进程生命周期。

## 数据模型  serves: FR-1、FR-3

- **实体与字段**
  - `FormatSpec`：`name` / `ext?` / `priority` / `match[]` / `matchPath[]` / `template?` / `example?` / `mode` / `enforceOn[]` / `diffMode` / `maxAttempts` / `onExhausted` / `rules[]` / `derive[]` / `functions{}`。
  - `ParsedDoc`：`frontmatter{}` / `headings[]`（`text` / `level` / `line`）/ `tables[]`（`header[]` / `rows[][]` / `line`）/ `bodyLines[]` / `bodyLineNos[]` / `lineCount` / `charCount`。
  - `Violation`：`checkId` / `type` / `severity` / `key` / `message` / `line?`。
  - `FormatReport`：`spec` / `violations` / `errors` / `warnings` / `newErrors` / `newWarnings`。
- **约束与不变量**
  - `match` 与 `matchPath` 不能同时为空（否则会匹配一切）——加载期拒绝，而不是运行期兜底；
  - `name` 取自目录名，同一工作区内唯一；`priority` 决定首个命中，同级按名称稳定排序；
  - delta 的 `key` 必须稳定：`rule.id + '|' + (failure.key ?? rule.key ?? message)`，不得含行号（否则改一行就重新报）；
  - 派生事实后一条可见前一条，形成前向链；不得回写 `doc`。
- **迁移与回填**：无需迁移——校验不落盘、不留存；旧文档靠 `diff_mode=delta` 天然不追溯。
- **生命周期**：spec 按「目录 + 四个文件 mtime」签名缓存，改文件即失效；文档解析结果与违规列表都是单次调用内的临时对象。

## 接口设计  serves: FR-1、FR-6

| 编号 | 接口 | 输入 | 输出 | 失败与错误 | 兼容性 |
|---|---|---|---|---|---|
| IF-1 | 宿主钩子 `tools/post-execute` | `exec`（工具名与 arguments）、`result.value.{path,operation,before,after}`、`next()` | `PostToolDecision`：`accept` 或 `block{feedback[]}` | 不抛异常；内部失败一律降级为 `accept`（最多附一条 warning） | 只读 `value`，宿主冻结 `arguments`；宿主新增字段默认忽略 |
| IF-2 | `validateDocument(spec, after, before, templateText?, options?)` | spec、落盘后全文、落盘前全文或 null、模板正文、`{fileName, relPath, scriptTimeoutMs}` | `FormatReport` | 不抛；脚本抛错或超时变成一条 `severity=error` 的违规 | `FormatReport` 字段只增不改；`options` 全可选；`before=null` 等价 strict |
| IF-3 | `spec.yaml` 文件契约 | 类型目录下的 YAML：`match` / `match_path` / `rules` / `derive` / `functions` … | 加载后的 `FormatSpec` | YAML 非法 → `logger.warn` + 跳过该类型；`match` 与 `match_path` 同时为空 → 拒绝加载 | 顶层未知键忽略；`rules[].require` 作为 `assert` 的别名保留 |
| IF-4 | 自定义函数沙箱（`expr` / `script`） | 表达式或脚本文本；上下文白名单 `doc/text/fileName/relPath/specName/api` | 通过（`undefined`/`null`/`true`/空数组）或违规（`string` / `{message,line,key,severity}` / 数组） | 抛错或 1s 超时 → 一条「函数执行失败」，其余规则照跑 | `api` 白名单只增不减；返回值接受三种形态 |

#### IF-1 宿主钩子决策协议

**语义**

write/edit 落盘成功、且宿主给出 `after` 全文之后被调用。顺序固定：按 `relPath` + 文件名匹配 spec → 未命中直接 `accept` → 命中则加载模板与 example、调用 `validateDocument` → 按 `mode` 与 delta 结果决定 `accept` / `warn` / `block`。block 只改变工具结果，**不回滚已落盘内容**——这是刻意的：文件已经写对一半，回滚会让 agent 丢失已有进度。

**错误码**

本接口没有异常码，只有三条降级路径，全部落到 `accept`：

- 未命中 spec → 零正文放行（无法可依，不误伤）；
- spec 非法 → 一条 warning 指向 spec 文件，且**不伪装成文档违规**；
- 引擎内部异常 → 记一条错误文本，放行。

`block` 的 `feedback[].text` 必须包含：本次新增违规清单（rule id + 行号 + 建议）、历史违规计数、目标模板或骨架、填写参考路径、剩余次数。

**兼容性**

宿主升级时按「缺字段 = 未命中」处理，不做版本嗅探；插件只读 `arguments`，不修改入参；
`next()` 必须恰好调用一次，避免短路宿主链上的其它钩子。

#### IF-2 validateDocument

**语义**

纯函数校验：解析 → 构建事实 → `derive` 前向链 → 规则求值（priority 降序，`when` 守卫）→ 按 `diffMode` 归责。不触文件系统、不做 IO，因此可用纯文本单测覆盖。

**错误码**

不抛异常。两个特例：
- 用户函数抛错或超时 → 产出一条 `checkId = <函数名>` 的错误文本「函数执行失败」，继续跑其它规则；
- 依赖失败事实的规则照常求值（事实缺失即条件不成立），不级联报错。

**兼容性**

`FormatReport` 只增字段，不改语义；`violations` 与 `errors` 的口径区别（全量 vs 仅 error 级）必须保持稳定，因为反馈渲染与统计都依赖它；`scriptTimeoutMs` 可作为测试注入项，默认 1000ms。

#### IF-3 spec.yaml 文件契约

**语义**

一个文档类型一个目录：目录名即 `name`，同目录 `template.md` 与 `example.md` 按约定自动挂上，无需在 YAML 里写。
`match` 判文件名（无 `*?` 按关键词包含，否则按 glob），`match_path` 判相对路径，两者都写时必须同时满足。
`rules` 是条件树数组，`derive` 是前向链，`functions` 是用户函数表。

**错误码**

- YAML 语法错误或 `normalizeSpec` 抛错 → `logger.warn('format spec <name>/ 非法——<原因>')` 并跳过该类型，其它类型照常；
- `match` 与 `match_path` 同时缺失 → 视为配置错误拒绝加载（绝不匹配一切）；
- `functions` 里声明的函数名与内置函数重名 → 以内置为准并告警。

**兼容性**

顶层未知键忽略（允许项目写注释性字段）；`rules[].require` 保留为 `assert` 别名；
`mode` / `diff_mode` / `max_attempts` / `on_exhausted` 缺省时按 `block` / `delta` / `3` / `allow` 处理，旧 spec 不需要补齐。

#### IF-4 自定义函数沙箱

**语义**

`functions` 里用 `expr`（按真假判定）或 `script`（返回违规列表）注册；脚本上下文只注入白名单：`doc`、`text`、`fileName`、`relPath`、`specName`、`api`。`api` 提供 `hasSection` / `section` / `collectIds` / `frontmatter` / `violation`。
返回值协议：`undefined` / `null` / `true` / 空数组 = 通过；string、`{message, line, key, severity}`、或它们的数组 = 违规。

**错误码**

抛错与超时都归为一条「函数执行失败」，`checkId` 为函数名——**绝不拖垮写文件**；`expr` 为假时报 rule 自身的 `message`（而不是函数返回的文本），因为判据属于规则、实现属于函数。

**兼容性**

`api` 白名单只增不减（删一个方法会静默破坏项目已有的 spec）；返回值三种形态必须长期同时接受；
脚本内不得依赖 `this`、模块系统或任何 IO，白名单之外一律 `undefined`。

**幂等与重试**

函数在同一次校验内可能被多条规则调用，必须是纯函数：只读事实、不写外部状态。
没有重试语义——超时即失败，不做第二次执行。

## 备选方案  serves: 全文

| 方案 | 一句话说明 | 优点 | 代价 | 为什么未选 |
|---|---|---|---|---|
| A（选用） | 规则数据化 + 条件树引擎 + 内置原语 | 项目零代码接入；判据可单测；示例可自证 | 引擎与沙箱要自己写，抽象成本前置 | — |
| B | 继续用写死的检查函数，只把阈值参数化 | 实现最省，无新概念 | 判据表达力仍受代码限制；新判据仍要发版 | 正是本期要消掉的那笔成本 |
| C | 把文档规范写进 prompt 让模型自觉遵守 | 零实现 | 不可机械验证、不可回归、无法定位误报 | 试点已证伪：结构问题仍占到 17 次打回 |
| D：什么都不做 | 维持现状，靠评审人挑 | 无成本 | 评审时间被结构问题吃掉，判据继续搁置 | 打回率与搁置数都在上升 |

## 四风险与证据  serves: 全文

| 风险类型 | 判断问题 | 现有证据 | 结论 |
|---|---|---|---|
| 价值 | 项目方真的愿意维护 spec.yaml 吗 | 本仓库自用三份 spec（prd / metrics / design）驱动同一个引擎，且示例模板受守护测试约束；试点 6 条搁置判据待 2 周内迁入 | 部分 |
| 可用性 | 被打回的 agent 能照着指引改对吗 | PRD 示例里内联了打回文本原型（含新增/历史分离、目标结构、剩余次数）；`test/format.test.ts` 的 post-execute 集成用例覆盖 accept / block / 放行三态 | 部分 |
| 可行性 | 规则引擎与沙箱建得出来吗 | 引擎已落地：条件树、量词、`fn`、`derive`、`when` 守卫、四类内置原语均有单测；死循环脚本被 1s 超时截断有专测 | 已验证 |
| 商业可行性 | 成本与合规能接受吗 | 纯本地执行、零网络、零外部服务；不落盘不采集，无 PII 流入 | 已验证 |

**未验证项的补课计划**

- 价值风险：2 周内在试点项目落地首批 spec，统计「自建 spec 的项目数 ≥ 2」；不达标先发布内置默认规范，把自定义能力后置；
- 可用性风险：用 6 份真实被打回文档做 agent 修复演练，记录「下一次 write 即零 error」的比例（目标 ≥ 80%）。

## 失败模式与回滚  serves: NFR-2、NFR-6

| 失败场景 | 触发条件 | 用户可见影响 | 检测手段 | 回滚动作 | 决策人 |
|---|---|---|---|---|---|
| 规则写错导致误拦 | spec 的判据过严或写法有误 | agent 反复被同一条规则打回 | 结构化日志里的 block 率与同一 checkId 重复率 | 把该 spec 的 `mode` 改为 `warn` 或 `off` | 项目维护者 |
| 模板与规则漂移 | 模板 H2 与 `sectionsRequired` 不一致 | 照着模板写仍被打回 | 守护测试「每份示例模板都通过它自己的 spec」 | 修模板或修规则，二者必须一致 | 插件组 |
| 脚本死循环 | `script` 里出现无出口循环 | 该校验耗时被截断，产出一条失败 | 单测覆盖超时路径；日志里出现「函数执行失败」 | 修脚本；必要时删除该函数改用内置原语 | 规则作者 |
| 脚本抛错 | 引用未定义变量、越权访问 | 一条函数失败，其余规则照跑 | 同上 | 同上 | 规则作者 |
| 打回文本过长 | 模板很大且违规很多 | block 反馈吃掉上下文预算 | 反馈字数与模板行数 | 超阈值改为「指针 + 节清单」 | 插件组 |
| 匹配到错误 spec | 文件名关键词过宽（如裸 `design`） | 文档被无关规则校验 | 误报率与 spec 命中日志 | 收紧 `match`，改用 `match_path` | 项目维护者 |

- **开关**：`mode: block | warn | off`，粒度是单个文档类型（一个 spec 目录）；`diff_mode` 决定是否追溯存量。
- **回滚演练**：在试点项目把 design spec 切回 `warn` 跑一轮，确认不阻断写入且能正常提示；预期 1 分钟内生效（mtime 缓存失效，无需重启）。
- **不可逆动作**：**无**。校验不回滚、不改写正文；唯一的写操作是插件自身 bundle 安装，与本引擎无关。

## 跨关注点  serves: NFR-1、NFR-3、NFR-4、NFR-5

| 关注点 | 结论 | 依据与措施 |
|---|---|---|
| 安全 | 用户脚本不得成为任意代码执行入口 | `node:vm` 白名单上下文，无 `require` / `process` / IO；默认 1s 超时截断 |
| 隐私与合规 | 不采集、不落盘、不外发 | 只读 `after` 全文并内存校验；无网络调用；日志只记 spec 名、规则 id、违规数与耗时 |
| 成本 | 近似为零 | 无外部服务、无模型调用；按 mtime 签名缓存 spec，单次校验只解析一次文档 |
| 可观测性 | 误报与放行可统计 | 每次 block 记结构化日志；`on_exhausted=allow` 的放行单独计数（区别于真正通过） |
| 性能与容量 | 单次校验 P95 ≤ 50ms（1000 行文档） | 单遍行扫描解析；跳过代码围栏；违规全量聚合但一次渲染，不做 N 次遍历 |
| 文档与支持 | 项目方能自助排错 | `docs/template-authoring.md` 定义模板契约；示例 spec 即活文档；spec 非法时告警直接指向文件 |

## 交付拆分与里程碑  serves: 全文

| 里程碑 | 内容 | 出口判据 | 负责人 | 目标日期 |
|---|---|---|---|---|
| M1 | 匹配 + 解析 + 内置原语 + 规则引擎 | 原语单测通过；`matchSpec` 首个命中与 priority 用例通过 | 插件组 | 2026-10-20 |
| M2 | 动态函数沙箱 + `derive` + 反馈渲染与骨架 | 死循环被超时截断；无模板时能生成骨架 | 插件组 | 2026-10-24 |
| M3 | 三份示例 spec + 模板 + 守护测试 | 模板零 error、示例零 error、负例探针逐条会拦人 | 插件组 + 文档组 | 2026-10-28 |
| M4 | 试点 warn → block | warn 期误报率 < 5%，随后切 block | 插件组 | 2026-11-10 |
| M5 | 全量 | 试点复盘通过；agent 一次修复率 ≥ 80% | 插件组 | 2026-11-24 |

## 需求追溯  serves: 全文

| 需求编号 | 设计节 | 测试用例 | 指标 |
|---|---|---|---|
| FR-1 | 数据模型 / 接口设计（IF-3） | test/format.test.ts「匹配：优先级与首个命中」；「示例规范守护」 | 自定义判据接入成本 |
| FR-2 | 方案总览 / 架构与依赖 | test/rules.test.ts「each + where：每个 H2 必须 serves」；「count 量词」；「not / any 组合」 | agent 一次修复率 |
| FR-3 | 数据模型（前向链不变量） | test/rules.test.ts「derive + 用户 expr 函数」 | agent 一次修复率 |
| FR-4 | 架构与依赖（primitives） | test/rules.test.ts「fn 调内置函数 hasSection」；test/format.test.ts「内置原语」 | agent 一次修复率 |
| FR-5 | 接口设计（IF-4） | test/format.test.ts「动态代码：expr / script」；「脚本抛错 → 一条错误，不崩」；「死循环被超时截断」 | agent 一次修复率 |
| FR-6 | 接口设计（IF-1 反馈字段） | test/format.test.ts「打回指引：目标模板与骨架」；「post-execute 集成」 | agent 一次修复率 |
| NFR-1 | 跨关注点（性能与容量） | 待补基准用例：1000 行文档单次校验耗时 | 单次校验耗时 P95 |
| NFR-2 | 失败模式与回滚（spec 非法） | test/format.test.ts「示例规范守护」；加载非法 spec 的跳过行为 | 自定义判据接入成本 |
| NFR-3 | 接口设计（IF-4 超时） | test/format.test.ts「死循环被超时截断」 | 不适用（合规约束，非业务指标） |
| NFR-6 | 方案总览（delta 归责） | test/format.test.ts「delta：只拦新增违规」；「新建（before=null）等价 strict」 | 单份需求结构化返工次数 |

## 常见问题  serves: 全文

| 问题 | 回答 |
|---|---|
| 项目方最可能抱怨什么？ | 「我又多了一份要维护的 YAML」。对策是把 spec 控制在声明式规则内，并且用示例件（`example.md`）当活文档；真不愿维护的项目继续走内置默认规范。 |
| 六个月后这套东西会变成什么负担？ | 最可能的负担是 spec 与模板漂移、以及原语语义被误用。防法是守护测试：模板必须通过自己的 spec，每份示例必须零 error，改语义就会有测试红。 |
| 文档量涨 10 倍先坏在哪里？ | 先坏在解析与表格扫描是整篇遍历（每份文档 O(行数)），以及 block 反馈过长。前者靠 P95 基准用例暴露，后者靠「超阈值转指针」。 |
| 谁会在半夜被叫起来？他手上有什么？ | 不会有人被叫起来——插件在本地、无服务端。最坏情况是 agent 被持续误拦，此时维护者手上有：结构化日志（spec 名 / 规则 id / 违规数）、spec 文件本身、以及把 `mode` 改成 `warn` 这个开关。 |
| 数据错了怎么修？修得回来吗？ | 校验不落盘、不留存，所以没有「错数据」要修；误判只影响当次反馈，改 spec 后下一次写入即修正，无需回填。 |
| 这个决定错了多久能发现？ | 价值假设（项目方愿维护 YAML）在 2 周试点内见分晓——判据是「自建 spec 的项目数 ≥ 2」；可用性假设用 6 份真实打回文档的修复演练，一轮即知。 |
| 为什么不直接用 JSON Schema 校验文档结构？ | 我们的判据不是纯 schema：需要「每个 H2 带 serves」「清单编号必须在明细里出现」这类跨行、跨节约束，还要允许项目写脚本。JSON Schema 表达不了，且它没有 delta 归责与反馈渲染。 |

## 开放问题  serves: 全文

| 问题 | 选项 | 负责人 | 截止 |
|---|---|---|---|
| 大模板在 block 文本里是否改为「指针 + 节清单」 | 全文内联 / 超阈值（60 行）转指针 | 插件组 | 2026-10-30 |
| `file_check` 是否做全仓巡检（而非只在 write/edit 时校验） | 做 / 不做 | 插件组 | 2026-11-15 |
| 内置默认规范是否随包发行 | 随包 / 项目自建 | 架构组 | 2026-11-20 |

## 附录  serves: 全文

- **原型与验证材料**：打回文本原型见 PRD 示例的「文本交互原型」；无模板时的骨架输出由 `skeleton.ts` 生成，测试覆盖于「打回指引：目标模板与骨架」。
- **相关文档**：`examples/file-format-specs/prd/example.md`（需求来源）、`docs/content-validation-design.md`（三环节全景）、`docs/template-authoring.md`（模板契约）。
- **评审记录**：2026-10-14 设计评审通过（架构组 + 宿主组 + 文档组）；未闭环项 = 开放问题前两条，各有负责人与截止。
- **变更历史**：2026-10-14 初稿（含接口 IF-1～IF-4 与四风险证据）；2026-10-15 按评审意见补「失败模式与回滚」的不可逆动作结论、把性能口径从「未测」改为 P95 ≤ 50ms。
