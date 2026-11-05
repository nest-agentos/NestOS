import type {ServerResponse} from 'node:http';

export function responseOpen(response: ServerResponse): boolean {
    return !response.destroyed && !response.writableEnded && !response.writableFinished;
}
/** Closing a stream revokes in-flight authorization callbacks as well as the timer. */
export function startViewHeartbeat(response: ServerResponse, options: {
    authorize?(): Promise<boolean>; current(): boolean; seen(): void;
    failed(stage: string,error: unknown,durationMs: number): void;
}): void {
    let stopped=false,checking=false;
    const active=()=>!stopped && responseOpen(response) && options.current();
    const stop=()=>{stopped=true;clearInterval(timer);};
    const timer=setInterval(()=>{
        if(checking || !active())return; checking=true; const started=Date.now();
        void Promise.resolve().then(()=>options.authorize?.() ?? true).then(accepted=>{
            if(!active())return;
            if(!accepted){stop();response.end();return;}
            options.seen();response.write(': heartbeat\n\n');
        }).catch(error=>{if(!active())return;stop();options.failed('heartbeat',error,Date.now()-started);response.end();})
            .finally(()=>{checking=false;});
    },15000);
    response.once('close',stop);response.once('finish',stop);
    response.once('error',error=>{const wasActive=active();stop();if(wasActive)options.failed('stream',error,0);});
}
