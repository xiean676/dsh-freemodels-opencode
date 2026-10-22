# dsh-freemodels-opencode

把 **opencode Zen 免费车道**的模型接进 DeepSeek Harness，并且解决"这堆模型到底哪个能用"这个手工问题：

- **刷新模型**：一键从上游重新拉清单（含 models.dev 的上下文窗口、弃用标记）。
- **勾选启用**：勾上的模型才会以 provider `opencode` 出现在模型选择器里；**一个都不勾 = 一个都不显示**。
- **测试能不能用**：对单个模型或全部已勾选模型发一个真实尺寸的请求，给出九档结论，而不是让你自己瞎试。
- **按能力排序**：每个模型带一枚 S/A/B/C 人工评级徽章，卡片和模型选择器用同一个顺序，最强的排最前。

界面在 **设置 → 模型** 页底部，标题「opencode 免费模型」。

本插件是独立项目，**不修改也不依赖** [`@opencode2dsh/dsh-plugin`](https://github.com/FishBottle7/opencode2dsh)。两者可以共存：原插件负责它自己的 provider，本插件负责 provider `opencode`。

## 为什么需要它

上游 `https://opencode.ai/zen/v1/models` 现在返回 86 个模型 id，其中大部分是付费模型。本插件**在拉取时就把付费的丢掉**，当前只留免费车道的 9 个，所以卡片里、探测队列里、状态文件里都不会出现付费 id。

免费车道的判定不只看 `-free` 后缀：`big-pickle` 不带后缀也在车道上，反过来有些模型带 free 却在黑名单里。

剩下这一点是静态清单回答不了的：免费车道随时会因为限流、区域封锁、上游策略变化而失效，**同一个模型几小时前 200、现在 429**。所以"能不能用"只能是**实时观测**，本插件就是这么做的。

## 安装

```bash
dsh plugin --profile desktop add dsh-freemodels-opencode
```

或者从源码装：

```bash
git clone https://github.com/xiean676/dsh-freemodels-opencode.git
cd dsh-freemodels-opencode
npm install --ignore-scripts
npm run build
dsh plugin --profile desktop add .
```

装完重启 Harness，进 **设置 → 模型**，滚到最底下就是卡片。

> 桌面版的设置页在 Electron 里，本插件的桥接走同源 HTTP；如果卡片显示"读不到插件状态"，说明桌面端没把 `webServer` 服务暴露给插件，此时勾选和探测不可用（provider 本身仍然正常工作，用的是上次保存的勾选）。

## 界面怎么用

1. 点 **刷新模型** —— 拉一次清单。首次装完会自动拉一次。列表里只有免费模型。
2. 勾想要的模型。勾上的才会出现在模型选择器里。
3. 点某个模型右边的 **测试** —— 发一个真实尺寸的请求（96 token 上限，而不是一个 ping），几百毫秒到几十秒出结论。**上游一有内容就立刻判「可用」**，不用等整段流读完。
4. 或者点 **测试已勾选（N）** —— 串行测一遍已经勾上的。遇到「需付费」「车道额度用尽」，或者带 5 分钟以上 `retry-after` 的「被限流」就立刻停：这三种结论对剩下的模型必然一样，继续测只会烧掉你在等的那段额度。
   - 批量测试会**先让你确认一次**（按钮变成「确认测试 N 个模型？」），因为它真的会发 N 次请求、消耗 N 份免费额度。
   - 同一个模型 **60 秒内不会重复测**，重复点只会得到「刚测过」，不会再发请求。

> 免费车道的判定是启发式的（黑名单 → 已知白名单 → models.dev 零价 → 名字含 free）。如果某个刚上线的免费模型没被识别出来，或者某个付费模型混了进来，点 **刷新模型** 会重新判定；判定逻辑在 `src/catalog.ts` 的 `isFreeLane`。

### 排序与评级

卡片上方有三个排序按钮，默认 **按能力**：

| 排序 | 含义 |
| --- | --- |
| 按能力 | 按评级从高到低，评级相同再按上下文量 —— 和模型选择器里的顺序完全一致 |
| 按名称 | 按模型名字母排 |
| 按上下文 | 按上下文窗口从大到小 |

每行左边的 **S/A/B/C 徽章是人工评级，不是跑分结果**。它是对这批模型「干长活儿稳不稳」的手工判断，分 S（90+）、A（80+）、B（70+）、C 四段；鼠标悬停徽章会看到每个模型的具体理由。想调整顺序就编辑插件里的 `src/rank.ts` —— 改分数和理由都在那儿，其余代码不用动。

没在人工表里的新模型会走关键词启发式打分（看 id 里的版本号和 `flash`/`preview` 这类档位词），并且**被压到人工评级之下**（上限 63 分），所以明天上游冒出来的新模型只会排到列表末尾，不会顶掉谁。

启发式按 `-` / `_` / `.` 分词后**整词匹配**：早期版本用子串判断，于是 `minimax-m3.1-flash-free` 里的 `max` 被当成「高档模型」加分、还把后面的 `flash` 扣分 break 掉了。现在 `minimax` 不再命中 `max`，`flash` 也照常扣分。

上游清单是活的：`space-bunny-free` 和 `longcat-2.5-preview-free` 在 2026-10 已被撤下，但人工表里**保留**了它们的条目（96 / 74 分）—— 上游哪天恢复，插件自动把它们放回原位，不用改代码。

上下文窗口后缀 K/M 按 2 的幂换算（262144 → 256K），手写整数（200000 → 200K）按 1000 换算，两种上游数字都能对上数据手册。

### 九档结论

| 结论 | 含义 | 该怎么办 |
| --- | --- | --- |
| 可用 | 上游真的答完了这次请求，不是只回了个 200 | 用 |
| 被限流 | 429 `FreeUsageLimitError`，这个出口的额度暂时用完；有 `retry-after` 会显示「约 N 秒/分钟后可再试」 | 等到那个时间点再测，**不是不可用** |
| 车道额度用尽 | 403 `FreeTierError`：车道按客户端指纹拒绝了这台机器 | 换模型也没用，只能等上游放开，或者去用 opencode 本体 |
| 需付费 | 401/403 `AuthError`：匿名车道没有这个模型的凭据 | 换免费车道的模型 |
| 区域受限 | 403 `RegionError`：模型存在，但你当前出口 IP 所在国家/地区被拒 | 换网络出口 |
| 上游不提供 | 400：上游不认识这个 id，或不用 chat-completions 协议 | 别选它 |
| 上游临时故障 | 5xx `Upstream request failed`：上游网关自己没接住这次请求 | **和这个模型无关**，过一会儿重测 |
| 刚测过 | 60 秒内测过同一个模型，这次没发请求 | 想再测等一分钟 |
| 未测出 | 超时、空响应 | 重测；**不代表不可用** |

「上游临时故障」是单拎出来的一档：上游 5xx 说的是网关自己没接住，跟这个模型能不能用没有半点关系，混进「未测出」会让人以为模型坏了。

「被限流」和「可用」分开是有代价的：探测请求从 `ping` + 16 token 改成了一段要求数到 30 的真任务 + 96 token 上限。太小的请求只证明"那一刻还有一点点额度"，正好会造出你说的那种"测着可用、一问就 429"。现在测出来可用，就意味着这条链路刚刚真的完整答完过一次。

结论只在当前会话里存在，不落盘 —— 限流会过期，把"不可用"写进磁盘会一直骗人。

### 推理档位

免费模型全部声明支持推理档位，但各自能选的不一样：`space-bunny-free` / `beam-free` 是 low/medium/high/xhigh/max，`nemotron-3.5-super-vl-free` 最全（none→xhigh），`deepseek-v4.1-flash-free` 和 `glm-5.3-flash-free` 只有 low/high/max，而 `big-pickle` / `mimo-v2.6-flash-free` / `longcat-2.5-preview-free` / `nemotron-3.5-lightning-free` 上游没声明，插件就给默认四档 **off / low / high / max**。

默认四档是实测过这条车道能接受的写法，中间档（medium）被故意去掉：档位写错是每一轮都硬 400，而不是降级。你想改成别的档位表，改 `src/adapter.ts` 的 `DEFAULT_EFFORT_LADDER` —— 顺带说明，DSH 自带的 `dsh-thinking-slider`「补齐四档」功能在这里没用，它改的是 `llm-pi-ai` 的 provider 表，而 `opencode` 是本插件自己的 provider。

插件把这些声明从 models.dev 读进目录，通过 `LlmAdapter.resolveModel()` 的 `reasoning.efforts` 交给 harness，所以你才能在模型选择器里看到档位、选得动。选中的档位在请求里落成 `reasoning_effort`（`off` 发出去是 `none`）。

如果某个模型在 DSH 里还是选不到档位：先点 **刷新模型** 重新拉一次元数据，再重启 DSH。档位来自目录，目录没刷新就不会出现在选择器里。

models.dev 是个 5.8 MB 的大文档，实测要 15 秒左右，超时也不少见。所以插件把超时放宽到 90 秒并重试一次；**万一还是失败，模型会沿用上次成功拉到的档位和窗口，而不是被清空** —— 一次抓取失败不该让你重新选一遍档位。

**刷新分两步走**：点「刷新模型」只拉 Zen 清单（一般一秒内返回），models.dev 的元数据在后台补全，卡片会在 15 秒 / 60 秒 / 150 秒自动跟进刷新。这样那个 5.8 MB 的文档再慢，也不会让你盯着一个转圈的按钮。

拉 Zen 清单本身也会失败 —— 本机 node 的 DNS 解析器解析 `opencode.ai` 会间歇性超时（`.NET` 的解析器却一直正常），所以这里加了 1 次重试 + 1.5 秒退避，超时放宽到 45 秒。失败时卡片会把错误翻成人话（域名解析失败 / 连接被重置 / TLS 协商失败 / 证书校验失败 / 请求超时），而不是甩一句 `fetch failed`。

### 上下文未知是什么意思

卡片上如果显示「上下文未知」，说明 models.dev 这次没有这个模型的记录，那两个数字只是插件的兜底常数，不是任何人公布的值。这时插件不会把 262144 印出来冒充真实窗口，你点 **刷新模型** 重试即可。

### 会话里失败时

真发消息时撞上限流，不再套用 harness 默认的「5 次重试、每次等几百毫秒到 10 秒」——那条策略会把同一次拒绝重花五遍，最后仍然失败，只是多等十几秒。插件通过 `providerRetryPolicy()` 声明自己的策略：

- `RATE_LIMIT` **不重试**。429 带的窗口是分钟到小时级，一轮对话里重试等于白烧。
- `AUTH`、`LANE_EXHAUSTED`、`REGION_BLOCKED`、`MODEL_UNAVAILABLE` 不重试。这些换 key、换模型、等一会儿都不会自己好。
- 只对 `EMPTY_RESPONSE`、`TIMEOUT`、`TRANSPORT` 重试 1 次。

失败消息里会带上游给的等待窗口，例如「opencode: Rate limit exceeded. Please try again later.（上游建议 20 小时后再试）」，不必自己猜。装没装 `llm-retry` 插件都一样：没装就是直接失败并显示这句话，装了也应该只看到一次。


## 自己测

```bash
npm run typecheck   # 宿主 + 客户端两套 tsconfig
npm run check       # build + 三组离线冒烟，全都不打上游
npm run selftest    # 17 组：会话头、清单、评级、档位、分类、存储、路由、adapter、SSE、bundle
npm run render      # 用真 React 渲染构建产物里那张卡，验首帧不崩
npm run interaction # jsdom 里点一遍：勾选、单条测试、刷新、批量测试、失败路径
node scripts/live-check.mjs                        # 可选，真打上游：刷新清单并逐个测，打印九档结论
node scripts/live-smoke.mjs                        # 可选，真打上游：走一遍 adapter 的流式链路
node scripts/integration.mjs                       # 可选，要 FMO_HOST_MODULES
node scripts/refresh-now.mjs <state.json 路径>      # 可选，绕过界面原地重刷真实 state 文件
```

`integration.mjs` 把宿主真的 `LlmRuntime` 拉起来跑一遍注册与流式，能抓到离线用例抓不到的契约漂移。宿主把 `@deepseek-ai/*` 打进 `app.asar`，普通 node 进程 import 不了，所以要用解包出来的依赖树：

```bash
FMO_HOST_MODULES=/path/to/extracted/@deepseek-ai/tree node scripts/integration.mjs
```

没设这个变量就跳过，不算失败。

`refresh-now.mjs` 会真打上游并真写 state 文件，所以**故意不挂在 `npm run check` 上** —— 只在旧版本把缓存搞脏、又不想重启 DSH 时手动跑一次。

`render` 和 `interaction` 需要 `react-dom`，`interaction` 还需要 `jsdom`。两者都是 devDependency，装了 `node_modules` 就有；缺了会跳过而不是失败。

## 它怎么实现的（给想改的人）

| 文件 | 作用 |
| --- | --- |
| `src/zen-ids.ts` | 免费车道要求的 `ses_*` 会话 id 与 7 个伪装头 |
| `src/rank.ts` | 人工评级表与能力排序（**改顺序只需要动这个文件**） |
| `src/catalog.ts` | 拉 Zen 清单 + models.dev 元数据，**丢掉付费模型**后合并出 `ModelMeta[]` |
| `src/probe.ts` | 单模型探测与九档分类（永不抛异常，流式判级） |
| `src/net-errors.ts` | 把 `fetch failed` 翻成人话：DNS 失败 / 连接重置 / TLS / 证书 / 超时 |
| `src/store.ts` | `$DSH_HOME/data/dsh-freemodels-opencode/state.json`，串行写、原子替换 |
| `src/adapter.ts` | provider `opencode` 的 `LlmAdapter`：只列勾选的、流式转发 |
| `src/bridge.ts` | 四条同源路由：`/status` `/refresh` `/select` `/probe`（探测走 NDJSON 流式返回） |
| `src/index.ts` | 宿主入口：注册 adapter、首轮加载清单、挂路由 |
| `src/client/` | 浏览器入口 + 卡片（只 require `react`） |

关键设计：**模型清单的权威是这个插件自己**。`LlmAdapter.listModels()` 返回的就是勾选集，勾选为空时返回 `[]` —— 宿主允许空目录，于是模型选择器里干干净净什么都不显示，正是要的行为。

模型选择器里的顺序也是 `rank.ts` 定的能力序，不是勾选顺序：能力值、上下文窗口、档位深度都进 `src/store.ts` 的 `#advertised()` 指纹，任一变化都会触发重新发布，所以改评级不用重启 DSH。

## 许可

MIT。`src/zen-ids.ts` / 免费车道闸门 / models.dev 解码 / 错误分类的原始协议工作来自 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（MIT, Copyright (c) 2026 FishBottle7），详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

上游服务由 OpenCode 运营，与本项目无关。

## 更新说明

### v0.3.0

- **人工评级补两条**：`minimax-m3.1-flash-free` 定为 87（A 段，1M 上下文 + 512K 输出 + 档位齐全，新上线稳定性未验证所以压一档），`flint-40b-free` 定为 71（B 段下沿）。上游已撤下但保留条目的 `space-bunny-free` / `longcat-2.5-preview-free` 加了注释说明。
- **修启发式的子串误命中**：档位词改成按 `-` / `_` / `.` 分词后整词匹配。`minimax` 里的 `max` 不再被当成「高档模型」加分，`flash` 的扣分也不再被 break 掉。启发式上限 61 → 63，仍严格低于最低人工分 64。
- **刷新分两步走**：点「刷新模型」只拉 Zen 清单（秒回），models.dev 的元数据在后台补全，卡片自动跟进。zen 拉取加 1 次重试 + 退避，超时放宽到 45 秒。
- **网络错误翻成人话**：新增 `src/net-errors.ts`，把 `fetch failed` 拆成域名解析失败 / 连接被重置 / TLS 协商失败 / 证书校验失败 / 请求超时，并带上错误码。
- **探测改流式判级**：上游一有内容就立刻判「可用」，不再等整段 body 读完。探测预算 30 秒 → 90 秒。慢模型（实测首内容要 29.8 秒）不再被误判成「未测出」。
- **结论加两档**：「上游临时故障」（上游 5xx，和模型本身无关）与「刚测过」（60 秒内不重复测试，不发请求）。
- **`/probe` 改 NDJSON 流式返回**，卡片边收边渲染，不会因为串行测 9 个模型超过宿主的 300 秒请求超时被整条掐断。
- **省额度**：探测上限 512 → 96 token，任务从「数到 60」改成「数到 30」。
- **批量测试两步确认**：按钮先变成「确认测试 N 个模型？」，5 秒内再点才真的发 N 次请求。

### v0.2.0

- 模型卡片与模型选择器统一改为**按人工评级（`src/rank.ts`）排序**，S/A/B/C 徽章 + 悬停理由。
- 卡片新增 **按能力 / 按名称 / 按上下文** 三种排序；勾选与否不再影响行顺序。
- 上下文与输出上限带 **「已知 / 未知」** 标记，上游没公布时不再把兜底常数当真实窗口印出来。
- models.dev 拉取超时放宽到 90 秒并重试一次；拉取失败时**沿用上次的档位与窗口**，不再清空。
- 未声明档位的模型默认档位改为实测可用的 **off / low / high / max**（原先含 medium，会硬 400）。
