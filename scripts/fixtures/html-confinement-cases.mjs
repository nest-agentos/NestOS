import {createSocket} from 'node:dgram';
import assert from 'node:assert/strict';

async function open(page, script, markup = '<div id="result"></div>') {
    await page.evaluate(source => window.htmlFixture.open('/confinement.HTML', source),
        '<!doctype html><body>' + markup + '<script>' + script + '</script>');
    return page.frameLocator('.mdx-html-preview__frame').frameLocator('iframe');
}
async function verifyRealm(page) {
    const frame = await open(page, `const tests=[()=>parent.document,()=>top.document,()=>document.cookie,()=>localStorage,
        ()=>document.body.ownerDocument.defaultView,()=>document.getElementById('clobber').value,()=>document.body.constructor.constructor('return this')(),
        ()=>Object.getPrototypeOf(document.body).constructor,()=>fetch.constructor('return this')().parent.document];
        document.getElementById('result').textContent=JSON.stringify(tests.map(test=>{try{test();return false}catch{return true}}));
        globalThis.nativeMarker=true;document.getElementById('event').addEventListener('click',event=>{try{event.constructor.constructor('return this')().parent.document;document.body.dataset.eventIsolated='no'}catch{document.body.dataset.eventIsolated='yes'}});`, '<div id="result"></div><form id="clobber"><input name="value"></form><button id="event">Event</button>');
    assert.deepEqual(JSON.parse(await frame.locator('#result').textContent()), Array(9).fill(true));
    assert.equal(await frame.locator('body').evaluate(node => node.ownerDocument.defaultView.nativeMarker), undefined);
    await frame.locator('#event').click(); assert.equal(await frame.locator('body').getAttribute('data-event-isolated'), 'yes');
}
async function verifyDynamic(page, origin) {
    const frame = await open(page, `document.getElementById('result').innerHTML='<button id="dynamic" onclick="this.dataset.clicked=1">Click</button><input id="field">';
        const input=document.getElementById('field');let blocked=0;for(const type of ['file','image','FiLe']){try{input.setAttribute('TYPE',type)}catch{blocked++}}
        input.dataset.blocked=blocked;
        document.body.style.backgroundColor='rgb(4, 5, 6)';document.body.style.backgroundImage='url(${origin}/attack-css)';`);
    await page.waitForTimeout(30);
    await frame.locator('#dynamic').click(); assert.equal(await frame.locator('#dynamic').getAttribute('data-clicked'), '1');
    assert.equal(await frame.locator('#field').getAttribute('data-blocked'), '3');
    assert.equal(await frame.locator('#field').evaluate(node => node.type), 'text');
    assert.equal(await frame.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(4, 5, 6)');
    await open(page, '', `<link rel="dns-prefetch" href="//127.0.0.1"><link rel="preconnect" href="${origin}/attack-hint"><meta http-equiv="refresh" content="0;url=${origin}/attack-meta"><form action="${origin}/attack-form"><button>Submit</button></form><style>@import '${origin}/attack-import';p{background:url('${origin}/attack-style')}</style><p>CSS</p>`);
    await page.frameLocator('.mdx-html-preview__frame').frameLocator('iframe').locator('button').click();
    await page.waitForTimeout(50);
}
async function verifyAsync(page) {
    let frame = await open(page, `document.addEventListener('DOMContentLoaded',()=>{document.body.dataset.ready='yes'});
        window.onload=()=>{document.body.dataset.loaded='yes'};Promise.resolve().then(()=>{document.body.dataset.promise='yes'});
        new Promise(resolve=>setTimeout(resolve,25)).then(()=>document.body.dataset.delayed='yes');
        new Promise(resolve=>setTimeout(resolve,1000)).then(()=>document.body.dataset.latePromise='bad');
        let count=0;const timer=setInterval(()=>{document.body.dataset.count=++count;clearInterval(timer)},16);
        setTimeout(()=>document.body.dataset.late='bad',1000);`);
    await page.waitForTimeout(100);
    for (const key of ['ready','loaded','promise','delayed']) assert.equal(await frame.locator('body').getAttribute('data-' + key), 'yes');
    assert.equal(await frame.locator('body').getAttribute('data-count'), '1');
    const old = page.frames().find(frame => frame.parentFrame()?.parentFrame());
    await page.getByRole('button', {name: '刷新预览'}).click(); await page.waitForTimeout(80); assert(old.isDetached());
    await page.evaluate(() => {window.htmlFixture.replace('<body><p>old</p><script>setTimeout(()=>document.body.dataset.late=1,300)</script>');window.htmlFixture.replace('<body><p>new</p>');});
    await page.waitForTimeout(400);
    frame = page.frameLocator('.mdx-html-preview__frame').frameLocator('iframe');
    assert.equal(await frame.locator('p').textContent(), 'new'); assert.equal(await frame.locator('body').getAttribute('data-late'), null);
    await page.evaluate(() => window.htmlFixture.destroy()); await page.waitForTimeout(1100);
    assert.equal(await page.locator('main iframe').count(), 0);
    assert.equal(await page.evaluate(() => window.__htmlTimers.size), 0, 'host timers survived preview destruction');
}
async function verifyBudgets(page) {
    for (const [script, reason] of [['while(true){}', /执行时限/], ['new Uint8Array(64*1024*1024)', /内存上限/],
        ['function loop(){Promise.resolve().then(loop)}loop()', /异步作业限制/],
        ['for(let i=0;i<101;i++)setTimeout(()=>{},60000)', /计时器/],
        ['for(let i=0;i<1001;i++)document.body.addEventListener("click",()=>{})', /监听/]]) {
        await open(page, script); assert.match(await page.locator('.mdx-html-preview__toolbar [role=status]').textContent(), reason);
    }
    await page.evaluate(() => window.htmlFixture.destroy());
}
async function verifyRtc(page) {
    const udp = createSocket('udp4'); let packets = 0;
    udp.on('message', () => packets++); await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
    try {
        const frame = await open(page, `try{const rtc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});rtc.createDataChannel('test');rtc.createOffer().then(offer=>rtc.setLocalDescription(offer))}catch{document.getElementById('result').textContent='blocked'}`);
        assert.equal(await frame.locator('#result').textContent(), 'blocked');
        await page.waitForTimeout(1600); assert.equal(packets, 0);
    } finally {udp.close();}
    return packets;
}
export async function verifyConfinement(page, requests, origin) {
    await verifyRealm(page); await verifyDynamic(page, origin); await verifyAsync(page); await verifyBudgets(page);
    const udpPackets = await verifyRtc(page);
    assert(!requests.some(url => url.includes('/attack')), 'preview emitted a forbidden request');
    return {realmProbes: 9, eventRealm: true, dynamicHtmlCss: true, typeConstraintShared: true, promiseTimersAndTeardown: true, hostTimersAfterDestroy: 0, budgetCases: 5, udpPackets};
}
