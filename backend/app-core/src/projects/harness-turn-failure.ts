const codes:Record<string,string>={
    usageLimitExceeded:'NATIVE_USAGE_LIMIT_EXCEEDED',usage_limit_exceeded:'NATIVE_USAGE_LIMIT_EXCEEDED',
    contextWindowExceeded:'NATIVE_CONTEXT_LIMIT_EXCEEDED',context_window_exceeded:'NATIVE_CONTEXT_LIMIT_EXCEEDED',
    httpConnectionFailed:'NATIVE_CONNECTION_FAILED',responseStreamDisconnected:'NATIVE_CONNECTION_FAILED',
};
/** Only recognized structured classifications cross the boundary; native messages may contain private data. */
export function nativeFailureCode(error:unknown):string|undefined {
    if(!error||typeof error!=='object')return;
    const value=error as {codexErrorInfo?:unknown;codex_error_info?:unknown;code?:unknown};
    const info=value.codexErrorInfo??value.codex_error_info??value.code;
    const kind=typeof info==='string'?info:info&&typeof info==='object'?Object.keys(info)[0]:undefined;
    return kind?codes[kind]:undefined;
}
export function nativeTurnFailure(code:unknown):boolean {
    return code==='NATIVE_TURN_FAILED'||code==='NATIVE_TURN_CANCELLED'||Object.values(codes).includes(code as string);
}
