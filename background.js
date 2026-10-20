// Ad Shield – background service worker.
// When a new tab or window opens, decide from the user's last click whether it
// is a genuine request (sign-in window, clicked link) or an ad. Ads are closed
// immediately.

// Always allowed: sign-in, payment and sharing windows.
const TRUSTED = [
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com',
  'github.com', 'gitlab.com', 'facebook.com', 'www.facebook.com', 'm.facebook.com',
  'twitter.com', 'x.com', 'api.twitter.com', 'discord.com', 'id.twitch.tv', 'steamcommunity.com',
  'auth0.com', 'okta.com', 'linkedin.com', 'www.linkedin.com', 'instagram.com',
  'paypal.com', 'www.paypal.com', 'checkout.stripe.com', 'hooks.stripe.com', 'iyzipay.com',
  'sandbox-api.iyzipay.com', 'pay.google.com', 'wa.me', 'api.whatsapp.com', 't.me',
  'telegram.me', 'reddit.com', 'pinterest.com', 'e-devlet.gov.tr', 'giris.turkiye.gov.tr',
  'turkiye.gov.tr', 'youtube.com', 'www.youtube.com'
];
// Ad networks and pay-per-click link shorteners that should never open as a
// new tab. General-purpose shorteners (bit.ly, rebrand.ly, ...) are not listed:
// people share them in emails and posts; ad tabs through them are still caught
// by the click checks below.
const BLOCKED = [
  'ouo.io', 'shrinkme.io', 'adf.ly',
  'linkvertise.com', 'herdembilgiler.com', 'popads.net', 'popcash.net', 'propellerads.com',
  'onclickads.net', 'adsterra.com', 'exoclick.com', 'hilltopads.net', 'clickadu.com',
  'adcash.com', 'monetag.com', 'trafficstars.com', 'juicyads.com'
];

// Gambling domains that keep reappearing with a new number appended
// ("bahis" and "kumar" are the Turkish words for betting and gambling).
const GAMBLING = /(^|\.)[a-z]*(bet|casino|bahis|slot|bonus|kumar)[a-z]*\d{2,}\.[a-z]{2,}$/;

const CLICK_WINDOW = 3000; // ms – a new tab must open within this time to count as caused by a click
const CONTEXT_WINDOW = 120000; // ms – "Open link in new tab" from the right-click menu
const lastClick = new Map(); // tabId -> {t, trap, intent, href, frameUrl}
const lastContext = new Map(); // tabId -> {t, href}: link the user right-clicked

const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const matches = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));
// Rough registrable domain: "a.b.example.com.tr" -> "example.com.tr"
function baseDomain(h) {
  const p = h.split('.');
  const twoPart = /^(com|net|org|gov|edu|co|gen|web|bel|k12)$/.test(p[p.length - 2] || '') && p.length > 2;
  return p.slice(twoPart ? -3 : -2).join('.');
}
const sameSite = (a, b) => a && b && baseDomain(a) === baseDomain(b);

async function isDisabled(h) {
  const { disabledSites = [] } = await chrome.storage.local.get('disabledSites');
  return matches(h, disabledSites);
}

async function count(tabId, field) {
  const key = 'count_' + tabId;
  const d = (await chrome.storage.session.get(key))[key] || { popups: 0, overlays: 0 };
  d[field]++;
  await chrome.storage.session.set({ [key]: d });
}

chrome.runtime.onMessage.addListener((m, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  if (m.t === 'click') {
    const prev = lastClick.get(tabId);
    // One physical click produces up to 4 events; keep the trap flag across them.
    const same = prev && Date.now() - prev.t < 400;
    lastClick.set(tabId, {
      t: Date.now(),
      trap: m.trap || (same && prev.trap),
      intent: m.intent !== 'none' ? m.intent : (same ? prev.intent : 'none'),
      href: m.href || (same ? prev.href : null),
      frameUrl: m.frameUrl
    });
  } else if (m.t === 'context') {
    lastContext.set(tabId, { t: Date.now(), href: m.href });
  } else if (m.t === 'overlay') {
    count(tabId, 'overlays');
  }
});

// Decision: true = ad, close it; false = allow; null = no URL yet, check again later.
async function isAd(sourceTab, targetUrl, win) {
  const sourceHost = host(sourceTab.url || '');
  const targetHost = host(targetUrl);
  if (!sourceHost || await isDisabled(sourceHost)) return false;
  if (!targetHost) return null; // still about:blank
  if (matches(targetHost, BLOCKED) || GAMBLING.test(targetHost)) return true;
  if (matches(targetHost, TRUSTED)) return false;
  if (sameSite(sourceHost, targetHost)) return false;

  // The user right-clicked this link and chose "Open link in new tab".
  const ctx = lastContext.get(sourceTab.id);
  if (ctx && Date.now() - ctx.t < CONTEXT_WINDOW && host(ctx.href) === targetHost) return false;

  // Tiny windows such as 5x5 exist only to host ads.
  if (win && win.type === 'popup' && (win.width < 120 || win.height < 120)) return true;

  const click = lastClick.get(sourceTab.id);
  const fresh = click && Date.now() - click.t < CLICK_WINDOW;
  if (!fresh) return true;        // cross-site tab opened without a click
  if (click.trap) return true;    // click landed on an invisible overlay
  if (click.intent === 'link') {
    // The user clicked a link: is this where that link points?
    const linkHost = host(click.href);
    if (linkHost === targetHost || sameSite(linkHost, targetHost)) return false;
    return true;                  // link points to A, window opens B: pop-under
  }
  if (click.intent === 'button') {
    // Buttons such as "Sign in with Google" usually go to a TRUSTED host.
    // A button inside an embedded third-party frame (e.g. a video player)
    // opening an unknown site is treated as an ad.
    const frameHost = host(click.frameUrl);
    if (frameHost && !sameSite(frameHost, sourceHost)) return true;
    return false;
  }
  return true; // click on empty space opening a different site
}

const pending = new Map();    // new tabId -> {source, t}: page-opened tab still on about:blank
const lastSpawn = new Map();  // source tabId -> {t, url}: same-site tab just opened from it
const lastPage = new Map();   // tabId -> last legitimate top-frame URL

// Tab-under: the site reopens itself in a new tab and sends the original tab
// to an ad. Also catches a redirect right after a click on an invisible overlay.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const prev = lastPage.get(d.tabId);
  const newHost = host(d.url);
  const revert = async () => {
    count(d.tabId, 'popups');
    try { await chrome.tabs.update(d.tabId, { url: prev }); } catch (e) {}
  };
  if (prev && /^https?:/.test(d.url) && !sameSite(host(prev), newHost) && !(await isDisabled(host(prev)))) {
    if (matches(newHost, BLOCKED) || GAMBLING.test(newHost)) return revert();
    const click = lastClick.get(d.tabId);
    const fresh = click && Date.now() - click.t < 3000;
    const userInitiated = d.transitionType === 'typed' || d.transitionType === 'auto_bookmark' ||
      d.transitionType === 'reload' || (d.transitionQualifiers || []).includes('from_address_bar') ||
      (d.transitionQualifiers || []).includes('forward_back');
    if (!userInitiated && fresh) {
      const matchesLink = click.intent === 'link' && sameSite(host(click.href), newHost);
      const spawn = lastSpawn.get(d.tabId);
      const tabUnder = spawn && Date.now() - spawn.t < 3000;
      if (!matchesLink && (click.trap || tabUnder)) return revert();
    }
  }
  if (/^https?:/.test(d.url)) lastPage.set(d.tabId, d.url);
});

async function evaluate(newTabId, sourceTabId, url) {
  let source;
  try { source = await chrome.tabs.get(sourceTabId); } catch (e) { return; }
  let win = null;
  try {
    const t = await chrome.tabs.get(newTabId);
    win = await chrome.windows.get(t.windowId);
  } catch (e) { return; }
  const verdict = await isAd(source, url, win);
  if (verdict === null) { pending.set(newTabId, { source: sourceTabId, t: Date.now() }); return; }
  pending.delete(newTabId);
  if (!verdict && sameSite(host(source.url || ''), host(url))) lastSpawn.set(sourceTabId, { t: Date.now(), url });
  if (verdict) {
    try { await chrome.tabs.remove(newTabId); } catch (e) {}
    try { await chrome.tabs.update(sourceTabId, { active: true }); } catch (e) {}
    count(sourceTabId, 'popups');
  }
}

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  evaluate(d.tabId, d.sourceTabId, d.url);
});

// Tabs opened via window.open that do not fire onCreatedNavigationTarget.
// The browser also sets openerTabId on tabs the user opens (Cmd+T, bookmarks,
// address bar), so only tabs created right after a click on the page count.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;
  const url = tab.pendingUrl || tab.url || '';
  if (/^(chrome|brave|edge|devtools|chrome-extension):/.test(url)) return; // user-opened new tab page
  const click = lastClick.get(tab.openerTabId);
  if (!click || Date.now() - click.t > CLICK_WINDOW) return;
  if (url && !url.startsWith('about:')) {
    evaluate(tab.id, tab.openerTabId, url);
  } else {
    pending.set(tab.id, { source: tab.openerTabId, t: Date.now() });
  }
});

// Windows that open as about:blank and redirect to an ad within a few seconds.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url || !pending.has(tabId)) return;
  const p = pending.get(tabId);
  pending.delete(tabId);
  if (Date.now() - p.t > 5000) return;
  evaluate(tabId, p.source, info.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastClick.delete(tabId);
  lastContext.delete(tabId);
  pending.delete(tabId);
  lastSpawn.delete(tabId);
  lastPage.delete(tabId);
  chrome.storage.session.remove('count_' + tabId);
});

// When the shield is turned off for a site, lift the network rules there too.
async function syncAllowRules() {
  const { disabledSites = [] } = await chrome.storage.local.get('disabledSites');
  const old = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  const add = disabledSites.length ? [{
    id: 1, priority: 1000, action: { type: 'allowAllRequests' },
    condition: { requestDomains: disabledSites, resourceTypes: ['main_frame', 'sub_frame'] }
  }] : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old, addRules: add });
}
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.disabledSites) syncAllowRules(); });
chrome.runtime.onInstalled.addListener(() => {
  syncAllowRules();
  chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
});
