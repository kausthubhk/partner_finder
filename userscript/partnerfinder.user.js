// ==UserScript==
// @name         PartnerFinder — local match filter
// @namespace    partnerfinder
// @version      0.2
// @description  Scores the profile currently in YOUR dating-app feed against filters.yaml via a local server, and shows a verdict HUD. Your feed only, processed locally.
// @match        https://tinder.com/*
// @match        https://*.bumble.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ---------------------------------------------------------------- config
  const CFG = {
    endpoint: 'http://localhost:8787/evaluate',
    // What to do with a HIDE verdict: 'dim' (default, safe), 'hide' (display:none), 'off'.
    // 'hide' can confuse a swipe UI that expects the card to be there — start with 'dim'.
    applyVerdict: 'dim',
    debounceMs: 600,
    minCardChars: 40,
    debug: false,
  };
  const log = (...a) => CFG.debug && console.log('[PF]', ...a);

  // ------------------------------------------------------- fixed vocabularies
  // SPEC 6.1: badges come from a FIXED vocabulary the person picked from a list, so they're
  // high confidence and need no LLM. Class names are obfuscated and rotate; the vocabulary
  // does not. So we detect badges by matching text, not by selector — that's what makes this
  // survive the apps' next redeploy.
  //
  // Server-side badges_to_attrs() does the actual mapping to diet/drinks/smokes; we just need
  // to recognise a string as "a badge" and ship it. Keep entries lowercase.
  const BADGE_VOCAB = [
    // diet
    'vegetarian', 'vegan', 'pescatarian', 'eggetarian', 'non-vegetarian', 'kosher', 'halal',
    'carnivore', 'omnivore', 'other diet',
    // drinking
    'non-drinker', "doesn't drink", 'does not drink', 'sober', 'teetotaler', 'teetotaller',
    'drinks socially', 'social drinker', 'on special occasions', 'frequently drinks',
    'drinks', 'never drinks',
    // smoking
    'non-smoker', "doesn't smoke", 'does not smoke', 'smoker', 'smokes socially',
    'social smoker', 'never smokes', 'trying to quit', 'smokes regularly',
    // cannabis (surfaced so red_flags/manual review can see it)
    'never smokes weed', 'smokes weed', 'cannabis',
    // exercise / lifestyle chips that often sit in the same row
    'exercise', 'workout', 'gym',
    // religion / politics / family (Bumble surfaces these as chips)
    'hindu', 'muslim', 'christian', 'sikh', 'jain', 'buddhist', 'jewish', 'atheist',
    'agnostic', 'spiritual', 'catholic',
    'wants kids', "doesn't want kids", 'does not want kids', 'open to kids', 'have kids',
    'want someday', 'not sure yet',
    // education
    'bachelors', 'masters', 'phd', 'in college', 'high school', 'trade school',
    // zodiac (noise, but harmless and keeps the row intact)
    'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio',
    'sagittarius', 'capricorn', 'aquarius', 'pisces',
  ];

  // UI chrome that leaks into innerText and pollutes the bio we send to the model.
  const CHROME_LINES = new Set([
    'see more', 'show more', 'see less', 'read more', 'report', 'share', 'block',
    'unmatch', 'settings', 'messages', 'matches', 'likes', 'back', 'close', 'menu',
    'home', 'explore', 'profile', 'my profile', 'add to favorites', 'send a compliment',
    'recently active', 'active recently', 'new here', 'verified', 'liked you',
    'gold', 'platinum', 'boost', 'super like', 'rewind', 'nope', 'like', 'pass',
    'open profile', 'view profile', 'tap to see more',
  ]);

  // ---------------------------------------------------------------- adapters
  // SPEC 99: "per-app via a thin adapter (CSS selectors + field map) so adding an app =
  // adding an adapter." Selectors are ordered best-first and ALL are allowed to miss —
  // `generic` is the always-works floor.
  const ADAPTERS = {
    tinder: {
      name: 'tinder',
      test: (h) => h.includes('tinder.com'),
      // Tinder stacks rec cards; these are the least-obfuscated hooks it exposes.
      cardSelectors: [
        '[data-testid="card"]',
        '.recsCardboard__cardsContainer > div:last-child',
        'main [role="group"]',
        'main',
      ],
      headingSelectors: ['h1', '[itemprop="name"]', '[role="heading"]', 'h2'],
    },
    bumble: {
      name: 'bumble',
      test: (h) => h.includes('bumble.com'),
      cardSelectors: [
        '.encounters-story',
        '[data-qa-role="encounters-card"]',
        '.profile__card',
        'main',
      ],
      headingSelectors: [
        '.encounters-story-profile__name',
        '[data-qa-role="profile-name"]',
        'h1',
        '[role="heading"]',
      ],
    },
    generic: {
      name: 'unknown',
      test: () => true,
      cardSelectors: ['main', 'body'],
      headingSelectors: ['h1', 'h2', '[role="heading"]'],
    },
  };

  function currentAdapter() {
    const host = location.host;
    for (const key of ['tinder', 'bumble']) {
      if (ADAPTERS[key].test(host)) return ADAPTERS[key];
    }
    return ADAPTERS.generic;
  }

  // ------------------------------------------------------------ DOM helpers
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return false;
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  /** Pick the profile card currently in front of the user. */
  function pickCard(adapter) {
    for (const sel of adapter.cardSelectors) {
      let nodes;
      try {
        nodes = Array.from(document.querySelectorAll(sel));
      } catch (e) {
        continue; // a selector that this browser/app version rejects — just skip it
      }
      // Several cards are usually mounted at once (the swipe stack). Take the last
      // visible one — that's the top of the stack, i.e. the one being looked at.
      const visible = nodes.filter(isVisible);
      const el = visible[visible.length - 1];
      if (el && (el.innerText || '').trim().length >= CFG.minCardChars) {
        log('card via', sel);
        return el;
      }
    }
    return null;
  }

  /** Short text leaves inside the card — the candidate pool for badges/height. */
  function textLeaves(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el = walker.currentNode;
    while (el) {
      // A "leaf" for our purposes: no element child that itself has text.
      const hasTextChild = Array.from(el.children).some(
        (c) => (c.innerText || '').trim().length > 0
      );
      if (!hasTextChild) {
        const t = (el.innerText || '').trim();
        if (t && t.length <= 60) out.push(t);
      }
      el = walker.nextNode();
    }
    return out;
  }

  // ---------------------------------------------------------- field extractors
  /** Structured badges — matched against the fixed vocabulary, not against class names. */
  function extractBadges(card) {
    const found = new Set();
    for (const raw of textLeaves(card)) {
      const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
      if (t.length > 40) continue;
      for (const v of BADGE_VOCAB) {
        // Whole-token match so "smoker" can't fire inside "non-smoker".
        if (t === v || t.startsWith(v + ' ') || t.endsWith(' ' + v) || t.includes(' ' + v + ' ')) {
          found.add(raw.trim());
          break;
        }
      }
    }
    return Array.from(found);
  }

  /**
   * Age from the card heading. Tinder renders "Priya 22" (no comma), which is exactly what
   * the server's `, 22` regex misses — so we parse it here where we know it's the heading
   * and can't collide with a random number elsewhere on the page.
   */
  function extractAge(card, adapter) {
    for (const sel of adapter.headingSelectors) {
      let el;
      try {
        el = card.querySelector(sel);
      } catch (e) {
        continue;
      }
      if (!el) continue;
      const t = (el.innerText || '').trim();
      // "Priya 22", "Priya, 22", "Priya 22 years"
      const m = t.match(/(?:^|[\s,])(\d{2})(?:\s|$|,)/);
      if (m) {
        const age = parseInt(m[1], 10);
        if (age >= 18 && age <= 99) {
          log('age', age, 'from', sel);
          return age;
        }
      }
    }
    return null;
  }

  /** Height from a chip: "5'4"", "5 ft 4", "163 cm". */
  function extractHeightCm(card) {
    for (const t of textLeaves(card)) {
      let m = t.match(/\b(\d{3})\s*cm\b/i);
      if (m) {
        const cm = parseInt(m[1], 10);
        if (cm >= 120 && cm <= 220) return cm;
      }
      m = t.match(/\b([4-6])\s*(?:['’]|ft|feet|foot)\s*(\d{1,2})/i);
      if (m) {
        const cm = Math.round(parseInt(m[1], 10) * 30.48 + parseInt(m[2], 10) * 2.54);
        if (cm >= 120 && cm <= 220) return cm;
      }
    }
    return null;
  }

  /**
   * Free text only — the bio and prompt answers. Strips UI chrome and any line we already
   * sent as a structured badge, so the model spends tokens on prose instead of chip labels.
   */
  function extractBio(card, badges) {
    const badgeSet = new Set(badges.map((b) => b.toLowerCase().trim()));
    const seen = new Set();
    const keep = [];
    for (const rawLine of (card.innerText || '').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const low = line.toLowerCase();
      if (CHROME_LINES.has(low)) continue;
      if (badgeSet.has(low)) continue;
      if (/^\d+$/.test(line)) continue; // bare counters ("5", "12 km")
      if (seen.has(low)) continue;
      seen.add(low);
      keep.push(line);
    }
    return keep.join('\n');
  }

  function collect() {
    const adapter = currentAdapter();
    const card = pickCard(adapter);
    if (!card) return null;
    const badges = extractBadges(card);
    return {
      source_app: adapter.name,
      badges,
      age: extractAge(card, adapter),
      height_cm: extractHeightCm(card),
      raw_text: extractBio(card, badges),
      _card: card,
    };
  }

  // ------------------------------------------------------------------- HUD
  const hud = document.createElement('div');
  hud.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
    'max-width:300px', 'background:rgba(17,17,17,0.92)', 'color:#fff',
    'font:13px/1.45 system-ui,sans-serif', 'padding:10px 12px',
    'border-radius:10px', 'border-left:6px solid #888',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)', 'white-space:pre-wrap', 'pointer-events:none',
  ].join(';');
  hud.textContent = 'PartnerFinder: waiting for a profile…';
  function mountHud() {
    if (document.body && !hud.isConnected) document.body.appendChild(hud);
  }
  mountHud();

  let lastStyledCard = null;
  function clearCardStyle() {
    if (lastStyledCard) {
      lastStyledCard.style.filter = '';
      lastStyledCard.style.opacity = '';
      lastStyledCard.style.display = '';
      lastStyledCard = null;
    }
  }

  /** SPEC 4[4]: apply the verdict in-page, not just in the HUD. */
  function applyVerdict(card, v) {
    clearCardStyle();
    if (CFG.applyVerdict === 'off' || !card || v.verdict !== 'HIDE') return;
    if (CFG.applyVerdict === 'hide') card.style.display = 'none';
    else {
      card.style.filter = 'grayscale(1) blur(2px)';
      card.style.opacity = '0.45';
    }
    lastStyledCard = card;
  }

  function render(v, captured) {
    const color = v.verdict === 'HIDE' ? '#e5534b' : v.score > 0 ? '#3fb950' : '#d29922';
    hud.style.borderLeftColor = color;
    const src = [
      captured.age != null ? `age ${captured.age}` : null,
      captured.height_cm != null ? `${captured.height_cm}cm` : null,
      captured.badges.length ? `${captured.badges.length} badges` : null,
    ].filter(Boolean).join(' · ');
    hud.textContent =
      `PartnerFinder  [${v.verdict}]  score ${v.score}\n` +
      (v.reasons || []).join('\n') +
      (src ? `\n— scraped: ${src}` : '');
  }

  // ---------------------------------------------------------------- transport
  function evaluate(captured) {
    const { _card, ...payload } = captured;
    GM_xmlhttpRequest({
      method: 'POST',
      url: CFG.endpoint,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload),
      onload: (r) => {
        try {
          const v = JSON.parse(r.responseText);
          render(v, captured);
          applyVerdict(_card, v);
        } catch (e) {
          hud.textContent = 'PartnerFinder: bad response from server';
        }
      },
      onerror: () => {
        hud.textContent =
          'PartnerFinder: local server offline.\nStart it: uvicorn app:app --port 8787';
      },
    });
  }

  // -------------------------------------------------------------- watch feed
  let lastHash = '';
  function quickHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(h);
  }

  let timer = null;
  const obs = new MutationObserver(() => {
    mountHud();
    clearTimeout(timer);
    timer = setTimeout(() => {
      let captured;
      try {
        captured = collect();
      } catch (e) {
        log('collect failed', e);
        return;
      }
      if (!captured || !captured.raw_text) return;
      // Dedupe on the identifying fields, so a re-render of the same card doesn't re-bill
      // the API but a genuinely new card always does.
      const h = quickHash(
        [captured.raw_text.slice(0, 600), captured.age, captured.height_cm,
         captured.badges.join('|')].join('~')
      );
      if (h === lastHash) return;
      lastHash = h;
      clearCardStyle();
      hud.textContent = 'PartnerFinder: scoring…';
      evaluate(captured);
    }, CFG.debounceMs);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Expose a hook so you can check what the collector sees without opening the network tab:
  //   copy(JSON.stringify(window.__pf_debug(), null, 2))
  window.__pf_debug = () => {
    const c = collect();
    if (c) delete c._card;
    return c;
  };
})();
