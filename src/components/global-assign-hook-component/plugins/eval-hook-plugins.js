(() => {

    // 是否要在在控制台上打印eval hook日志提醒
    const enableEvalHookLog = true;

    // 用eval执行的代码也要能够注入，我擦开个接口吧...
    const evalHolder = window.eval;
    window.eval = function (jsCode) {

        if (enableEvalHookLog) {
            const isNeedNewLine = jsCode && jsCode.length > 100;
            console.log("AST HOOK工具检测到eval执行代码： " + (isNeedNewLine ? "\n" : "") + jsCode);
        }

        let newJsCode = jsCode;
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("load", () => {
            newJsCode = decodeURIComponent(xhr.responseText);
        });
        // 必须同步执行，否则无法返回结果
        // ============ 新增：标记这是 eval 代码请求开始 ============
        // 只在 URL 上加 ?sourceType=eval，不额外设置请求头。
        // 这样服务端能识别 eval，又尽量保持老版简单 POST 行为，避免触发 OPTIONS 预检。
        xhr.open("POST", "http://127.0.0.1:10010/hook-js-code?sourceType=eval", false);
        // ============ 新增：标记这是 eval 代码请求结束 ============
        xhr.send(encodeURIComponent(jsCode));
        arguments[0] = newJsCode;
        return evalHolder.apply(this, arguments);
    }

    window.eval.toString = function () {
        return "function eval() { [native code] }";
    }

})();
