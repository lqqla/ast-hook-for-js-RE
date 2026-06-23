# ast-hook-for-js-RE 项目理解

这份文档用于从整体上理解 `ast-hook-for-js-RE` 的设计思路、运行链路、模块职责、局部作用和全局作用。它不是逐行源码注释，而是帮助后续修改功能时判断“应该改哪里、为什么这么改、改动会影响什么”。

## 一、这个项目是什么

`ast-hook-for-js-RE` 是一个面向浏览器 JavaScript 逆向分析的辅助工具。

它通过本地代理拦截网页返回的 HTML 和 JavaScript，把原始 JS 代码在浏览器执行前进行 AST 改写，在变量赋值、对象属性初始化、函数参数等位置插入 hook 调用。这样浏览器执行页面逻辑时，工具可以记录运行中的变量名、变量值、执行顺序和代码位置。

可以把它理解成：

```text
浏览器版的 JS 运行时变量观察器
```

它的核心目标不是直接破解某个具体网站，而是帮助分析人员在真实浏览器环境里更快定位：

- 某个加密参数在哪里生成
- 某个变量值最早在哪个代码位置出现
- 参数是由哪些中间变量拼接而来
- 混淆 JS 运行时实际流过了哪些值

## 二、为什么需要这个项目

传统 JS 逆向经常需要在压缩、混淆、动态加载、eval、webpack bundle 中手动搜索和打断点。问题是：

- 加密参数可能不是直接字符串，而是多段变量拼接
- 代码压缩后变量名没有语义
- 同一个值可能经过很多中间变量流转
- 静态搜索搜不到运行时生成的值
- 手动断点需要先知道大概位置

这个项目的思路是反过来：

```text
不先猜代码位置，而是先在运行时记录所有关键变量值，再用目标值反查代码位置。
```

例如浏览器 Network 里看到请求参数 `m=xxxx`，用户把 `xxxx` 复制到 console 里搜索，工具就能从已记录的变量数据库中找出哪些变量曾经出现过这个值，并打印对应的代码位置。之后用户再从那个位置向前追加密逻辑。

## 三、它有什么用

主要用途是辅助定位 JS 逆向分析入口。

典型使用流程：

1. 启动本地代理服务。
2. 浏览器访问目标页面并走本地代理。
3. 代理拦截 JS 响应并插入 hook。
4. 页面正常执行。
5. hook 运行时代码记录变量值。
6. 用户从 Network 复制加密参数。
7. 在 console 中调用搜索函数。
8. 工具打印变量名、变量值、执行顺序、代码位置。
9. 用户点击代码位置或手动跳转到 Sources 面板继续调试。

它适合：

- 定位加密参数生成逻辑
- 分析混淆 JS 的运行时数据流
- 观察变量赋值和对象属性初始化
- 在真实浏览器环境里辅助扣代码

它不直接负责：

- 自动还原完整算法
- 自动破解业务逻辑
- 自动生成可复用 SDK
- 自动处理所有动态代码加载形式

## 四、整体运行链路

整体链路可以分成“代理层、AST 改写层、浏览器运行时层、插件层”。

```text
浏览器请求页面
  ↓
AnyProxy 本地代理拦截响应
  ↓
判断响应类型是 HTML 还是 JavaScript
  ↓
对 JS 代码调用 injectHook() 做 AST 改写
  ↓
把 hook.js 和插件代码拼到业务 JS 前面
  ↓
浏览器执行注入后的 JS
  ↓
业务代码执行到变量赋值等位置时调用 cc11001100_hook()
  ↓
插件接收变量信息并保存、搜索、展示
```

关键入口：

- `src/proxy-server/proxy-server.js`：启动 AnyProxy。
- `src/proxy-server/rules.js`：AnyProxy 响应阶段规则。
- `src/components/global-assign-hook-component/core/global-assign-hook-component-main.js`：响应处理主逻辑。
- `src/components/global-assign-hook-component/core/inject-hook.js`：AST 改写核心。
- `src/components/global-assign-hook-component/core/hook.js`：浏览器端 hook 运行时核心。
- `src/components/global-assign-hook-component/core/plugins-manager.js`：拼接 hook 运行时代码和插件。
- `src/components/global-assign-hook-component/plugins/`：浏览器端插件目录。
- `src/api-server/api-server.js`：辅助处理 eval 代码 hook 的本地 API 服务。

## 五、代理层的作用

代理层负责把网页响应交给项目处理。

入口文件是：

```text
src/proxy-server/proxy-server.js
```

它启动 AnyProxy，监听本地 `10086` 端口，并加载：

```text
src/proxy-server/rules.js
```

`rules.js` 中的核心逻辑是：

```js
beforeSendResponse(requestDetail, responseDetail) {
    globalAssignHookComponent.process(requestDetail, responseDetail);
}
```

也就是说，每个响应在返回浏览器前都会经过 `process()`。

代理层本身不理解 AST，也不做变量分析。它只负责提供“响应被浏览器执行前的改写机会”。

## 六、响应处理层的作用

响应处理主逻辑在：

```text
src/components/global-assign-hook-component/core/global-assign-hook-component-main.js
```

它根据响应头判断类型：

- `Content-Type` 包含 `text/html`：按 HTML 响应处理。
- `Content-Type` 包含 `javascript`：按独立 JS 响应处理。

### HTML 响应

HTML 响应会使用 `cheerio` 解析页面，遍历内联 `<script>` 标签。

当前逻辑只处理：

```html
<script>
  // inline JavaScript
</script>
```

对于这种内联脚本，会调用 `injectHook(jsCode)` 做 AST 改写。

对于外链脚本：

```html
<script src="xxx.js"></script>
```

HTML 处理阶段会跳过，因为外链 JS 会作为单独的 JS 响应再次经过代理处理。

### JavaScript 响应

独立 JS 响应会读取响应 body，然后调用：

```js
const newJsCode = injectHook(body);
responseDetail.response.body = loadPluginsAsStringWithCache() + newJsCode;
```

因此返回给浏览器的最终 JS 结构是：

```text
hook.js + 插件代码 + AST 改写后的业务 JS
```

## 七、AST hook 后代码在哪里

AST hook 后的代码不是仓库里的固定文件，而是运行时生成的。

生成位置在：

```text
src/components/global-assign-hook-component/core/inject-hook.js
```

`injectHook(jsCode)` 接收原始 JS 字符串，解析成 AST，遍历 AST，并把关键表达式改写成 `cc11001100_hook(...)` 调用。

例如原代码：

```js
var token = makeToken(userId);
```

改写后类似：

```js
var token = cc11001100_hook("token", makeToken(userId), "var-init");
```

再例如：

```js
obj.sign = sign;
```

改写后类似：

```js
obj.sign = cc11001100_hook("obj.sign", sign, "assign");
```

改写后的代码会有两个去向：

- 直接拼接运行时代码后返回给浏览器。
- 对较大的 JS，写入 `js-file-cache` 缓存目录，后续相同 URL 可直接复用。

## 八、inject-hook.js 具体 hook 了哪些地方

`inject-hook.js` 当前主要针对 4 类 AST 节点插桩：

```text
VariableDeclaration
AssignmentExpression
ObjectExpression
FunctionDeclaration
```

可以理解为它当前重点观察这 4 类位置：

```text
变量声明初始化
普通赋值表达式
对象字面量属性初始化
函数声明的参数
```

它不是全量 JS 语义追踪器，也不是所有表达式都会 hook。它只是选择一些高收益位置插入 `cc11001100_hook(...)`。

### 1. VariableDeclaration：变量声明初始化

对应代码形态：

```js
var a = value;
let b = makeValue();
const token = sign + timestamp;
```

改写前：

```js
const token = makeToken(userId, timestamp);
```

改写后大致变成：

```js
const token = cc11001100_hook("token", makeToken(userId, timestamp), "var-init");
```

含义是：

- `"token"`：变量名。
- `makeToken(...)`：原始初始化表达式。
- `"var-init"`：hook 类型，表示变量初始化。

`cc11001100_hook()` 会原样返回第二个参数，所以 `token` 最终拿到的仍然是 `makeToken(...)` 的返回值。

这个 hook 点能捕获很多常见中间变量，例如：

```js
const m = encrypt(data);
const sign = md5(m + ts);
const payload = JSON.stringify(params);
```

注意边界：

- 没有初始化值的声明不会 hook，例如 `let a;`。
- `var f = function () {}` 这种 `FunctionExpression` 初始化会被跳过。
- `const f = () => {}` 是 `ArrowFunctionExpression`，当前代码没有专门跳过，可能会被包一层 hook，但字符串数据库插件通常不会保存函数值。
- 解构声明不会逐个 hook 解构出来的变量。

例如：

```js
const {token, sign} = result;
```

当前更接近被改成：

```js
const {token, sign} = cc11001100_hook("", result, "var-init");
```

它能观察到右侧 `result`，但不会分别记录 `token` 和 `sign` 两个变量名对应的值。变量名为空字符串，是因为当前代码只识别 `Identifier` 和 `MemberExpression`，不识别 `ObjectPattern` / `ArrayPattern`。

### 2. AssignmentExpression：赋值表达式

对应代码形态：

```js
a = value;
obj.token = value;
window.sign = sign;
```

改写前：

```js
token = sign + timestamp;
obj.m = token;
```

改写后大致变成：

```js
token = cc11001100_hook("token", sign + timestamp, "assign");
obj.m = cc11001100_hook("obj.m", token, "assign");
```

含义是：

- `"token"` / `"obj.m"`：被赋值的左侧名称。
- 第二个参数：原始右侧表达式。
- `"assign"`：hook 类型，表示赋值。

这个 hook 点适合捕获：

```js
window.__sign = sign;
params.m = encrypt(raw);
headers["x-token"] = token;
```

注意边界：

复合赋值不会记录最终结果，而是记录右侧表达式。

例如：

```js
a += b;
```

当前会更接近变成：

```js
a += cc11001100_hook("a", b, "assign");
```

插件看到的是 `b`，不是 `a + b` 的最终结果。

解构赋值也不会逐个记录字段：

```js
({token, sign} = result);
```

当前更接近：

```js
({token, sign} = cc11001100_hook("", result, "assign"));
```

它观察的是右侧 `result`，不是解构后的 `token` / `sign`。

另外，`i++`、`++i` 这种是 `UpdateExpression`，当前没有 hook。

### 3. ObjectExpression：对象字面量属性初始化

对应代码形态：

```js
const obj = {
    token: token,
    sign: makeSign(),
    page: 1
};
```

改写前：

```js
const params = {
    m: token,
    ts: Date.now(),
    page: 1
};
```

改写后大致变成：

```js
const params = cc11001100_hook("params", {
    m: cc11001100_hook("m", token, "object-key-init"),
    ts: cc11001100_hook("ts", Date.now(), "object-key-init"),
    page: cc11001100_hook("page", 1, "object-key-init")
}, "var-init");
```

这里可能出现两层 hook：

1. 外层 `VariableDeclaration` 记录 `params` 这个变量的初始化。
2. 内层 `ObjectExpression` 记录对象里的每个属性值。

这个 hook 点很有用，因为请求参数经常会先被组装成对象：

```js
const data = {
    page: page,
    m: encrypted,
    sign: sign
};
```

注意边界：

- 属性值是函数表达式时会跳过。
- 属性值是对象字面量时会跳过当前这一层，避免递归处理过深或产生复杂嵌套。
- 对象展开 `...obj` 是 `SpreadElement`，当前逻辑没有专门处理，可能导致后续属性也不再处理。
- getter、setter、对象方法、私有字段等现代对象语法不是这个 visitor 的重点。

例如：

```js
const obj = {
    token,
    nested: {
        sign
    },
    ...extra,
    method() {
        return token;
    }
};
```

当前通常只能比较稳定地 hook 到直接属性值，例如 `token`。`nested` 这种对象值会被跳过，`...extra` 和 `method()` 也不是当前插件擅长处理的形态。

### 4. FunctionDeclaration：函数声明参数

对应代码形态：

```js
function encrypt(data, key) {
    return doEncrypt(data, key);
}
```

改写前：

```js
function encrypt(data, key) {
    return doEncrypt(data, key);
}
```

改写后大致变成：

```js
function encrypt(data, key) {
    cc11001100_hook("data", data, "function-parameter");
    cc11001100_hook("key", key, "function-parameter");
    return doEncrypt(data, key);
}
```

这里和变量赋值不同：它不是把参数重新赋值，而是在函数体开头插入额外表达式，用来观察参数传入时的值。

这个 hook 点适合定位：

```js
function sign(params, secret) {}
function encrypt(payload) {}
function request(page, token) {}
```

注意边界：

- 只处理 `function name(...) {}` 这种 `FunctionDeclaration`。
- 不处理函数表达式的参数，例如 `const f = function (a) {}`。
- 不处理箭头函数参数，例如 `const f = (a) => {}`。
- 默认参数、剩余参数、解构参数不一定能稳定插入。

例如：

```js
function request({token, sign}, page = 1, ...rest) {
    send(token, sign, page);
}
```

当前逻辑不是为这种现代参数写法设计的。它可能无法为每个解构字段生成有效的 hook 语句，也不会分别记录 `token`、`sign`、`page`、`rest` 的语义值。

## 九、inject-hook.js 当前没有覆盖的常见现代语法

这个项目有些年头了，`inject-hook.js` 的插桩点比较朴素。遇到现代前端代码时，要特别注意这些边界：

### 解构

```js
const {a, b} = obj;
const [x, y] = arr;
({token} = result);
```

当前一般只 hook 右侧整体值，不会逐个记录 `a`、`b`、`x`、`y`、`token`。

如果后续要增强解构支持，需要在 `inject-hook.js` 中识别：

```text
ObjectPattern
ArrayPattern
RestElement
AssignmentPattern
```

并展开每个绑定名。

### 箭头函数

```js
const encrypt = (data, key) => {
    return doEncrypt(data, key);
};
```

当前 `FunctionDeclaration` visitor 不会处理箭头函数参数。变量声明层可能会 hook 到 `encrypt` 这个函数值本身，但不会自动在箭头函数体开头插入参数 hook。

如果要支持，需要新增对：

```text
ArrowFunctionExpression
FunctionExpression
```

的处理。

### 函数调用参数

```js
fetch(url, {
    body: sign
});

send(token);
```

当前没有专门 hook `CallExpression` 的每个参数。

对象字面量参数里的属性可能会因为 `ObjectExpression` 被 hook 到，但普通参数 `send(token)` 本身不会作为调用参数被 hook。`token` 是否能被搜索到，取决于它之前是否在变量声明或赋值位置被记录过。

### 返回值

```js
function encrypt(data) {
    return doEncrypt(data);
}
```

当前没有 hook `ReturnStatement`，不会直接记录函数返回值。

如果返回值没有被外部变量接住，例如：

```js
send(encrypt(data));
```

那当前插桩不一定能直接捕获 `encrypt(data)` 的返回值。

### new Function / 动态脚本

```js
new Function(code)();
```

当前 `eval-hook-plugins.js` 只处理 `window.eval`，不处理 `new Function`。

动态创建 `<script>`、Blob URL、Worker 脚本等也不是当前完整覆盖范围。

### class、私有字段、装饰器等

```js
class A {
    #token = "";
    method() {}
}
```

当前没有专门处理 class 字段、私有字段、装饰器等语法。

部分语法还可能因为 `babel.parse(jsCode)` 没有显式配置 parser plugins 而解析失败。

### import/export、模块语法

如果 JS 是 ESM，Babel 是否能顺利解析取决于当前解析配置和具体语法。

即使能解析，当前也不会 hook `import` 进来的绑定本身。`export const a = value` 里的变量声明可能会被变量声明 visitor 处理，但模块加载、导入绑定、动态 import 不是当前核心覆盖点。

### 可选链、空值合并、模板字符串

```js
const token = obj?.data?.token ?? "";
const body = `${prefix}.${sign}`;
```

这类表达式如果出现在变量初始化或赋值右侧，通常会作为整体被 hook。

也就是说，它记录的是：

```text
整个表达式最终结果
```

而不是表达式内部每一步的中间值。

## 十、如何判断一个值会不会被当前 inject-hook 捕获

可以用一个简单规则判断：

```text
这个值是否出现在当前 4 类 hook 点之一？
```

更具体一点：

```text
它是不是变量声明的初始化值？
它是不是赋值表达式的右侧值？
它是不是对象字面量的直接属性值？
它是不是函数声明的入参？
```

如果答案都是否，那当前项目大概率不会直接记录它。

例如：

```js
send(encrypt(data));
```

这里 `encrypt(data)` 是函数调用参数，不是当前 4 类 hook 点。除非 `encrypt(data)` 的内部或外部还有变量声明、赋值、对象属性初始化，否则它的返回值可能不会直接出现在搜索结果里。

改成：

```js
const token = encrypt(data);
send(token);
```

当前项目就能通过 `VariableDeclaration` 捕获 `token`。

这也解释了为什么它适合“定位入口”，但不是完整数据流追踪系统。

## 十一、hook.js 是什么

`hook.js` 是浏览器端运行时的基础函数。

文件位置：

```text
src/components/global-assign-hook-component/core/hook.js
```

AST 改写后的业务 JS 会调用：

```js
cc11001100_hook(name, value, type)
```

但原网页环境里本来没有这个函数，所以项目必须先注入 `hook.js`。

它的核心职责是：

1. 在 `window` 上注册 `cc11001100_hook`。
2. 维护一个回调数组 `cc11001100_hook.hookCallback`。
3. 每次被业务代码调用时，把 `name`、`value`、`type` 传给所有插件回调。
4. 最后原样返回 `value`，尽量不影响原页面逻辑。

简化理解：

```js
function cc11001100_hook(name, value, type) {
    notifyPlugins(name, value, type);
    return value;
}
```

这也是它能尽量保持页面正常运行的原因：业务代码拿到的仍然是原始值。

## 十二、插件是什么

插件是运行在浏览器页面里的扩展逻辑。

插件目录：

```text
src/components/global-assign-hook-component/plugins/
```

当前内置插件包括：

- `string-put-to-db-plugins.js`
- `search-strings-db-plugins.js`
- `eval-hook-plugins.js`

插件一般依赖 `hook.js` 提供的全局对象：

```js
window.cc11001100_hook
```

如果插件希望在每次 hook 触发时执行，就把自己的函数注册进去：

```js
window.cc11001100_hook.hookCallback.push(callback);
```

之后每次业务代码执行到被 AST 改写的位置，都会触发插件回调。

## 十三、hook.js、插件、AST 改写代码的关系

三者不是同一层东西。

```text
inject-hook.js
  负责改写业务 JS，把观察点埋进去。

hook.js
  负责在浏览器里提供 cc11001100_hook()，接住观察点。

plugins/
  负责拿到观察数据后做具体事情。
```

它们的关系是：

```text
原始业务 JS
  ↓ inject-hook.js
带 cc11001100_hook(...) 的业务 JS

hook.js
  ↓ 提供 cc11001100_hook 函数
插件
  ↓ 注册 hookCallback

浏览器执行时：
业务 JS 调用 cc11001100_hook()
  ↓
hook.js 分发给插件
  ↓
插件保存、搜索、打印变量信息
```

如果没有 `inject-hook.js`，业务代码不会调用 `cc11001100_hook()`。

如果没有 `hook.js`，改写后的业务代码会因为找不到 `cc11001100_hook` 而报错。

如果没有插件，hook 仍然会执行并返回原值，但不会保存和展示任何有用数据。

## 十四、plugins-manager.js 的作用

文件位置：

```text
src/components/global-assign-hook-component/core/plugins-manager.js
```

它负责把 `hook.js` 和插件文件拼成一整段浏览器运行时代码。

拼接顺序大致是：

```text
(() => {
    防重复加载逻辑
    hook.js
    string-put-to-db-plugins.js
    search-strings-db-plugins.js
    eval-hook-plugins.js
})();
```

拼接后的代码会被放到被改写业务 JS 的前面：

```text
运行时代码 + AST hook 后的业务代码
```

这样浏览器执行时，先定义 `cc11001100_hook` 和插件能力，再执行业务代码。

它还带有一个短时间内存缓存，避免每个请求都重复读插件文件。

## 十五、现有插件分别做什么

### string-put-to-db-plugins.js

这个插件负责保存字符串类型的变量值。

它会在每次 hook 回调触发时检查 `value`，如果是字符串，就记录到：

```js
window.cc11001100_hook.stringsDB.varValueDb
```

记录内容包括：

- 变量名
- 变量值
- hook 类型
- 执行顺序
- 调用栈推导出的代码位置

它是“变量数据库”的来源。

### search-strings-db-plugins.js

这个插件负责提供搜索能力。

它会暴露：

```js
window.search()
window.searchByValue()
window.searchByName()
```

用户可以在浏览器 console 中搜索某个值或变量名。插件会在变量数据库中查找匹配项，并把结果打印到 console。

它还使用 `postMessage` 尝试在父页面和 iframe 之间传播搜索请求，让多 frame 页面也能查到结果。

### eval-hook-plugins.js

这个插件负责处理 `eval(jsCode)` 场景。

它会替换浏览器中的 `window.eval`，在 eval 执行前，把 eval 字符串发到本地 API：

```text
POST http://127.0.0.1:10010/hook-js-code
```

本地 API 会对这段字符串再次调用 `injectHook()`，返回改写后的代码，然后插件再执行改写后的 eval 内容。

这个设计用于覆盖一部分运行时动态生成代码的场景。

## 十六、api-server 的作用

文件位置：

```text
src/api-server/api-server.js
```

它监听本地 `10010` 端口，主要提供：

```text
POST /hook-js-code
```

用途是给浏览器里的 `eval-hook-plugins.js` 调用。

正常 JS 响应是在代理层被 hook 的；但 eval 里的 JS 字符串是在浏览器运行时才出现的，代理层看不到。所以插件只能把 eval 字符串发回本地 API，让 Node 端用同一套 `injectHook()` 再处理一次。

### eval 处理链路细讲

普通外链 JS 的处理时机是：

```text
浏览器请求 xxx.js
  ↓
代理拿到 JS 响应 body
  ↓
Node 端调用 injectHook(body)
  ↓
浏览器执行改写后的 JS
```

但 `eval` 的处理时机不一样。`eval` 执行的代码通常不是一个独立网络响应，而是页面运行过程中拼出来的一段字符串：

```js
const code = decrypt(payload);
eval(code);
```

在这种情况下，代理层只能看到最初的 JS 文件，看不到 `decrypt(payload)` 最后生成出来的 `code` 字符串。因此项目必须在浏览器运行时拦截 `eval`。

它的实际链路是：

```text
浏览器先执行已注入的插件代码
  ↓
eval-hook-plugins.js 保存原始 window.eval
  ↓
插件替换 window.eval
  ↓
页面业务代码调用 eval(jsCode)
  ↓
新的 window.eval 先拿到 jsCode 字符串
  ↓
通过同步 XMLHttpRequest 发给 http://127.0.0.1:10010/hook-js-code
  ↓
api-server.js 收到 jsCode
  ↓
api-server.js 调用 injectHook(jsCode)
  ↓
返回 AST 改写后的 newJsCode
  ↓
浏览器端插件把 arguments[0] 改成 newJsCode
  ↓
调用原始 eval 执行改写后的代码
```

也就是说，`eval-hook-plugins.js` 自己不做 AST 分析，它只负责在浏览器里“截获 eval 字符串”。真正的 AST 改写仍然复用 Node 端的：

```text
src/components/global-assign-hook-component/core/inject-hook.js
```

这点很重要：普通 JS 响应和 eval 字符串最终走的是同一套 AST 改写逻辑，只是入口不同。

### 为什么 eval 插件要用同步 XHR

`eval` 是一个同步 API。

原始业务代码通常期望：

```js
eval(jsCode);
下一行代码立刻继续执行;
```

如果插件用异步请求把 `jsCode` 发给本地 API，那么请求还没返回，`eval` 就已经来不及替换成改写后的代码了。

所以插件里使用：

```js
xhr.open("POST", "http://127.0.0.1:10010/hook-js-code", false);
```

第三个参数 `false` 表示同步请求。这样浏览器会等本地 API 返回改写后的代码，再继续执行原始 eval。

代价是：如果 `api-server.js` 没有启动，或者请求被拦截、卡住、跨域失败，页面可能会明显卡顿或 eval 逻辑无法按预期被 hook。

### 为什么要 encodeURIComponent / decodeURIComponent

eval 代码本质是一段 JS 字符串，里面可能包含：

- 换行
- 引号
- 百分号
- 非 ASCII 字符
- URL 特殊字符
- 压缩混淆后的复杂符号

为了让这段字符串安全地通过 HTTP body 往返，浏览器端发送前会：

```js
xhr.send(encodeURIComponent(jsCode));
```

Node 端收到后会：

```js
const jsCode = decodeURIComponent(request.body.toString());
```

处理完之后，服务端再把改写后的代码编码返回：

```js
response.send(encodeURIComponent(newJsCode));
```

浏览器端收到后再解码：

```js
newJsCode = decodeURIComponent(xhr.responseText);
```

它的目的不是加密，而是避免 JS 字符串在 HTTP 传输中因为特殊字符被破坏。

### eval 处理什么时候生效

eval hook 生效需要满足这些前提：

1. 当前页面已经成功注入运行时代码和插件。
2. `plugins-manager.js` 的插件列表中包含 `eval-hook-plugins.js`。
3. 页面调用的是 `window.eval(...)` 或能被替换后的 eval 捕获到的调用形式。
4. `src/api-server/api-server.js` 正在运行，监听 `10010` 端口。
5. 页面可以请求 `http://127.0.0.1:10010/hook-js-code`。
6. eval 字符串可以被 Babel 解析。
7. 返回的改写后代码不破坏原 eval 逻辑。

其中最容易漏的是第 4 点：只启动代理服务还不够，分析 eval 时还需要同时启动 `api-server.js`。

### eval 处理什么时候可能不生效

以下情况可能绕过或破坏当前 eval hook：

- 业务代码在插件注入前就保存了原始 eval 引用。
- 业务代码没有调用 `window.eval`，而是调用 `new Function(...)`。
- 业务代码通过动态 `<script>`、Blob URL、Worker、模块加载器等方式执行字符串代码。
- 页面运行在 Worker 环境里，当前插件依赖 `window`，不一定适用。
- CSP 或浏览器策略阻止访问 `127.0.0.1:10010`。
- 本地 `api-server.js` 没启动，导致同步 XHR 卡住或失败。
- eval 里的代码不是完整可解析 JS 片段，`injectHook()` 抛错后会退回原始代码。
- 业务代码检测 `eval.toString()`、调用栈、执行时序或 XHR 行为。

当前插件只把 `window.eval.toString` 伪装成：

```js
function eval() { [native code] }
```

这能绕过一部分简单检测，但不是完整的反检测方案。

### eval 和普通 JS hook 的关系

可以这样理解：

```text
普通 JS hook：
  代理层提前改写网络响应。

eval hook：
  浏览器运行时截获字符串，再发回 Node 端改写。
```

它们的共同点：

- 最终都调用 `injectHook()`。
- 改写后的代码都会调用 `cc11001100_hook(...)`。
- 变量最终仍然进入同一套浏览器端插件系统。

它们的不同点：

- 普通 JS 有 URL 和响应头上下文。
- eval 字符串通常没有独立 URL。
- 普通 JS 可以走响应缓存。
- eval 当前每次调用都实时发给本地 API。
- 普通 JS 的注入发生在浏览器执行前。
- eval 的注入发生在页面运行过程中。

所以后续如果做“针对特定 JS 定向注入”，普通 JS 可以按 URL 规则匹配；但 eval 代码没有天然 URL，需要额外按页面 URL、调用栈、代码内容特征或调用次数来定向。

## 十七、什么时候会起作用

项目起作用需要满足这些前提：

1. 浏览器流量经过本地 AnyProxy。
2. 目标响应经过 `beforeSendResponse`。
3. 响应头能被识别为 HTML 或 JavaScript。
4. JS 内容能被 Babel 成功解析。
5. 注入后的代码在浏览器里能够正常执行。
6. 页面没有完全阻止代理改写后的脚本执行。
7. 如果是 HTTPS，需要浏览器信任 AnyProxy 证书。
8. 如果分析 eval 代码，还需要 `api-server.js` 正在运行。

对于独立 JS 文件，最关键的前提是：

```text
响应头 Content-Type 包含 javascript
```

对于 HTML 内联脚本，最关键的前提是：

```text
HTML 响应能被识别为 text/html，并且脚本是内联 script 内容
```

## 十八、什么时候不会起作用或效果有限

以下场景可能不生效或效果有限：

- JS 响应头不是 `javascript`，导致没有进入 JS 处理逻辑。
- JS 语法 Babel 当前配置无法解析。
- 响应 body 是 JSON，但 Content-Type 被标成 JavaScript。
- 代码使用特殊加载器、模块包装或自校验，改写后触发反调试。
- CSP、SRI、完整性校验或框架运行机制阻止改写后脚本执行。
- Web Worker 场景下 `window` 不存在，当前运行时代码对 Worker 支持不完善。
- 很多值不是通过普通赋值流转，而是藏在 TypedArray、ArrayBuffer、闭包内部或原生 API 返回值里。
- 动态脚本不是通过 `eval`，而是通过 `new Function`、Blob URL、动态 script 标签等方式执行，当前插件未完全覆盖。
- 页面逻辑高度依赖源码格式、函数 `toString()`、堆栈形态或执行时序，AST 改写可能改变可观察行为。

## 十九、局部作用和全局作用

### 局部作用

局部作用指“单个被改写 JS 文件内部”的效果。

对于一个被 hook 的 JS 文件，`injectHook()` 会在这个文件的若干 AST 节点上插入 `cc11001100_hook()` 调用。这样这个文件内部的变量初始化、赋值、对象属性初始化等行为会被观察到。

局部影响包括：

- 当前 JS 文件代码体积变大。
- 当前 JS 文件执行时多了函数调用开销。
- 当前 JS 文件里的部分表达式结构被改变。
- 当前 JS 文件的变量值会进入浏览器端变量数据库。

### 全局作用

全局作用指“整个页面上下文”的效果。

因为 `hook.js` 会把 `cc11001100_hook`、`hook`、`_hook` 等挂到 `window` 上，所以它影响的是当前页面全局环境。

全局影响包括：

- 页面里所有已注入的 JS 会共享同一个 `window.cc11001100_hook`。
- 插件注册的回调对当前页面上下文内所有 hook 点生效。
- `stringsDB` 挂在 `window.cc11001100_hook` 上，是页面级运行时数据库。
- `eval-hook-plugins.js` 会替换当前页面的 `window.eval`。
- 多个脚本只需要加载一次运行时代码，`window.cc11001100_hook_done` 用于防重复加载。

因此，局部是“某个脚本被插桩”，全局是“页面里有一套统一的 hook 运行时和插件系统”。

## 二十、插件化设计的边界

作者提到后续新增功能以插件形式更新，这句话需要区分两类功能。

### 适合用插件新增的功能

插件适合处理“已经 hook 到数据之后要做什么”。

例如：

- 保存更多类型的变量
- 改进搜索展示
- 增加变量过滤
- 增加上报到本地服务
- 记录时间线
- 记录调用栈
- 支持导出变量数据库
- 增强 eval 处理
- 在页面上增加调试面板

这些功能不需要改变业务 JS 的 AST 结构，只需要消费 `cc11001100_hook(name, value, type)` 传来的数据。

### 不适合只用插件新增的功能

如果功能需要“新增埋点位置”，就不能只改插件。

例如：

- hook 函数调用参数
- hook 函数返回值
- hook `new` 表达式
- hook 数组元素
- hook `fetch` 或 XHR 参数构造点
- hook `new Function`
- hook 动态 script 标签
- hook Promise 链路

这些需要修改：

```text
src/components/global-assign-hook-component/core/inject-hook.js
```

因为插件只能处理已经触发的 hook 数据，不能让原始业务 JS 自动多出新的 hook 点。

一句话：

```text
inject-hook.js 决定“在哪里看”，插件决定“看到了以后做什么”。
```

## 二十一、什么前提下应该改哪里

### 想改变哪些 JS 会被注入

应该改：

```text
src/components/global-assign-hook-component/core/global-assign-hook-component-main.js
```

原因是这里负责响应分流和调用 `injectHook()`。

如果要实现“只针对特定 JS 定向注入”，应该在 `processJavaScriptResponse()` 中，在 `injectHook(body)` 之前增加 URL、响应头或 body 特征判断。

必要时新增配置文件，例如：

```text
src/proxy-server/inject-targets.js
```

### 想改变注入哪些运行时插件

应该改：

```text
src/components/global-assign-hook-component/core/plugins-manager.js
```

尤其是其中的插件列表：

```js
const pluginsNames = [
    "string-put-to-db-plugins.js",
    "search-strings-db-plugins.js",
    "eval-hook-plugins.js",
];
```

### 想新增一个拿到变量后的功能

应该新增插件文件：

```text
src/components/global-assign-hook-component/plugins/xxx-plugins.js
```

然后在 `plugins-manager.js` 中加入文件名。

### 想新增 AST 插桩点

应该改：

```text
src/components/global-assign-hook-component/core/inject-hook.js
```

例如新增 Babel visitor，处理新的 AST 节点类型。

### 想改变 hook 分发行为

应该改：

```text
src/components/global-assign-hook-component/core/hook.js
```

例如改变错误处理、回调执行方式、返回值策略、全局变量名等。

这类改动影响面较大，因为所有被 AST 改写的业务 JS 都依赖它。

### 想增强 eval 处理

可能要同时改：

```text
src/components/global-assign-hook-component/plugins/eval-hook-plugins.js
src/api-server/api-server.js
```

浏览器端插件负责拦截 eval，本地 API 负责调用 `injectHook()`。

### 想调整缓存策略

应该改：

```text
src/components/global-assign-hook-component/core/global-assign-hook-component-main.js
```

缓存当前和 JS URL 绑定。如果后续实现定向注入、按规则注入、按 body 特征注入，就需要重新设计缓存 key，避免旧缓存污染新规则。

## 二十二、当前设计的核心假设

项目当前设计建立在几个假设上：

1. 大部分目标 JS 可以被代理层看到。
2. 大部分目标 JS 可以被 Babel 解析。
3. 在赋值、对象属性初始化、函数参数处插桩，就足够定位大量加密参数。
4. `cc11001100_hook()` 原样返回 value，所以对业务逻辑影响较小。
5. 插件运行在浏览器页面中，可以使用 `window`、`console`、`postMessage` 等浏览器能力。
6. 用户最终还是会人工调试，工具主要负责缩短定位入口的时间。

这些假设决定了项目更像“定位工具”，不是完整自动化逆向平台。

## 二十三、实现定向注入时的理解基础

当前项目默认行为接近“全量注入”：

```text
只要响应是 JavaScript，就尝试 AST hook。
```

定向注入要改变的是“是否对某个 JS 响应调用 injectHook()”。

因此第一优先级不应该改 `inject-hook.js`，而应该在响应处理层加规则：

```text
requestDetail.url / response headers / response body
  ↓
是否命中目标规则
  ↓
命中：loadPluginsAsStringWithCache() + injectHook(body)
未命中：原样返回 body
```

同时需要注意：

- 运行时代码只应该随着被 hook 的 JS 一起注入。
- 非目标 JS 不应被 AST 改写。
- 缓存 key 不能只依赖 URL，否则规则变化后可能复用错误结果。
- HTML 内联脚本没有独立 JS URL，如果也要定向，需要按页面 URL 或 script 内容特征匹配。
- eval 没有天然的响应 URL 上下文，如果也要定向，需要额外设计来源信息或特征匹配。

## 二十四、用一句话概括

这个项目的本质是：

```text
通过代理在 JS 执行前做 AST 插桩，再在浏览器运行时用 hook.js 和插件系统收集变量流动信息，帮助逆向人员从运行时值反查代码位置。
```

其中：

```text
代理层提供改写机会。
inject-hook.js 负责插桩。
hook.js 负责接住插桩。
插件负责处理数据。
api-server 辅助处理 eval 动态代码。
```
