(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let h = '';
  try { h = new URL(tab.url).hostname.replace(/^www\./, ''); } catch (e) {}
  document.getElementById('site').textContent = h || '—';

  const key = 'count_' + tab.id;
  const c = (await chrome.storage.session.get(key))[key] || { popups: 0, overlays: 0, blocked: [] };
  document.getElementById('popups').textContent = c.popups;
  document.getElementById('overlays').textContent = c.overlays;
  const badge = await chrome.action.getBadgeText({ tabId: tab.id });
  document.getElementById('requests').textContent = badge || '0';

  // Blocked pop-ups, each with a way to open it anyway.
  const list = document.getElementById('blocked');
  if (!c.blocked || !c.blocked.length) {
    list.innerHTML = '<li class="empty">Nothing blocked yet.</li>';
  } else {
    for (const b of c.blocked) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = b.url;
      span.title = b.url;
      const open = document.createElement('button');
      open.textContent = 'Open';
      open.onclick = () => chrome.tabs.create({ url: b.url, index: tab.index + 1 });
      li.append(span, open);
      list.append(li);
    }
  }

  // Two per-site switches: allow pop-ups only, or turn the whole shield off.
  const toggleList = async (storeKey, btn, onText, offText) => {
    const render = (arr) => {
      const listed = arr.includes(h);
      btn.textContent = listed ? onText : offText;
      btn.className = listed ? 'off' : 'on';
    };
    let arr = (await chrome.storage.local.get(storeKey))[storeKey] || [];
    render(arr);
    btn.disabled = !h;
    btn.onclick = async () => {
      arr = arr.includes(h) ? arr.filter((x) => x !== h) : [...arr, h];
      await chrome.storage.local.set({ [storeKey]: arr });
      render(arr);
      chrome.tabs.reload(tab.id);
    };
  };
  toggleList('popupSites', document.getElementById('popupToggle'),
    'Block pop-ups on this site again', 'Allow pop-ups on this site');
  toggleList('disabledSites', document.getElementById('toggle'),
    'Turn shield on for this site', 'Turn shield off for this site');
})();
