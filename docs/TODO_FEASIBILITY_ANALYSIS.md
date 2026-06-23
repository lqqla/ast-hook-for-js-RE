# ast-hook-for-js-RE TODO 可行性分析

这份文档专门分析项目中作者留下的 TODO、README 中的计划功能，以及这些功能在当前架构下是否可实现、应该怎么实现、难度和风险在哪里。

它不是最终设计文档，而是后续继续讨论和补充注释的底稿。

## 一、TODO 来源汇总

目前能看到的 TODO 主要来自这些位置：

```text
README.md
src/components/global-assign-hook-component/core/plugins-manager.js
src/components/global-assign-hook-component/plugins/string-put-to-db-plugins.js
src/api-server/api-server.js
```

README 中的 v0.3 TODO：

```text
script hook plugins，通过 script 设置 innerHTML 动态插入到页面中的逻辑也能够 Hook 到
eval hook plugins 想办法能够直接定位到 jsvm 中，现在只能知道是在 eval 中，但跳不到 vm 中
cache 的逻辑优化
想办法对定位 doc 请求 url 中的加密参数能够起到一定的帮助作用
```

源码中的 TODO 或扩展想法：

```text
妥善处理 Worker 环境
更多类型搞进来
变量数据库是否应该大而全，还是针对性取舍
Buffer 类结构直接运算 Hook 不到的问题
以后如果能够和页面上双向通信，上报各种数据到 api-server，可以做更强分析
```

## 二、总体判断

这些 TODO 大多数都有实现可能，但实现层次不同。

可以粗略分成三类：

```text
插件层可完成：
  动态 script hook
  更多变量类型采集
  fetch / XHR / location / history 辅助定位

需要插件 + api-server 配合：
  eval sourceURL 定位
  动态 script 内容二次 AST hook
  页面数据集中上报

需要改 AST 或核心运行时：
  Worker 兼容
  Buffer / TypedArray 深度追踪
  更多 AST hook 点
  缓存体系重构
```

实现难点不在“能不能写”，而在副作用控制：

- hook 越多，页面性能开销越大。
- patch 浏览器原生 API 越多，越容易被页面检测。
- AST 改写越深入，越容易改变代码时序或语义。
- 采集数据越多，越容易产生内存和搜索性能问题。

因此这个项目后续扩展应该优先保持“小而可控”：先做定向、过滤、缓存正确性，再扩大 hook 覆盖范围。

## 三、TODO 1：动态 script hook

### 作者原意

让这种动态插入的代码也能被 hook：

```js
const script = document.createElement("script");
script.innerHTML = "var token = encrypt(data);";
document.body.appendChild(script);
```

当前代理层能处理网络响应和 HTML 里的静态内联 script，但页面运行时动态创建的 script 字符串不再经过代理，因此当前项目捕获不到。

### 是否可实现

可实现。

建议第一版做成浏览器端插件：

```text
src/components/global-assign-hook-component/plugins/script-hook-plugins.js
```

然后在：

```text
src/components/global-assign-hook-component/core/plugins-manager.js
```

中把插件加入 `pluginsNames`。

### 实现思路

插件层 patch 常见 DOM API：

```text
HTMLScriptElement.prototype.text
HTMLScriptElement.prototype.textContent
Element.prototype.innerHTML
Node.prototype.appendChild
Node.prototype.insertBefore
Node.prototype.replaceChild
document.write
document.writeln
```

核心流程：

```text
页面创建 script
  ↓
页面设置 script.innerHTML / textContent / text
  ↓
插件拦截到 script 内容
  ↓
同步请求 api-server 的 /hook-js-code
  ↓
api-server 调用 injectHook()
  ↓
插件把 script 内容替换成 hook 后代码
  ↓
页面继续插入并执行 script
```

可以复用现有 eval 的本地 API：

```text
POST http://127.0.0.1:10010/hook-js-code
```

但更理想的是给 api-server 增加 sourceType：

```text
POST /hook-js-code?sourceType=dynamic-script
```

这样后续日志、缓存、sourceURL 都能区分 eval 和动态 script。

### 第一版可以只覆盖哪些情况

建议第一版先覆盖：

```js
script.innerHTML = "...";
script.textContent = "...";
script.text = "...";
parent.appendChild(script);
```

暂时不强行覆盖所有 DOM 插入方式。先保证可用，再逐步扩展。

### 风险和边界

- patch DOM 原型可能影响页面原本逻辑。
- `innerHTML` 里可能包含 HTML，不一定只是 JS 字符串。
- script 可能带 `src`，外链脚本不应该在动态 script 插件里处理。
- 异步 hook 会改变执行时序，因此多数情况下需要同步请求。
- 页面可能检测原生函数 `toString()`。
- 页面可能用 CSP 阻止动态脚本或本地请求。

### 难度评估

中等。

基础版本不难，难点是覆盖所有插入路径和减少副作用。

### 推荐优先级

中高。

现代前端里动态脚本不少，这个 TODO 的收益比较直接。

## 四、TODO 2：eval hook 定位到 JSVM

### 作者原意

当前 eval 插件已经可以 hook eval 字符串，但在 Chrome DevTools 里定位体验差。用户能知道“代码在 eval 中”，但不能很好跳到具体 VM 脚本位置。

### 是否可实现

部分可实现。

最现实的目标是：

```text
让 eval 代码在 DevTools Sources 中显示成稳定、可点击、可区分的虚拟文件。
```

### 实现思路一：追加 sourceURL

在 api-server 处理 eval 代码后，给返回内容追加：

```js
//# sourceURL=ast-hook-eval/eval-<hash>.js
```

例如：

```js
newJsCode += "\n//# sourceURL=ast-hook-eval/eval-" + hash + ".js";
```

这样 Chrome DevTools 会把 eval 代码展示成一个命名脚本，而不是普通的 `VM123`。

当前第一版采用的是更容易被 console 自动识别为可点击链接的 URL 形式：

```js
//# sourceURL=http://127.0.0.1:10010/ast-hook-eval/eval-<hash>.js
```

配套实现：

```text
eval-hook-plugins.js:
  调用 /hook-js-code?sourceType=eval，标记这次 hook 来源是 eval。

api-server.js:
  对原始 eval 代码计算 hash。
  把 hook 后代码保存到 runtime-code-cache/eval/。
  给返回代码追加 sourceURL。
  提供 GET /ast-hook-eval/eval-<hash>.js，方便点击或打开虚拟 eval 文件。

search-strings-db-plugins.js:
  如果调用栈里出现 http://127.0.0.1:10010/ast-hook-eval/eval-xxx.js:行:列，
  优先把这个地址作为搜索结果的 codeAddress 打印。
```

目标效果是把搜索结果中的代码位置从：

```text
eval at window.eval (https://example.com/jquery.js:376:27)
```

提升为：

```text
http://127.0.0.1:10010/ast-hook-eval/eval-a1b2c3d4e5f6.js:1:18423
```

这样在 Chrome console 中更接近普通 JS 文件 `url:line:column` 的点击跳转体验。

### 实现思路二：记录 eval 元信息

`eval-hook-plugins.js` 调用本地 API 时额外带上：

```json
{
  "sourceType": "eval",
  "pageUrl": location.href,
  "stack": new Error().stack,
  "code": "..."
}
```

api-server 保存：

```text
eval hash
页面 URL
调用栈
原始 eval 代码
hook 后代码
生成的 sourceURL
时间戳
```

这样搜索结果里可以提示：

```text
这个变量来自 eval-xxxx.js
eval 调用点来自 main.js:line:column
```

### 实现思路三：source map

更进一步可以生成 source map，把 hook 后代码映射回 eval 原始代码。

但这一步难度明显上升，因为当前 `injectHook()` 使用 Babel generator 压缩输出，代码结构和行列号会变化。

如果要做 source map，需要：

- `babel.parse` 保留 source location。
- `generator` 开启 sourceMaps。
- eval 返回代码中追加 sourceMappingURL。
- api-server 提供 source map 文件或 data URL。

### 风险和边界

- `sourceURL` 只能改善 DevTools 展示，不等于完美源码映射。
- eval 原始代码如果被压缩成一行，定位仍然粗糙。
- AST 改写后行号可能和原始 eval 不一致。
- 如果页面对 eval 返回值、时序、调用栈敏感，仍可能出问题。

### 难度评估

基础 `sourceURL`：低到中。

记录 eval 元信息：中等。

source map 精准映射：高。

### 推荐优先级

中高。

`sourceURL` 版本性价比很高，值得较早做。

## 五、TODO 3：cache 逻辑优化

### 当前问题

当前缓存大致按 URL 存：

```text
url -> cache filepath
```

缓存文件名使用：

```js
md5(url)
```

这会带来几个问题：

- 同一个 URL 内容变化后可能复用旧缓存。
- 修改 `inject-hook.js` 后可能复用旧缓存。
- 修改插件或运行时代码后，缓存文件本身不变，但前置 runtime 会变。
- 后续做定向注入时，不同规则可能误用同一个缓存。
- `meta.jsonl` 会不断追加，缺少清理机制。
- 缓存目录是相对路径 `./js-file-cache`，和启动目录绑定，容易和 README 描述不一致。

### 是否可实现

可实现，而且建议优先做。

它和“特定 JS 定向注入”直接相关。

### 实现思路

设计新的 cache key：

```text
cacheKey = md5(
  url +
  bodyHash +
  injectHookVersionHash +
  targetRuleHash
)
```

其中：

```text
bodyHash:
  当前 JS 响应内容 hash

injectHookVersionHash:
  inject-hook.js 文件内容 hash

targetRuleHash:
  当前命中的定向注入规则 hash
```

缓存文件结构建议：

```text
js-file-cache/
  meta.json
  files/
    <cacheKey>.js
```

meta 记录：

```json
{
  "cacheKey": "...",
  "url": "...",
  "bodyHash": "...",
  "ruleName": "...",
  "injectHookHash": "...",
  "filepath": "...",
  "createdAt": 1710000000000,
  "lastUsedAt": 1710000100000
}
```

### 可以顺手修的点

- 用 `__dirname` 或项目根目录计算缓存绝对路径。
- AST 转换失败不写缓存。
- 小文件是否缓存做成配置。
- 增加 `disableCache` 配置项。
- 增加最大缓存数量或 TTL。
- 启动时校验缓存文件是否存在，不存在就丢弃 meta。

### 风险和边界

- cache key 变复杂后，需要认真处理旧缓存兼容。
- 如果每次 body 都变化，缓存命中率会下降。
- body hash 对大文件有轻微开销，但比 AST 转换小很多。

### 难度评估

低到中。

代码量不大，但要设计清楚，否则后续定向注入会被缓存坑到。

### 推荐优先级

最高。

建议在定向注入前或同一阶段完成。

## 六、TODO 4：帮助定位 document 请求 URL 中的加密参数

### 作者原意

当前工具主要靠用户从 Network 面板复制请求参数，再在 console 中手动 `search()`。

作者想让工具对 document 请求 URL 里的加密参数也有帮助。这里的 document 请求可以理解为页面导航、表单提交、location 跳转这类请求。

### 是否可实现

可实现，但会分阶段。

最小可行版本是“自动捕获请求 URL 并辅助搜索参数值”。

### 实现思路一：浏览器端请求 API hook

新增插件，例如：

```text
request-url-helper-plugins.js
```

patch：

```text
window.fetch
XMLHttpRequest.prototype.open
HTMLFormElement.prototype.submit
history.pushState
history.replaceState
location.assign
location.replace
```

当发现 URL 里有 query 参数时：

```text
解析 URL
提取参数名和值
调用现有 stringsDB 搜索
把结果打印出来
```

输出可以类似：

```text
[request-url-helper] GET /api/list?m=xxx
param: m = xxx
matched variable:
  name: sign
  execOrder: 100233
  codeLocation: ...
```

### 实现思路二：代理层记录 document 请求

AnyProxy 的 requestDetail 能看到请求 URL。可以在代理规则里记录：

```text
document 请求 URL
请求时间
query 参数
referer
```

但代理层无法直接访问浏览器里的 `stringsDB`，所以如果要自动关联变量数据库，需要和页面插件或 api-server 通信。

### 实现思路三：集中到 api-server

更完整的架构：

```text
页面插件上报变量数据库
代理或插件上报请求 URL
api-server 做参数值和变量值的关联搜索
console 或 Web UI 展示结果
```

这样 document 请求、XHR、fetch、iframe 请求都能统一分析。

### 风险和边界

- 自动搜索所有 URL 参数可能产生大量噪声。
- 参数可能经过 URL encode，需要做多种变体匹配。
- document 跳转可能发生在页面卸载前，异步上报可能来不及。
- location 相关属性有些不可直接重写，需要选择可 patch 的入口。

### 难度评估

最小浏览器插件版本：中等。

代理 + api-server + 页面数据关联版本：中高。

### 推荐优先级

中等。

建议等定向注入、缓存和 eval sourceURL 稳定后再做。

## 七、TODO 5：妥善处理 Worker 环境

### 当前问题

当前运行时代码依赖：

```js
window
document
iframe
postMessage
XMLHttpRequest
```

Worker 环境中没有 `window` 和 `document`，全局对象通常是 `self`。因此当前 `plugins-manager.js` 里有 TODO：

```text
妥善处理 Worker 环境
```

### 是否可实现

可实现，但需要拆分运行时代码。

### 当前项目到底怎么处理 Worker

当前项目并没有真正支持 Worker。更准确地说：

```text
代理层可能会把 Worker 脚本当作普通 JS 响应注入，
但注入进去的 hook runtime 和插件大概率无法在 Worker 环境里正常运行。
```

例如页面主线程中有：

```js
const worker = new Worker("/worker.js");
```

如果 `/worker.js` 经过 AnyProxy，并且响应头 `Content-Type` 包含 `javascript`，那么当前 `global-assign-hook-component-main.js` 仍然会把它当作普通 JS 响应处理：

```text
loadPluginsAsStringWithCache() + injectHook(workerJsBody)
```

也就是说，Worker 脚本也可能被 AST 改写，里面会出现：

```js
cc11001100_hook(...)
```

问题在于，拼到最前面的运行时代码不适配 Worker。

`plugins-manager.js` 当前拼出的 loadOnce 逻辑里有类似判断：

```js
if (!window) {
    return;
}
```

这段代码在 Worker 中不是“判断没有 window 然后退出”，而是会先访问一个不存在的变量 `window`，直接触发：

```text
ReferenceError: window is not defined
```

即使这里改成了安全判断，后面的 `hook.js` 和插件也大量依赖 `window`：

```js
window.cc11001100_hook
window.location.href
window.addEventListener
document.getElementsByTagName("iframe")
```

Worker 环境里通常没有：

```text
window
document
iframe
DOM
```

Worker 的全局对象通常是：

```js
self
```

所以当前状态不是“Worker 被正确跳过”，也不是“Worker 被正确支持”，而是：

```text
Worker JS 可能进入注入流程，但 runtime 不兼容，可能导致 Worker 脚本报错。
```

这就是作者留下“妥善处理 Worker 环境” TODO 的直接原因。

### 为什么 Worker 对这个项目重要

一些网站会把加密、压缩、签名、图片处理或混淆执行逻辑放到 Worker 中。

主线程代码可能只有：

```js
const worker = new Worker("/crypto-worker.js");
worker.postMessage({
    payload: rawData
});

worker.onmessage = function (event) {
    const sign = event.data.sign;
};
```

真正的逻辑在 Worker 文件里：

```js
self.onmessage = function (event) {
    const sign = encrypt(event.data.payload);
    self.postMessage({sign});
};
```

如果项目不能在 Worker 里工作，那么用户在主页面 console 中搜索变量时，可能看不到 Worker 内部的关键中间值。

这类场景下，主线程只看得到输入和输出，看不到 Worker 内部的数据流。

### 实现思路

第一步，把 `hook.js` 从 `window` 改成通用 root：

```js
const root = typeof window !== "undefined" ? window : self;
```

然后把：

```js
window.cc11001100_hook
```

改成：

```js
root.cc11001100_hook
```

第二步，插件按环境加载：

```text
通用插件：
  hook.js
  string-put-to-db-plugins.js 的核心存储逻辑

window 专用插件：
  search-strings-db-plugins.js 中依赖 iframe/document 的部分
  eval-hook-plugins.js 中依赖 window.eval 的部分
  动态 script hook

worker 专用插件：
  self.importScripts hook
  Worker 内部 fetch/XHR hook
  self.postMessage 上报
```

第三步，处理 Worker 脚本入口。

Worker 脚本通常通过网络请求加载：

```js
new Worker("/worker.js");
```

如果代理能识别 `/worker.js` 是 JavaScript 响应，理论上可以走现有 JS 响应注入。但注入的 runtime 必须能在 Worker 里执行。

### 分阶段实现建议

#### 阶段 1：先避免误伤 Worker

如果暂时不打算完整支持 Worker，第一步至少应该避免 Worker 被错误注入后直接报错。

最低成本修复是让 runtime 的环境判断变安全：

```js
const root = typeof window !== "undefined"
    ? window
    : (typeof self !== "undefined" ? self : globalThis);

if (!root) {
    return;
}
```

然后对依赖 DOM 的插件做环境判断：

```js
const isWindowContext = typeof window !== "undefined" && typeof document !== "undefined";
const isWorkerContext = typeof self !== "undefined" && typeof document === "undefined";
```

这样至少不会因为访问 `window` 直接炸掉。

但这还不是完整 Worker 支持，只是避免误伤。

#### 阶段 2：让基础 hook 在 Worker 中可运行

这一阶段目标是让 Worker 内的 `cc11001100_hook(...)` 能正常执行并记录数据。

需要做：

```text
hook.js 使用 root，而不是 window
string-put-to-db-plugins.js 使用 root，而不是 window
Worker 中的 location 信息改成 self.location.href
search-strings-db-plugins.js 的 document / iframe 逻辑在 Worker 中禁用
eval-hook-plugins.js 按环境判断是否启用
```

这样 Worker 内部至少可以维护自己的变量数据库：

```js
self.cc11001100_hook.stringsDB
```

但这份数据库仍然在 Worker 线程内部，主页面 console 不一定能直接访问。

#### 阶段 3：把 Worker 数据回传出来

为了让用户在主页面也能搜到 Worker 中的数据，需要把 Worker 里的 hook 数据送出来。

两条路线：

```text
Worker -> 主线程：
  通过 postMessage 把 hook 数据发回主线程。

Worker -> api-server：
  Worker 直接 fetch / XHR 上报到 http://127.0.0.1:10010。
```

主线程路线更贴近浏览器通信模型，但需要处理 message 通道和 Worker 构造函数包装。

api-server 路线更统一，后续 iframe、Worker、eval、请求 URL 都可以集中存储和搜索。

#### 阶段 4：支持 importScripts 和 Worker 内动态代码

Worker 中常见加载方式：

```js
importScripts("/lib.js", "/crypto.js");
```

如果这些脚本经过代理，理论上也能被注入。但如果想在 Worker 内部捕获动态加载行为，可以在 Worker runtime 中 patch：

```js
self.importScripts
```

这个阶段属于增强覆盖范围，不建议第一版就做。

### 风险和边界

- Worker 没有 DOM，很多插件不能直接复用。
- Worker 和页面主线程的数据不共享，需要 postMessage 或 api-server 集中。
- SharedWorker、ServiceWorker 又各有生命周期和限制。
- ServiceWorker 受 HTTPS、作用域、缓存影响，复杂度更高。

### 难度评估

普通 Worker：中等。

SharedWorker / ServiceWorker 完整支持：高。

### 推荐优先级

中低。

除非目标站大量使用 Worker，否则可以先不做。

## 八、TODO 6：更多变量类型采集

### 当前问题

`string-put-to-db-plugins.js` 目前主要保存字符串类型。

代码里有 TODO：

```text
更多类型搞进来
为什么一定要大而全，也许应该针对性取舍
```

### 是否可实现

可实现。

这是最适合插件化扩展的 TODO 之一。

### 实现思路

把当前的 `valueString` 提取逻辑改成序列化函数：

```js
function normalizeValue(value) {
    // 返回 { valueText, valueType, shouldSave }
}
```

支持类型：

```text
string
number
boolean
bigint
null
undefined
Array
Plain Object
ArrayBuffer
TypedArray
URLSearchParams
FormData
```

建议加限制：

```text
最大保存长度
最大数组元素数
最大对象字段数
是否启用对象 JSON 序列化
是否只保存命中特征的值
```

否则变量数据库会很快变大。

### 推荐策略

不要“大而全”默认开启。建议做成配置：

```js
const captureConfig = {
    string: true,
    number: false,
    boolean: false,
    object: false,
    typedArray: true,
    maxValueLength: 3000,
    minStringLength: 4,
};
```

### 风险和边界

- JSON.stringify 可能触发循环引用错误。
- 对象序列化可能触发 getter，改变页面行为。
- 大量 number / boolean 噪声非常多。
- 保存对象和数组会显著增加内存。

### 难度评估

低到中。

基础类型很简单，对象和二进制类型要谨慎。

### 推荐优先级

中等。

建议在有定向注入后再做，否则全站全量采集容易噪声爆炸。

## 九、TODO 7：Buffer / TypedArray 直接运算 Hook 不到

### 作者原意

有些加密参数不是以字符串形式流转，而是以字节数组、Buffer、TypedArray、ArrayBuffer 等形式参与计算，最后才转成字符串。

当前项目主要 hook 赋值点，如果中间一直是二进制结构，且插件只保存字符串，就很难搜索到。

### 是否可实现

部分可实现。

但要区分两件事：

```text
保存二进制变量值：
  可以通过插件增强实现。

追踪二进制运算过程：
  需要 hook 更多 API 或 AST 节点，难度更高。
```

### 实现思路一：保存 TypedArray / ArrayBuffer

在 `string-put-to-db-plugins.js` 增强序列化：

```js
ArrayBuffer -> hex/base64
Uint8Array -> hex/base64
Int32Array -> 数组摘要
```

保存时可以同时保存：

```text
hex
base64
utf8 尝试解码
长度
类型
```

### 实现思路二：patch 常见字节转换 API

可以新增插件 patch：

```text
TextEncoder.prototype.encode
TextDecoder.prototype.decode
btoa
atob
crypto.subtle.digest
crypto.subtle.encrypt
crypto.subtle.sign
Uint8Array.prototype.set
ArrayBuffer.prototype.slice
```

这样可以捕获字节和字符串之间的转换点。

### 实现思路三：新增 AST hook 点

如果想追踪表达式内部的二进制运算，需要在 `inject-hook.js` 增加对：

```text
CallExpression
NewExpression
ReturnStatement
BinaryExpression
```

的可选 hook。

但这会明显增加插桩量，性能和副作用都更大。

### 风险和边界

- 二进制数据可能很大，直接保存会拖垮内存。
- patch 原生 crypto / TypedArray API 可能被检测。
- 很多 WebCrypto 返回 Promise，需要处理异步返回值。
- hex/base64 只是展示形式，不等于能直接定位源头。

### 难度评估

保存二进制摘要：中等。

patch 常见 API：中高。

完整数据流追踪：高。

### 推荐优先级

中低。

建议等“更多类型采集”稳定后，再挑常见 API 做小范围 patch。

## 十、TODO 8：页面和 api-server 双向通信

### 作者原意

`api-server.js` 里提到，如果能和页面双向通信，把各种数据上报到本地，就能实现更强分析。

当前 api-server 主要只做一件事：

```text
接收 eval 字符串，调用 injectHook，返回 hook 后代码。
```

### 是否可实现

可实现，而且可以作为后续高级功能的基础。

### 实现思路

让浏览器端插件把数据上报到 api-server：

```text
hook 到的变量
请求 URL
eval 元信息
动态 script 元信息
frame 信息
worker 信息
页面 URL
```

api-server 增加接口：

```text
POST /runtime-event
POST /search
GET /sessions
GET /session/:id/events
```

或者使用 WebSocket：

```text
ws://127.0.0.1:10010/runtime
```

页面插件负责上报，api-server 负责集中存储和查询。

### 好处

- 跨 iframe / Worker 数据可以统一。
- 搜索不用依赖当前 console 所在线程。
- 可以持久化分析结果。
- 可以做独立 Web UI。
- 可以把 document 请求、XHR、eval、变量值串起来。

### 风险和边界

- 上报频率太高会明显拖慢页面。
- 需要批量、采样、限流。
- 数据结构需要设计，否则后续不好查。
- 跨域和 CSP 可能阻止上报。
- api-server 的存储策略需要避免内存无限增长。

### 难度评估

基础 HTTP 上报：中等。

WebSocket 实时分析面板：中高。

完整分析平台：高。

### 推荐优先级

中低。

这是长期方向，不是定向注入第一阶段必须项。

## 十一、README 中被划掉的“指定切入点自动扣代码”

### 作者原意

README 里有一个被划掉的计划：

```text
指定切入点，基于 AST 分析依赖，实现简单的自动扣代码
```

这不是当前已实现能力，作者自己也标注为未发布和不确定。

### 是否可实现

理论可实现，但难度高。

这已经从“运行时变量定位工具”变成“静态依赖切片 / 自动扣代码工具”。

### 需要解决的问题

至少需要：

```text
从某个 AST 节点向上找依赖变量
跨作用域解析变量绑定
处理函数调用依赖
处理对象属性依赖
处理闭包
处理模块打包器结构
处理动态属性名
处理混淆控制流
输出可独立运行代码
补齐运行时环境和 polyfill
```

### 难度评估

高。

可以做“简单 case”，但要做到稳定通用非常难。

### 推荐优先级

低。

建议先把定位工具打磨好，再考虑半自动扣代码。

## 十二、建议实现路线

结合当前目标“实现可针对特定 JS 进行定向注入”，推荐路线是：

```text
第一阶段：基础可靠性
  1. cache 逻辑优化
  2. JS 定向注入规则
  3. 日志和命中规则可观测性

第二阶段：调试体验
  4. eval sourceURL
  5. eval 元信息记录
  6. 动态 script hook 基础版

第三阶段：覆盖更多运行时场景
  7. 更多变量类型采集
  8. 请求 URL 参数自动辅助搜索
  9. TextEncoder / TypedArray / crypto 重点 API hook

第四阶段：架构增强
  10. Worker 兼容
  11. 页面数据上报到 api-server
  12. 独立查询或可视化界面
```

这个顺序的原因是：

```text
先控制注入范围，减少副作用；
再提高定位体验；
再扩大 hook 覆盖；
最后做集中分析平台。
```

## 十三、难度总览

| TODO | 可行性 | 难度 | 推荐优先级 | 主要改动位置 |
| --- | --- | --- | --- | --- |
| cache 逻辑优化 | 高 | 低到中 | 最高 | `global-assign-hook-component-main.js` |
| JS 定向注入 | 高 | 中 | 最高 | `global-assign-hook-component-main.js` / 新配置 |
| eval sourceURL | 高 | 低到中 | 高 | `eval-hook-plugins.js` / `api-server.js` |
| 动态 script hook | 高 | 中 | 中高 | 新插件 / `api-server.js` |
| 更多变量类型采集 | 高 | 低到中 | 中 | `string-put-to-db-plugins.js` |
| document URL 参数辅助定位 | 高 | 中到中高 | 中 | 新插件 / api-server 可选 |
| Worker 兼容 | 中高 | 中到高 | 中低 | `hook.js` / `plugins-manager.js` / 插件拆分 |
| Buffer / TypedArray 深度追踪 | 中 | 中到高 | 中低 | 插件 / `inject-hook.js` 可选 |
| 页面和 api-server 双向通信 | 高 | 中到高 | 中低 | `api-server.js` / 新插件 |
| 指定切入点自动扣代码 | 理论可行 | 高 | 低 | 新 AST 分析模块 |

## 十四、后续讨论时可以继续补的点

后续可以针对每个 TODO 继续补充：

```text
最小可行版本代码设计
具体文件改动清单
是否适合做成插件
是否影响定向注入
是否需要 api-server
是否需要改 inject-hook.js
可能的测试样例
失败时如何降级
```

如果后续要先落地定向注入，最值得优先展开的是：

```text
cache 逻辑优化
JS 定向注入规则
eval sourceURL 是否要纳入同一套规则
```
