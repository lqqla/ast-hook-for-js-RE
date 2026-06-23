const express = require("express");
const bodyParser = require("body-parser");
const {injectHook} = require("../components/global-assign-hook-component/core/inject-hook");

const app = express();

// ============ 新增：eval sourceURL 辅助函数开始 ============
// 给同一段 eval 代码生成稳定短 ID，用在虚拟文件名里。
// 这里不用 crypto，是为了保持最小改动，不额外引入 Node 依赖。
function hashCode(s) {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16);
}

// 删除代码里已有的 //# sourceURL=...，避免后面追加时出现多个 sourceURL。
function removeSourceURL(jsCode) {
    return jsCode.replace(/\n?\/\/# sourceURL=.*$/gm, "");
}

// 给 hook 后的 eval 代码追加 sourceURL，让 DevTools/调用栈显示成一个虚拟 JS 文件。
function appendSourceURL(jsCode, sourceURL) {
    return removeSourceURL(jsCode) + "\n//# sourceURL=" + sourceURL;
}
// ============ 新增：eval sourceURL 辅助函数结束 ============

app.use(bodyParser.raw({
    verify: function (req, res, buf, encoding) {
        if (buf && buf.length) {
            const contentType = req.headers["content-type"];
            // ============ 改动：charset 兜底开始 ============
            // 老版这里直接取 [1]，请求头没有 charset 时会报错。
            // 这里默认 utf-8，避免 eval 请求未显式设置 Content-Type 时服务端异常。
            const charset = /charset=([\w-]+)/.exec(contentType)?.[1] || "utf-8";
            // ============ 改动：charset 兜底结束 ============
            console.log(charset);
            req.rawBody = buf.toString(charset);
        }
    }, type: function () {
        return true
    }
}));
// 将传过来的js代码注入hook
app.post("/hook-js-code", function (request, response) {
    const jsCode = decodeURIComponent(request.body.toString());
    let newJsCode = jsCode;
    // ============ 新增：识别 eval 请求开始 ============
    // eval 插件通过 ?sourceType=eval 标记请求来源。
    // 这里仍兼容 x-ast-hook-source-type，但最小改动版默认不在前端设置这个请求头，避免触发 OPTIONS 预检。
    const sourceType = request.query.sourceType || request.headers["x-ast-hook-source-type"] || "";
    // ============ 新增：识别 eval 请求结束 ============
    try {
        newJsCode = injectHook(jsCode);
    } catch (e) {
        console.error(e);
    }
    // ============ 新增：只给 eval 代码追加 sourceURL 开始 ============
    // 普通 JS 注入不进这个分支；只有 eval 代码会获得虚拟文件名。
    // 这样 Chrome DevTools/console 里更容易看到 eval 内部的行列位置。
    if (sourceType === "eval") {
        const sourceURL = `http://127.0.0.1:10010/ast-hook-eval/eval-${hashCode(jsCode)}.js`;
        newJsCode = appendSourceURL(newJsCode, sourceURL);
    }
    // ============ 新增：只给 eval 代码追加 sourceURL 结束 ============
    // ============ 改动：charset 兜底开始 ============
    // 响应 charset 同样做兜底，避免 content-type 缺少 charset 时异常。
    const charset = /charset=([\w-]+)/.exec(request.headers["content-type"])?.[1] || "utf-8";
    // ============ 改动：charset 兜底结束 ============
    console.log(charset);
    response.setHeader("Content-Type", `text/plain; charset=${charset}`);
    //response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "*");
    response.send(encodeURIComponent(newJsCode));
    response.end();
})

// 以后如果能够和页面上双向通信，上报各种数据到这里，就能够实现功能更强的分析之类的

const server = app.listen(10010, function () {
    console.log("启动成功");
})
