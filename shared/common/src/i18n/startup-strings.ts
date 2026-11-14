/** Small startup labels are also composed into the complete locale catalogs. */
export const STARTUP_ZH={
    "httpApp.starting": "正在启动 NestOS…",
    "httpApp.startupFailed": "NestOS 启动失败",
    "httpApp.moduleLoadFailed": "页面模块加载失败，可能是页面版本已更新或网络中断。请点击“重新加载”；若仍失败，请检查网络和浏览器证书。",
    "httpApp.moduleRepairFailed": "页面模块重新获取失败，请检查网络和浏览器证书后重试；草稿不会被删除。",
    "httpApp.reload": "重新加载"
} as const;
export const STARTUP_EN={
    "httpApp.starting": "Starting NestOS…",
    "httpApp.startupFailed": "NestOS failed to start",
    "httpApp.moduleLoadFailed": "A page module could not load. The page version may have changed or the network was interrupted. Reload the page; if it still fails, check the network and browser certificate.",
    "httpApp.moduleRepairFailed": "Page modules could not be fetched again. Check the network and browser certificate, then retry. Drafts will be kept.",
    "httpApp.reload": "Reload"
} as const;
