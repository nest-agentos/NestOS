import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>{vi.doUnmock('../../../shared/common/src/i18n/en');vi.resetModules();});
it('loads only the active default catalog and loads English on demand before switching',async()=>{
 vi.resetModules();const loaded=vi.fn();vi.doMock('../../../shared/common/src/i18n/en',async()=>{loaded();return await vi.importActual('../../../shared/common/src/i18n/en');});
 const {t,getLocale,setLocale,translatedValues}=await import('@nestos/common');const {startupText}=await import('@nestos/common/startup');
 expect(t('httpApp.reload')).toBe('重新加载');expect(loaded).not.toHaveBeenCalled();
 await setLocale('en');expect(getLocale()).toBe('en');expect(t('httpApp.reload')).toBe('Reload');expect(startupText('httpApp.reload')).toBe('Reload');expect(loaded).toHaveBeenCalledOnce();
 expect(await translatedValues('httpApp.reload')).toEqual(['重新加载','Reload']);
 const pending=setLocale('en');await setLocale('zh-CN');await pending;expect(getLocale()).toBe('zh-CN');
});
it('keeps the current language after a failed catalog load and emits only safe diagnostics',async()=>{
 vi.resetModules();vi.doMock('../../../shared/common/src/i18n/en',()=>{throw new Error('PRIVATE_LOCALE_URL');});
 const {t,getLocale,setLocale}=await import('@nestos/common');const {getLogger}=await import('@nestos/common/startup');
 await expect(setLocale('en')).rejects.toMatchObject({code:'LOCALE_MODULE_LOAD_FAILED'});expect(getLocale()).toBe('zh-CN');expect(t('httpApp.reload')).toBe('重新加载');
 const logs=getLogger().query({modules:['i18n']});expect(logs).toHaveLength(1);expect(JSON.stringify(logs)).not.toContain('PRIVATE_LOCALE_URL');
 await expect(setLocale('unsupported' as never)).rejects.toMatchObject({code:'LOCALE_UNSUPPORTED'});
});
it('does not let a slow inactive catalog override a newer language selection',async()=>{
 vi.resetModules();let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
 vi.doMock('../../../shared/common/src/i18n/en',async()=>{await waiting;return await vi.importActual('../../../shared/common/src/i18n/en');});
 const {getLocale,setLocale}=await import('@nestos/common');
 const pending=setLocale('en');await setLocale('zh-CN');release();await pending;
 expect(getLocale()).toBe('zh-CN');await setLocale('en');expect(getLocale()).toBe('en');
});
