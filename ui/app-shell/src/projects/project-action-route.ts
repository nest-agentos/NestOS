export type ProjectAction='open'|'status'|'remount'|'unmount'|'detach';
export interface ProjectActionRoute {projectId:string;action:ProjectAction;mountId:string}
const prefix='@project/';
export function projectActionPath(projectId:string,action:ProjectAction,mountId:string):string {
    return prefix+[projectId,action,mountId].map(encodeURIComponent).join('/');
}
export function parseProjectAction(resource:string):ProjectActionRoute|undefined {
    if(!resource.startsWith(prefix))return;
    const parts=resource.slice(prefix.length).split('/');
    if(parts.length!==3)throw new Error('INVALID_PROJECT_ACTION');
    const [projectId,action,mountId]=parts.map(decodeURIComponent);
    if(!projectId||!mountId||!['open','status','remount','unmount','detach'].includes(action!))throw new Error('INVALID_PROJECT_ACTION');
    return {projectId,action:action as ProjectAction,mountId};
}
