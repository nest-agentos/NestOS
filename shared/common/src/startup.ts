export {randomUUID} from './utils/random';
export {createModuleLogger,getLogger} from './utils/MemoryLogger';
export {NAVIGATION_EVENTS} from './events/navigation-events';
import {getLocale} from './i18n/locale';
import {STARTUP_ZH,STARTUP_EN} from './i18n/startup-strings';
export function startupText(key:keyof typeof STARTUP_ZH):string {return (getLocale()==='en'?STARTUP_EN:STARTUP_ZH)[key];}
