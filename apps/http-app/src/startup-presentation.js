// Set the presentation before the body is parsed so a restored detail cannot flash the tab bar.
(() => {
    const [, ...segments] = location.hash.replace(/^#\/?/, '').split('/');
    let resource = segments.join('/');
    try { resource = decodeURIComponent(resource); } catch { /* The route loader reports invalid addresses. */ }
    const savedList = history.state?.resourceId === resource && history.state?.mobileView === 'list';
    if (resource !== 'new' && resource.replace(/^\/+$/, '') && !savedList) {
        document.documentElement.dataset.httpEntryDetail = '';
    }
})();
