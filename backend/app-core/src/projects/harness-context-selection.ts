/** Keep confirmed and unsettled contexts; a failed creation without a native identity is history. */
export function retainedExecutionContexts<T extends {validity: string; nativeRef?: unknown; activeOperation?: unknown}>(bindings:T[]):T[] {
    return bindings.filter(binding=>!(binding.validity==='invalid'&&!binding.nativeRef&&!binding.activeOperation));
}
