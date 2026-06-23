(() => {

    // 检索字符串数据库

    const cc11001100_hook = window.cc11001100_hook;
    const stringsDB = cc11001100_hook.stringsDB;

    // 为什么要采取消息机制呢？
    // 对于浏览器来说，要保证跨域之间的安全，比如使用iframe引入的新的域之中的数据，Chrome似乎是将不同的域隔离在不同的线程中
    // 当前页面中有多少个线程，可以从Chrome的开发中工具的 Sources --> Threads 查看，如果有多个会有这个选项，同时还可以鼠标单击在不同的线程之间切换
    // 但是在console中，输入的命令是运行在当前的线程栈中的，所以这就涉及到一个跨域通信的问题，所以就引入postMessage来在当前页面中有多个线程栈的时候，
    // 执行一条命令时会扩散到所有线程栈中执行，这样使用者就不必在意底层细节了

    // 发送消息时的域名，用于识别内部消息
    const messageDomain = "cc11001100_hook";
    const messageTypeSearch = "search";

    // 防止消息重复处理
    const alreadyProcessMessageIdSet = new Set();

    window.addEventListener("message", event => {
        const eventData = event.data;
        if (!eventData || eventData.domain !== messageDomain) {
            return;
        }

        // 如果已经处理过的话，则不再处理
        const messageId = eventData.messageId;
        if (alreadyProcessMessageIdSet.has(messageId)) {
            return;
        }

        if (eventData.type === messageTypeSearch) {
            const pattern = eventData.pattern;
            const isEquals = eventData.isEquals;
            const fieldName = eventData.fieldName;
            const isNeedExpansion = eventData.isNeedExpansion;
            _search(fieldName, pattern, isEquals, isNeedExpansion);
            alreadyProcessMessageIdSet.add(messageId);
            _searchParentAndChildren(messageId, fieldName, pattern, isEquals, isNeedExpansion);
        }

    });

    window.search = window.searchByValue = cc11001100_hook.search = cc11001100_hook.searchByValue = function (pattern, isEquals = true, isNeedExpansion = true) {
        const fieldName = "value";
        // 先搜索当前页面
        _search(fieldName, pattern, isEquals, isNeedExpansion);
        const messageId = new Date().getTime();
        alreadyProcessMessageIdSet.add(messageId);
        // 然后递归搜索父页面和子页面
        _searchParentAndChildren(messageId, fieldName, pattern, isEquals, isNeedExpansion);
    }

    window.searchByName = cc11001100_hook.searchByName = function (pattern, isEquals = false, isNeedExpansion = false) {
        const fieldName = "name";
        // 先搜索当前页面
        _search(fieldName, pattern, isEquals, isNeedExpansion);
        const messageId = new Date().getTime();
        alreadyProcessMessageIdSet.add(messageId);
        // 然后递归搜索父页面和子页面
        _searchParentAndChildren(messageId, fieldName, pattern, isEquals, isNeedExpansion);
    }

    function _searchParentAndChildren(messageId, fieldName, pattern, isEquals, isNeedExpansion) {
        const searchMessage = {
            "domain": messageDomain,
            "type": messageTypeSearch,
            "fieldName": fieldName,
            "messageId": messageId,
            pattern,
            isEquals,
            isNeedExpansion
        }

        // 子页面
        const iframeArray = document.getElementsByTagName("iframe");
        if (iframeArray.length) {
            for (let iframe of iframeArray) {
                iframe.contentWindow.postMessage(searchMessage, "*");
            }
        }

        // 父页面
        if (window.parent) {
            window.parent.postMessage(searchMessage, "*");
        }
    }

    function _search(filedName, pattern, isEquals, isNeedExpansion) {
        const result = [];
        const expansionValues = isNeedExpansion ? expansionS(pattern) : [pattern];
        for (let s of stringsDB.varValueDb) {
            let isMatch = false;
            if (typeof pattern === "string") {
                if (isEquals) {
                    for (let newPattern of expansionValues) {
                        isMatch = isMatch || (newPattern === s[filedName]);
                    }
                } else {
                    for (let newPattern of expansionValues) {
                        isMatch = isMatch || (s[filedName] && s[filedName].indexOf(newPattern) !== -1);
                    }
                }
            } else if (pattern instanceof RegExp) {
                isMatch = pattern.test(s[filedName]);
            }
            if (!isMatch) {
                continue;
            }
            const codeInfo = parseCodeLocation(s.codeLocation)
            result.push({
                name: s.name,
                value: abbreviationPattern(pattern, s[filedName]),
                type: s.type,
                execOrder: s.execOrder,
                codeName: codeInfo.codeName,
                codeAddress: codeInfo.codeAddress,
                execTimes: stringsDB.codeLocationExecuteTimesCount[s.codeLocation]
            });
        }
        showAlignedResult(result);
    }

    // 对搜索值进行一个扩大，以便能够搜索到更多结果
    // 这样也不用苦逼的手动去测试到底是url encode还是url decode了的了
    function expansionS(s) {
        const result = [];

        // 原字符串是要放进去的
        result.push(s);

        if (typeof s !== "string") {
            return result;
        }

        // url编码后
        try {
            const t = encodeURIComponent(s);
            if (result.indexOf(t) === -1) {
                result.push(t);
            }
        } catch (e) {
        }

        // url解码后
        try {
            const t = decodeURIComponent(s);
            if (result.indexOf(t) === -1) {
                result.push(t);
            }
        } catch (e) {
        }

        // 表单数据到底是怎么被编码的...
        try {
            const t = s.replace(/ /g, "+");
            if (result.indexOf(t) === -1) {
                result.push(t);
            }
        } catch (e) {
        }

        return result;
    }

    // ============ 新增：搜索结果对齐输出开始 ============
    // 原 showResult() 用大量 \t 拼接列，遇到长字符串、中文、Chrome console 折叠时容易错位。
    // 这里改成逐条分块输出，不依赖 console.table()，避免被页面环境降级成 [object Object]。
    function showAlignedResult(result) {
        let message = "\n在线程栈： \n" + window.location.href + "\n";
        if (!result.length) {
            message += "中没有搜索到结果。\n\n";
            console.log(message);
            console.log("\n\n\n");
            return;
        }

        message += `中搜到${result.length}条结果： \n\n`;
        console.log(message);

        for (let i = 0; i < result.length; i++) {
            const s = result[i];
            console.log(`========== 结果 ${i + 1}/${result.length} ==========`);
            console.log(`变量名：${s.name}`);
            console.log(`变量值：${s.value}`);
            console.log(`变量类型：${s.type}`);
            console.log(`所在函数：${s.codeName || ""}`);
            console.log(`执行次数：${s.execTimes}`);
            console.log(`执行顺序：${s.execOrder}`);
            console.log(`代码位置：${s.codeAddress}`);
        }
        console.log("\n\n\n\n");
    }
    // ============ 新增：搜索结果对齐输出结束 ============

    function showResult(result) {
        let message = "\n在线程栈： \n" + window.location.href + "\n";
        if (!result.length) {
            message += "中没有搜索到结果。\n\n";
            console.log(message);
            console.log("\n\n\n");
            return;
        }

        message += `中搜到${result.length}条结果： \n\n`;
        console.log(message);
        console.log(`变量名\t\t\t\t\t变量值\t\t\t\t\t变量类型\t\t\t\t\t所在函数\t\t\t\t\t执行次数\t\t\t\t\t执行顺序\t\t\t\t\t代码位置\n\n\n`);
        for (let s of result) {
            if (s.value.length > 90) {
                console.log(`${s.name}\t\t\t\t\t${s.value}`);
                console.log(blank(s.name.length) + `\t\t\t\t\t${s.type}\t\t\t\t\t${s.codeName}`);
                console.log(blank(s.name.length) + `\t\t\t\t\t${s.execTimes}\t\t\t\t\t${s.execOrder}`);
            } else {
                console.log(`${s.name}\t\t\t\t\t${s.value}\t\t\t\t\t${s.type}\t\t\t\t\t${s.codeName}`);
                console.log(blank(s.name.length) + `\t\t\t\t\t${s.execTimes}\t\t\t\t\t${s.execOrder}`);
            }
            // 打印的时候代码地址尽量放到单独一行，以防文本太长被折叠Chrome就不会自动将其识别为链接了，这时候还得手动复制就麻烦了
            console.log(blank(s.name.length) + "\t\t\t\t\t" + s.codeAddress + "\n\n\n\n");
        }
        console.log("\n\n\n\n");
    }

    function abbreviationPattern(pattern, value) {
        if (typeof pattern !== "string" || pattern.length < 40) {
            return value;
        }
        const newPattern = pattern.slice(0, 15) + "......" + pattern.slice(pattern.length - 15, pattern.length);
        return value.replace(pattern, newPattern);
    }

    function blank(n) {
        let s = "";
        while (n-- > 0) {
            s += " ";
        }
        return s;
    }

    function parseCodeLocation(codeLocation) {
		// eval/Worker 等环境下 getCodeLocation() 返回 null，parseCodeLocation 对 null 调用 .match() 导致 TypeError
        // codeLocation 可能是正常字符串，也可能是 null
        if (!codeLocation) {
            // codeLocation 是 null → 进这里，返回空值，不往下执行
            return { codeName: null, codeAddress: null };
        }
        // codeLocation 有值 → 正常解析
        const codeInfo = {};
        // ============ 新增：EVAL_VIRTUAL_URL_STACK_PARSE 开始 ============
        // 这里就是“eval 虚拟 URL 的栈解析增强”。
        // api-server.js 会给 eval 代码末尾追加 sourceURL，例如：
        // //# sourceURL=http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js
        //
        // eval 代码执行时，new Error().stack 里可能出现类似位置：
        // http://127.0.0.1:10010/ast-hook-eval/eval-xxxx.js:12:34
        //
        // 下面这个正则就是专门从调用栈字符串里抓出这类 eval 虚拟文件地址：
        // - https?                 匹配 http 或 https
        // - 127.0.0.1:10010        匹配本地 ast-hook API 服务
        // - /ast-hook-eval/        匹配 eval 虚拟文件路径
        // - eval-[a-f0-9]+.js      匹配 eval 虚拟文件名
        // - :\d+:\d+               匹配 行号:列号
        let matcher = codeLocation.match(/https?:\/\/127\.0\.0\.1:10010\/ast-hook-eval\/eval-[a-f0-9]+\.js:\d+:\d+/);
        if (matcher != null && matcher.length > 0) {
            // 命中后优先使用 eval 内部地址作为 codeAddress。
            // 这样 search() 打印结果时，显示的是 eval 里面的具体行列，
            // 而不是 eval 外层调用点，例如 eval at window.eval (...)。
            codeInfo.codeAddress = matcher[0];
        }
        // ============ 新增：EVAL_VIRTUAL_URL_STACK_PARSE 结束 ============
        // ============ 原逻辑兜底：继续兼容普通调用栈位置开始 ============
        matcher = codeLocation.match(/\((.+?)\)/);
        if (!codeInfo.codeAddress && matcher != null && matcher.length > 1) {
            codeInfo.codeAddress = matcher[1];
        } else if (!codeInfo.codeAddress) {
            codeInfo.codeAddress = codeLocation;
        }
        // ============ 原逻辑兜底：继续兼容普通调用栈位置结束 ============

        matcher = codeLocation.match(/at (.+?)\(/);
        if (matcher != null && matcher.length > 1) {
            codeInfo.codeName = matcher[1]
        }

        return codeInfo;
    }

})();
