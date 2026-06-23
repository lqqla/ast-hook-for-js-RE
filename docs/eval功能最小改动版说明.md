# eval 功能最小改动版说明

## 为什么老版没有触发 OPTIONS 预检

老版 `eval-hook-plugins.js` 发请求时只有：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code", false);
xhr.send(encodeURIComponent(jsCode));
```

它仍然是跨源请求，因为页面 origin 可能是 `https://match.yuanrenxue.cn`，目标是 `http://127.0.0.1:10010`。但是这类请求通常属于 CORS 简单请求：

- 方法是 `POST`。
- 没有手动加自定义请求头。
- 请求体是字符串，浏览器默认的 `Content-Type` 通常仍落在简单请求允许范围内。

简单请求不会先发 `OPTIONS` 预检，而是直接发 `POST`。

原版服务端在 `POST /hook-js-code` 返回时已经设置了：

```js
response.setHeader("Access-Control-Allow-Origin", "*");
response.setHeader("Access-Control-Allow-Methods", "*");
```

所以老版虽然跨源，但直接 POST 能拿到允许跨源的响应头，因此没有被 CORS 拦截。

新版之所以容易出现 `OPTIONS`，一般是因为 eval 请求被改成了非简单请求，例如：

- 手动设置了自定义头，如 `X-Ast-Hook-Source-Type`。
- 手动设置了浏览器不认定为 safelisted 的 `Content-Type` 值。

注意：URL 上加 `?sourceType=eval` 不会触发预检；触发预检的关键通常是方法和请求头。

## 当前最小改动目标

目标是实现新版 eval 定位能力，但尽量保持老版请求形态：

1. eval 请求仍然走同步 POST。
2. 不手动设置请求头，避免引入 OPTIONS 预检。
3. 服务端通过 query 参数识别 eval 请求。
4. 只给 eval 代码追加 `//# sourceURL=...`。
5. 搜索结果优先提取 eval 虚拟文件地址。

不保留：

- eval 代码落盘缓存。
- `runtime-code-cache/eval` 写入逻辑。
- `GET /ast-hook-eval/:filename` 文件读取接口。
- 全局 CORS 中间件。
- `crypto/fs/path` 依赖。
- eval 插件里的手动 `Content-Type` 请求头。

## 当前保留的最小代码改动

### 1. `eval-hook-plugins.js`

只把请求 URL 从：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code", false);
```

改成：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code?sourceType=eval", false);
```

作用：不加请求头，只用 query 告诉服务端“这次是 eval 代码”。

### 2. `api-server.js`

新增三个小函数：

```js
function hashCode(s) { ... }
function removeSourceURL(jsCode) { ... }
function appendSourceURL(jsCode, sourceURL) { ... }
```

作用：

- `hashCode`：给同一段 eval 代码生成稳定虚拟文件名。
- `removeSourceURL`：避免原代码里已有 sourceURL 时产生多个 sourceURL。
- `appendSourceURL`：给 hook 后 eval 代码追加虚拟文件名。

在 `/hook-js-code` 里新增 eval 分支：

```js
const sourceType = request.query.sourceType || request.headers["x-ast-hook-source-type"] || "";

if (sourceType === "eval") {
    const sourceURL = `http://127.0.0.1:10010/ast-hook-eval/eval-${hashCode(jsCode)}.js`;
    newJsCode = appendSourceURL(newJsCode, sourceURL);
}
```

作用：只有 eval 请求才追加 `sourceURL`，普通 JS hook 不受影响。

保留老版 POST 响应内 CORS：

```js
response.setHeader("Access-Control-Allow-Origin", "*");
response.setHeader("Access-Control-Allow-Methods", "*");
```

这样简单 POST 仍然能跨源返回。

另外把 charset 读取改成了兜底写法：

```js
const charset = /charset=([\w-]+)/.exec(request.headers["content-type"])?.[1] || "utf-8";
```

作用：请求头没有 charset 时不直接抛异常。

### 3. `search-strings-db-plugins.js`

在解析调用栈时优先识别：

```text
http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js:line:column
```

作用：搜索结果里尽量显示 eval 内部代码位置，而不是只显示 `eval at window.eval (...)` 外层调用位置。

## 当前最小 diff 摘要

核心代码只涉及三个文件：

```text
src/components/global-assign-hook-component/plugins/eval-hook-plugins.js
src/api-server/api-server.js
src/components/global-assign-hook-component/plugins/search-strings-db-plugins.js
```

其中：

- `eval-hook-plugins.js`：只改 1 行 URL。
- `api-server.js`：新增 sourceURL 辅助函数和 eval 分支，保留原 POST CORS 方式。
- `search-strings-db-plugins.js`：只改 `parseCodeLocation()` 的地址提取逻辑。

## 如果仍然遇到 OPTIONS

如果某些浏览器或页面环境仍然发起预检，最小补丁不是恢复全局 CORS，而是只给这个接口加一个 OPTIONS 路由：

```js
app.options("/hook-js-code", function (request, response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.status(204).end();
});
```

但当前最小版优先避免触发预检，所以暂时不加这段。
