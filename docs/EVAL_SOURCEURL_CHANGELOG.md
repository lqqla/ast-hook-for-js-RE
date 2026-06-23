# eval 可点击定位增强变更记录

这份文档记录针对 eval 生成代码定位问题做的第一版改动。

目标是让 eval 内部 hook 到的变量，在 console 搜索结果中尽量显示成类似普通 JS 文件的：

```text
url:line:column
```

从而可以在 Chrome DevTools console 中点击跳转，而不是只能看到：

```text
eval at window.eval (https://example.com/jquery.js:376:27)
```

## 一、问题背景

当前项目原本已经能处理 eval：

```text
业务代码调用 eval(jsCode)
  ↓
eval-hook-plugins.js 拦截 window.eval
  ↓
把 jsCode 发给 api-server.js
  ↓
api-server.js 调用 injectHook(jsCode)
  ↓
返回 hook 后代码给浏览器执行
```

但原始实现有一个定位问题：

```text
eval 代码没有稳定的文件名。
```

所以当 `string-put-to-db-plugins.js` 通过 `new Error().stack` 记录代码位置时，搜索结果里常见的是：

```text
eval at window.eval (https://match.yuanrenxue.cn/static/new_match/jquery/jquery.js:376:27)
```

这只能说明：

```text
eval 是从 jquery.js:376:27 被调用的。
```

但不能直接说明：

```text
变量位于 eval 生成代码内部的哪一行哪一列。
```

用户仍然需要手动跟进 eval 入口，再搜索定位。

## 二、本次改动目标

本次改动目标是：

```text
给 eval 生成代码分配稳定的虚拟 JS 文件 URL，
让 DevTools 和搜索结果尽量能显示 eval 内部的 url:line:column。
```

第一版不追求完美源码映射，也不做 source map。

第一版只做三件事：

```text
标记 eval hook 请求
给 eval hook 后代码追加 sourceURL
让搜索结果优先打印 eval 虚拟文件地址
```

## 三、改动文件总览

本次涉及 4 个文件：

```text
src/components/global-assign-hook-component/plugins/eval-hook-plugins.js
src/api-server/api-server.js
src/components/global-assign-hook-component/plugins/search-strings-db-plugins.js
TODO_FEASIBILITY_ANALYSIS.md
```

其中前三个是功能代码，最后一个是 TODO 分析文档补充。

## 四、改动 1：eval-hook-plugins.js 标记 eval 请求

文件：

```text
src/components/global-assign-hook-component/plugins/eval-hook-plugins.js
```

### 改了什么

原来 eval 插件请求本地 API：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code", false);
xhr.send(encodeURIComponent(jsCode));
```

现在改成：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code?sourceType=eval", false);
xhr.setRequestHeader("Content-Type", "text/plain; charset=UTF-8");
xhr.setRequestHeader("X-Ast-Hook-Source-Type", "eval");
xhr.send(encodeURIComponent(jsCode));
```

### 为什么改

`api-server.js` 的 `/hook-js-code` 不只可能服务 eval，后续动态 script hook 也可能复用它。

因此需要告诉服务端：

```text
这次请求处理的是 eval 代码。
```

服务端只有知道来源是 eval，才会追加 eval 专用的 `sourceURL`。

### 影响范围

只影响 eval 插件调用本地 API 的请求。

普通 JS 响应注入不受影响。

## 五、改动 2：api-server.js 为 eval 生成 sourceURL

文件：

```text
src/api-server/api-server.js
```

### 改了什么

新增依赖：

```js
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
```

新增 eval 代码缓存目录：

```js
const evalCodeCacheDirectory = path.resolve(__dirname, "../../runtime-code-cache/eval");
```

新增辅助函数：

```text
ensureDirectoryExists()
md5()
removeSourceURL()
appendSourceURL()
saveEvalCode()
```

在 `/hook-js-code` 中新增逻辑：

```js
const sourceType = request.query.sourceType || request.headers["x-ast-hook-source-type"] || "";

if (sourceType === "eval") {
    const id = `eval-${md5(jsCode).slice(0, 12)}`;
    const sourceURL = `http://127.0.0.1:10010/ast-hook-eval/${id}.js`;
    newJsCode = appendSourceURL(newJsCode, sourceURL);
    saveEvalCode(id, jsCode, newJsCode, sourceURL);
}
```

### 为什么这样改

Chrome DevTools 支持通过注释给 eval 代码命名：

```js
//# sourceURL=some-file.js
```

如果给 eval 代码追加：

```js
//# sourceURL=http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js
```

那么 DevTools 和调用栈更可能显示这个虚拟文件名。

选择完整 HTTP URL，而不是普通字符串路径，是为了让 console 输出更接近普通网络 JS 文件：

```text
http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js:1:12345
```

这种格式更容易被 Chrome console 当成可点击位置。

### 为什么要 hash

同一段 eval 代码应该有稳定文件名。

因此使用原始 eval 代码计算 MD5：

```js
eval-${md5(jsCode).slice(0, 12)}
```

这样同一段 eval 代码多次执行时，会复用同一个虚拟文件名。

### 为什么要 removeSourceURL

有些 eval 代码自身可能已经带有：

```js
//# sourceURL=...
```

如果直接追加多个 `sourceURL`，DevTools 行为可能不稳定。

所以先移除旧的 `sourceURL`，再追加项目自己的 `sourceURL`。

## 六、改动 3：api-server.js 提供 eval 虚拟文件访问路由

文件：

```text
src/api-server/api-server.js
```

### 改了什么

新增路由：

```js
app.get("/ast-hook-eval/:filename", function (request, response) {
    const filename = path.basename(request.params.filename);
    const matcher = /^(eval-[a-f0-9]{12})\.js$/.exec(filename);
    if (!matcher) {
        response.status(404).end();
        return;
    }
    const hookedFilePath = path.join(evalCodeCacheDirectory, `${matcher[1]}.hooked.js`);
    if (!fs.existsSync(hookedFilePath)) {
        response.status(404).end();
        return;
    }
    response.setHeader("Content-Type", "application/javascript; charset=UTF-8");
    response.send(fs.readFileSync(hookedFilePath).toString());
    response.end();
})
```

### 为什么改

`sourceURL` 指向的是：

```text
http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js
```

如果这个 URL 不能访问，点击时体验会变差。

新增 GET 路由后，这个虚拟 URL 可以返回对应的 hook 后 eval 代码。

### 安全和范围控制

路由只允许访问符合格式的文件名：

```text
eval-[a-f0-9]{12}.js
```

并使用：

```js
path.basename()
```

避免路径穿越。

## 七、改动 4：eval 原始代码和 hook 后代码落盘

文件：

```text
src/api-server/api-server.js
```

### 改了什么

eval 代码会保存到：

```text
runtime-code-cache/eval/
```

每段 eval 保存两个文件：

```text
eval-<hash>.original.js
eval-<hash>.hooked.js
```

同时追加 meta：

```text
runtime-code-cache/eval/meta.jsonl
```

记录内容包括：

```json
{
  "id": "eval-xxxxxxxxxxxx",
  "sourceURL": "http://127.0.0.1:10010/ast-hook-eval/eval-xxxxxxxxxxxx.js",
  "originalFilePath": "...",
  "hookedFilePath": "...",
  "createdAt": 1710000000000
}
```

### 为什么改

即使 DevTools 跳转不理想，用户也可以直接查看落盘文件。

同时这给后续增强留下基础：

```text
记录 eval 调用栈
做 source map
做 eval 代码检索
做 Web UI 展示
```

## 八、改动 5：search-strings-db-plugins.js 优先识别 eval 虚拟 URL

文件：

```text
src/components/global-assign-hook-component/plugins/search-strings-db-plugins.js
```

### 改了什么

在 `parseCodeLocation(codeLocation)` 中新增优先匹配：

```js
let matcher = codeLocation.match(/https?:\/\/127\.0\.0\.1:10010\/ast-hook-eval\/eval-[a-f0-9]+\.js:\d+:\d+/);
if (matcher != null && matcher.length > 0) {
    codeInfo.codeAddress = matcher[0];
}
```

只有没有匹配到 eval 虚拟 URL 时，才走原来的括号解析逻辑。

### 为什么改

原来的解析逻辑主要提取括号里的内容：

```text
eval at window.eval (https://example.com/jquery.js:376:27)
```

它会优先拿到 eval 入口：

```text
https://example.com/jquery.js:376:27
```

但现在我们希望优先展示 eval 内部位置：

```text
http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js:1:12345
```

因此需要先从完整调用栈中找 eval 虚拟文件地址。

## 九、改动 6：TODO 文档补充

文件：

```text
TODO_FEASIBILITY_ANALYSIS.md
```

### 改了什么

在 `eval hook 定位到 JSVM` 小节中补充了本次第一版方案：

```text
sourceURL 使用 http://127.0.0.1:10010/ast-hook-eval/eval-<hash>.js
eval-hook-plugins.js 标记 sourceType=eval
api-server.js 保存 original/hooked 代码
api-server.js 提供 GET /ast-hook-eval/eval-<hash>.js
search-strings-db-plugins.js 优先识别 eval 虚拟 URL
```

### 为什么改

把实现思路和实际落地方案记录下来，方便后续继续迭代：

```text
source map
pretty 输出
eval 调用栈元信息
搜索结果展示优化
```

## 十、预期效果

改动前，搜索结果里的代码位置可能是：

```text
eval at window.eval (https://match.yuanrenxue.cn/static/new_match/jquery/jquery.js:376:27)
```

改动后，理想情况下会变成：

```text
http://127.0.0.1:10010/ast-hook-eval/eval-a1b2c3d4e5f6.js:1:18423
```

这样在 Chrome console 中更接近普通 JS 文件位置，可以尝试直接点击跳转。

如果调用栈中同时存在 eval 内部虚拟 URL 和 eval 入口 URL，搜索结果会优先展示 eval 内部虚拟 URL。

## 十一、如何使用

需要重新启动：

```text
src/api-server/api-server.js
```

也需要刷新目标页面，让新的插件代码注入进去。

如果页面已经加载了旧插件，旧页面不会自动获得新逻辑。

## 十二、验证方式

可以按这个流程验证：

```text
1. 启动 api-server.js。
2. 启动 proxy-server.js。
3. 浏览器走代理访问会触发 eval 的目标页面。
4. 触发 eval 逻辑。
5. 在 console 中用 search/searchByValue 搜索目标值。
6. 观察代码位置是否出现 http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js:line:column。
7. 点击该位置，看 DevTools 是否能跳到 eval 虚拟文件。
8. 检查 runtime-code-cache/eval/ 是否生成 original.js、hooked.js 和 meta.jsonl。
```

## 十三、当前限制

第一版仍有这些限制：

- 当前 `injectHook()` 会压缩输出，因此 eval 虚拟文件可能仍是一行，位置类似 `:1:18423`。
- 没有 source map，无法保证 hook 后代码行列号和原始 eval 代码完全一致。
- 只处理通过 `eval-hook-plugins.js` 发到 `/hook-js-code?sourceType=eval` 的 eval 代码。
- 如果 Chrome 对 `sourceURL` 的展示策略变化，点击行为可能和预期略有差异。
- 如果页面 CSP 或浏览器策略阻止访问 `127.0.0.1:10010`，虚拟 URL 可能无法打开。
- `meta.jsonl` 当前会持续追加，没有清理策略。

## 十四、后续可优化方向

后续可以继续做：

```text
eval 专用 pretty 输出
eval source map
记录 eval 调用栈
搜索结果同时展示 eval 内部位置和 eval 入口位置
给 eval 虚拟文件生成更有语义的名字
meta 去重和缓存清理
把 eval 代码纳入统一 runtime-code-cache 管理
```

其中最值得优先做的是：

```text
搜索结果同时展示：
  eval 内部虚拟 URL
  eval 入口 URL
```

这样既能跳到 eval 内部，也能回到生成 eval 的原始代码。

