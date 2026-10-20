(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let h = '';
  try { h = new URL(tab.url).hostname.replace(/^www\./, ''); } catch (e) {}
  document.getElementById('site').textContent = h || '—';

  const key = 'count_' + tab.id;
  const c = (await chrome.storage.session.get(key))[key] || { popups: 0, overlays: 0 };
  document.getElementById('popups').textContent = c.popups;
  document.getElementById('overlays').textContent = c.overlays;
  const badge = await chrome.action.getBadgeText({ tabId: tab.id });
  document.getElementById('requests').textContent = badge || '0';

  const btn = document.getElementById('toggle');
  const render = (list) => {
    const off = list.includes(h);
    btn.textContent = off ? 'Turn shield on for this site' : 'Turn shield off for this site';
    btn.className = off ? 'off' : 'on';
  };
  let { disabledSites = [] } = await chrome.storage.local.get('disabledSites');
  render(disabledSites);
  btn.disabled = !h;
  btn.onclick = async () => {
    disabledSites = disabledSites.includes(h) ? disabledSites.filter((x) => x !== h) : [...disabledSites, h];
    await chrome.storage.local.set({ disabledSites });
    render(disabledSites);
    chrome.tabs.reload(tab.id);
  };
})();
