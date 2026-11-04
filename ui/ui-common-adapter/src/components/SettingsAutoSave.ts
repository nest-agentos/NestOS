import {t} from '@nestos/common';
import {SettingsAutoSave as AutoSave} from '@nestos/ui-common';
export {SettingsValidationError,requestSettingsSave,type SettingsSave} from '@nestos/ui-common';
/** Localize the shared save controller while preserving its common ownership registry. */
export class SettingsAutoSave extends AutoSave {
    constructor(root:HTMLElement,save:ConstructorParameters<typeof AutoSave>[1],status?:HTMLElement) {super(root,save,status,key=>t(key as Parameters<typeof t>[0]));}
}
