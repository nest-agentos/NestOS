import {resolveBrowserTarget} from '@nestos/app-contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {NativeInteractionPanel} from '@nestos/llm-ui-adapter';
import {Modal} from '@nestos/ui-common';
import {randomUUID,t} from '@nestos/common';

/** Open the existing authorized Session; no command or instruction is created here. */
export function sessionInteractionDialog(projects:ProjectService,openSession:(id:string)=>Promise<void>){
    return async(resource:string,signal?:AbortSignal):Promise<void>=>{
        const target=resolveBrowserTarget(resource);
        if(target.kind!=='remote'||!target.nativeSessionId||!target.profileId)throw Object.assign(new Error('Session interaction target unavailable'),{code:'EINVAL'});
        const [{NativeInteractionPanel}, project] = await Promise.all([import('@nestos/llm-ui-adapter'), projects.forFolder(target.folder)]);
        if(!project||project.path!==target.folder||target.archived||!projects.remoteMounts)throw Object.assign(new Error('Session binding unavailable'),{code:'EACCES'});
        const controls=await projects.remoteMounts.projectConversation(project.project.id,target.profileId,target.nativeSessionId,{timeoutMs:3000});
        let panel:NativeInteractionPanel|undefined,modal:Modal|undefined;
        try{
            if(signal?.aborted)return;
            await new Promise<void>((resolve,reject)=>{
                const id='session-interactions-'+randomUUID();
                modal=new Modal(t('kanban.sessionInteractions'),`<div id="${id}"></div>`,{onCancel:resolve,closeLabel:t('kanban.close')});modal.show();
                const mount=document.getElementById(id)!,footer=mount.closest('[role=dialog]')!.querySelector('.ui-modal__footer')!;
                const session=document.createElement('button');session.type='button';session.className='ui-modal__button settings-btn settings-btn--secondary';session.textContent=t('kanban.enterSession');
                session.addEventListener('click',()=>{modal!.hide();void openSession(resource).catch(reject);});footer.replaceChildren(session);
                panel=new NativeInteractionPanel(mount,controls);void panel.start().catch(reject);
                signal?.addEventListener('abort',close,{once:true});
            });
        }finally{signal?.removeEventListener('abort',close);panel?.destroy();modal?.hide();await controls.close();}
        function close(){modal?.hide();}
    };
}
