// Ad Shield – content script (runs in the extension's isolated world).
// Responsibilities:
//  1) Find and remove invisible, full-screen "click trap" overlays.
//  2) Report what each click landed on to the background worker, which uses it
//     to decide whether a newly opened window is a genuine request or an ad.
//  3) Undo hyperlink tampering: links rewritten to another site after load.
(() => {
  if (window.__adShieldLoaded) return;
  window.__adShieldLoaded = true;

  const topHost = (() => {
    try {
      const anc = location.ancestorOrigins;
      if (anc && anc.length) return new URL(anc[anc.length - 1]).hostname;
    } catch (e) {}
    return location.hostname;
  })();

  let enabled = true;
  chrome.storage.local.get({ disabledSites: [] }, (d) => {
    enabled = !d.disabledSites.some((h) => topHost === h || topHost.endsWith('.' + h));
    if (!enabled) document.documentElement.setAttribute('data-as-off', '');
    else sweep();
  });

  const MEANINGFUL = 'video,audio,canvas,img,svg,input,textarea,select,button,form,[role=dialog] input';

  // Is this element a click trap? Fixed/absolute, covers at least half the
  // viewport, sits on a very high layer, and is almost invisible and empty.
  function isTrapOverlay(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.documentElement || el === document.body) return false;
    // Transparent backdrops behind menus and dialogs (Material, Angular CDK,
    // Bootstrap...) close the menu on an outside click; they are not traps.
    if (/backdrop|cdk-overlay|modal|dialog|drawer|scrim/i.test((el.className || '') + ' ' + el.id)) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    const vw = innerWidth || 1, vh = innerHeight || 1;
    const cover = (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) *
                   Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
    if (cover < 0.5) return false;
    const z = parseInt(cs.zIndex, 10);
    if (!(z >= 999)) return false;
    const opacity = parseFloat(cs.opacity);
    const bg = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const bgAlpha = bg ? (bg[1].split(',')[3] !== undefined ? parseFloat(bg[1].split(',')[3]) : 1) : 0;
    const noImage = cs.backgroundImage === 'none';
    const text = (el.innerText || '').trim();
    const empty = text.length < 3 && !el.querySelector(MEANINGFUL);
    const invisible = opacity < 0.05 || (bgAlpha < 0.08 && noImage);
    // Never remove a video player or a real dialog (sign-in form etc.).
    if (el.querySelector('video, iframe[allowfullscreen], form, input[type=password]')) return false;
    return invisible && empty;
  }

  function neutralize(el) {
    el.setAttribute('data-as-removed', '');
    el.style.setProperty('pointer-events', 'none', 'important');
    el.style.setProperty('display', 'none', 'important');
    try { chrome.runtime.sendMessage({ t: 'overlay' }); } catch (e) {}
  }

  function sweep() {
    if (!enabled || !document.body) return;
    // Direct children of body and inline-positioned elements are enough, and cheap.
    const cands = document.body.querySelectorAll('body > *, [style*="fixed"], [style*="z-index"]');
    for (const el of cands) if (!el.hasAttribute('data-as-removed') && isTrapOverlay(el)) neutralize(el);
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; sweep(); }, 150);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  document.addEventListener('DOMContentLoaded', sweep);
  addEventListener('load', sweep);

  // Hyperlink tampering: if a script rewrites a same-site link to another site
  // after load, remember the original address and go there on click.
  const base = (h) => h.split('.').slice(-2).join('.');
  const originalHref = new WeakMap();
  new MutationObserver((muts) => {
    for (const m of muts) {
      const a = m.target;
      if (a.tagName !== 'A' || !m.oldValue) continue;
      try {
        const before = new URL(m.oldValue, location.href), after = new URL(a.href);
        if (base(before.hostname) === base(location.hostname) && base(after.hostname) !== base(location.hostname)) {
          if (!originalHref.has(a)) originalHref.set(a, before.href);
        }
      } catch (e) {}
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['href'], attributeOldValue: true });

  // Work out the intent behind a click.
  function describeClick(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    let trap = false, intent = 'none', href = null;
    for (const n of path) {
      if (!(n instanceof HTMLElement)) continue;
      if (!trap && isTrapOverlay(n)) trap = true;
      if (intent === 'none') {
        if (n.tagName === 'A' && n.href) { intent = 'link'; href = n.href; }
        else if (n.matches('button, input[type=button], input[type=submit], [role=button], [onclick]')) intent = 'button';
      }
    }
    // Modern sites make cards clickable with JS listeners and no onclick
    // attribute; a pointer cursor is the visible sign of a real control.
    if (intent === 'none' && !trap) {
      for (const n of path) {
        if (!(n instanceof HTMLElement) || n === document.body) break;
        if (getComputedStyle(n).cursor === 'pointer') { intent = 'button'; break; }
      }
    }
    // A link wrapping most of the page is a trap as well.
    if (intent === 'link') {
      const a = path.find((n) => n instanceof HTMLElement && n.tagName === 'A');
      const r = a.getBoundingClientRect();
      if ((r.width * r.height) / ((innerWidth || 1) * (innerHeight || 1)) > 0.6) trap = true;
    }
    return { trap, intent, href, frameUrl: location.href };
  }

  // Capture phase: runs before the page's own listeners.
  const onClick = (e) => {
    if (!enabled || !e.isTrusted) return;
    const info = describeClick(e);
    const a = e.composedPath().find((n) => n instanceof HTMLElement && n.tagName === 'A');
    const original = a && originalHref.get(a);
    if (original) {
      info.href = original;
      try { chrome.runtime.sendMessage({ t: 'click', ...info }); } catch (err) {}
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click') location.assign(original);
      return;
    }
    try { chrome.runtime.sendMessage({ t: 'click', ...info }); } catch (err) {}
    if (info.trap) {
      // Swallow the click on the trap and remove it; the next click reaches
      // the real content.
      e.preventDefault();
      e.stopImmediatePropagation();
      const t = e.composedPath().find((n) => n instanceof HTMLElement && isTrapOverlay(n));
      if (t) neutralize(t);
    }
  };
  for (const type of ['pointerdown', 'mousedown', 'click', 'auxclick']) {
    addEventListener(type, onClick, { capture: true });
  }

  // Right-click on a link: remember it so "Open link in new tab" is allowed.
  addEventListener('contextmenu', (e) => {
    if (!enabled || !e.isTrusted) return;
    const a = e.composedPath().find((n) => n instanceof HTMLElement && n.tagName === 'A' && n.href);
    if (a) try { chrome.runtime.sendMessage({ t: 'context', href: originalHref.get(a) || a.href }); } catch (err) {}
  }, { capture: true });
})();
