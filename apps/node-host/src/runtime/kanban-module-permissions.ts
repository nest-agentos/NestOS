/** The Node host reads deployment configuration, separate from decision or model input. */
export function kanbanModulePermissions(raw:string|undefined):Readonly<Record<string,unknown>>|undefined {
    if(raw===undefined)return;
    try {
        const value:unknown=JSON.parse(raw);
        if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>;
    }catch { /* Report a stable configuration error without printing policy content. */ }
    throw Object.assign(new Error('Invalid Kanban module permissions'),{code:'KANBAN_MODULE_PERMISSIONS_INVALID'});
}
