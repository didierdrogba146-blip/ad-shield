// Ad Shield – background service worker.
// When a new tab or window opens, decide from the user's last click whether it
// is a genuine request (sign-in window, clicked link) or an ad. Ads are closed
// immediately and logged so the user can still open them from the popup.

importScripts('domain.js'); // baseDomain(), sameSite()

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
// Ad networks: never allowed as a new tab or redirect.
const BLOCKED = [
  'herdembilgiler.com', 'popads.net', 'popcash.net', 'propellerads.com',
  'onclickads.net', 'adsterra.com', 'exoclick.com', 'hilltopads.net', 'clickadu.com',
  'adcash.com', 'monetag.com', 'trafficstars.com', 'juicyads.com'
];
// Pay-per-click link shorteners: allowed only when the user clicked a visible
// link pointing at them (file-download sites use them on purpose).
const LINK_ONLY = ['ouo.io', 'ouo.press', 'shrinkme.io', 'adf.ly', 'linkvertise.com'];

// Gambling domains that keep reappearing with a new number appended
// ("bahis" and "kumar" are the Turkish words for betting and gambling).
const GAMBLING = /(^|\.)[a-z]*(bet|casino|bahis|slot|bonus|kumar)[a-z]*\d{2,}\.[a-z]{2,}$/;

const CLICK_WINDOW = 3000;     // ms – a new tab must open within this time to count as caused by a click
const CONTEXT_WINDOW = 120000; // ms – "Open link in new tab" from the right-click menu
const POPUNDER_CHECK = 400;    // ms – how long to wait before checking whether a new tab was pushed behind

const lastClick = new Map();   // tabId -> {t, trap, intent, href, frameUrl}
const lastContext = new Map(); // tabId -> {t, href}: link the user right-clicked
const pending = new Map();     // new tabId -> {source, t}: page-opened tab still on about:blank
const lastSpawn = new Map();   // source tabId -> {t, url}: same-site tab just opened from it
const lastPage = new Map();    // tabId -> last legitimate top-frame URL
const judged = new Set();      // tab ids already decided (two listeners can report the same tab)

const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const matches = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));
const isAdHost = (h) => matches(h, BLOCKED) || GAMBLING.test(h);

async function settings() {
  const { disabledSites = [], popupSites = [] } = await chrome.storage.local.get(['disabledSites', 'popupSites']);
  return { disabledSites, popupSites };
}

// Per-tab counters and the list of blocked pop-ups (newest first, max 20).
async function record(tabId, field, url) {
  const key = 'count_' + tabId;
  const d = (await chrome.storage.session.get(key))[key] || { popups: 0, overlays: 0, blocked: [] };
  d[field]++;
  if (url) d.blocked = [{ url, t: Date.now() }, ...(d.blocked || []).filter((b) => b.url !== url)].slice(0, 20);
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
    record(tabId, 'overlays');
  }
});

// Decision: 'ad' = close, 'allow', 'wait' = no URL yet, 'check-focus' = allowed
// only if the new tab really comes to the front (popunders push themselves behind).
async function judge(sourceTab, targetUrl, win) {
  const sourceHost = host(sourceTab.url || '');
  const targetHost = host(targetUrl);
  const { disabledSites, popupSites } = await settings();
  if (!sourceHost || matches(sourceHost, disabledSites) || matches(sourceHost, popupSites)) return 'allow';
  if (!targetHost) return 'wait'; // still about:blank
  if (isAdHost(targetHost)) return 'ad';
  if (matches(targetHost, TRUSTED)) return 'allow';
  if (sameSite(sourceHost, targetHost)) return 'allow';

  const click = lastClick.get(sourceTab.id);
  const fresh = click && Date.now() - click.t < CLICK_WINDOW;
  const linkHost = fresh && click.intent === 'link' ? host(click.href) : '';
  const clickedLinkHere = linkHost && !click.trap && (linkHost === targetHost || sameSite(linkHost, targetHost));

  if (matches(targetHost, LINK_ONLY)) return clickedLinkHere ? 'allow' : 'ad';

  // The user right-clicked this link and chose "Open link in new tab".
  const ctx = lastContext.get(sourceTab.id);
  if (ctx && Date.now() - ctx.t < CONTEXT_WINDOW && host(ctx.href) === targetHost) return 'allow';

  // Tiny windows such as 5x5 exist only to host ads.
  if (win && win.type === 'popup' && (win.width < 120 || win.height < 120)) return 'ad';

  if (!fresh) return 'ad';          // cross-site tab opened without a click
  if (click.trap) return 'ad';      // click landed on an invisible overlay
  if (click.intent === 'link') return clickedLinkHere ? 'allow' : 'ad'; // link to A, tab opens B: pop-under
  if (click.intent === 'button') {
    // A button inside an embedded third-party frame (e.g. a video player)
    // opening an unknown site is treated as an ad.
    const frameHost = host(click.frameUrl);
    if (frameHost && !sameSite(frameHost, sourceHost)) return 'ad';
    // A real button on the page: allow, unless the new tab hides behind.
    return 'check-focus';
  }
  return 'ad'; // click on empty space opening a different site
}

async function closeAd(newTabId, sourceTabId, url) {
  try { await chrome.tabs.remove(newTabId); } catch (e) {}
  try { await chrome.tabs.update(sourceTabId, { active: true }); } catch (e) {}
  record(sourceTabId, 'popups', url);
}

async function evaluate(newTabId, sourceTabId, url) {
  if (judged.has(newTabId)) return;
  let source, win = null;
  try {
    source = await chrome.tabs.get(sourceTabId);
    const t = await chrome.tabs.get(newTabId);
    win = await chrome.windows.get(t.windowId);
  } catch (e) { return; }
  const verdict = await judge(source, url, win);
  if (verdict === 'wait') { pending.set(newTabId, { source: sourceTabId, t: Date.now() }); return; }
  judged.add(newTabId);
  pending.delete(newTabId);
  if (verdict === 'ad') return closeAd(newTabId, sourceTabId, url);
  if (verdict === 'check-focus') {
    // Popunder signature: the ad tab is opened, then the page pulls focus back
    // to itself so the ad waits behind it. A genuine window stays in front.
    setTimeout(async () => {
      try {
        const [t, w] = await Promise.all([chrome.tabs.get(newTabId), chrome.windows.get(win.id)]);
        const sameWindow = t.windowId === source.windowId;
        const behind = sameWindow ? !t.active : !w.focused;
        if (behind) closeAd(newTabId, sourceTabId, url);
      } catch (e) {}
    }, POPUNDER_CHECK);
  }
  if (sameSite(host(source.url || ''), host(url))) lastSpawn.set(sourceTabId, { t: Date.now(), url });
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
  if (url && !url.startsWith('about:')) evaluate(tab.id, tab.openerTabId, url);
  else pending.set(tab.id, { source: tab.openerTabId, t: Date.now() });
});

// Windows that open as about:blank and redirect to an ad within a few seconds.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url || !pending.has(tabId)) return;
  const p = pending.get(tabId);
  pending.delete(tabId);
  if (Date.now() - p.t > 5000) return;
  evaluate(tabId, p.source, info.url);
});

// Tab-under: the site reopens itself in a new tab and sends the original tab
// to an ad. Also catches a redirect right after a click on an invisible overlay.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const prev = lastPage.get(d.tabId);
  const newHost = host(d.url);
  const qualifiers = d.transitionQualifiers || [];
  const userInitiated = ['typed', 'auto_bookmark', 'reload', 'generated', 'keyword'].includes(d.transitionType) ||
    qualifiers.includes('from_address_bar') || qualifiers.includes('forward_back');
  if (prev && !userInitiated && /^https?:/.test(d.url) && !sameSite(host(prev), newHost)) {
    const { disabledSites } = await settings();
    if (!matches(host(prev), disabledSites)) {
      const click = lastClick.get(d.tabId);
      const fresh = click && Date.now() - click.t < CLICK_WINDOW;
      const matchesLink = fresh && click.intent === 'link' && !click.trap && sameSite(host(click.href), newHost);
      const spawn = lastSpawn.get(d.tabId);
      const tabUnder = spawn && Date.now() - spawn.t < CLICK_WINDOW;
      const adHost = isAdHost(newHost) || (matches(newHost, LINK_ONLY) && !matchesLink);
      if (adHost || (fresh && !matchesLink && (click.trap || tabUnder))) {
        record(d.tabId, 'popups', d.url);
        // Going back keeps the page's state (bfcache); fall back to reloading it.
        try { await chrome.tabs.goBack(d.tabId); } catch (e) {
          try { await chrome.tabs.update(d.tabId, { url: prev }); } catch (e2) {}
        }
        return;
      }
    }
  }
  if (/^https?:/.test(d.url)) lastPage.set(d.tabId, d.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const m of [lastClick, lastContext, pending, lastSpawn, lastPage]) m.delete(tabId);
  judged.delete(tabId);
  chrome.storage.session.remove('count_' + tabId);
});

// When the shield is turned off for a site, lift the network rules there too.
async function syncAllowRules() {
  const { disabledSites } = await settings();
  const old = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  const add = disabledSites.length ? [{
    id: 1, priority: 1000, action: { type: 'allowAllRequests' },
    condition: { requestDomains: disabledSites, resourceTypes: ['main_frame', 'sub_frame'] }
  }] : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old, addRules: add });
}
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.disabledSites) syncAllowRules(); });
chrome.runtime.onInstalled.addListener(syncAllowRules);
// Runs every time the worker starts, so the badge survives browser restarts.
chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
