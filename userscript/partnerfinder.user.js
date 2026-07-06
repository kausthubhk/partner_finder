// ==UserScript==
// @name         PartnerFinder — local match filter
// @namespace    partnerfinder
// @version      0.1
// @description  Scores the profile currently in YOUR dating-app feed against filters.yaml via a local server, and shows a verdict HUD. Your feed only, processed locally.
// @match        https://tinder.com/*
// @match        https://*.bumble.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  const ENDPOINT = 'http://localhost:8787/evaluate';

  // Selectors to find the visible profile card. Tinder/Bumble class names are obfuscated and
  // change, so we fall back to <main>. To make it precise: open DevTools, inspect the card
  // that holds the bio, copy a stable selector, and put it FIRST in this list.
  const CARD_SELECTORS = ['main'];

  let lastHash = '';

  // --- floating HUD ---------------------------------------------------------
  const hud = document.createElement('div');
  hud.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
    'max-width:300px', 'background:rgba(17,17,17,0.92)', 'color:#fff',
    'font:13px/1.45 system-ui,sans-serif', 'padding:10px 12px',
    'border-radius:10px', 'border-left:6px solid #888',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)', 'white-space:pre-wrap', 'pointer-events:none',
  ].join(';');
  hud.textContent = 'PartnerFinder: waiting for a profile…';
  function mountHud() { if (document.body && !hud.isConnected) document.body.appendChild(hud); }
  mountHud();

  // --- helpers --------------------------------------------------------------
  function cardText() {
    for (const sel of CARD_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 40) return el.innerText.trim();
    }
    return '';
  }

  function quickHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(h);
  }

  function render(v) {
    const color = v.verdict === 'HIDE' ? '#e5534b' : (v.score > 0 ? '#3fb950' : '#d29922');
    hud.style.borderLeftColor = color;
    const head = `PartnerFinder  [${v.verdict}]  score ${v.score}`;
    hud.textContent = head + '\n' + (v.reasons || []).join('\n');
  }

  function evaluate(text) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        source_app: location.host.includes('bumble') ? 'bumble' : 'tinder',
        raw_text: text,
      }),
      onload: (r) => { try { render(JSON.parse(r.responseText)); } catch (e) { hud.textContent = 'PartnerFinder: bad response from server'; } },
      onerror: () => { hud.textContent = 'PartnerFinder: local server offline.\nStart it: uvicorn app:app --port 8787'; },
    });
  }

  // --- watch the feed -------------------------------------------------------
  let timer = null;
  const obs = new MutationObserver(() => {
    mountHud();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const txt = cardText();
      if (!txt) return;
      const h = quickHash(txt.slice(0, 600));      // dedupe: only re-evaluate on a new card
      if (h === lastHash) return;
      lastHash = h;
      hud.textContent = 'PartnerFinder: scoring…';
      evaluate(txt);
    }, 600);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
