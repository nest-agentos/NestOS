import{a6 as S,M as U,a8 as T,a9 as G,aa as q,ab as $}from"./mdx-renderer-h9x2njUa.js";function O(){const a=new Uint8Array(16);if(typeof globalThis.crypto?.getRandomValues=="function")globalThis.crypto.getRandomValues(a);else for(let e=0;e<a.length;e++)a[e]=Math.floor(Math.random()*256);a[6]=a[6]&15|64,a[8]=a[8]&63|128;const t=Array.from(a,e=>e.toString(16).padStart(2,"0")).join("");return`${t.slice(0,8)}-${t.slice(8,12)}-${t.slice(12,16)}-${t.slice(16,20)}-${t.slice(20)}`}const V="mdx:reveal-content";function le(a,t){if(!(a===t||!t.contains(a))){for(let e=a.parentElement;e&&e!==t;e=e.parentElement)e instanceof HTMLDetailsElement&&(e.open=!0);a.dispatchEvent(new CustomEvent(V,{bubbles:!0}))}}function Y(a){return["small","normal","large"].map((t,e)=>`<button type="button" data-size="${t}" style="flex:1;padding:12px 20px;border:2px solid #d0d5dd;border-radius:8px;background:#fff;cursor:pointer;font-size:14px;">
            <div style="font-weight:600;margin-bottom:4px;">${S("print."+t,a)}</div>
            <div style="color:#656d76;font-size:12px;">${12+e*2}px</div>
        </button>`).join("")}function W(a,t){const e=document.createElement("div");return e.style.cssText="position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);",e.innerHTML=`<div role="dialog" aria-modal="true" aria-label="${S("print.options",t)}" style="background:#fff;border-radius:12px;padding:24px;min-width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
        <div style="font-size:16px;font-weight:600;margin-bottom:16px;">${S("print.options",t)}</div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:14px;">
            <input type="checkbox" data-show-file-name ${a?"checked":""}>${S("print.showFileName",t)}
        </label>
        <div style="font-size:14px;margin-bottom:8px;">${S("print.fontSize",t)}</div>
        <div style="display:flex;gap:12px;margin-bottom:16px;">${Y(t)}</div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button type="button" id="mdx-print-cancel" style="padding:8px 16px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">${S("print.cancel",t)}</button>
        </div>
    </div>`,e}function J(a,t){return new Promise(e=>{const i=W(a,t),n=r=>{const l=i.querySelector("[data-show-file-name]").checked;i.remove(),document.removeEventListener("keydown",o),e(r?{fontSize:r,showFileName:l}:null)},o=r=>{r.key==="Escape"&&n()};i.addEventListener("click",r=>{const l=r.target.closest("[data-size],#mdx-print-cancel");l?n(l.dataset.size):r.target===i&&n()}),document.addEventListener("keydown",o),document.body.append(i),i.querySelector("[data-show-file-name]").focus()})}const K=`
/* ============================================
   ROOT & TYPOGRAPHY
   ============================================ */

.mdx-print {
    font-family: 
        -apple-system, 
        BlinkMacSystemFont, 
        "Segoe UI", 
        Roboto, 
        "Helvetica Neue", 
        Arial, 
        /* ✅ 添加中文字体支持 */
        "PingFang SC",           /* macOS 中文 */
        "Hiragino Sans GB",      /* macOS 中文备选 */
        "Microsoft YaHei",       /* Windows 中文 */
        "WenQuanYi Micro Hei",   /* Linux 中文 */
        "Noto Sans SC",          /* Google 中文字体 */
        sans-serif,
        "Apple Color Emoji", 
        "Segoe UI Emoji", 
        "Segoe UI Symbol";
    font-size: 14px;
    line-height: 1.8;  /* ✅ 中文适当增加行高 */
    color: #24292f;
    background: #ffffff;
    max-width: 800px;
    margin: 0 auto;
    padding: 40px 20px;
    
    /* ✅ 确保文本渲染正常 */
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
}

.mdx-print * {
    box-sizing: border-box;
}

/* ============================================
   HEADER
   ============================================ */

.mdx-print-header {
    /* Title-only header: no divider line, whitespace separates it from the body. */
    margin-bottom: 32px;
}

.mdx-print-header__title {
    margin: 0;
    font-size: 1.75em;
    font-weight: 600;
    color: #24292f;
}

.mdx-print-header__meta {
    margin: 8px 0 0;
    font-size: 0.875em;
    color: #656d76;
}

.mdx-print-header__meta-item {
    display: inline;
}

.mdx-print-header__meta-item:not(:last-child)::after {
    content: " · ";
    color: #d0d7de;
}

/* ============================================
   HEADINGS
   ============================================ */

.mdx-print h1,
.mdx-print h2,
.mdx-print h3,
.mdx-print h4,
.mdx-print h5,
.mdx-print h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
}

.mdx-print h1 {
    font-size: 2em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid #d8dee4;
}

.mdx-print h2 {
    font-size: 1.5em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid #d8dee4;
}

.mdx-print h3 { font-size: 1.25em; }
.mdx-print h4 { font-size: 1em; }
.mdx-print h5 { font-size: 0.875em; }
.mdx-print h6 { font-size: 0.85em; color: #656d76; }

/* ============================================
   PARAGRAPHS & INLINE ELEMENTS
   ============================================ */

.mdx-print p { margin: 0 0 16px; }
.mdx-print strong { font-weight: 600; }
.mdx-print em { font-style: italic; }

.mdx-print a {
    color: #0969da;
    text-decoration: none;
}

.mdx-print mark {
    background-color: #fff8c5;
    padding: 0.1em 0.2em;
    border-radius: 2px;
}

.mdx-print del {
    text-decoration: line-through;
    color: #656d76;
}

/* ============================================
   LISTS
   ============================================ */

.mdx-print ul,
.mdx-print ol {
    margin: 0 0 16px;
    padding-left: 2em;
    list-style-position: outside;
}

.mdx-print ul { list-style-type: disc; }
.mdx-print ol { list-style-type: decimal; }
.mdx-print ul ul { list-style-type: circle; }
.mdx-print ul ul ul { list-style-type: square; }
.mdx-print ol ol { list-style-type: lower-alpha; }
.mdx-print ol ol ol { list-style-type: lower-roman; }
.mdx-print li { display: list-item; margin: 0.25em 0; }
.mdx-print li > p { margin: 0; }
.mdx-print li.task-list-item { list-style: none; }
.mdx-print input[type="checkbox"] { margin-right: 0.5em; }

/* ============================================
   CODE
   ============================================ */

.mdx-print code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.875em;
    background-color: rgba(175, 184, 193, 0.2);
    border-radius: 6px;
    padding: 0.2em 0.4em;
}

.mdx-print pre {
    margin: 0 0 16px;
    padding: 16px;
    overflow-x: auto;
    font-size: 0.875em;
    line-height: 1.45;
    background-color: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
}

.mdx-print pre code {
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-size: inherit;
}

/* ============================================
   TABLE
   ============================================ */

.mdx-print table {
    border-collapse: collapse;
    width: 100%;
    margin: 0 0 16px;
}

.mdx-print th,
.mdx-print td {
    padding: 6px 13px;
    border: 1px solid #d0d7de;
    text-align: left;
}

.mdx-print th {
    font-weight: 600;
    background-color: #f6f8fa;
}

.mdx-print tr:nth-child(2n) {
    background-color: #f6f8fa;
}

/* ============================================
   BLOCKQUOTE
   ============================================ */

.mdx-print blockquote {
    margin: 0 0 16px;
    padding: 0 1em;
    color: #656d76;
    border-left: 0.25em solid #d0d7de;
}

/* ============================================
   HORIZONTAL RULE
   ============================================ */

.mdx-print hr {
    height: 0.25em;
    padding: 0;
    margin: 24px 0;
    background-color: #d0d7de;
    border: 0;
}

/* ============================================
   IMAGES
   ============================================ */

.mdx-print img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 16px 0;
}

/* ============================================
   CALLOUT / ADMONITION
   ============================================ */

.mdx-print-callout {
    margin: 16px 0;
    padding: 16px;
    border-radius: 6px;
    border-left: 4px solid;
}

.mdx-print-callout--note {
    border-left-color: #0969da;
    background-color: #ddf4ff;
}

.mdx-print-callout--warning {
    border-left-color: #9a6700;
    background-color: #fff8c5;
}

.mdx-print-callout--danger {
    border-left-color: #cf222e;
    background-color: #ffebe9;
}

.mdx-print-callout--tip {
    border-left-color: #1a7f37;
    background-color: #dafbe1;
}

/* ============================================
   PRINT-SPECIFIC STYLES
   ============================================ */

@media print {
    .mdx-print {
        max-width: none;
        padding: 0;
        font-size: 12pt;
    }

    .mdx-print,
    .mdx-print * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
    }

    .mdx-print a {
        color: inherit;
        text-decoration: underline;
    }

    .mdx-print a[href]::after {
        content: none !important;
    }

    .mdx-print h1,
    .mdx-print h2,
    .mdx-print h3 {
        page-break-after: avoid;
        break-after: avoid;
    }

    .mdx-print pre,
    .mdx-print blockquote,
    .mdx-print img {
        page-break-inside: avoid;
        break-inside: avoid;
    }

    /* 表格容器：打印时取消横向滚动，允许正常分页 */
    .mdx-print .mdx-table-container {
        overflow: visible !important;
    }

    /* 长表格允许断页，但单行不在中间被切断 */
    .mdx-print table {
        break-inside: auto;
        page-break-inside: auto;
    }

    .mdx-print tr {
        break-inside: avoid;
        page-break-inside: avoid;
    }

    /* 跨页时表头重复 */
    .mdx-print thead {
        display: table-header-group;
    }

    .mdx-print p,
    .mdx-print li {
        orphans: 3;
        widows: 3;
    }

    /* === 打印时展开所有折叠内容 === */

    /* foldable 块：强制展开 <details> */
    .mdx-print details:not([open]) > :not(summary) {
        display: revert !important;
    }

    /* 代码块：移除折叠高度限制 */
    .mdx-print .mdx-code-block-wrapper--collapsed pre {
        max-height: none !important;
        overflow-y: visible !important;
    }

    /* 代码块：隐藏底部展开触发器 */
    .mdx-print .mdx-code-block-expand-trigger {
        display: none !important;
    }

    /* cloze 卡片：强制显示内容 */
    .mdx-print .mdx-cloze.hidden .mdx-cloze__content {
        display: inline !important;
    }

    /* cloze 卡片：隐藏占位符 */
    .mdx-print .mdx-cloze.hidden .mdx-cloze__placeholder {
        display: none !important;
    }

    /* cloze 卡片：隐藏 NEW、冷却和危险等仅用于交互的状态标记 */
    .mdx-print .mdx-cloze::before,
    .mdx-print .mdx-cloze::after {
        content: none !important;
        display: none !important;
    }

    /* cloze 卡片：停用打印时的脉冲动画 */
    .mdx-print .mdx-cloze.is-due,
    .mdx-print .mdx-cloze.is-danger {
        animation: none !important;
    }

}

@page {
    margin: 20mm 15mm;
    size: A4;
}

/* ============================================
   UTILITY CLASSES
   ============================================ */

.mdx-print--compact {
    font-size: 12px;
    line-height: 1.5;
}

.mdx-print--no-header .mdx-print-header {
    display: none;
}

.mdx-print-content { min-width: 0; overflow-wrap: anywhere; }`;let de=class{constructor(t={}){this.rendererOptions=t}renderer=null;getRenderer(){return this.renderer||(this.renderer=new U({...this.rendererOptions})),this.renderer}getStyles(t){let e=K;if(t.pageSize&&t.pageSize!=="A4"&&(e+=`
@page { size: ${t.pageSize}; }`),t.fontSize){const n={small:"12px",normal:"14px",large:"16px"}[t.fontSize]||"14px";e+=`
.mdx-print { font-size: ${n}; }`}if(t.styles){const i=Array.isArray(t.styles)?t.styles.join(`
`):t.styles;e+=`
/* Custom Styles */
`+i}return e}async resolvePrintOptions(t){if(t.fontSize)return t;const e=await J(t.showFileName!==!1,t.locale);return e?{...t,...e}:null}buildHeader(t){if(!t.showHeader)return"";const e=this.printTitle(t),i=t.headerMeta||{};let n="";return i.author&&(n+=`<span class="mdx-print-header__meta-item">${this.escapeHtml(i.author)}</span>`),i.date&&(n+=`<span class="mdx-print-header__meta-item">${this.escapeHtml(i.date)}</span>`),i.version&&(n+=`<span class="mdx-print-header__meta-item">v${this.escapeHtml(i.version)}</span>`),t.showFileName===!1&&!n?"":`
            <header class="mdx-print-header">
                ${t.showFileName===!1?"":`<h1 class="mdx-print-header__title">${this.escapeHtml(e)}</h1>`}
                ${n?`<div class="mdx-print-header__meta">${n}</div>`:""}
            </header>
        `}async renderForPrint(t,e={}){const i=this.getRenderer(),n=document.createElement("div");n.style.cssText="position:absolute;left:-9999px;visibility:hidden;",document.body.appendChild(n);try{await i.render(n,t);let o=n.innerHTML;return e.beforePrint&&(o=e.beforePrint(o)),o}finally{document.body.removeChild(n)}}async print(t,e={}){const i=await this.resolvePrintOptions(e);if(!i)return;const n=await this.renderForPrint(t,i);await this.printFromHtml(n,i)}async printFromHtml(t,e={}){const i=await this.resolvePrintOptions(e);if(!i)return;const n=this.getStyles(i),o=this.buildHeader(i),r=i.variant==="compact"?"mdx-print--compact":"",l=o.trim()?"":"mdx-print--no-header",s="mdx-print-overlay";let d=document.getElementById(s);d||(d=document.createElement("div"),d.id=s,document.body.appendChild(d));const c="mdx-print-overlay-style";let h=document.getElementById(c);h||(h=document.createElement("style"),h.id=c,document.head.appendChild(h)),h.textContent=`
            #${s} { display: none; }
            @media print {
                html, body {
                    overflow: visible !important;
                    height: auto !important;
                    position: static !important;
                }
                body > *:not(#${s}) { display: none !important; }
                #${s} {
                    display: block !important;
                    position: static !important;
                    width: auto !important;
                    overflow: visible !important;
                    height: auto !important;
                }
            }
            ${n}
        `,t=this.preprocessHtmlForPrint(t),d.innerHTML=`
            <article class="mdx-print ${r} ${l}">
                ${o}
                <main class="mdx-print-content">
                    ${t}
                </main>
            </article>
        `,await new Promise(g=>setTimeout(g,300));const m=document.title;i.showFileName===!1?document.title="":(i.title||i.fileName)&&(document.title=this.printTitle(i));const u=this.cleanupAfterPrint(d,h,m);try{window.print()}catch(g){throw u(),g}}printTitle(t){if(!t.fileName)return t.title||"Untitled Document";const e=t.fileName.split(/[\\/]/).pop()||t.fileName,i=e.lastIndexOf(".");return i>0&&i<e.length-1?e.slice(0,i):e}preprocessHtmlForPrint(t){return t.replace(/<details(?![^>]*\bopen\b)([^>]*)>/g,"<details open$1>")}cleanupAfterPrint(t,e,i){let n=!1;const o=()=>{n||(n=!0,clearTimeout(r),document.title=i,window.removeEventListener("afterprint",o),window.removeEventListener("focus",o),t.parentNode&&(t.innerHTML=""),e.parentNode&&document.head.removeChild(e))};window.addEventListener("afterprint",o,{once:!0}),window.addEventListener("focus",o,{once:!0});const r=setTimeout(o,6e4);return o}escapeHtml(t){const e=document.createElement("div");return e.textContent=t,e.innerHTML}destroy(){this.renderer&&(this.renderer.destroy(),this.renderer=null)}};function P(a){return!!a&&!/^(?:[a-z][a-z0-9+.-]*:|[\\/#?]|@asset\/)/i.test(a)}class Q{lifetime=new AbortController;urls=new Map;install(t){t.getAssets()?.readDocumentImage&&t.registerSyntaxExtension({renderer:{image(e){if(!P(e.href)||/^(?:(?:video|file)\[[^\]]*\]|embed)$/.test(e.text))return!1;const i=e.title?` title="${T(e.title)}"`:"";return`<img data-mdx-document-image="${T(e.href)}" alt="${T(e.text)}"${i}>`}}})}update(t,e,i,n){const o=i.getAssets();if(!o?.readDocumentImage)return;for(const[s,d]of this.urls)e.contains(s)||(URL.revokeObjectURL(d),this.urls.delete(s));const r=n?AbortSignal.any([n,this.lifetime.signal]):this.lifetime.signal,l=new Map;for(const s of t.querySelectorAll("img[data-mdx-document-image]")){const d=s.dataset.mdxDocumentImage;if(!P(d))continue;let c=l.get(d);c||(c=this.read(o,d,r),l.set(d,c)),this.present(s,d,e,r,c,i)}}async read(t,e,i){const n=O(),o=performance.now();try{i.throwIfAborted();const r=await t.readDocumentImage(e,i);return console.debug("[mdx] document.image",{operationId:n,stage:"read",result:"success",bytes:r.data.byteLength,durationMs:performance.now()-o}),r}catch(r){throw i.aborted||console.warn("[mdx] document.image",{operationId:n,stage:"read",result:"failure",code:H(r),durationMs:performance.now()-o}),r}}async present(t,e,i,n,o,r){try{const{data:l,mimeType:s}=await o;if(n.aborted||!i.contains(t))return;const d=URL.createObjectURL(new Blob([l],{type:s}));this.urls.set(t,d),t.src=d,t.dataset.originalSrc=e}catch(l){if(n.aborted||!i.contains(t))return;const s=H(l);t.dataset.mdxAssetError=s;const d=`editor.image.${s}`,c=r.translate?.(d)??d;t.title=c===d?S(d):c,t.alt=[t.alt,t.title].filter(Boolean).join(" · ")}finally{delete t.dataset.mdxDocumentImage}}destroy(){this.lifetime.abort();for(const t of this.urls.values())URL.revokeObjectURL(t);this.urls.clear()}}function H(a){if(a instanceof URIError)return"EINVAL";const t=a?.code;return t&&["ENOENT","EACCES","EINVAL","EFBIG"].includes(t)?t:"EIO"}class pe{name="core:asset-resolver";priority=95;createdUrls=new Set;documentImages=new Q;constructor(t={}){}install(t){this.documentImages.install(t),t.on("domUpdated",async e=>{this.documentImages.update(e.element,e.root??e.element,t,e.signal),await this.resolveAssets(e.element,t)}),t.registerCommand?.("pruneAssets",async()=>await this.pruneUnusedAssets(t))}async resolveAssets(t,e){const i=e.getAssets();if(!i)return;const n=l=>i.read(l),o=t.querySelectorAll("[src], [href]"),r=[];for(const l of o){const s=l.hasAttribute("src")?"src":"href",d=l.getAttribute(s);if(!d||l.hasAttribute("data-original-src")||!d.startsWith("@asset/"))continue;const c=d.slice(7);r.push(n(c).then(h=>{if(!h)return;const m=i.mimeType?.(c)??"application/octet-stream",u=URL.createObjectURL(new Blob([h],{type:m}));this.createdUrls.add(u),l.setAttribute(s,u),l.setAttribute("data-original-src",d),l.tagName==="IMG"&&l.removeAttribute("srcset")}).catch(()=>{console.warn("[AssetResolver] Resolve error:",c)}))}await Promise.all(r)}async pruneUnusedAssets(t){return t.getAssets()?.prune?.()??0}destroy(){this.documentImages.destroy(),this.createdUrls.forEach(t=>URL.revokeObjectURL(t)),this.createdUrls.clear()}}const B='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3l2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z"/><path d="M20 2v4M18 4h4"/></svg>',Z='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',D='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/></svg>',X='<svg class="mdx-ai-chat__spinner" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 12a8 8 0 1 1-8-8"/></svg>',ee='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/></svg>';function C(a){const t=a.cloneNode(!0);return t.querySelectorAll?.(".mdx-ai-chat").forEach(e=>e.replaceChildren()),t.textContent??""}function te(a,t){let e=a.nodeType===Node.ELEMENT_NODE?a:a.parentElement;for(;e&&e.parentElement!==t;)e=e.parentElement;return e?.parentElement===t?e:void 0}function ie(a,t){if(!a.focusNode)return;const e=t.cloneRange();e.setStart(a.focusNode,a.focusOffset),e.collapse(!0);const i=e.getBoundingClientRect?.();if(i&&i.height>0)return i;const n=Array.from(t.getClientRects?.()??[]),o=a.focusNode===t.startContainer&&a.focusOffset===t.startOffset,r=o?n[0]:n.at(-1);if(r)return new DOMRect(o?r.left:r.right,r.top,0,r.height)}async function ne(a,t,e,i){const n=te(t.endContainer,e);if(!n||!e.contains(t.startContainer))throw new Error("请重新选择文档中的文字");if((t.endContainer.nodeType===Node.ELEMENT_NODE?t.endContainer:t.endContainer.parentElement)?.closest("pre, code, button, input, textarea, .mdx-ai-chat"))throw new Error("请在普通 Markdown 正文中选择文字");const r=C(n),l=document.createRange();l.selectNodeContents(n),l.setEnd(t.endContainer,t.endOffset);const s=C(l.cloneContents()),d=[...e.children].slice(0,[...e.children].indexOf(n)).filter(m=>m.tagName===n.tagName&&C(m)===r).length;let c=0,h=0;for(const m of G(a)){const u=a.indexOf(m.raw,c);if(u<0)continue;c=u+m.raw.length;const g=document.createElement("div");if(g.innerHTML=await i(m.raw),g.children.length!==1||g.firstElementChild?.tagName!==n.tagName||C(g.firstElementChild)!==r||h++!==d)continue;const I=`MDXAIPOS${O().replaceAll("-","")}`;let E;for(let b=0;b<=m.raw.length;b++){const L=m.raw[b-1],k=s.at(-1);if(s.length&&L!==k&&L!==";"&&!/[*_~\])]/.test(L??""))continue;g.innerHTML=await i(m.raw.slice(0,b)+I+m.raw.slice(b));const M=C(g.firstElementChild??g);M.indexOf(I)===s.length&&M.replace(I,"")===r&&(E=u+b)}if(E!==void 0)return E;break}throw new Error("无法准确定位选区的 Markdown 源码，请在普通段落中重新选择")}class oe{constructor(t,e,i,n){this.context=t,this.host=e,this.signal=i,this.inserted=n,this.cleanups.push(t.on("editorPostInit",({editor:o})=>this.mount(o)))}editor;root;range;text="";busy=!1;disposed=!1;popup;cleanups=[];mount(t){if(this.editor=t,!t.container)return;this.root=t.container.querySelector(".mdx-editor-container__render-mode")??void 0;const e=this.popup=document.createElement("button");e.type="button",e.hidden=!0,e.className="mdx-ai-selection",e.innerHTML=B,e.title="为选区插入 AI",e.setAttribute("aria-label",e.title),document.body.append(e);const i=r=>r.preventDefault();e.addEventListener("pointerdown",i),e.onclick=()=>{this.insert()};const n=()=>this.update();document.addEventListener("selectionchange",n),document.addEventListener("scroll",n,!0),window.addEventListener("resize",n);const o=t.on("modeChanged",n);this.cleanups.push(o),this.cleanups.push(()=>document.removeEventListener("selectionchange",n),()=>document.removeEventListener("scroll",n,!0),()=>window.removeEventListener("resize",n)),this.update()}update(){if(this.disposed||!this.editor||!this.root)return;const t=document.getSelection(),e=t?.rangeCount?t.getRangeAt(0):void 0,n=!this.busy&&!this.editor.config.readOnly&&this.editor.getMode()==="render"&&e&&!e.collapsed&&this.root.contains(e.commonAncestorContainer)&&!(e.startContainer.parentElement?.closest(".mdx-ai-chat")||e.endContainer.parentElement?.closest(".mdx-ai-chat"));if(this.range=n?e.cloneRange():void 0,this.text=n?this.editor.getText():"",!!this.popup&&(this.popup.hidden=!this.range,this.range&&t)){const o=ie(t,this.range);if(!o){this.popup.hidden=!0;return}this.popup.style.left=`${Math.max(8,Math.min(o.right,innerWidth-44))}px`,this.popup.style.top=`${Math.max(8,Math.min(o.bottom+6,innerHeight-44))}px`}}async insert(){const t=this.range?.cloneRange(),e=this.editor,i=this.root,n=this.text,o=this.signal();if(this.busy||!t||!e||!i||e.getMode()!=="render"||e.config.readOnly)return;this.busy=!0,this.popup&&(this.popup.hidden=!0);const r=O(),l=this.context.getDocumentPath();try{const s=C(t.cloneContents());if(!s.trim())return;const d=await ne(n,t,i,h=>this.context.renderMarkdown(h));if(o.throwIfAborted(),e.getText()!==n||e.getMode()!=="render")throw new Error("文档或模式已改变，请重新选择");const c={anchorId:r,documentPath:l,defaultPrompt:s};if(await this.host.createAnchor({source:c,selection:s,signal:o}),o.throwIfAborted(),e.getMode()!=="render")throw new Error("模式已改变，请重新选择");if(this.inserted(c,s),!e.applySourceEdit(d,d,`::@${r}@`,n))throw new Error("文档已改变，请重新选择");document.getSelection()?.removeAllRanges()}catch(s){o.aborted||this.context.notify(s instanceof Error?s.message:String(s),"error")}finally{this.busy=!1,this.update()}}destroy(){this.disposed=!0,this.cleanups.splice(0).forEach(t=>t()),this.popup?.remove()}}function me(a){const t=new q($("mdxAiChatAnchor")),e=new Set;return t.walkTokens(t.lexer(a),i=>{i.type==="mdxAiChatAnchor"&&e.add(i.anchorId)}),[...e]}function re(a){const t=new q($("mdxAiChat")),e=[];let i=0;for(const n of t.lexer(a)){const o=a.indexOf(n.raw,i);o<0||(i=o+n.raw.length,n.type==="mdxAiChat"&&e.push({from:o,to:i,prompt:String(n.prompt??"")}))}return e}function se(a,t,e){const i=new U({htmlPolicy:"literal",documentPath:t.documentPath,assets:a.getAssets(),signal:e});return i.usePlugin({name:"ai-preview:links",install(n){n.on("domUpdated",({element:o})=>{o.querySelectorAll("a[href], img[src]").forEach(r=>{const l=r.tagName==="A"?"href":"src",s=r.getAttribute(l)??"";/^(?:javascript|data|vbscript):/i.test(s.replace(/[\u0000-\u0020]/g,""))&&r.removeAttribute(l)})})}}),i}class he{constructor(t){this.options=t}name="interaction:ai-chat";cleanups=[];lifetime=new AbortController;drafts=new Map;path;selectionActions;install(t){const e=$("mdxAiChat");e.extensions.push({name:"mdxAiChat",renderer:n=>`<div class="mdx-ai-chat" data-mdx-ai-prompt="${T(n.prompt)}"></div>
`}),t.registerSyntaxExtension(e);const i=$("mdxAiChatAnchor");i.extensions.push({name:"mdxAiChatAnchor",renderer:n=>`<span class="mdx-ai-chat mdx-ai-chat--anchor" data-mdx-ai-prompt="" data-mdx-ai-id="${T(n.anchorId)}"></span>`}),t.registerSyntaxExtension(i),this.options.host.createAnchor&&this.options.selectionActions!==!1&&(this.selectionActions=new oe(t,this.options.host,()=>this.lifetime.signal,(n,o)=>{this.drafts.set(JSON.stringify([n.documentPath,"anchor",n.anchorId]),{...this.newDraft(o,!0),focusOnMount:!0})})),this.cleanups.push(t.on("domUpdated",({element:n,options:o})=>{const r=t.getDocumentPath();r!==this.path&&(this.lifetime.abort(),this.lifetime=new AbortController,this.drafts.forEach(s=>{s.stop?.(),s.preview?.destroy()}),this.drafts.clear(),this.path=r);const l=new Map;n.querySelectorAll("[data-mdx-ai-prompt]").forEach(s=>{const d=s.dataset.mdxAiPrompt,c=s.dataset.mdxAiId,h={documentPath:r,defaultPrompt:d,...c?{anchorId:c}:{}},m=l.get(d)??0;l.set(d,m+1);const u=JSON.stringify(c?[r,"anchor",c]:[r,o?.blockIndex??"document",d,m]);if(s.dataset.mdxAiMounted)return;s.dataset.mdxAiMounted="true";let g=this.drafts.get(u);g||(g=this.newDraft(d,!c),this.drafts.set(u,g)),this.mount(s,g,h,t)})}))}newDraft(t,e){return{expanded:e,previewOpen:!1,anchorRead:0,revision:0,prompt:t,attachments:[],targets:[],busy:!1,loading:!1,status:""}}activate(t,e){if(t.targetsRead||(t.loading=!0,t.targetsRead=this.loadTargets(t,e),t.refresh?.(),e.anchorId&&this.loadAnchor(t,e)),e.anchorId&&this.options.host.observeAnchor&&!t.stop){let i;const n=this.options.host.observeAnchor({source:e,signal:this.lifetime.signal},()=>{i===void 0&&(i=setTimeout(()=>{i=void 0,t.expanded&&this.loadAnchor(t,e)},150))});t.stop=()=>{i!==void 0&&clearTimeout(i),n()}}return t.targetsRead}async loadTargets(t,e){const i=this.lifetime.signal;try{const[n,o]=await Promise.all([this.options.host.listTargets({source:e,signal:i}),this.options.host.getDefaultTarget?.({source:e,signal:i})]);if(i.aborted)return;t.targets=n;const r=this.options.defaultTarget??o;t.target=n.find(l=>l.id===r?.id&&l.kind===r.kind)??n.find(l=>l.kind==="agent"&&l.id==="default")??n.find(l=>l.kind==="agent")??n[0],t.target||(t.status="没有可用的 agent / flow")}catch(n){i.aborted||(t.status=this.errorMessage(n))}finally{i.aborted||(t.loading=!1,t.refresh?.())}}async promoteLegacy(t,e,i,n){if(i.anchorId||!this.options.host.createAnchor)return;const o=n.pluginManager.editorInstance;if(!o||o.config.readOnly||o.getMode()!=="render"||!o.container)return;const r=o.getText(),l=[...o.container.querySelectorAll("[data-mdx-ai-prompt]:not([data-mdx-ai-id])")].filter(m=>m.dataset.mdxAiPrompt===i.defaultPrompt),s=re(r).filter(m=>m.prompt===i.defaultPrompt)[l.indexOf(t)];if(!s)throw new Error("无法定位旧 AI 输入行，请用选区菜单重新插入");const d=O(),c=this.lifetime.signal;if(await this.options.host.createAnchor({source:{...i,anchorId:d},selection:"",signal:c}),c.throwIfAborted(),o.getText()!==r||o.getMode()!=="render")throw new Error("文档已改变，请重新发送");i.anchorId=d;for(const[m,u]of this.drafts)u===e&&this.drafts.delete(m);this.drafts.set(JSON.stringify([i.documentPath,"anchor",d]),e);const h=r.slice(s.from,s.to).match(/(?:\r?\n[ \t]*)+$/)?.[0]??"";if(!o.applySourceEdit(s.from,s.to,`::@${d}@${h}`,r))throw new Error("文档已改变，请重新发送")}async loadAnchor(t,e){if(!e.anchorId||!this.options.host.getAnchor)return;const i=this.lifetime.signal,n=++t.anchorRead;try{const o=await this.options.host.getAnchor({source:e,signal:i,includeResponse:t.previewOpen});if(i.aborted||n!==t.anchorRead)return;t.anchor=o,!t.revision&&!t.prompt&&o.defaultPrompt&&(t.prompt=o.defaultPrompt),t.anchorStatus=o.status==="missing"?"关联的分支已删除；再次发送会创建新分支":"",t.refresh?.()}catch(o){!i.aborted&&n===t.anchorRead&&(t.anchorStatus=this.errorMessage(o),t.refresh?.())}}mount(t,e,i,n){const o=this.lifetime.signal;e.preview?.destroy(),e.preview=void 0,t.innerHTML=`${i.anchorId?`<button type="button" class="mdx-ai-chat__toggle" aria-label="展开 AI 输入">${B}</button>`:""}<form class="mdx-ai-chat__form">
      <details class="mdx-ai-chat__target-picker">
        <summary class="mdx-ai-chat__target" aria-label="选择 agent 或 flow" aria-disabled="true"></summary>
        <div class="mdx-ai-chat__targets" role="group" aria-label="可用的 agent 和 flow"></div>
      </details>
      <textarea rows="1" class="mdx-ai-chat__prompt" aria-label="AI 提示词" placeholder="输入提示词"></textarea>
      <button type="button" class="mdx-ai-chat__attach" aria-label="添加附件">+</button>
      <button type="submit" aria-label="发送">${D}</button>
      ${this.options.host.getAnchor&&i.anchorId?`<button type="button" class="mdx-ai-chat__preview-toggle" aria-label="展开起始回复">${Z}</button>`:""}
      <input type="file" multiple hidden>
      <div class="mdx-ai-chat__attachments"></div>
      <span class="mdx-ai-chat__status" role="status" aria-live="polite"></span>
    </form><section class="mdx-ai-chat__response" hidden><p class="mdx-ai-chat__activity" role="status" aria-live="polite"></p><div class="mdx-ai-chat__response-body" tabindex="0"></div>
      <button type="button" class="mdx-ai-chat__history" hidden>起始回复</button><button type="button" class="mdx-ai-chat__open">跳转到分支</button></section>`;const r=t.querySelector("form"),l=t.querySelector(".mdx-ai-chat__target-picker"),s=l.querySelector("summary"),d=t.querySelector(".mdx-ai-chat__targets"),c=t.querySelector(".mdx-ai-chat__prompt"),h=t.querySelector(".mdx-ai-chat__attach"),m=t.querySelector('[type="submit"]'),u=t.querySelector('[type="file"]'),g=t.querySelector(".mdx-ai-chat__attachments"),I=t.querySelector('[role="status"]'),E=t.querySelector(".mdx-ai-chat__toggle"),b=t.querySelector(".mdx-ai-chat__preview-toggle"),L=t.querySelector(".mdx-ai-chat__response"),k=t.querySelector(".mdx-ai-chat__response-body"),M=t.querySelector(".mdx-ai-chat__open"),R=t.querySelector(".mdx-ai-chat__history"),F=t.querySelector(".mdx-ai-chat__activity");let N=null;c.value=e.prompt;const j=()=>{c.style.height="auto",c.style.height=`${c.scrollHeight}px`},x=()=>{r.hidden=!e.expanded,t.classList.toggle("mdx-ai-chat--expanded",e.expanded),E?.setAttribute("aria-expanded",String(e.expanded)),L.hidden=!e.expanded||!e.previewOpen,b?.setAttribute("aria-expanded",String(e.previewOpen)),M.hidden=!this.options.host.openConversation||e.anchor?.status!=="bound",c.value!==e.prompt&&(c.value=e.prompt),j();const p=e.anchor?.activity,f=e.followLatest&&p?p.markdown:e.anchor?.response?.markdown,y=e.busy?"submitting":p?.status==="pending"?p.markdown?"responding":"waiting":p?.status??"ready",w=y==="submitting"?"正在提交…":y==="waiting"?"等待回复…":y==="responding"?"正在回复…":y==="completed"?"回复完成":y==="failed"?"回复失败，请打开分支查看":"";m.dataset.state=y,m.title=w||"发送",m.innerHTML=["submitting","waiting","responding"].includes(y)?X:y==="failed"?ee:D,F.textContent=w,R.hidden=!p||!e.anchor?.response||p.id===e.anchor.response.id,R.textContent=e.followLatest?"查看起始回复":"查看最新回复",b?.setAttribute("aria-label",e.previewOpen?"收起回复":"展开回复"),e.previewOpen&&f===void 0&&(e.preview?.destroy(),e.preview=void 0,k.textContent=e.anchor?.status==="bound"?"等待起始回复…":"尚未关联分支"),e.previewOpen&&f!==N&&(N=f,f!==void 0&&(e.preview||(k.textContent="正在渲染…"),(e.preview??=se(n,i,o)).renderStreaming(k,f).catch(v=>{!o.aborted&&N===f&&v?.name!=="AbortError"&&(k.textContent=this.errorMessage(v))}))),s.textContent=e.target?.label??(e.loading?"选择…":"选择 agent / flow"),s.title=e.target?`${e.target.kind}: ${e.target.label}`:"选择 agent 或 flow",s.setAttribute("aria-disabled",String(e.busy||e.loading)),(e.busy||e.loading)&&(l.open=!1),d.replaceChildren(...e.targets.map(A=>{const v=document.createElement("button");return v.type="button",v.textContent=`${A.kind==="flow"?"Flow · ":""}${A.label}`,v.setAttribute("aria-pressed",String(A===e.target)),v.disabled=e.busy||e.loading,v.onclick=()=>{o.aborted||e.busy||e.loading||(e.target!==A&&(e.target=A,e.revision++),l.open=!1,x(),s.focus())},v})),c.disabled=h.disabled=e.busy,m.disabled=e.busy||e.loading||!e.target||!e.prompt.trim(),r.setAttribute("aria-busy",String(e.busy)),I.textContent=e.busy?"正在提交…":e.loading?"加载 agent / flow…":e.anchorStatus||e.status,g.replaceChildren(...e.attachments.map((A,v)=>{const _=document.createElement("button");_.type="button";const z=A.kind==="file"?A.file.name:A.name;return _.textContent=`${z} ×`,_.setAttribute("aria-label",`移除附件 ${z}`),_.disabled=e.busy,_.onclick=()=>{e.attachments.splice(v,1),e.revision++,x()},_}))};e.refresh=x,E&&(E.onclick=()=>{e.expanded=!e.expanded,x(),e.expanded&&(this.activate(e,i),c.focus())}),b&&(b.onclick=()=>{e.previewOpen=!e.previewOpen,x(),e.previewOpen&&this.loadAnchor(e,i)}),R.onclick=()=>{e.followLatest=!e.followLatest,x()},M.onclick=async()=>{try{await this.options.host.openConversation?.({source:i,signal:o})}catch(p){o.aborted||(e.status=this.errorMessage(p),x())}},c.onkeydown=p=>{p.key==="Enter"&&(p.ctrlKey||p.metaKey)&&!p.isComposing&&(p.preventDefault(),r.requestSubmit())},r.addEventListener("focusin",()=>{this.activate(e,i)}),c.oninput=()=>{e.prompt!==c.value&&(e.prompt=c.value,e.revision++),x()},s.onclick=p=>{if(e.busy||o.aborted){p.preventDefault();return}!e.target&&!e.loading&&(e.targetsRead=void 0),(!e.targetsRead||e.loading)&&(p.preventDefault(),this.activate(e,i).then(()=>{!o.aborted&&e.targets.length&&(l.open=!0)}))},l.onkeydown=p=>{p.key==="Escape"&&(l.open=!1,s.focus())},r.addEventListener("paste",p=>{if(e.busy||o.aborted||!p.clipboardData)return;const f=Array.from(p.clipboardData.files),y=f.length?f:Array.from(p.clipboardData.items).filter(w=>w.kind==="file").map(w=>w.getAsFile()).filter(w=>!!w);y.length&&(p.preventDefault(),e.attachments.push(...y.map(w=>({kind:"file",file:w}))),e.revision++,x())}),u.onchange=()=>{const p=Array.from(u.files??[]);p.length&&(e.attachments.push(...p.map(f=>({kind:"file",file:f}))),e.revision++),u.value="",x()},h.onclick=async()=>{if(this.activate(e,i),!(e.busy||o.aborted)){if(!this.options.host.pickAttachments){u.click();return}e.busy=!0,x();try{const p=await this.options.host.pickAttachments({source:i,attachments:[...e.attachments],signal:o});!o.aborted&&p.length&&(e.attachments.push(...p),e.revision++)}catch(p){o.aborted||(e.status=this.errorMessage(p))}finally{o.aborted||(e.busy=!1,e.refresh?.())}}},r.onsubmit=async p=>{if(p.preventDefault(),(!e.targetsRead||e.loading)&&await this.activate(e,i),!(e.busy||e.loading||!e.target||!e.prompt.trim()||o.aborted)){e.busy=!0,e.status="",x();try{if(!i.anchorId&&this.options.host.createAnchor&&await this.promoteLegacy(t,e,i,n),(!e.submission||e.submission.revision!==e.revision)&&(e.submission={revision:e.revision,operationId:O()}),await this.options.host.onSubmit({operationId:e.submission.operationId,prompt:e.prompt,target:{...e.target},attachments:[...e.attachments],source:{...i},signal:o}),!o.aborted){const f=e.submission.operationId;e.attachments=[],e.submission=void 0,e.revision++,i.anchorId&&this.options.host.getAnchor?(e.followLatest=!0,e.previewOpen=!0,e.status="",e.anchor={...e.anchor,status:"bound",activity:{id:f,operationId:f,status:"pending",markdown:""}},this.activate(e,i),this.loadAnchor(e,i)):e.status="已发送"}}catch(f){o.aborted||(e.status=this.errorMessage(f))}finally{o.aborted||(e.busy=!1,e.refresh?.())}}},x(),e.focusOnMount&&(e.focusOnMount=!1,this.activate(e,i),c.focus())}errorMessage(t){return t instanceof Error?t.message:String(t)}destroy(){this.lifetime.abort(),this.selectionActions?.destroy(),this.drafts.forEach(t=>{t.stop?.(),t.preview?.destroy()}),this.cleanups.splice(0).forEach(t=>t()),this.drafts.clear()}}export{he as A,de as D,V as R,me as a,pe as b,le as c,O as r};
