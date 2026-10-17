# dsh-freemodels-opencode

把 **opencode Zen 免费车道**的模型接进 DeepSeek Harness，并且解决"这堆模型到底哪个能用"这个手工问题：

- **刷新模型**：一键从上游重新拉清单（含 models.dev 的上下文窗口、弃用标记）。
- **勾选启用**：勾上的模型才会以 provider `opencode` 出现在模型选择器里；**一个都不勾 = 一个都不显示**。
- **测试能不能用**：对单个模型或全部已勾选模型发一个最小的真实请求，给出五档结论，而不是让你自己瞎试。

界面在 **设置 → 模型** 页底部，标题「opencode 免费模型」。

本插件是独立项目，**不修改也不依赖** [`@opencode2dsh/dsh-plugin`](https://github.com/FishBottle7/opencode2dsh)。两者可以共存：原插件负责它自己的 provider，本插件负责 provider `opencode`。

## 为什么需要它

上游 `https://opencode.ai/zen/v1/models` 现在返回 **85 个模型 id**，但：

- 只有 9 个带 `-free` 后缀，而 `big-pickle` 这类不带后缀的也在免费车道上；
- 免费车道随时会因为限流、区域封锁、上游策略变化而失效，**同一个模型几小时前 200、现在 429**；
- 付费模型匿名访问会拿 401 `AuthError`，看起来像"挂了"，其实是"要钱"。

所以"能不能用"只能是**实时观测**，不能是静态清单。本插件就是这么做的。

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

1. 点 **刷新模型** —— 拉一次清单。首次装完会自动拉一次。
2. 在列表里勾想要的模型。免费车道的排在前面，非免费车道的标「可能需付费」。
3. 点某个模型右边的 **测试** —— 发一个真实的最小请求，几百毫秒到几秒出结论。
4. 或者点 **测试已勾选（N）** —— 串行测一遍已经勾上的，遇到"需付费"立刻停（后面的必然一样，不白花额度）。

### 五档结论

| 结论 | 含义 | 该怎么办 |
| --- | --- | --- |
| 可用 | 上游正常应答，现在就能用 | 用 |
| 被限流 | 429，当前被限流 | 过一会儿重测，**不是不可用** |
| 需付费 | 401/403 `AuthError`：匿名车道没有这个模型的凭据 | 换免费车道的模型 |
| 区域受限 | 403 `RegionError`：模型存在，但你当前出口 IP 所在国家/地区被拒 | 换网络出口 |
| 上游不提供 | 400：上游不认识这个 id，或不用 chat-completions 协议 | 别选它 |
| 未测出 | 超时、5xx、空响应 | 重测；**不代表不可用** |

结论只在当前会话里存在，不落盘 —— 限流会过期，把"不可用"写进磁盘会一直骗人。

## 自己测

```bash
npm run typecheck   # 宿主 + 客户端两套 tsconfig
npm run check       # build + 三组离线冒烟，全都不打上游
npm run selftest    # 11 组：会话头、清单、分类、存储、路由、adapter、SSE、bundle
npm run render      # 用真 React 渲染构建产物里那张卡，验首帧不崩
npm run interaction # jsdom 里点一遍：勾选、单条测试、刷新、批量测试、失败路径
node scripts/live-smoke.mjs                        # 可选，真打上游，会花额度
node scripts/integration.mjs                       # 可选，要 FMO_HOST_MODULES
```

`integration.mjs` 把宿主真的 `LlmRuntime` 拉起来跑一遍注册与流式，能抓到离线用例抓不到的契约漂移。宿主把 `@deepseek-ai/*` 打进 `app.asar`，普通 node 进程 import 不了，所以要用解包出来的依赖树：

```bash
FMO_HOST_MODULES=/path/to/extracted/@deepseek-ai/tree node scripts/integration.mjs
```

没设这个变量就跳过，不算失败。

`render` 和 `interaction` 需要 `react-dom`，`interaction` 还需要 `jsdom`。两者都是 devDependency，装了 `node_modules` 就有；缺了会跳过而不是失败。

## 它怎么实现的（给想改的人）

| 文件 | 作用 |
| --- | --- |
| `src/zen-ids.ts` | 免费车道要求的 `ses_*` 会话 id 与 7 个伪装头 |
| `src/catalog.ts` | 拉 Zen 清单 + models.dev 元数据，合并出 `ModelMeta[]` |
| `src/probe.ts` | 单模型探测与五档分类（永不抛异常） |
| `src/store.ts` | `$DSH_HOME/data/dsh-freemodels-opencode/state.json`，串行写、原子替换 |
| `src/adapter.ts` | provider `opencode` 的 `LlmAdapter`：只列勾选的、流式转发 |
| `src/bridge.ts` | 四条同源路由：`/status` `/refresh` `/select` `/probe` |
| `src/index.ts` | 宿主入口：注册 adapter、首轮加载清单、挂路由 |
| `src/client/` | 浏览器入口 + 卡片（只 require `react`） |

关键设计：**模型清单的权威是这个插件自己**。`LlmAdapter.listModels()` 返回的就是勾选集，勾选为空时返回 `[]` —— 宿主允许空目录，于是模型选择器里干干净净什么都不显示，正是要的行为。

## 许可

MIT。`src/zen-ids.ts` / 免费车道闸门 / models.dev 解码 / 错误分类的原始协议工作来自 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（MIT, Copyright (c) 2026 FishBottle7），详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

上游服务由 OpenCode 运营，与本项目无关。
