export interface SoftwareExecutionPermissions {
    allow: ReadonlyArray<{projectId:string;profileId:string;command:string}>;
}

export type ExecutionPermissionVerdict = {decision:'allow'} | {decision:'manual';code:string};

/** Match only a single command in the original workspace under an administrator's exact rule. */
export function softwareExecutionPermission(policy:SoftwareExecutionPermissions|undefined, context:{
    projectId:string;profileId:string;cwd:string|null;request:Record<string,unknown>;
}):ExecutionPermissionVerdict {
    const {projectId,profileId,cwd,request}=context;
    if(request.method!=='item/commandExecution/requestApproval'||typeof request.command!=='string')
        return {decision:'manual',code:'PERMISSION_ACTION_UNSUPPORTED'};
    if(!cwd||request.cwd!==cwd||request.grantRoot!=null||request.networkApprovalContext!=null||request.additionalPermissions!=null)
        return {decision:'manual',code:'PERMISSION_SCOPE_UNSUPPORTED'};
    const offered=request.decisions??request.availableDecisions;
    if(!Array.isArray(offered)||!offered.includes('accept'))
        return {decision:'manual',code:'PERMISSION_ONE_SHOT_UNAVAILABLE'};
    const rule=policy?.allow.some(rule=>rule.projectId===projectId&&rule.profileId===profileId&&rule.command===request.command);
    return rule?{decision:'allow'}:{decision:'manual',code:'PERMISSION_RULE_MISSING'};
}

export function parseSoftwareExecutionPermissions(value:unknown):SoftwareExecutionPermissions|undefined {
    if(value===undefined)return;
    const policy=value as Partial<SoftwareExecutionPermissions>|null;
    if(!policy||typeof policy!=='object'||Object.keys(policy).some(key=>key!=='allow')||
        !Array.isArray(policy.allow)||policy.allow.length>128||!policy.allow.every(validRule))
        throw Object.assign(new Error('Invalid software execution permissions'),{code:'KANBAN_MODULE_PERMISSIONS_INVALID'});
    return {allow:policy.allow.map(rule=>({...rule}))};
}

function validRule(value:unknown):boolean {
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const rule=value as Record<string,unknown>;
    return Object.keys(rule).length===3&&['projectId','profileId'].every(key=>typeof rule[key]==='string'&&/^[\w.-]{1,128}$/.test(rule[key]))&&
        typeof rule.command==='string'&&rule.command.length>0&&rule.command.length<=4096&&!rule.command.includes('\0');
}
