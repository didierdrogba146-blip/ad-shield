# Ad Shield

An open-source ad and pop-up blocker for Brave and other Chromium browsers (Manifest V3).
It works **alongside** your existing ad blocker, not instead of it, and catches what list-based blockers miss:
- ads served from the site's own domain
- invisible click traps
- pop-unders and tab-unders
- links rewritten after the page loads

It **leaves genuine pop-ups alone**, such as sign-in, payment and sharing windows.

## Installation
1. Download or clone this repository.
2. Open `brave://extensions` (or `chrome://extensions` in Chrome).
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the repository folder.

## Three layers
| Layer | File | What it does |
|---|---|---|
| Network | `rules.json` | Blocks ad networks, first-party ad paths, link-shortener redirects and gambling domains that keep reappearing under new numbers |
| Page | `cosmetic.js`, `cosmetic.css` | Hides ad slots, finds and removes invisible full-screen overlays, and sends tampered links to their original address |
| Tab | `background.js` | Judges every new tab and every tab redirect against your last click, then closes or reverts the ones that are ads |

## How the pop-up filter decides
**Allowed:**
- Sign-in, payment and sharing providers (Google, Apple, Microsoft, GitHub, PayPal, Stripe and others)
- Windows opened from the same site
- The destination of the visible link you clicked
- Windows opened by a button on the main page

**Blocked:**
- Cross-site tabs opened without a click
- Tabs opened by a click on an invisible overlay
- Clicking a link to one place opening somewhere else (pop-under)
- Tiny or off-screen windows
- Pages that reopen themselves in a new tab and send the original tab to an ad (tab-under)
- Windows that a "Play" button inside an embedded player opens on another site

If a site breaks, click the extension icon and choose **Turn shield off for this site**.

## Why ad blockers fall short
Techniques found through reverse engineering on real streaming sites:

1. **First-party ads.** Blockers block domains from ready-made lists. Ads served from a folder on the site's own domain never show up in those lists. Brave Shields does not block first-party ads in its default mode.
2. **Obfuscated loaders.** The ad script is hidden inside `eval(atob('...'))`, so content matching fails.
3. **Bot detection.** The script detects headless browsers and `navigator.webdriver` and shows no ads to them. The automated browsers that filter-list maintainers use never see the ads.
4. **Delayed start.** On a first visit, ads wait several minutes before appearing, so a quick test shows nothing.
5. **Fooling the browser's pop-up blocker.** Browsers only block windows opened without a click. The site lays a nearly invisible `div` over the whole page on the top layer, which turns every click into a "real" one.
6. **Redirect chains.** Ad destinations pass through link shorteners, so the real domain stays hidden until the last moment.
7. **Rotating domains.** Gambling sites that get blocked come back with a new number appended to their name, faster than lists can follow.
8. **Manifest V3 limits.** Extensions can no longer intercept requests themselves; they hand the browser a fixed set of rules with a size cap. Lists only refresh when the extension ships an update.

Academic work (USENIX Security 2019, "click interception") groups click hijacking into three techniques:
- invisible overlays
- oversized links covering the page
- link addresses rewritten after load

Ad Shield detects all three by behaviour rather than by list, so it keeps working when a site changes its domains.

## Test results
Tested together with default Brave Shields on real streaming sites, clicking 4 points on each page:

| | Shields only | Shields + Ad Shield |
|---|---|---|
| Site A (movie page) | 7 banners, 1 invisible overlay, 4 ad tabs | 0 / 0 / 0 |
| Site B (movie page) | 11 banners, 4 ad tabs | 0 / 0 |
| 4 other sites | no ads seen | same-site links opened normally |

Local scenario tests (10 scenarios, 9 passed):
- **Opened:** sign-in pop-up, normal link, same-site window
- **Blocked:** invisible overlay, tiny window, pop-under, tampered link, tab-under
- **The failing scenario (pop-under + link):** the ad was blocked, but the clicked link did not open either. This comes from the browser's own one-pop-up-per-click rule, not from the extension; the result is the same without it.

## Known limitations
- If a site renames its ad folder, the network rule needs an update. Overlay, pop-up and tab-under protection is behaviour-based and unaffected.
- A sign-in provider not in the trusted list may be closed if it opens from inside an embedded player. Add it to `TRUSTED` in `background.js`.
- The gambling-domain pattern also blocks typing those addresses into the address bar yourself.

## Changelog
**1.2.0**
- Fix: tabs the user opens (Cmd+T, bookmarks, address bar) were closed as ads.
- Fix: general-purpose link shorteners shared in emails and posts are no longer treated as ads.
- Fix: "Open link in new tab" from the right-click menu is allowed.
- Fix: clickable cards built with JavaScript listeners count as real controls.
- Fix: transparent backdrops behind menus and dialogs are no longer mistaken for click traps.
- Removed an overly broad network rule that could block regular site images.
- Verified on 13 popular sites: the extension only blocked ad and tracking requests, never the page or anything it needs.

## License
Public domain ([The Unlicense](LICENSE)). Copy, modify and distribute it freely; no copyright is claimed.
