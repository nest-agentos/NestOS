export const workspacePrerequisitesFile='prerequisites.json';
const name=/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const path=/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

function entries(value:unknown,valid:(entry:string)=>boolean):string[] {
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>24||!value.every(row=>typeof row==='string'&&valid(row)))
        throw invalid();
    return [...new Set(value)];
}
function invalid() {return Object.assign(new Error('Invalid workspace prerequisites'),{code:'WORKSPACE_PREREQUISITES_INVALID'});}
function relative(value:string) {return value.length<=256&&path.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');}

export function workspacePrerequisites(content:string) {
    let fields:Record<string,unknown>;
    try {fields=JSON.parse(content);}catch{throw invalid();}
    if(!fields||fields.schema!==1||Object.keys(fields).some(key=>!['schema','executables','files','binDirectories'].includes(key)))throw invalid();
    const bins=entries(fields.binDirectories,relative),tools=entries(fields.executables,value=>name.test(value)),files=entries(fields.files,relative);
    if(!tools.length&&!files.length)throw invalid();
    return {bins,tools,files};
}

export function prerequisiteProbe(spec:ReturnType<typeof workspacePrerequisites>) {
    const script=[
        'for entry do',
        ' value=${entry#*:}',
        ' case "$entry" in',
        ' bin:*) PATH="$PWD/$value:$PATH" ;;',
        ' tool:*) command -v "$value" >/dev/null || printf "%s\\n" "$entry" ;;',
        ' file:*) [ -f "$value" ] && [ -r "$value" ] || printf "%s\\n" "$entry" ;;',
        ' esac',
        'done',
    ].join('\n');
    const checks=[...spec.tools.map(tool=>'tool:'+tool),...spec.files.map(file=>'file:'+file)];
    return {command:'sh',args:['-c',script,'kanban-prerequisites',...spec.bins.map(bin=>'bin:'+bin),...checks],checks};
}
