import { createStartupStatus } from './client/startup-status';
import {connectApplication} from './client/application-connection';
import {installStartupNavigation} from './client/startup-navigation';
import {preloadBrowserEditor} from 'nestos-web/preload';

const startup = createStartupStatus(), stopStartupNavigation = installStartupNavigation();
performance.mark('nestos:entry');
const connection = connectApplication();
void connection.ready.catch(() => {});
// Warm the editor independently so a slow editor chunk cannot delay navigation.
void preloadBrowserEditor(connection.editor).catch(() => {});
void import('./client/hosted-application')
    .then(module => module.startApplicationClient(message => startup.progress(message), () => {
        stopStartupNavigation();
        document.body.dataset.httpNavReady = '';
        delete document.body.dataset.appStarting;
        startup.ready();
    }, connection))
    .catch(error => {
        console.error('[Bootstrap] Fatal:', error);
        startup.fail(error);
        void connection.close().catch(() => {});
    });
