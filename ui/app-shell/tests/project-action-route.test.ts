import {expect,it} from 'vitest';
import {projectActionPath,parseProjectAction} from '../src/projects/project-action-route';
import {initialViewRequest} from '../src/lifecycle/initial-view';
it('preserves stable project and mount identities without opening a session on cold navigation',()=>{
    const path=projectActionPath('demo','detach','mount/with spaces');
    expect(parseProjectAction(path)).toEqual({projectId:'demo',action:'detach',mountId:'mount/with spaces'});
    expect(initialViewRequest([],path).workbench.initialSessionId).toBeUndefined();
    expect(parseProjectAction('/folder:Demo')).toBeUndefined();
    expect(()=>parseProjectAction('@project/demo/delete/mount')).toThrow('INVALID_PROJECT_ACTION');
    expect(()=>parseProjectAction('@project/demo/detach/')).toThrow('INVALID_PROJECT_ACTION');
});
it('routes a cold project draft through the resource workbench without a session binding', () => {
    const path = '/folder:Demo/@new', request = initialViewRequest([], path);
    expect(request.resourceId).toBe(path);
    expect(request.workbench.initialSessionId).toBeUndefined();
    expect(request.workbench.initialNavigation).toBe(false);
});
