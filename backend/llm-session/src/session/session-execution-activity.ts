import type {SessionInstruction} from '../contracts/instruction-queue';
import type { SessionStatus } from '../core/types';
import { SessionInstructionRuntime } from './session-instruction-runtime';

/** Instance-owned coordination shared by the host's Session views, never a global singleton. */
export class SessionExecutionActivity {
    private readonly runs = new Map<string, () => void>();
    private readonly ingress = new Set<(sessionId:string, input:SessionInstruction)=>Promise<boolean>>();
    registerInstructionGate(gate: (sessionId:string, input:SessionInstruction)=>Promise<boolean>): ()=>void {this.ingress.add(gate);return ()=>{this.ingress.delete(gate);};}
    private async intercept(sessionId:string, input:SessionInstruction):Promise<boolean> {
        for(const gate of this.ingress)if(await gate(sessionId,structuredClone(input)))return true;
        return false;
    }
    private instructions?: SessionInstructionRuntime;

    instructionRuntime(...options: ConstructorParameters<typeof SessionInstructionRuntime>): SessionInstructionRuntime {
        return this.instructions ??= new SessionInstructionRuntime(options[0],options[1],options[2],(id,item)=>this.intercept(id,item));
    }

    isActive(sessionId: string): boolean { return this.runs.has(sessionId); }
    begin(sessionId: string, interrupt: () => void): void { this.runs.set(sessionId, interrupt); }
    abort(sessionId: string): void { this.runs.get(sessionId)?.(); }
    finish(sessionId: string, status?: SessionStatus, instructionId?: string): void {
        this.runs.delete(sessionId);
        if (status) this.instructions?.queues.settled(sessionId, status, instructionId);
        else this.instructions?.queues.wake(sessionId);
    }

    async dispose(): Promise<void> { await this.instructions?.dispose(); }
}
