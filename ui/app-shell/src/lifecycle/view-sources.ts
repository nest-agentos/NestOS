import type {ApplicationServices, ApplicationViewSources} from '@nestos/app-contracts/services';

export type ViewSubscribe = <K extends keyof ApplicationViewSources>(topic: K, listener: (value: ApplicationViewSources[K]) => void) => () => void;
type Sources = Pick<ApplicationServices, 'sessionRepository' | 'sessionFiles' | 'sessionManager' | 'kernel' | 'projects'>;
/** Keep observation adapters shared between initial application and later workspace views. */
export function bindViewSources<T extends Sources>(source: T, subscribe: ViewSubscribe): T {
    const projects = source.projects;
    return {...source,
        sessionManager: overlay(source.sessionManager, {onGlobalEvent: listener => subscribe('global', listener), onEvent: listener => subscribe('session', listener)}),
        sessionRepository: overlay(source.sessionRepository, {subscribe: listener => subscribe('repository', listener)}),
        sessionFiles: overlay(source.sessionFiles, {subscribe: listener => subscribe('files', listener)}),
        kernel: {...source.kernel, kernel: overlay(source.kernel.kernel, {onChanged: listener => subscribe('kernel', listener)})},
        projects: overlay(projects, {
            favorites: overlay(projects.favorites, {subscribe: listener => subscribe('favorites', listener)}),
            drafts: overlay(projects.drafts, {onPromoted: listener => subscribe('draft', listener)}),
            remoteMounts: projects.remoteMounts && overlay(projects.remoteMounts, {onChange: listener => subscribe('mounts', listener)}),
        })};
}
export function overlay<T extends object>(source: T, overrides: Partial<T>): T {
    return new Proxy(source, {get(target, key) {
        if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key, overrides);
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
}
