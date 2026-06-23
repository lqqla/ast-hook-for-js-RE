# eval 版与原版差异核查

核查对象：

- 原版：`C:\Users\huangyueming.p\Documents\AST内存漫游\ast-hook-for-js-RE-master`
- eval 版：`C:\Users\huangyueming.p\Documents\AST内存漫游\ast-hook-for-js-RE-eval`

对比方式：

```powershell
git diff --no-index --stat -- `
  "C:\Users\huangyueming.p\Documents\AST内存漫游\ast-hook-for-js-RE-master" `
  "C:\Users\huangyueming.p\Documents\AST内存漫游\ast-hook-for-js-RE-eval"
```

语法检查：

```powershell
node --check .\src\api-server\api-server.js
node --check .\src\components\global-assign-hook-component\plugins\eval-hook-plugins.js
node --check .\src\components\global-assign-hook-component\plugins\search-strings-db-plugins.js
```

三个 JS 文件均可被 Node 正常解析。

## 结论

eval 版相对原版的核心变化不是重写 AST 注入逻辑，而是围绕 `eval()` 代码做了三件事：

1. 把 `eval` hook 请求标记成 `sourceType=eval`。
2. API 服务端对 eval 代码追加稳定的 `//# sourceURL=...`，并把原始/注入后的 eval 代码落盘。
3. 搜索结果解析调用栈时，优先识别这个 eval 虚拟文件 URL，方便 Chrome DevTools 点击定位到 eval 内部代码。

跨源触发的根因是：被 hook 的网页页面 origin 通常是目标站点，例如 `https://match.yuanrenxue.cn`，但 eval 插件里的同步 XHR 请求打到 `http://127.0.0.1:10010`。协议、域名、端口任一不同就是不同源，所以浏览器会按 CORS 处理。

最小改动评价：

- 如果目标只是“修 CORS 报错”，当前改动不算最小；只需要给本地 API 增加统一 CORS/OPTIONS 处理即可。
- 如果目标是“让 eval 代码可点击定位，并保留 eval 原文/注入后代码便于复盘”，当前功能代码改动基本聚焦，属于小范围改动；但新增 `runtime-code-cache/`、`js-file-cache/` 和 docs 产物较多，应视为运行/说明产物，不应和核心代码改动混在一起评审。
- `src/proxy-server/rules.js` 只有文件末尾换行变化，没有业务意义。

## 文件级差异

### 功能代码改动

```text
src/api-server/api-server.js
src/components/global-assign-hook-component/plugins/eval-hook-plugins.js
src/components/global-assign-hook-component/plugins/search-strings-db-plugins.js
src/proxy-server/rules.js
```

其中真正有业务逻辑的是前三个文件。

### 新增或移动的文档

```text
docs/EVAL_SOURCEURL_CHANGELOG.md
docs/eval-hook修改说明.md
docs/PROJECT_UNDERSTANDING.md
docs/README.md
docs/TODO_FEASIBILITY_ANALYSIS.md
```

`PROJECT_UNDERSTANDING.md`、`README.md`、`TODO_FEASIBILITY_ANALYSIS.md` 是从原版根目录移动到 `docs/` 下；其中 `TODO_FEASIBILITY_ANALYSIS.md` 有少量内容变化。

### 运行缓存/样本产物

```text
js-file-cache/*.js
js-file-cache/meta.jsonl
runtime-code-cache/eval/*.js
runtime-code-cache/eval/meta.jsonl
```

这些不是源码逻辑，而是运行 hook 后产生或保留的样本/缓存。`runtime-code-cache/eval/meta.jsonl` 里记录了 eval 虚拟文件 ID、sourceURL、原始代码路径、hook 后代码路径和创建时间。

## 为什么会触发跨源

原版 eval 插件会在页面上下文里执行：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code", false);
xhr.send(encodeURIComponent(jsCode));
```

eval 版改为：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code?sourceType=eval", false);
xhr.setRequestHeader("Content-Type", "text/plain; charset=UTF-8");
xhr.send(encodeURIComponent(jsCode));
```

这里的请求发起方是被注入脚本所在页面，不是 Node 服务本身。假设页面地址是：

```text
https://match.yuanrenxue.cn/...
```

目标 API 是：

```text
http://127.0.0.1:10010/...
```

二者协议、主机、端口都不一致，所以是跨源请求。浏览器不会因为目标是 `127.0.0.1` 就跳过同源策略。

原版只在 `POST /hook-js-code` 的业务处理末尾设置：

```js
response.setHeader("Access-Control-Allow-Origin", "*");
response.setHeader("Access-Control-Allow-Methods", "*");
```

这个处理有两个弱点：

1. 如果浏览器先发 `OPTIONS` 预检，原版没有专门处理 `OPTIONS`，预检不会走到 POST 路由末尾。
2. CORS 头只在单个 POST 路由里设置，新增 GET 或 OPTIONS 路径时容易漏。

eval 版把 CORS 头提升成全局中间件：

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

这样 POST、GET、OPTIONS 都会带 CORS 响应头，预检会直接返回 204。

补充注意：当前实际代码里 `eval-hook-plugins.js` 只设置了 `Content-Type`，没有设置 `X-Ast-Hook-Source-Type`。服务端允许 `X-Ast-Hook-Source-Type` 是预留兼容；真正标记 eval 来源依赖 URL query：`?sourceType=eval`。

## 代码改了哪里、有什么用

### 1. `src/components/global-assign-hook-component/plugins/eval-hook-plugins.js`

改动位置：约第 20-22 行。

原版：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code", false);
xhr.send(encodeURIComponent(jsCode));
```

eval 版：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code?sourceType=eval", false);
xhr.setRequestHeader("Content-Type", "text/plain; charset=UTF-8");
xhr.send(encodeURIComponent(jsCode));
```

作用：

- `?sourceType=eval`：告诉服务端这次处理的是 eval 代码。服务端只有看到这个标记，才追加 eval 专用 `sourceURL` 并保存 eval 缓存。
- `Content-Type: text/plain; charset=UTF-8`：显式声明请求体编码，配合服务端 charset 解析，减少不同浏览器/默认头导致的编码不确定性。
- 同步 XHR 保持不变：因为 `window.eval()` 必须同步返回执行结果，异步请求会破坏原调用语义。

### 2. `src/api-server/api-server.js`

#### 2.1 新增 Node 内置模块

改动位置：第 3-5 行。

```js
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
```

作用：

- `crypto`：对 eval 原始代码计算 MD5，生成稳定 ID。
- `fs`：把 eval 原始代码和 hook 后代码写入本地缓存。
- `path`：生成跨平台文件路径，并限制读取文件名。

#### 2.2 新增 eval 缓存目录

改动位置：第 9 行。

```js
const evalCodeCacheDirectory = path.resolve(__dirname, "../../runtime-code-cache/eval");
```

作用：集中保存 eval 运行时代码：

```text
runtime-code-cache/eval/<id>.original.js
runtime-code-cache/eval/<id>.hooked.js
runtime-code-cache/eval/meta.jsonl
```

#### 2.3 新增全局 CORS/OPTIONS 处理

改动位置：第 11-24 行。

作用：

- 给所有 API 响应统一加 `Access-Control-Allow-Origin: *`。
- 允许 `GET,POST,OPTIONS`。
- 允许 `Content-Type, X-Ast-Hook-Source-Type` 请求头。
- 对 `OPTIONS` 预检直接返回 `204`。

这就是跨源问题的主要修复点。

#### 2.4 新增工具函数

改动位置：第 26-56 行。

```js
function ensureDirectoryExists(directory) { ... }
function md5(s) { ... }
function removeSourceURL(jsCode) { ... }
function appendSourceURL(jsCode, sourceURL) { ... }
function saveEvalCode(id, originalJsCode, hookedJsCode, sourceURL) { ... }
```

作用分别是：

- `ensureDirectoryExists`：确保缓存目录存在。
- `md5`：给同一段 eval 代码生成稳定文件名，例如 `eval-9a0aa88b3b46`。
- `removeSourceURL`：删除代码里已有的 `//# sourceURL=...`，避免多个 sourceURL 冲突。
- `appendSourceURL`：给 hook 后代码末尾追加新的虚拟文件 URL。
- `saveEvalCode`：保存原始 eval、hook 后 eval，并追加一行 JSON 元数据。

#### 2.5 调大 bodyParser 请求体上限

改动位置：第 58-64 行。

原版没有 `limit`，eval 版增加：

```js
limit: "50mb"
```

作用：eval 代码可能比普通片段大，避免较大 eval 代码 POST 到本地 API 时被 `body-parser` 拦成 `413 Payload Too Large`。

同时 charset 解析从强制取 `[1]` 改成：

```js
const charset = /charset=([\w-]+)/.exec(contentType)?.[1] || "utf-8";
```

作用：请求头缺少 charset 时不再抛异常，默认按 UTF-8 处理。

#### 2.6 `/hook-js-code` 增加 eval 分支

改动位置：第 75-90 行。

```js
const sourceType = request.query.sourceType || request.headers["x-ast-hook-source-type"] || "";

if (sourceType === "eval") {
    const id = `eval-${md5(jsCode).slice(0, 12)}`;
    const sourceURL = `http://127.0.0.1:10010/ast-hook-eval/${id}.js`;
    newJsCode = appendSourceURL(newJsCode, sourceURL);
    saveEvalCode(id, jsCode, newJsCode, sourceURL);
}
```

作用：

- 从 URL query 或请求头识别 eval 请求。
- 用原始 eval 代码 hash 生成稳定 ID。
- 追加 `//# sourceURL=http://127.0.0.1:10010/ast-hook-eval/<id>.js`。
- 把原始代码和 hook 后代码落盘，便于复查。

这个 `sourceURL` 是让 Chrome DevTools 把 eval 代码显示成类似普通 JS 文件的关键。

#### 2.7 `/hook-js-code` 响应 charset 兜底

改动位置：第 91 行。

```js
const charset = /charset=([\w-]+)/.exec(request.headers["content-type"])?.[1] || "utf-8";
```

作用：避免请求头没有 charset 时服务端报错。

#### 2.8 新增 `GET /ast-hook-eval/:filename`

改动位置：第 101-116 行。

```js
app.get("/ast-hook-eval/:filename", function (request, response) {
    const filename = path.basename(request.params.filename);
    const matcher = /^(eval-[a-f0-9]{12})\.js$/.exec(filename);
    ...
    response.setHeader("Content-Type", "application/javascript; charset=UTF-8");
    response.send(fs.readFileSync(hookedFilePath).toString());
})
```

作用：

- 让 `sourceURL` 指向的虚拟 JS URL 真的可以被本地 API 服务返回。
- Chrome console/DevTools 点击 `http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js:line:column` 时，有机会打开对应 hook 后代码。
- 文件名使用正则 `eval-[a-f0-9]{12}.js` 白名单，并用 `path.basename` 去掉路径部分，降低任意文件读取风险。

### 3. `src/components/global-assign-hook-component/plugins/search-strings-db-plugins.js`

改动位置：约第 195-205 行。

eval 版在解析 `Error().stack` 时新增优先匹配：

```js
let matcher = codeLocation.match(/https?:\/\/127\.0\.0\.1:10010\/ast-hook-eval\/eval-[a-f0-9]+\.js:\d+:\d+/);
if (matcher != null && matcher.length > 0) {
    codeInfo.codeAddress = matcher[0];
}
```

之后才回退到原来的括号匹配：

```js
matcher = codeLocation.match(/\((.+?)\)/);
if (!codeInfo.codeAddress && matcher != null && matcher.length > 1) {
    codeInfo.codeAddress = matcher[1];
} else if (!codeInfo.codeAddress) {
    codeInfo.codeAddress = codeLocation;
}
```

作用：

- 原版通常只能从调用栈里拿到 `eval at window.eval (...)` 外层调用位置。
- eval 版优先提取 `http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js:line:column`。
- 搜索字符串结果打印时更容易点击到 eval 内部具体行列，而不是只跳到触发 eval 的外层脚本。

### 4. `src/proxy-server/rules.js`

实际 diff 只有文件末尾换行变化：

```diff
-}
\ No newline at end of file
+}
```

作用：无业务作用。可以忽略，也可以保留；它不影响代理规则。

## 是否符合最小改动

按目标拆开看：

### 目标 A：只解决跨源/CORS

不完全最小。

最小改动只需要在 `src/api-server/api-server.js` 增加统一 CORS 头和 `OPTIONS` 处理，必要时保留 charset 兜底即可。下面这些都不是修 CORS 必需：

```text
crypto/fs/path
runtime-code-cache/eval
md5/removeSourceURL/appendSourceURL/saveEvalCode
GET /ast-hook-eval/:filename
search-strings-db-plugins.js 的栈解析增强
```

### 目标 B：让 eval 代码可定位、可复盘

基本符合小范围改动。

原因：

- 没有改 AST 注入核心 `injectHook`。
- 没有改代理主流程。
- eval 标记只影响 eval hook 请求。
- sourceURL 追加只在 `sourceType === "eval"` 时执行。
- 搜索结果解析只是增加优先识别 eval 虚拟 URL，原有解析逻辑仍作为 fallback。

但有两个可以进一步收窄的点：

1. `runtime-code-cache/`、`js-file-cache/` 属于运行产物，建议加入 `.gitignore` 或单独存放，不和源码 diff 一起提交。
2. `GET /ast-hook-eval/:filename` 读取的是本地 hook 后代码，这对定位有帮助，但如果只需要 console 显示虚拟 URL，不一定必须提供 GET 服务。

## 建议保留/调整

建议保留：

```text
src/api-server/api-server.js 的全局 CORS/OPTIONS
src/api-server/api-server.js 的 charset 默认 utf-8
src/api-server/api-server.js 的 bodyParser limit: "50mb"
eval-hook-plugins.js 的 ?sourceType=eval
api-server.js 的 sourceURL 追加
search-strings-db-plugins.js 的 eval URL 优先解析
```

建议视情况调整：

```text
runtime-code-cache/
js-file-cache/
```

如果这些只是本地调试产物，建议不要纳入核心改动。

可以忽略：

```text
src/proxy-server/rules.js
```

这只是末尾换行变化，没有功能影响。

## 一句话复盘

这版改动的主线是：页面里的 `eval()` 被拦截后，同步发到本地 API 注入 hook；本地 API 因为跨源请求需要 CORS；eval 版又给 hook 后代码追加 `sourceURL` 并保存缓存，让 DevTools 和搜索结果能尽量定位到 eval 内部代码。
