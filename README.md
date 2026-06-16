# ast-hook-for-js-RE
新版的二开项目，解决了部分网站打不开的问题



导出捕获的数据，携带相关js文件提供给ai分析
```
(function() {
    const db = window.cc11001100_hook?.stringsDB?.varValueDb;
    if (!db || !db.length) {
        console.log("没有捕获到数据，请先在网站上操作触发加密逻辑");
        return;
    }
    const result = db.map(item => ({
        name: item.name,
        value: item.value?.length > 200 ? item.value.slice(0, 200) + '...' : item.value,
        type: item.type,
        execOrder: item.execOrder,
        location: item.codeLocation
    }));
    copy(JSON.stringify(result, null, 2));
    console.log("已复制 " + result.length + " 条数据到剪贴板，粘贴到文本文件即可");
})();
```
