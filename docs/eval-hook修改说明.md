# eval hook 处理修改说明

## 背景

页面里的 `window.eval` 被 `src/components/global-assign-hook-component/plugins/eval-hook-plugins.js` 包装后，会把即将执行的 eval 代码同步 POST 到本地 API：

```text
http://127.0.0.1:10010/hook-js-code?sourceType=eval
```

本地服务 `src/api-server/api-server.js` 收到代码后执行 `injectHook(jsCode)`，再把注入后的代码返回给浏览器执行。

## 原始问题 1：CORS 预检失败

报错：

```text
Access to XMLHttpRequest at 'http://127.0.0.1:10010/hook-js-code?sourceType=eval'
from origin 'https://match.yuanrenxue.cn' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

原因：

- 浏览器从 `https://match.yuanrenxue.cn` 请求 `http://127.0.0.1:10010`，属于跨源请求。
- eval hook 的 XHR 使用了 POST 和自定义/非简单请求头，浏览器会先发 `OPTIONS` 预检。
- 原服务只在 `POST /hook-js-code` 里设置 CORS 响应头，没有处理 `OPTIONS`，所以预检被浏览器拦截。

修改位置：

```text
src/api-server/api-server.js
```

新增全局 CORS 处理：

```js
function setCorsHeaders(response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Ast-Hook-Source-Type");
}

app.use(function (request, response, next) {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
        response.status(204).end();
        return;
    }
    next();
});
```

同时删除了 `POST /hook-js-code` 内重复设置的：

```js
response.setHeader("Access-Control-Allow-Origin", "*");
response.setHeader("Access-Control-Allow-Methods", "*");
```

因为现在已经由全局中间件统一设置。

## 原始问题 2：413 Payload Too Large

报错：

```text
POST http://127.0.0.1:10010/hook-js-code?sourceType=eval 413 (Payload Too Large)
```

原因：

- eval 代码体积较大。
- `bodyParser.raw()` 没配置 `limit`，使用默认请求体大小上限。
- 请求体超过默认限制后，Express/body-parser 直接返回 413，代码没有进入 `/hook-js-code` 业务逻辑。

修改位置：

```text
src/api-server/api-server.js
```

把 raw body 上限调大：

```js
app.use(bodyParser.raw({
    limit: "50mb",
```

同时把 charset 解析改成带默认值，避免请求头缺少 charset 时触发异常：

```js
const charset = /charset=([\w-]+)/.exec(contentType)?.[1] || "utf-8";
```

以及响应处：

```js
const charset = /charset=([\w-]+)/.exec(request.headers["content-type"])?.[1] || "utf-8";
```

## 当前 eval 请求流程

1. 页面执行 `eval(jsCode)`。
2. `eval-hook-plugins.js` 拦截 `window.eval`。
3. 插件同步请求本地服务：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code?sourceType=eval", false);
xhr.setRequestHeader("Content-Type", "text/plain; charset=UTF-8");
xhr.send(encodeURIComponent(jsCode));
```

4. `api-server.js` 接收请求体并解码：

```js
const jsCode = decodeURIComponent(request.body.toString());
```

5. 执行 AST 注入：

```js
newJsCode = injectHook(jsCode);
```

6. 如果 `sourceType === "eval"`，保存 eval 原始代码和注入后代码：

```text
runtime-code-cache/eval/<id>.original.js
runtime-code-cache/eval/<id>.hooked.js
runtime-code-cache/eval/meta.jsonl
```

7. 给注入后的代码追加 `sourceURL`，方便 Chrome DevTools 定位：

```text
//# sourceURL=http://127.0.0.1:10010/ast-hook-eval/eval-xxxxxxxxxxxx.js
```

8. 浏览器收到注入后的 eval 代码并继续执行。

## 修改后的验证方式

语法检查：

```powershell
node --check .\src\api-server\api-server.js
```

验证 CORS 预检：

```powershell
$headers = @{
  Origin='https://match.yuanrenxue.cn'
  'Access-Control-Request-Method'='POST'
  'Access-Control-Request-Headers'='content-type,x-ast-hook-source-type'
}

Invoke-WebRequest `
  -Uri 'http://127.0.0.1:10010/hook-js-code?sourceType=eval' `
  -Method Options `
  -Headers $headers `
  -UseBasicParsing
```

期望结果：

```text
StatusCode: 204
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET,POST,OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Ast-Hook-Source-Type
```

验证大体积 POST：

```powershell
$body = [uri]::EscapeDataString(("console.log('x');" * 20000))

Invoke-WebRequest `
  -Uri 'http://127.0.0.1:10010/hook-js-code?sourceType=eval' `
  -Method Post `
  -Headers @{ Origin='https://match.yuanrenxue.cn' } `
  -ContentType 'text/plain; charset=UTF-8' `
  -Body $body `
  -UseBasicParsing
```

期望结果：

```text
StatusCode: 200
Access-Control-Allow-Origin: *
```

## 生效注意事项

修改 `src/api-server/api-server.js` 后，必须重启 `10010` API 服务。

示例：

```powershell
node .\src\api-server\api-server.js
```

如果端口已经被旧进程占用，先查 PID：

```powershell
Get-NetTCPConnection -LocalPort 10010
```

再停止对应进程：

```powershell
Stop-Process -Id <PID>
```

## 当前保留的修改

- 保留 CORS/OPTIONS 处理。
- 保留 `bodyParser.raw({ limit: "50mb" })`。
- 保留 charset 默认值 `utf-8`。
- 没有保留额外 eval 调试日志。
- 没有保留代理 `rules.js` 的禁用缓存改动。
