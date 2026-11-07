/* ---------------------------------------------------------------------------
   High Signal dashboard.

   Four layouts over one corpus, each shaped by what the reader came to do:

     today       the front page: the top three as a hero, then bands by rank
                 (top picks, worth a look, the rest), each step down the page
                 visibly lighter than the one above it
     latest      the same corpus newest first, grouped by day
     topics      a sticky index of topics beside one continuous page of topic
                 sections, four headlines each until a section is expanded
     sources     a board of publisher cards, three headlines each, no column
                 scrolls inside another column

   None of the four scrolls inside itself. The page scroll is the only scroll,
   which is what lets a headline be as long as it needs to be.

   The whole corpus is a few hundred headlines, so it is fetched once from
   /api/dashboard and every filter (score threshold, text query, source,
   category) plus every grouping and ordering runs client-side. That keeps
   switching views and filtering instant.

   A few things live only in the browser, because they are per-person and the
   server has no accounts: read state, hidden headlines, pinned topics and the
   time of the last visit (which is what marks a headline NEW). They are id
   sets or single values in localStorage, capped so they cannot grow without
   bound.

   Scores are rule-based and arrive with their own arithmetic attached
   (`score_reasons`), which is what the expanded row renders. Nothing about the
   number is hidden from the reader.
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  var POLL_MS = 300000;
  var JOB_POLL_MS = 1500;
  var VIEWS = ['today', 'latest', 'topics', 'sources'];
  // Names the views had before the A5 front page. Old bookmarks and stored
  // preferences still land somewhere sensible; Saved no longer exists.
  var VIEW_ALIASES = { feed: 'today', categories: 'topics', saved: 'today' };
  var SCORE_FLOORS = [0, 80, 90];
  var UNCATEGORIZED = 'Other';
  var READ_CAP = 4000;
  var HIDDEN_CAP = 1000;

  // How much of each layout opens unasked. Four headlines is the most a topic
  // section can show without the next topic falling off the screen; three is
  // the same judgement in a four-column board.
  var TOPIC_PREVIEW = 4;
  var SOURCE_PREVIEW = 3;
  var FEED_PAGE = 30;

  // The front page bands by rank, not by score: real scores bunch together
  // (90, 90, 90, 86, then seventeen between 80 and 84), so fixed thresholds
  // would leave a top band of one. Positions are 1-based and inclusive.
  var HERO_SIZE = 3;
  var BANDS = [
    { key: 'top',   label: 'Top picks',    from: 4,  to: 8 },
    { key: 'worth', label: 'Worth a look', from: 9,  to: 20 },
    { key: 'rest',  label: 'The rest',     from: 21, to: Infinity }
  ];
  var REST_COLUMNS = 3;

  // Publisher text that is a bot wall or newsletter boilerplate rather than a
  // summary of the story.
  var JUNK_SUMMARY = /not a robot|click the box|^welcome to|subscribe now|^curated weekly/i;
  // The scraper's own placeholder (scraper.py LEGACY_SUMMARY_PREFIX).
  var GENERATED_SUMMARY_PREFIX = 'Headline picked up from ';

  // Titles never reach the page: they name the view for the document outline
  // and for anything reading the page aloud.
  var VIEW_TITLES = {
    today: 'Today',
    latest: 'Latest',
    topics: 'Topics',
    sources: 'Sources'
  };

  var KNOWN_CATEGORIES = [
    'Security', 'Policy & Regulation', 'Funding & M&A', 'Chips & Hardware',
    'Crypto & Fintech', 'Science & Space', 'AI Research', 'Models & Releases',
    'AI Tools & Agents', 'Engineering & Open Source', 'Big Tech',
    'Business & Markets', 'Other'
  ];

  var CATEGORY_ORDER = [
    'Chips & Hardware', 'Funding & M&A', 'Big Tech', 'Models & Releases',
    'Policy & Regulation', 'Crypto & Fintech', 'Security', 'AI Research',
    'Enterprise AI', 'Data & Infrastructure', 'AI Tools & Agents',
    'Engineering & Open Source', 'Science & Space', 'Business & Markets', 'Other'
  ];

  var state = {
    articles: [],
    pending: null,          // fetched but withheld so the list never jumps
    pendingCount: 0,
    stats: null,
    health: null,
    thresholds: { high: 75, mid: 60 },
    view: 'today',
    minScore: 0,
    query: '',
    source: '',
    category: '',
    status: 'loading',      // loading | ready | error
    pollFailures: 0,
    lastSync: null,
    selectedId: null,
    expandedId: null,
    // Which topic sections and source cards the reader has opened past their
    // preview. Names, not indexes, so a rescrape cannot expand the wrong one.
    openTopics: {},
    openSources: {},
    limit: FEED_PAGE,
    job: null,
    jobTimer: null,
    adminToken: '',        // deliberately memory-only
    adminSources: {},
    sourceToolJob: null,
    sourceToolTimer: null,
    offlineSnapshot: false
  };

  var el = {};
  [
    'grid', 'reading', 'search', 'scoreSwitch', 'viewSwitch', 'dateline',
    'themeBtn', 'resultCount', 'toasts',
    'status', 'statusChip', 'statusChipText', 'statusPanel',
    'statusPanelList', 'statusPanelAction', 'helpBtn',
    'progress', 'progressBar', 'progressLabel',
    'filters', 'newPill', 'moreBtn',
    'moreMenu', 'markReadBtn', 'sourcesDialog', 'helpDialog', 'sourceList',
    'sourcesSummary', 'addSource', 'addSourceForm', 'discoverSourceBtn',
    'testSourceBtn', 'testPreview', 'sourceDiscovery', 'sourceType',
    'sourceFeedUrl', 'sourceSelector', 'sourceFallback', 'categorySelect',
    'refreshFromDialog', 'viewTitle', 'catIndex',
    'catIndexNav', 'jumpBar', 'jump', 'adminToken', 'adminStatus', 'stateFile'
  ].forEach(function (id) { el[id] = document.getElementById(id); });
  el.themeIcon = document.querySelector('[data-theme-icon]');

  /* == Escaping =============================================================
     Titles and links come from third-party pages, so never trust them as
     markup. */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    try {
      var parsed = new URL(value, window.location.origin);
      return ['http:', 'https:'].indexOf(parsed.protocol) !== -1 ? parsed.href : '#';
    } catch (error) {
      return '#';
    }
  }

  // Escapes `text` while wrapping every case-insensitive hit of `query` in a
  // <mark>. Slicing happens on the raw string so escaping can never split an
  // entity in half.
  function highlight(text, query) {
    var raw = String(text == null ? '' : text);
    if (!query) return escapeHtml(raw);

    var haystack = raw.toLowerCase();
    var needle = query.toLowerCase();
    var out = '';
    var cursor = 0;
    var hit = haystack.indexOf(needle);

    while (hit !== -1) {
      out += escapeHtml(raw.slice(cursor, hit));
      out += '<mark>' + escapeHtml(raw.slice(hit, hit + needle.length)) + '</mark>';
      cursor = hit + needle.length;
      hit = haystack.indexOf(needle, cursor);
    }

    return out + escapeHtml(raw.slice(cursor));
  }

  /* == Preferences and local state ========================================= */

  function readPref(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* private mode */ }
  }

  function readJson(key, fallback) {
    try {
      var value = JSON.parse(localStorage.getItem(key));
      return value == null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* full */ }
  }

  // Read and hidden are per-person and the server has no accounts, so they
  // live here. Ids are kept newest-first and truncated, which bounds the
  // storage without a migration.
  var store = {
    read: readJson('hs.read', []),
    hidden: readJson('hs.hidden', []),
    pinned: readJson('hs.pinned', [])
  };

  var readIndex = {};
  store.read.forEach(function (id) { readIndex[id] = true; });
  var hiddenIndex = {};
  store.hidden.forEach(function (id) { hiddenIndex[id] = true; });
  var pinnedIndex = {};
  store.pinned.forEach(function (name) { pinnedIndex[name] = true; });


  function isRead(id) { return readIndex[id] === true; }
  function isHidden(id) { return hiddenIndex[id] === true; }
  function isPinned(name) { return pinnedIndex[name] === true; }

  // Pinning only moves a category to the front of the grid. Categories are a
  // closed taxonomy of a dozen or so names, so this set needs no cap.
  function togglePinned(name) {
    if (isPinned(name)) {
      delete pinnedIndex[name];
      store.pinned = store.pinned.filter(function (existing) { return existing !== name; });
    } else {
      pinnedIndex[name] = true;
      store.pinned.push(name);
    }
    writeJson('hs.pinned', store.pinned);
    return isPinned(name);
  }

  function markRead(id, read) {
    if (read === isRead(id)) return false;
    if (read) {
      readIndex[id] = true;
      store.read.unshift(id);
      if (store.read.length > READ_CAP) {
        store.read.slice(READ_CAP).forEach(function (old) { delete readIndex[old]; });
        store.read = store.read.slice(0, READ_CAP);
      }
    } else {
      delete readIndex[id];
      store.read = store.read.filter(function (existing) { return existing !== id; });
    }
    writeJson('hs.read', store.read);
    return true;
  }

  /* -- What is new since the last visit ----------------------------------
     A headline is NEW when High Signal first saw it after the reader's
     previous visit. The visit is stamped when the page is hidden or closed,
     and the baseline it is compared against is pinned for the life of the
     tab, so reloading mid-read does not wipe the tags the reader came back
     for. A first visit has no baseline, so nothing is NEW. */

  var previousVisit = (function () {
    var pinned = null;
    try { pinned = sessionStorage.getItem('hs.visitBaseline'); } catch (error) { /* blocked */ }
    if (pinned === null) {
      pinned = readPref('hs.lastVisit', '');
      try { sessionStorage.setItem('hs.visitBaseline', pinned); } catch (error) { /* blocked */ }
    }
    return parseDate(pinned);
  })();

  function stampVisit() {
    writePref('hs.lastVisit', new Date().toISOString());
  }

  function isNew(article) {
    if (!previousVisit || isRead(article.id)) return false;
    var seen = parseDate(article.first_seen) || parseDate(article.timestamp);
    return Boolean(seen && seen > previousVisit);
  }

  function toggleHidden(id) {
    if (isHidden(id)) {
      delete hiddenIndex[id];
      store.hidden = store.hidden.filter(function (existing) { return existing !== id; });
    } else {
      hiddenIndex[id] = true;
      store.hidden.unshift(id);
      store.hidden = store.hidden.slice(0, HIDDEN_CAP);
    }
    writeJson('hs.hidden', store.hidden);
  }

  /* -- Moving reading state between addresses -----------------------------
     localStorage is scoped to one origin, so a reader who follows the site to
     a new hostname arrives with nothing. This exports the lists as a file and
     merges one back in. Merging, not replacing: importing an old file should
     never throw away what has been read since. Files from before Saved was
     retired still load; their `saved` list is ignored. */

  var STATE_FILE_KIND = 'high-signal-reading-state';

  function readingStateDocument() {
    return {
      kind: STATE_FILE_KIND,
      version: 1,
      exported_at: new Date().toISOString(),
      origin: location.origin,
      read: store.read,
      hidden: store.hidden,
      pinned: store.pinned
    };
  }

  function idList(value, cap) {
    if (!Array.isArray(value)) return [];
    var out = [];
    var seen = {};
    value.forEach(function (entry) {
      if (typeof entry !== 'string' || !entry || seen[entry]) return;
      seen[entry] = true;
      if (out.length < cap) out.push(entry);
    });
    return out;
  }

  function mergeReadingState(document) {
    if (!document || typeof document !== 'object' || document.kind !== STATE_FILE_KIND) {
      throw new Error('That file is not a High Signal reading state export.');
    }
    var added = { read: 0, hidden: 0, pinned: 0 };

    idList(document.read, READ_CAP).forEach(function (id) {
      if (isRead(id)) return;
      readIndex[id] = true;
      store.read.push(id);
      added.read += 1;
    });
    store.read = store.read.slice(0, READ_CAP);

    idList(document.hidden, HIDDEN_CAP).forEach(function (id) {
      if (isHidden(id)) return;
      hiddenIndex[id] = true;
      store.hidden.push(id);
      added.hidden += 1;
    });
    store.hidden = store.hidden.slice(0, HIDDEN_CAP);

    idList(document.pinned, 100).forEach(function (name) {
      if (isPinned(name)) return;
      pinnedIndex[name] = true;
      store.pinned.push(name);
      added.pinned += 1;
    });

    // Rebuild the indexes the caps may have trimmed, then persist once.
    readIndex = {};
    store.read.forEach(function (id) { readIndex[id] = true; });
    hiddenIndex = {};
    store.hidden.forEach(function (id) { hiddenIndex[id] = true; });

    writeJson('hs.read', store.read);
    writeJson('hs.hidden', store.hidden);
    writeJson('hs.pinned', store.pinned);
    return added;
  }

  /* == Formatting ========================================================== */

  function scoreTone(score) {
    if (score >= state.thresholds.high) return 'jade';
    if (score >= state.thresholds.mid) return 'amber';
    return 'red';
  }

  function plural(count, noun, pluralNoun) {
    if (count === 1) return count + ' ' + noun;
    return count + ' ' + (pluralNoun || noun + 's');
  }

  function parseDate(value) {
    if (!value) return null;
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function shortAge(ms) {
    var minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return minutes + 'm';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h';
    var days = Math.round(hours / 24);
    if (days < 8) return days + 'd';
    var weeks = Math.round(days / 7);
    if (weeks < 6) return weeks + 'w';
    return Math.round(days / 30) + 'mo';
  }

  function relativePast(date) {
    if (!date) return 'never synced';
    var minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'updated just now';
    if (minutes < 60) return 'updated ' + plural(minutes, 'min') + ' ago';
    return 'updated ' + plural(Math.round(minutes / 60), 'hr') + ' ago';
  }

  var DAY_FORMAT = { day: 'numeric', month: 'short' };

  function formatDay(date) {
    try {
      return date.toLocaleDateString(undefined, DAY_FORMAT);
    } catch (error) {
      return date.toDateString().slice(4, 10);
    }
  }

  // Most scraped pages publish no date, so recency has two meanings and the UI
  // must not blur them: a real publish time reads "2h", a first-sighting reads
  // "2h" in a muted style with the distinction spelled out on hover.
  function ageOf(article) {
    var published = parseDate(article.published);
    if (published) {
      var precise = article.published_precision === 'exact';
      return {
        date: published,
        text: precise ? shortAge(Date.now() - published.getTime()) : formatDay(published),
        title: 'Published ' + published.toLocaleString(),
        estimated: false
      };
    }

    var seen = parseDate(article.first_seen) || parseDate(article.timestamp);
    if (!seen) return { date: null, text: '', title: '', estimated: true };

    return {
      date: seen,
      text: shortAge(Date.now() - seen.getTime()),
      title: 'This source publishes no date. First seen by High Signal '
             + seen.toLocaleString(),
      estimated: true
    };
  }

  // Day precision is only useful while the reader still thinks in days. Older
  // items collapse to months, which turned a 28-header wall into four.
  function dayBucket(date) {
    if (!date) return 'Undated';
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.floor((startOfToday - new Date(
      date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'Earlier this week';

    var options = date.getFullYear() === now.getFullYear()
      ? { month: 'long' }
      : { month: 'long', year: 'numeric' };
    try {
      return date.toLocaleDateString(undefined, options);
    } catch (error) {
      return formatDay(date);
    }
  }

  /* == Corpus ============================================================== */

  function categoryOf(article) {
    return article.category || UNCATEGORIZED;
  }

  function scoreOf(article) {
    return article.signal_score || 0;
  }

  function corpus() {
    return state.articles;
  }

  function isPaged() {
    return state.view === 'today' || state.view === 'latest';
  }

  // The query matches the source name as well as the title, so typing
  // "techmeme" narrows the page to one source without leaving the view.
  // state.articles is kept in signal order; Latest re-sorts its own copy.
  function visibleArticles() {
    var query = state.query.trim().toLowerCase();

    var articles = corpus().filter(function (article) {
      if (isHidden(article.id)) return false;
      if (scoreOf(article) < state.minScore) return false;
      if (state.source && article.source !== state.source) return false;
      if (state.category && categoryOf(article) !== state.category) return false;
      if (!query) return true;
      return String(article.title || '').toLowerCase().indexOf(query) !== -1 ||
             String(article.source || '').toLowerCase().indexOf(query) !== -1;
    });
    return state.view === 'latest' ? sortedDashboardArticles(articles, 'recent') : articles;
  }

  // What is actually on the page right now. Today and Latest page themselves,
  // so "copy visible links" and "mark everything shown as read" have to mean
  // the rows the reader can see, not the whole filtered corpus behind them.
  function renderedArticles() {
    var articles = visibleArticles();
    return isPaged() ? articles.slice(0, state.limit) : articles;
  }

  function corpusTotal() {
    return corpus().filter(function (a) { return !isHidden(a.id); }).length;
  }

  // Expanding a section is a reading decision, not a filter, so it survives a
  // rescrape and is deliberately not written to localStorage or the URL.
  function toggleOpen(set, name, anchorPrefix) {
    var closing = set[name] === true;
    if (closing) delete set[name];
    else set[name] = true;

    var offset = window.scrollY;
    render();
    // Collapsing pulls the page up from under the reader, so put them back at
    // the head of the section they just closed. Expanding adds below the fold
    // and needs nothing but the scroll position they already had.
    if (closing) scrollToAnchor(anchorPrefix + slug(name), true);
    else window.scrollTo(0, offset);
  }

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function scrollToAnchor(id, instant) {
    var smooth = !instant && !reducedMotion.matches;
    var options = { behavior: smooth ? 'smooth' : 'auto', block: 'start' };
    if (id === 'top') {
      window.scrollTo({ top: 0, behavior: options.behavior });
      return;
    }
    var target = document.getElementById(id);
    if (target) target.scrollIntoView(options);
  }

  // Buckets articles by `key`, biggest bucket first, then alphabetically, with
  // the catch-all category pinned last so it never leads the page.
  function groupBy(articles, key) {
    var buckets = {};
    var names = [];

    articles.forEach(function (article) {
      var name = key(article);
      if (!buckets[name]) {
        buckets[name] = [];
        names.push(name);
      }
      buckets[name].push(article);
    });

    names.sort(function (a, b) {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return buckets[b].length - buckets[a].length || a.localeCompare(b);
    });

    return names.map(function (name) {
      var items = buckets[name].slice().sort(function (a, b) {
        return scoreOf(b) - scoreOf(a);
      });
      return { name: name, articles: items };
    });
  }

  function distinct(articles, key) {
    var seen = {};
    var count = 0;
    articles.forEach(function (article) {
      var value = key(article);
      if (!seen[value]) {
        seen[value] = true;
        count++;
      }
    });
    return count;
  }

  function articleById(id) {
    var pool = corpus();
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].id === id) return pool[i];
    }
    return null;
  }

  function activeFilters() {
    var pills = [];
    if (state.query.trim()) pills.push({ kind: 'query', label: '“' + state.query.trim() + '”' });
    if (state.minScore) pills.push({ kind: 'score', label: 'score ' + state.minScore + '+' });
    if (state.source) pills.push({ kind: 'source', label: state.source });
    if (state.category) pills.push({ kind: 'category', label: state.category });
    return pills;
  }

  function isFiltered() {
    return activeFilters().length > 0;
  }

  // The pills speak for the filters that have no control of their own. The
  // signal floor is switched on in plain sight beside the tabs, and the search
  // box shows its own query, so a pill for either is the same state said
  // twice.
  function pillFilters() {
    return activeFilters().filter(function (pill) {
      return pill.kind !== 'score' && pill.kind !== 'query';
    });
  }

  /* == Rendering =========================================================== */

  function icon(name, className) {
    return '<svg class="' + className + '" viewBox="0 0 24 24" aria-hidden="true">' +
           '<use href="#i-' + name + '"/></svg>';
  }

  function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'x';
  }

  // Metadata under a headline is a sentence, not a row of pills: plain words at
  // one size, separated by a middle dot. The two that filter are still buttons,
  // they just do not dress like one.
  function metaLine(parts) {
    return parts.filter(Boolean).join('<span class="row__dot" aria-hidden="true">·</span>');
  }

  function metaFilter(kind, value, className) {
    return '<button type="button" tabindex="-1" class="' + className +
      '" data-act="filter-' + kind + '" data-value="' + escapeHtml(value) +
      '" title="Show only ' + escapeHtml(value) + '">' + escapeHtml(value) + '</button>';
  }

  function metaSource(article) {
    return metaFilter('source', article.source, 'row__source');
  }

  function metaTopic(article) {
    return metaFilter('category', categoryOf(article), 'row__topic');
  }

  function metaAge(article) {
    var age = ageOf(article);
    if (!age.text) return '';
    return '<span class="row__age' + (age.estimated ? ' row__age--est' : '') +
      '" title="' + escapeHtml(age.title) + '">' + escapeHtml(age.text) + '</span>';
  }

  function metaAlso(article) {
    var also = article.also_in || [];
    if (!also.length) return '';
    return '<span class="row__also" title="Also carried by ' +
      escapeHtml(also.join(', ')) + '">+' + also.length + '</span>';
  }

  // Per-row controls are deliberately out of the tab sequence. With a few
  // hundred rows, five tab stops each would put the app's own controls hundreds
  // of presses away; the keyboard reaches these through j/k plus x, m and
  // Space instead, and the search box filters by source name as well.
  function iconButton(action, iconName, label, pressed) {
    return '<button type="button" tabindex="-1" class="row__icon" data-act="' + action + '"' +
      (pressed === undefined ? '' : ' aria-pressed="' + (pressed ? 'true' : 'false') + '"') +
      ' title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' +
      icon(iconName, '') + '</button>';
  }

  function renderScoreBreakdown(article) {
    var reasons = article.score_reasons || [];
    if (!reasons.length) {
      return '<p class="detail__empty">This headline was cached before scores '
           + 'became itemised. It will pick up a breakdown on the next scrape.</p>';
    }

    var rows = reasons.map(function (reason) {
      var delta = reason.delta || 0;
      var sign = delta > 0 ? '+' : '';
      var width = Math.min(100, Math.abs(delta) * 1.4);
      return '<div class="bd__row bd__row--' + (reason.kind || 'bonus') + '">' +
        '<span class="bd__label">' + escapeHtml(reason.label) + '</span>' +
        '<span class="bd__bar"><span style="width:' + width + '%"></span></span>' +
        '<span class="bd__delta">' + sign + delta + '</span>' +
      '</div>';
    }).join('');

    return '<div class="bd">' + rows +
      '<div class="bd__total"><span>Signal score</span><span>' +
      scoreOf(article) + '</span></div></div>';
  }

  function renderDetail(article) {
    var age = ageOf(article);
    var also = (article.also_in || []);
    var summary = article.summary || (
      article.summary_error
        ? 'Summary unavailable. Open the original for the full story.'
        : 'Fetching publisher summary...'
    );
    var facts = [
      age.text ? (age.estimated ? 'First seen ' : 'Published ') +
                 (age.date ? age.date.toLocaleString() : '—') : null,
      'Source: ' + article.source,
      'Category: ' + categoryOf(article),
      article.summary_source ? 'Summary: ' + article.summary_source : null,
      article.is_stale ? 'Source fetch failed; showing the last successful copy from ' +
        (parseDate(article.last_fetched_at)
          ? parseDate(article.last_fetched_at).toLocaleString() : 'an earlier run') : null,
      also.length ? 'Also carried by ' + also.join(', ') : null
    ].filter(Boolean);

    return '<div class="detail">' +
      '<p class="detail__summary">' + escapeHtml(summary) + '</p>' +
      '<ul class="detail__facts">' + facts.map(function (fact) {
        return '<li>' + escapeHtml(fact) + '</li>';
      }).join('') + '</ul>' +
      '<h3 class="detail__heading">Why this score</h3>' +
      renderScoreBreakdown(article) +
      '<div class="detail__actions">' +
        '<a class="btn btn--solid btn--sm" href="' + escapeHtml(safeUrl(article.link)) +
        '" target="_blank" rel="noopener noreferrer" data-act="open">' +
        icon('arrow', '') + 'Open original</a>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="toggle-read">' +
        (isRead(article.id) ? 'Mark unread' : 'Mark read') + '</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="filter-source"' +
        ' data-value="' + escapeHtml(article.source) + '">Only this source</button>' +
      '</div>' +
    '</div>';
  }

  // A row carries whatever context its surroundings do not, and never more than
  // one line of it. The headline is the same size in every layout; only the
  // sentence under it changes -- source and topic in the feed, source and date
  // inside a topic section, topic and date inside a source card, where the card
  // header has already said the publisher's name.
  function renderRow(article, query, options) {
    var opts = options || {};
    var score = scoreOf(article);
    var id = escapeHtml(article.id);
    var expanded = state.expandedId === article.id;
    var stale = article.is_stale
      ? '<span title="The latest source fetch failed; this is the last successful copy">stale copy</span>'
      : '';

    return '<li class="row' + (opts.className ? ' ' + opts.className : '') + '"' +
      ' data-item data-id="' + id + '"' +
      ' data-read="' + (isRead(article.id) ? 'true' : 'false') + '"' +
      (state.selectedId === article.id ? ' data-selected="true"' : '') + '>' +
      '<div class="row__line">' +
        (opts.position
          ? '<span class="row__pos" aria-hidden="true">' + opts.position + '</span>'
          : '') +
        '<div class="row__body">' +
          '<a class="row__link" href="' + escapeHtml(safeUrl(article.link)) + '"' +
          ' target="_blank" rel="noopener noreferrer" data-act="open">' +
          '<span class="row__title">' + highlight(article.title, query) + '</span></a>' +
          '<p class="row__meta">' + (opts.meta || '') +
            ((opts.meta && stale) ? ' · ' : '') + stale + '</p>' +
        '</div>' +
        '<div class="row__tools">' +
          // The score no longer wears a badge. It is the quietest thing on the
          // line and it is still the door to its own arithmetic.
          '<button type="button" tabindex="-1" class="row__score" data-act="expand"' +
          ' aria-expanded="' + (expanded ? 'true' : 'false') +
          '" title="Signal score ' + score + ' — open the breakdown"' +
          ' aria-label="Signal score ' + score + '. Open the breakdown">' + score + '</button>' +
          iconButton('hide', 'x', 'Hide this headline') +
        '</div>' +
      '</div>' +
      (expanded ? renderDetail(article) : '') +
    '</li>';
  }

  /* -- Today and Latest ---------------------------------------------------
     The front page is one idea: visual weight follows rank and never goes
     back up. The top three are a hero, then three bands, each a visible step
     lighter than the one above -- a serif headline with its summary, a sans
     headline with one line of meta, then a three-column index of titles.
     Latest is the same corpus newest first, at the middle band's weight. */

  // Markup inside a textarea is parsed as text, so this decodes entities
  // (&nbsp; &amp; &#8217;) without ever building an element from the input.
  // The result is escaped again on the way out like any other text.
  var entityDecoder = document.createElement('textarea');

  function decodeEntities(text) {
    entityDecoder.innerHTML = text;
    return entityDecoder.value;
  }

  // A summary line is shown only when it is the publisher's own words about
  // this story: not missing, not the app's placeholder, not a bot wall or a
  // newsletter's welcome paragraph.
  function usableSummary(article) {
    var raw = String(article.summary || '').trim();
    if (!raw || !article.summary_source) return '';
    if (raw.indexOf(GENERATED_SUMMARY_PREFIX) === 0) return '';
    if (raw === article.source + ': ' + article.title) return '';
    var text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (!text || JUNK_SUMMARY.test(text)) return '';
    return text;
  }

  function newTag(article, small) {
    if (!isNew(article)) return '';
    return '<span class="newtag' + (small ? ' newtag--sm' : '') + '"' +
      ' title="First seen since your last visit">NEW</span>';
  }

  function staleNote(article) {
    return article.is_stale
      ? '<span title="The latest source fetch failed; this is the last successful copy">stale copy</span>'
      : '';
  }

  // Every story on these two pages carries the same hooks as a row elsewhere:
  // data-item for j/k, data-id for the actions, data-read for the muted title.
  function storyAttrs(article, className) {
    return ' class="' + className + '" data-item data-id="' + escapeHtml(article.id) + '"' +
      ' data-read="' + (isRead(article.id) ? 'true' : 'false') + '"' +
      (state.selectedId === article.id ? ' data-selected="true"' : '');
  }

  function storyLink(article, query, className) {
    return '<a class="' + className + '" href="' + escapeHtml(safeUrl(article.link)) + '"' +
      ' target="_blank" rel="noopener noreferrer" data-act="open">' +
      highlight(article.title, query) + '</a>';
  }

  // The number reads as plain type, but it is still the door to its own
  // arithmetic, the same as the score on every other row.
  function scoreButton(article, className) {
    var score = scoreOf(article);
    return '<button type="button" tabindex="-1" class="' + className + '" data-act="expand"' +
      ' aria-expanded="' + (state.expandedId === article.id ? 'true' : 'false') + '"' +
      ' title="Why ' + score + '? Open the score breakdown"' +
      ' aria-label="Signal score ' + score + '. Open the breakdown">' + score + '</button>';
  }

  function detailFor(article) {
    return state.expandedId === article.id ? renderDetail(article) : '';
  }

  function storyMeta(parts, article, small) {
    var stale = staleNote(article);
    return '<p class="story__meta"><span class="story__metatext">' + metaLine(parts) +
      (stale ? '<span class="row__dot" aria-hidden="true">·</span>' + stale : '') +
      '</span>' + (article ? newTag(article, small) : '') + '</p>';
  }

  function metaAgeAgo(article) {
    var age = ageOf(article);
    if (!age.text) return '';
    var text = /^\d+(m|h|d|w|mo)$/.test(age.text) ? age.text + ' ago' : age.text;
    return '<span class="row__age' + (age.estimated ? ' row__age--est' : '') +
      '" title="' + escapeHtml(age.title) + '">' + escapeHtml(text) + '</span>';
  }

  function renderLead(article, query) {
    var score = scoreOf(article);
    var expanded = state.expandedId === article.id;
    return '<article' + storyAttrs(article, 'lead') + '>' +
      '<div class="lead__kicker">' +
        '<span class="lead__badge">' + score + ' SIGNAL</span>' +
        metaFilter('category', categoryOf(article), 'lead__topic') +
      '</div>' +
      '<h3 class="lead__title">' + storyLink(article, query, 'lead__link') + '</h3>' +
      '<p class="lead__meta">' +
        metaLine([metaSource(article), metaAgeAgo(article), metaAlso(article)]) +
        (staleNote(article) ? '<span class="row__dot" aria-hidden="true">·</span>' +
          staleNote(article) : '') +
      '</p>' +
      '<div class="lead__actions">' +
        '<a class="slant slant--ink lead__btn lead__btn--read" href="' +
        escapeHtml(safeUrl(article.link)) + '"' +
        ' target="_blank" rel="noopener noreferrer" data-act="open">' +
        slantShape(136, 44, 11) + 'Read story ↗</a>' +
        '<button type="button" class="slant lead__btn lead__btn--why" data-act="expand"' +
        ' aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
        slantShape(104, 44, 11) + 'Why ' + score + '?</button>' +
      '</div>' +
      detailFor(article) +
    '</article>';
  }

  // The file-tab parallelogram behind a control: top edge shifted right by
  // `slant`, the same lean as the view tabs. The ring is the same shape pushed
  // 3px outward, shown only for keyboard focus.
  function slantShape(width, height, slant) {
    var w = width, h = height, k = slant, d = 3;
    var s = d * Math.sqrt(h * h + k * k) / h;
    var r = function (n) { return Math.round(n * 100) / 100; };
    return '<svg class="slant__shape" viewBox="0 0 ' + w + ' ' + h + '"' +
      ' preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="slant__body" d="M' + k + ' 0.75 L' + (w - 0.75) + ' 0.75 L' +
        (w - k) + ' ' + (h - 0.75) + ' L0.75 ' + (h - 0.75) + ' Z"/>' +
      '<path class="slant__ring" d="M' + r(k * (1 + d / h) - s) + ' ' + -d +
        ' L' + r(w + k * d / h + s) + ' ' + -d +
        ' L' + r(w - k - k * d / h + s) + ' ' + (h + d) +
        ' L' + r(-k * d / h - s) + ' ' + (h + d) + ' Z"/>' +
      '</svg>';
  }

  function renderSide(article, query) {
    return '<article' + storyAttrs(article, 'side') + '>' +
      '<div class="side__kicker">' +
        scoreButton(article, 'side__score') +
        metaFilter('category', categoryOf(article), 'side__topic') +
      '</div>' +
      '<h3 class="side__title">' + storyLink(article, query, 'side__link') + '</h3>' +
      '<p class="side__meta">' + metaLine([metaSource(article), metaAge(article)]) + '</p>' +
      detailFor(article) +
    '</article>';
  }

  function renderPick(article, query) {
    var summary = usableSummary(article);
    return '<li' + storyAttrs(article, 'pick') + '>' +
      scoreButton(article, 'pick__score') +
      '<div class="pick__body">' +
        '<h3 class="pick__title">' + storyLink(article, query, 'pick__link') + '</h3>' +
        (summary ? '<p class="pick__summary">' + escapeHtml(summary) + '</p>' : '') +
        storyMeta([metaSource(article), metaTopic(article), metaAge(article),
                   metaAlso(article)], article) +
        detailFor(article) +
      '</div>' +
    '</li>';
  }

  function renderWorth(article, query, withTopic) {
    return '<li' + storyAttrs(article, 'worth') + '>' +
      scoreButton(article, 'worth__score') +
      '<div class="worth__body">' +
        '<h3 class="worth__title">' + storyLink(article, query, 'worth__link') + '</h3>' +
        storyMeta([metaSource(article), withTopic ? metaTopic(article) : '',
                   metaAge(article), withTopic ? metaAlso(article) : ''], article) +
        detailFor(article) +
      '</div>' +
    '</li>';
  }

  function renderRestItem(article, query) {
    return '<li' + storyAttrs(article, 'restitem') + '>' +
      scoreButton(article, 'restitem__score') +
      '<h3 class="restitem__title">' + storyLink(article, query, 'restitem__link') + '</h3>' +
      newTag(article, true) +
      detailFor(article) +
    '</li>';
  }

  // Column-down reading order, split as evenly as the count allows: the
  // first n % 3 columns take one extra, so ten stories land 4 / 3 / 3.
  function renderRest(items, query) {
    var base = Math.floor(items.length / REST_COLUMNS);
    var extra = items.length % REST_COLUMNS;
    var columns = [];
    var cursor = 0;
    for (var c = 0; c < REST_COLUMNS; c++) {
      var size = base + (c < extra ? 1 : 0);
      columns.push(items.slice(cursor, cursor + size));
      cursor += size;
    }
    return '<div class="rest">' + columns.map(function (column) {
      return '<ol class="rest__col">' + column.map(function (article) {
        return renderRestItem(article, query);
      }).join('') + '</ol>';
    }).join('') + '</div>';
  }

  function bandHead(label, range) {
    return '<header class="band__head">' +
      '<h2 class="band__label">' + escapeHtml(label) + '</h2>' +
      '<span class="band__range">' + escapeHtml(range) + '</span>' +
      '<span class="band__rule" aria-hidden="true"></span>' +
    '</header>';
  }

  function renderLoadMore(shown, total) {
    if (shown >= total) return '';
    return '<div class="loadmore">' +
      '<button type="button" class="pill pill--outline pill--lg" data-act="load-more">' +
      'Load more · ' + shown + ' of ' + total + '</button></div>';
  }

  // `articles` is the page already cut to the current limit; `total` is how
  // many qualify. Bands are cut by position, so loading more only ever adds
  // to the last band and never moves a story between bands.
  function renderToday(articles, query, total) {
    var hero = articles.slice(0, HERO_SIZE);
    var out = '<section class="hero" aria-label="Top stories">' +
      renderLead(hero[0], query) +
      (hero.length > 1
        ? '<div class="hero__side">' + hero.slice(1).map(function (article) {
            return renderSide(article, query);
          }).join('') + '</div>'
        : '') +
    '</section>';

    BANDS.forEach(function (band) {
      var items = articles.slice(band.from - 1,
        band.to === Infinity ? undefined : band.to);
      if (!items.length) return;
      var last = band.from + items.length - 1;
      var range = '#' + band.from + (last > band.from ? '–' + last : '');
      var body;
      if (band.key === 'top') {
        body = '<ol class="band__list">' + items.map(function (article) {
          return renderPick(article, query);
        }).join('') + '</ol>';
      } else if (band.key === 'worth') {
        body = '<ol class="band__list">' + items.map(function (article) {
          return renderWorth(article, query, false);
        }).join('') + '</ol>';
      } else {
        body = renderRest(items, query);
      }
      out += '<section class="band band--' + band.key + '">' +
        bandHead(band.label, range) + body + '</section>';
    });

    return out + renderLoadMore(articles.length, total);
  }

  // Day headers only earn their space when the list is in date order, which
  // is the whole point of this view.
  function renderLatest(articles, query, total) {
    var groups = [];
    var current = null;
    articles.forEach(function (article) {
      var day = dayBucket(ageOf(article).date);
      if (!current || current.label !== day) {
        current = { label: day, articles: [] };
        groups.push(current);
      }
      current.articles.push(article);
    });

    return groups.map(function (group) {
      return '<section class="band band--day">' +
        bandHead(group.label, plural(group.articles.length, 'story', 'stories')) +
        '<ol class="band__list">' + group.articles.map(function (article) {
          return renderWorth(article, query, true);
        }).join('') + '</ol>' +
      '</section>';
    }).join('') + renderLoadMore(articles.length, total);
  }

  /* -- Categories --------------------------------------------------------- */

  // Every topic is a section on one page. Four headlines show; the rest wait
  // behind a link that opens them in place, so nothing scrolls inside anything.
  function renderTopic(group, query) {
    var open = state.openTopics[group.name] === true || Boolean(query);
    var rows = open ? group.articles : group.articles.slice(0, TOPIC_PREVIEW);
    var name = escapeHtml(group.name);
    var pinned = isPinned(group.name);
    var pinLabel = (pinned ? 'Unpin ' : 'Pin ') + group.name;

    var more = '';
    if (!query && group.articles.length > TOPIC_PREVIEW) {
      more = '<button type="button" class="more" data-act="expand-topic"' +
        ' data-value="' + name + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        (open ? 'Show fewer ↑' : 'Show all ' + group.articles.length + ' articles →') +
        '</button>';
    }

    return '<section class="topic" id="topic-' + slug(group.name) + '"' +
      ' data-name="' + name + '" aria-labelledby="topic-title-' + slug(group.name) + '">' +
      '<header class="topic__head">' +
        '<h2 class="topic__title" id="topic-title-' + slug(group.name) + '">' + name + '</h2>' +
        '<button type="button" class="topic__pin" data-act="toggle-pin"' +
          ' data-value="' + name + '" aria-pressed="' + (pinned ? 'true' : 'false') + '"' +
          ' title="' + escapeHtml(pinLabel) + '" aria-label="' + escapeHtml(pinLabel) + '">' +
          icon(pinned ? 'pin-on' : 'pin', '') +
        '</button>' +
        '<span class="topic__count">' + plural(group.articles.length, 'article') + '</span>' +
      '</header>' +
      '<ol class="topic__list">' + rows.map(function (article) {
        return renderRow(article, query, {
          className: 'row--topic',
          meta: metaLine([metaSource(article), metaAge(article), metaAlso(article)])
        });
      }).join('') + '</ol>' + more +
    '</section>';
  }

  function renderCategoryIndex(groups) {
    var links = groups.map(function (group) {
      var name = escapeHtml(group.name);
      var pinned = isPinned(group.name);
      var pinLabel = (pinned ? 'Unpin ' : 'Pin ') + group.name;
      return '<span class="catindex__row' + (pinned ? ' catindex__row--pinned' : '') + '">' +
        '<a class="catindex__link" href="#topic-' + slug(group.name) + '">' +
          '<span class="catindex__name">' + name + '</span>' +
          '<span class="catindex__count">' + group.articles.length + '</span>' +
        '</a>' +
        '<button type="button" class="catindex__pin" data-act="toggle-pin"' +
          ' data-value="' + name + '" aria-pressed="' + (pinned ? 'true' : 'false') + '"' +
          ' title="' + escapeHtml(pinLabel) + '" aria-label="' + escapeHtml(pinLabel) + '">' +
          icon(pinned ? 'pin-on' : 'pin', '') +
        '</button>' +
      '</span>';
    }).join('');

    el.catIndexNav.innerHTML =
      '<a class="catindex__link catindex__link--all" href="#top">All categories</a>' + links;

    el.jump.innerHTML = '<option value="top">All categories</option>' +
      groups.map(function (group) {
        return '<option value="topic-' + slug(group.name) + '">' +
          escapeHtml(group.name) + '</option>';
      }).join('');
  }

  /* -- Sources ------------------------------------------------------------ */

  // A board, not a stack of scrollers: every publisher is a card of the same
  // shape, three headlines deep, and the page is the only thing that scrolls.
  function renderSourceCard(group, query) {
    var open = state.openSources[group.name] === true || Boolean(query);
    var rows = open ? group.articles : group.articles.slice(0, SOURCE_PREVIEW);
    var name = escapeHtml(group.name);

    var foot = query ? '<span class="srccard__all">All matches shown</span>'
                     : '<span class="srccard__all">All articles shown</span>';
    if (!query && group.articles.length > SOURCE_PREVIEW) {
      foot = '<button type="button" class="more" data-act="expand-source"' +
        ' data-value="' + name + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        (open ? 'Show fewer ↑' : 'View all ' + group.articles.length + ' articles →') +
        '</button>';
    }

    return '<section class="card srccard" id="source-' + slug(group.name) + '"' +
      ' aria-labelledby="source-title-' + slug(group.name) + '">' +
      '<header class="srccard__head">' +
        '<h2 class="srccard__title" id="source-title-' + slug(group.name) + '">' +
        name + '</h2>' +
        // Nothing else, while the source is working. A green light on every one
        // of twenty-five cards says nothing, and the count it used to sit
        // beside is already in the footer under it -- two lines of chrome above
        // every title to repeat what the card says twice below. What survives
        // is the case worth reading: a source in trouble names its trouble.
        (group.health && group.health !== 'ok'
          ? '<p class="srccard__kicker" title="' +
            escapeHtml(healthLabel(group.health)) + '">' +
            '<span class="dot dot--' + group.health + '"></span>' +
            '<span>' + (group.health === 'empty' ? 'no match' : 'error') +
            '</span></p>'
          : '') +
      '</header>' +
      '<ol class="srccard__list">' + rows.map(function (article) {
        return renderRow(article, query, {
          className: 'row--source',
          meta: metaLine([metaTopic(article), metaAge(article)])
        });
      }).join('') + '</ol>' +
      '<footer class="srccard__foot">' + foot + '</footer>' +
    '</section>';
  }

  // A source that fetched fine but matched nothing, or errored outright, keeps
  // its place on the board. The old dashboard simply omitted it, so a broken
  // selector was indistinguishable from a quiet news day.
  function renderBrokenCard(row) {
    var detail = row.state === 'empty'
      ? 'The page loaded but no headline matched the selector.'
      : (row.error || 'The fetch failed.');
    var since = row.last_success
      ? 'Last worked ' + relativePast(parseDate(row.last_success)).replace('updated ', '')
      : 'Never returned a headline';

    return '<section class="card srccard srccard--broken">' +
      '<header class="srccard__head">' +
        '<h2 class="srccard__title">' + escapeHtml(row.name) + '</h2>' +
        '<p class="srccard__kicker">' +
          '<span class="dot dot--' + row.state + '"></span>' +
          '<span>' + escapeHtml(row.state === 'empty' ? 'no match' : 'error') +
          '</span>' +
        '</p>' +
      '</header>' +
      '<div class="srccard__broken">' +
        '<p>' + escapeHtml(detail) + '</p>' +
        '<p class="srccard__since">' + escapeHtml(since) +
        (row.http_status ? ' · HTTP ' + row.http_status : '') + '</p>' +
      '</div>' +
    '</section>';
  }

  function healthLabel(state_) {
    return {
      ok: 'Working', empty: 'Fetched, but nothing matched the selector',
      error: 'Fetch failed', disabled: 'Disabled', pending: 'Not scraped yet'
    }[state_] || state_;
  }

  function renderSkeleton() {
    var rows = '';
    for (var r = 0; r < 4; r++) {
      rows += '<div class="skeleton-row">' +
        '<span class="skeleton skeleton--line" style="width:70%"></span>' +
        '<span class="skeleton skeleton--subline" style="width:30%"></span>' +
      '</div>';
    }

    if (state.view === 'sources') {
      var cards = '';
      for (var c = 0; c < 8; c++) {
        cards += '<section class="card srccard">' +
          '<header class="srccard__head">' +
            '<p class="srccard__kicker"><span class="skeleton skeleton--label"></span></p>' +
            '<span class="skeleton skeleton--title" style="width:60%"></span>' +
          '</header>' +
          '<div class="srccard__list">' + rows + '</div>' +
        '</section>';
      }
      el.grid.innerHTML = cards;
      return;
    }

    if (state.view === 'topics') {
      var topics = '';
      for (var t = 0; t < 4; t++) {
        topics += '<section class="topic">' +
          '<header class="topic__head">' +
            '<span class="skeleton skeleton--heading"></span>' +
          '</header>' +
          '<div class="topic__list">' + rows + '</div>' +
        '</section>';
      }
      el.grid.innerHTML = topics;
      return;
    }

    var feed = '';
    for (var f = 0; f < 3; f++) feed += rows;
    el.grid.innerHTML = '<section class="band band--skeleton">' +
      '<header class="band__head"><span class="skeleton skeleton--label"></span></header>' +
      '<div class="band__list">' + feed + '</div></section>';
  }

  function renderState(iconName, title, body, bodyClass, action) {
    el.grid.innerHTML = '<div class="state">' +
      '<span class="state__icon">' + icon(iconName, '') + '</span>' +
      '<p class="state__title">' + escapeHtml(title) + '</p>' +
      '<p class="state__body ' + (bodyClass || '') + '">' + escapeHtml(body) + '</p>' +
      (action ? '<button type="button" class="btn btn--outline btn--sm" data-act="' +
        action.act + '">' + escapeHtml(action.label) + '</button>' : '') +
    '</div>';
  }

  // Today's date, then how much of the corpus the page is showing. The date
  // is the reader's, not the scrape's: freshness problems are the status
  // logic's job, not the masthead's.
  function renderDateline() {
    var now = new Date();
    var date;
    try {
      date = now.toLocaleDateString('en-GB', { weekday: 'long' }) + ', ' +
        now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (error) {
      date = now.toDateString();
    }
    var count = state.status === 'ready'
      ? ' · ' + renderedArticles().length + ' of ' + plural(corpusTotal(), 'story', 'stories')
      : '';
    el.dateline.textContent = date + count;
  }

  /* == Status ==============================================================
     Everything wrong with the data, gathered in one place. These used to be
     four mutually exclusive banners, so a page that was both stale and losing
     sources only ever admitted to one of them. They are a list now: the chip
     names each in two or three words, and the panel behind it carries the
     sentences. The order is the order they matter in, which is also the order
     the panel reads and the order the action is taken from -- an unreachable
     server is worth fixing before a stale headline is. */
  function statusConditions() {
    var list = [];

    if (state.pollFailures >= 1) {
      list.push({
        tone: 'error',
        label: 'offline',
        text: 'Cannot reach the server — showing the last data we loaded. Retrying…',
        action: { label: 'Retry now', handler: function () { load({ silent: true }); } }
      });
    }

    if (state.stats && state.stats.storage_error) {
      list.push({
        tone: 'error',
        label: 'storage error',
        text: state.stats.storage_error,
        action: { label: 'Retry now', handler: refresh }
      });
    }

    if (state.status === 'ready' && state.lastSync &&
        Date.now() - state.lastSync.getTime() > 3600000) {
      list.push({
        tone: 'warn',
        label: shortAge(Date.now() - state.lastSync.getTime()) + ' stale',
        text: 'These headlines are over an hour old. The scheduled scrape may not be running.',
        action: {
          label: state.stats && state.stats.refresh_mode === 'check' ? 'Check updates' : 'Re-scrape',
          handler: refresh
        }
      });
    }

    if (state.health && state.health.failing > 0) {
      list.push({
        tone: 'warn',
        label: state.health.failing + ' failing',
        text: plural(state.health.failing, 'source') + ' stopped returning headlines, ' +
              'so parts of the feed are missing.',
        action: { label: 'Review sources', handler: function () { selectView('sources'); } }
      });
    }

    return list;
  }

  function renderStatus() {
    var conditions = statusConditions();

    el.status.hidden = conditions.length === 0;
    if (!conditions.length) {
      closeStatusPanel();
      return;
    }

    var tone = conditions.some(function (c) { return c.tone === 'error'; }) ? 'error' : 'warn';
    el.status.dataset.tone = tone;

    el.statusChipText.textContent = conditions.map(function (c) { return c.label; }).join(' · ');
    el.statusChip.setAttribute('aria-label',
      conditions.map(function (c) { return c.text; }).join(' '));

    el.statusPanelList.innerHTML = conditions.map(function (c) {
      return '<li>' + escapeHtml(c.text) + '</li>';
    }).join('');

    // One button, for the first thing worth doing. The rest of the list is
    // reachable from the sources dialog, and two competing buttons in a panel
    // this small reads as a choice rather than a fix.
    var action = conditions[0].action;
    el.statusPanelAction.hidden = !action;
    if (action) {
      el.statusPanelAction.textContent = action.label;
      el.statusPanelAction.onclick = function () {
        closeStatusPanel();
        action.handler();
      };
    }
  }

  function closeStatusPanel() {
    el.statusPanel.hidden = true;
    el.statusChip.setAttribute('aria-expanded', 'false');
  }

  function renderFilters() {
    var pills = pillFilters();
    el.filters.hidden = pills.length === 0;
    el.filters.innerHTML = pills.map(function (pill) {
      return '<button type="button" class="filter" data-act="drop-filter"' +
        ' data-value="' + pill.kind + '" title="Remove this filter">' +
        escapeHtml(pill.label) + icon('x', 'filter__x') + '</button>';
    }).join('') + (pills.length
      ? '<button type="button" class="filter filter--clear" data-act="drop-filter"' +
        ' data-value="all">Clear all</button>'
      : '');
  }

  // The view's title is the hidden h1 and the document title: the tabs have
  // already said which view this is. The visible part is the dateline.
  function renderHead(articles, total) {
    var title = VIEW_TITLES[state.view] || VIEW_TITLES.today;

    document.title = title + ' · High Signal';
    el.viewTitle.textContent = title;
    renderDateline();

    if (state.status !== 'ready') {
      el.resultCount.textContent = '';
      return;
    }

    if (!articles.length) {
      // "0 articles in 0 categories" is arithmetic, not information. The empty
      // state below says what is missing and what to do about it.
      el.resultCount.textContent = '';
      return;
    }

    var scope = state.view === 'sources'
      ? plural(distinct(articles, function (a) { return a.source; }), 'source')
      : plural(distinct(articles, categoryOf), 'category', 'categories');

    el.resultCount.textContent = state.view === 'sources'
      ? scope + ' · ' + plural(articles.length, 'article')
      : plural(articles.length, 'article') +
        (isFiltered() ? ' of ' + total : '') + ' · ' + scope;
  }

  // The category index is a column beside the page on wide screens and a select
  // above it on narrow ones. Both are built from the same list in the same
  // order, so the two never disagree about where a topic sits.
  //
  // The flag drives the layout rather than the view name, because a category
  // view with nothing to index -- loading, or a search that matched nothing --
  // still owes its one column the full width.
  function renderReading(groups) {
    var showIndex = state.view === 'topics' && state.status === 'ready' &&
                    Boolean(groups && groups.length);
    el.reading.dataset.index = showIndex ? 'on' : 'off';
    el.catIndex.hidden = !showIndex;
    el.jumpBar.hidden = !showIndex;
    if (showIndex) renderCategoryIndex(groups);
  }

  function render() {
    el.grid.dataset.view = state.view;

    renderFilters();
    renderStatus();

    if (state.status === 'loading') {
      renderHead([], 0);
      renderReading(null);
      renderSkeleton();
      return;
    }

    if (state.status === 'error') {
      renderHead([], 0);
      renderReading(null);
      renderState('alert', 'Could not reach the server',
        'The dashboard could not load its published snapshot. Check the server and try again.',
        'state__body--error', { act: 'retry', label: 'Try again' });
      return;
    }

    var articles = visibleArticles();
    var query = state.query.trim();
    var total = corpusTotal();
    var scrollY = window.scrollY;

    renderHead(articles, total);

    if (!articles.length) {
      renderReading(null);
      renderEmpty();
      return;
    }

    if (isPaged()) {
      renderReading(null);
      var page = articles.slice(0, state.limit);
      el.grid.innerHTML = state.view === 'today'
        ? renderToday(page, query, articles.length)
        : renderLatest(page, query, articles.length);
      window.scrollTo(0, scrollY);
      return;
    }

    if (state.view === 'topics') {
      var topics = groupBy(articles, categoryOf);

      // The taxonomy has an editorial order of its own; pinning promotes a
      // topic within it rather than reshuffling everything around it.
      topics.sort(function (a, b) {
        var ai = CATEGORY_ORDER.indexOf(a.name);
        var bi = CATEGORY_ORDER.indexOf(b.name);
        return (ai < 0 ? CATEGORY_ORDER.length : ai) -
               (bi < 0 ? CATEGORY_ORDER.length : bi) || a.name.localeCompare(b.name);
      });
      var lead = [];
      var rest = [];
      topics.forEach(function (group) {
        (isPinned(group.name) ? lead : rest).push(group);
      });
      topics = lead.concat(rest);

      renderReading(topics);
      el.grid.innerHTML = topics.map(function (group) {
        return renderTopic(group, query);
      }).join('');
      window.scrollTo(0, scrollY);
      updateActiveTopic();
      return;
    }

    // Sources: alphabetical, because a board is scanned by name, not by size.
    var sources = groupBy(articles, function (a) { return a.source; });
    sources.sort(function (a, b) { return a.name.localeCompare(b.name); });

    if (state.health) {
      var byName = {};
      state.health.sources.forEach(function (row) { byName[row.name] = row; });
      sources.forEach(function (group) {
        var row = byName[group.name];
        group.health = row ? row.state : null;
      });
    }

    var board = sources.map(function (group) {
      return renderSourceCard(group, query);
    }).join('');

    if (state.health && !isFiltered()) {
      board += state.health.sources.filter(function (row) {
        return row.state === 'error' || row.state === 'empty';
      }).map(renderBrokenCard).join('');
    }

    renderReading(null);
    el.grid.innerHTML = board;
    window.scrollTo(0, scrollY);
  }

  // Which topic section the reader is actually inside. The index follows the
  // page rather than the last thing clicked, so scrolling away from a topic
  // moves the marker with it.
  function updateActiveTopic() {
    if (state.view !== 'topics') return;
    var sections = el.grid.querySelectorAll('.topic[id]');
    if (!sections.length) return;

    var offset = 96;
    var current = sections[0];
    Array.prototype.forEach.call(sections, function (section) {
      if (section.getBoundingClientRect().top <= offset) current = section;
    });

    Array.prototype.forEach.call(el.catIndexNav.querySelectorAll('.catindex__link'),
      function (link) {
        if (link.getAttribute('href') === '#' + current.id) {
          link.setAttribute('aria-current', 'location');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    el.jump.value = current.id;
  }

  function renderEmpty() {
    if (isFiltered()) {
      renderState('inbox', 'Nothing matches',
        'No headlines clear these filters.', '',
        { act: 'clear-filters', label: 'Clear filters' });
      return;
    }
    renderState('inbox', 'No headlines yet',
      'Sources are scraped on a schedule. Check back after the next run.', '',
      { act: 'retry', label: 'Check again' });
  }

  /* == Selection and keyboard navigation =================================== */

  function visibleIds() {
    return Array.prototype.map.call(
      el.grid.querySelectorAll('[data-item][data-id]'),
      function (row) { return row.dataset.id; });
  }

  function moveSelection(step) {
    var ids = visibleIds();
    if (!ids.length) return;
    var index = ids.indexOf(state.selectedId);
    var next = index === -1 ? (step > 0 ? 0 : ids.length - 1)
                            : Math.min(ids.length - 1, Math.max(0, index + step));
    select(ids[next], true);
  }

  function select(id, scrollIntoView) {
    var previous = el.grid.querySelector('[data-item][data-selected]');
    if (previous) previous.removeAttribute('data-selected');
    state.selectedId = id;
    var row = id && el.grid.querySelector('[data-item][data-id="' + cssEscape(id) + '"]');
    if (!row) return;
    row.dataset.selected = 'true';
    if (scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function selectedArticle() {
    return state.selectedId ? articleById(state.selectedId) : null;
  }

  /* == Row actions ========================================================= */

  function openArticle(article, viaKeyboard) {
    if (!article) return;
    markRead(article.id, true);
    var row = el.grid.querySelector('[data-item][data-id="' + cssEscape(article.id) + '"]');
    if (row) row.dataset.read = 'true';
    if (viaKeyboard) window.open(safeUrl(article.link), '_blank', 'noopener');
  }

  function toggleExpanded(id) {
    var opening = state.expandedId !== id;
    state.expandedId = opening ? id : null;
    state.selectedId = id;
    render();
    select(id, true);
    if (opening) loadSummary(articleById(id));
  }

  function handleHide(article) {
    if (!article) return;
    var ids = visibleIds();
    var next = ids[Math.min(ids.length - 1, ids.indexOf(article.id) + 1)];
    toggleHidden(article.id);
    if (state.expandedId === article.id) state.expandedId = null;
    state.selectedId = next === article.id ? null : next;
    render();
    if (state.selectedId) select(state.selectedId);
    toast('success', 'Hidden — undo from the toast', function () {
      toggleHidden(article.id);
      render();
    });
  }

  /* == Data ================================================================ */

  function fetchJson(url, options) {
    options = options || {};
    var admin = options.admin;
    var requestOptions = {};
    Object.keys(options).forEach(function (key) {
      if (key !== 'admin') requestOptions[key] = options[key];
    });
    requestOptions.headers = Object.assign({}, options.headers || {});
    if (admin) {
      if (!state.adminToken) return Promise.reject(new Error('Enter the owner token first.'));
      requestOptions.headers.Authorization = 'Bearer ' + state.adminToken;
    }
    return fetch(url, requestOptions).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; })
          .then(function (body) {
            var error = new Error(body.error || (url + ' ' + response.status));
            error.status = response.status;
            error.body = body;
            throw error;
          });
      }
      return response.json();
    });
  }

  var DASHBOARD_DB = 'high-signal-dashboard';
  var DASHBOARD_STORE = 'snapshots';

  function openDashboardDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var request = indexedDB.open(DASHBOARD_DB, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(DASHBOARD_STORE)) {
          request.result.createObjectStore(DASHBOARD_STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB failed')); };
    });
  }

  function readDashboardSlot(key) {
    return openDashboardDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var request = db.transaction(DASHBOARD_STORE, 'readonly')
          .objectStore(DASHBOARD_STORE).get(key);
        request.onsuccess = function () { db.close(); resolve(request.result || null); };
        request.onerror = function () { db.close(); reject(request.error); };
      });
    });
  }

  function validDashboard(payload) {
    return Boolean(payload && typeof payload === 'object' &&
      typeof payload.publication_id === 'string' && payload.publication_id &&
      Array.isArray(payload.articles) && payload.stats && payload.sources &&
      parseDate(payload.generated_at));
  }

  function lastDashboardSnapshot() {
    return readDashboardSlot('current').then(function (payload) {
      if (validDashboard(payload)) return payload;
      return readDashboardSlot('previous').then(function (previous) {
        return validDashboard(previous) ? previous : null;
      });
    }).catch(function () { return null; });
  }

  function saveDashboardSnapshot(payload) {
    if (!validDashboard(payload)) return Promise.resolve();
    return readDashboardSlot('current').catch(function () { return null; })
      .then(function (current) {
        return openDashboardDb().then(function (db) {
          return new Promise(function (resolve, reject) {
            var transaction = db.transaction(DASHBOARD_STORE, 'readwrite');
            var snapshots = transaction.objectStore(DASHBOARD_STORE);
            if (validDashboard(current) &&
                current.publication_id !== payload.publication_id) {
              snapshots.put(current, 'previous');
            }
            snapshots.put(payload, 'current');
            transaction.oncomplete = function () { db.close(); resolve(); };
            transaction.onerror = function () { db.close(); reject(transaction.error); };
            transaction.onabort = transaction.onerror;
          });
        });
      });
  }

  function articleSortTime(article) {
    return (parseDate(article.published) || parseDate(article.first_seen) ||
            parseDate(article.timestamp) || new Date(0)).getTime();
  }

  function sortedDashboardArticles(input, sort) {
    var articles = input.slice();
    if (sort === 'recent') {
      return articles.sort(function (a, b) {
        return articleSortTime(b) - articleSortTime(a) || scoreOf(b) - scoreOf(a);
      });
    }
    return articles.sort(function (a, b) {
      return scoreOf(b) - scoreOf(a) || a.source.localeCompare(b.source);
    });
  }

  var summaryRequests = {};
  var browserSummaries = readJson('hs.summaries', {});
  if (!browserSummaries || typeof browserSummaries !== 'object' || Array.isArray(browserSummaries)) {
    browserSummaries = {};
  }

  Object.keys(browserSummaries).forEach(function (id) {
    var entry = browserSummaries[id];
    if (!entry || typeof entry.summary !== 'string' ||
        typeof entry.checked_at !== 'number') delete browserSummaries[id];
  });

  function restoreSummary(article) {
    var cached = browserSummaries[article.id];
    if (!article.summary && cached && typeof cached.summary === 'string' &&
        Date.now() - cached.checked_at < 6 * 3600000) {
      article.summary = cached.summary;
      article.summary_source = cached.summary_source || '';
    }
  }

  function applySummary(article, result) {
    article.summary = result.summary || '';
    article.summary_source = result.summary_source || '';
    article.summary_error = result.summary_error || '';
    browserSummaries[article.id] = {
      summary: article.summary,
      summary_source: article.summary_source,
      checked_at: Date.now()
    };
    var keys = Object.keys(browserSummaries).sort(function (a, b) {
      return browserSummaries[b].checked_at - browserSummaries[a].checked_at;
    });
    keys.slice(500).forEach(function (key) { delete browserSummaries[key]; });
    writeJson('hs.summaries', browserSummaries);
  }

  function loadSummary(article) {
    if (!article || article.summary || summaryRequests[article.id]) return;

    summaryRequests[article.id] = true;
    fetchJson('/api/article/' + encodeURIComponent(article.id) + '/summary')
      .then(function (result) {
        applySummary(article, result);
        if (state.expandedId === article.id) {
          render();
          select(article.id);
        }
      })
      .catch(function (error) {
        article.summary_error = error.message || 'Could not load summary';
        if (state.expandedId === article.id) {
          render();
          select(article.id);
        }
      })
      .finally(function () {
        delete summaryRequests[article.id];
      });
  }

  // The signal floor is a fixed All / 80+ / 90+ now, chosen for where real
  // scores sit; the server's thresholds still colour the source-tool preview.
  function applyStats(stats) {
    state.stats = stats;
    if (stats && stats.thresholds) state.thresholds = stats.thresholds;
    state.lastSync = parseDate(stats && stats.last_update) || state.lastSync;
    if (stats && stats.refresh) followJob(stats.refresh);
    var checkMode = stats && stats.refresh_mode === 'check';
    el.refreshFromDialog.textContent = checkMode ? 'Check for updates' : 'Re-scrape now';
  }

  function applyHealth(health) {
    state.health = health;
    if (!health) return;
    renderStatus();
    el.sourcesSummary.textContent =
      health.ok + ' working · ' + health.failing + ' failing · ' +
      health.disabled + ' disabled · ' + health.total + ' configured';
  }

  function load(options) {
    var silent = options && options.silent;
    if (!silent) {
      state.status = 'loading';
      render();
    }

    return fetchJson('/api/dashboard').then(function (dashboard) {
      if (!validDashboard(dashboard)) throw new Error('The dashboard response is invalid.');
      saveDashboardSnapshot(dashboard).catch(function () {});
      state.offlineSnapshot = false;
      return applyDashboard(dashboard, silent);
    }).catch(function (error) {
      if (silent || state.articles.length) throw error;
      return lastDashboardSnapshot().then(function (dashboard) {
        if (!dashboard) throw error;
        state.pollFailures++;
        state.offlineSnapshot = true;
        applyDashboard(dashboard, false);
      });
    }).catch(function (error) {
      console.error(error);
      state.pollFailures++;
      if (silent) {
        renderStatus();
      } else {
        state.status = 'error';
        render();
      }
      throw error;
    });
  }

  function applyDashboard(dashboard, silent) {
      var articles = sortedDashboardArticles(dashboard.articles || [], 'score');
      articles.forEach(restoreSummary);
      applyStats(dashboard.stats);
      applyHealth(dashboard.sources);
      state.pollFailures = 0;
      if (state.offlineSnapshot) state.pollFailures = 1;
      state.status = 'ready';

      // A silent poll must not swap the list out from under the reader. New
      // headlines queue behind the pill instead; anything else (rescored,
      // reordered) applies straight away because nothing moves under the eye.
      if (silent && state.articles.length) {
        var known = {};
        state.articles.forEach(function (article) { known[article.id] = true; });
        var fresh = articles.filter(function (article) {
          return !known[article.id] && !isHidden(article.id);
        });
        if (fresh.length) {
          state.pending = articles;
          state.pendingCount = fresh.length;
          showNewPill();
          renderStatus();
          return dashboard;
        }
      }

      state.articles = articles;
      state.pending = null;
      state.pendingCount = 0;
      hideNewPill();
      render();
      return dashboard;
  }

  function showNewPill() {
    el.newPill.hidden = false;
    el.newPill.textContent = state.pendingCount === 1
      ? '1 new headline — show'
      : state.pendingCount + ' new headlines — show';
  }

  function hideNewPill() {
    el.newPill.hidden = true;
  }

  function applyPending() {
    if (!state.pending) return;
    state.articles = state.pending;
    state.pending = null;
    state.pendingCount = 0;
    hideNewPill();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* == Refresh job ========================================================= */

  // No longer offered from the header or the keyboard -- scraping runs on its
  // schedule -- but still reached from the sources dialog and the status
  // panel's fix-it action.
  function refresh() {
    fetchJson('/api/refresh', { method: 'POST' })
      .then(function (result) {
        if (result.status === 'checked') {
          return load({ silent: true }).then(function () {
            applyPending();
            toast('success', result.message);
          });
        }
        followJob(result.job);

        // Deployed serverlessly the scrape runs inside the request and comes
        // back already finished, so there is no job to poll -- reload here
        // instead, the way the poller would have.
        if (result.status === 'completed') {
          var job = result.job || {};
          if (job.state === 'error') {
            toast('error', 'Scrape failed: ' + (job.error || 'unknown error'));
          }
          load({ silent: true }).then(function () {
            applyPending();
            if (job.state === 'done') {
              toast('success', 'Sources re-scraped — ' + state.articles.length + ' headlines');
            }
            if (el.sourcesDialog.open) renderSourceList();
          }).catch(function () {});
          return;
        }

        toast('success', result.status === 'already_running'
          ? 'A scrape is already running'
          : 'Scraping ' + (state.health ? state.health.total : 'all') + ' sources…');
      })
      .catch(function (error) {
        // A refresh that cannot even reach the server is the same connectivity
        // problem the status logic reports, so say so there too.
        state.pollFailures++;
        renderStatus();
        toast('error', error.message || 'Could not refresh the feed.');
      });
  }

  // The scrape takes minutes, so the UI follows it with a determinate bar and
  // reloads once when it finishes. This also picks up the scrape that the
  // server starts by itself on a cold boot.
  function followJob(job) {
    state.job = job;
    renderJob();

    if (!job || job.state !== 'running') {
      if (state.jobTimer) {
        clearTimeout(state.jobTimer);
        state.jobTimer = null;
      }
      return;
    }

    if (state.jobTimer) return;

    var tick = function () {
      state.jobTimer = null;
      fetchJson('/api/refresh/status').then(function (next) {
        var wasRunning = state.job && state.job.state === 'running';
        state.job = next;
        renderJob();

        if (next.state === 'running') {
          state.jobTimer = setTimeout(tick, JOB_POLL_MS);
          return;
        }

        if (!wasRunning) return;

        if (next.state === 'error') {
          toast('error', 'Scrape failed: ' + (next.error || 'unknown error'));
        }
        load({ silent: true }).then(function () {
          applyPending();
          if (next.state === 'done') {
            toast('success', 'Sources re-scraped — ' + state.articles.length + ' headlines');
          }
          if (el.sourcesDialog.open) renderSourceList();
        }).catch(function () {});
      }).catch(function () {
        state.jobTimer = setTimeout(tick, JOB_POLL_MS * 2);
      });
    };

    state.jobTimer = setTimeout(tick, JOB_POLL_MS);
  }

  function renderJob() {
    var job = state.job;
    var running = job && job.state === 'running';
    el.progress.hidden = !running;

    if (!running) return;

    var total = job.total || 1;
    var done = Math.min(job.done || 0, total);
    el.progressBar.style.width = Math.round((done / total) * 100) + '%';
    el.progressLabel.textContent = done + '/' + total +
      (job.source ? ' · ' + job.source : ' · finishing up');
  }

  /* == Sources dialog ====================================================== */

  function hostedSourceMode() {
    return Boolean(state.stats && state.stats.refresh_mode === 'check');
  }

  function canManageSources() {
    return !hostedSourceMode() || Boolean(state.adminToken);
  }

  function mergeAuthoritativeSources(configs) {
    var previous = {};
    (state.health && state.health.sources || []).forEach(function (row) {
      previous[row.name] = row;
    });
    state.adminSources = {};
    var rows = configs.map(function (config) {
      state.adminSources[config.name] = config;
      return Object.assign({
        state: config.enabled === false ? 'disabled' : 'pending',
        count: 0, articles: 0, error: null, last_success: null
      }, previous[config.name] || {}, config);
    });
    var states = {};
    rows.forEach(function (row) {
      states[row.state] = (states[row.state] || 0) + 1;
    });
    applyHealth({
      sources: rows, total: rows.length, ok: states.ok || 0,
      failing: (states.error || 0) + (states.empty || 0),
      disabled: states.disabled || 0, states: states
    });
  }

  function loadAdminSources() {
    if (!state.adminToken || !hostedSourceMode()) return Promise.resolve();
    el.adminStatus.textContent = 'Checking owner access…';
    return fetchJson('/api/admin/sources', { admin: true }).then(function (result) {
      mergeAuthoritativeSources(result.sources || []);
      el.adminStatus.textContent = 'Owner access active for this tab. The token is not stored.';
      renderSourceList();
      resumeStoredSourceToolJob();
    }).catch(function (error) {
      state.adminSources = {};
      el.adminStatus.textContent = error.status === 401
        ? 'That owner token was not accepted.' : (error.message || 'Owner access failed.');
      renderSourceList();
      throw error;
    });
  }

  function openSources(focusName) {
    if (!el.sourcesDialog.open) el.sourcesDialog.showModal();
    renderSourceList(focusName);
    if (state.adminToken && hostedSourceMode()) loadAdminSources().catch(function () {});
    if (!el.categorySelect.options.length) {
      el.categorySelect.innerHTML = KNOWN_CATEGORIES.map(function (name) {
        return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
      }).join('');
    }
  }

  function renderSourceList(focusName) {
    if (!state.health) {
      el.sourceList.innerHTML = '<p class="dialog__note">Loading…</p>';
      fetchJson('/api/sources').then(function (health) {
        applyHealth(health);
        renderSourceList(focusName);
      }).catch(function () {
        el.sourceList.innerHTML = '<p class="dialog__note">Could not load sources.</p>';
      });
      return;
    }

    var canManage = canManageSources();
    el.addSource.classList.toggle('addsource--locked', !canManage);
    el.sourceList.innerHTML = state.health.sources.map(function (row) {
      var name = escapeHtml(row.name);
      var last = row.last_success
        ? relativePast(parseDate(row.last_success)).replace('updated ', 'ok ')
        : 'never returned a headline';

      return '<div class="srow' + (focusName === row.name ? ' srow--focus' : '') +
        '" data-name="' + name + '" data-state="' + escapeHtml(row.state) + '">' +
        '<span class="dot dot--' + escapeHtml(row.state) + '" title="' +
        escapeHtml(healthLabel(row.state)) + '"></span>' +
        '<div class="srow__main">' +
          '<a class="srow__name" href="' + escapeHtml(safeUrl(row.url)) +
          '" target="_blank" rel="noopener noreferrer">' + name + '</a>' +
          '<span class="srow__meta">' +
            escapeHtml(row.tier) + ' tier · ' + row.count + ' cached · ' +
            escapeHtml(last) +
            (row.error ? ' · ' + escapeHtml(String(row.error).slice(0, 90)) : '') +
            (row.retained_articles ? ' · showing ' + row.retained_articles + ' retained' : '') +
            (row.state === 'empty' ? ' · selector matched nothing' : '') +
          '</span>' +
          (row.selector ? '<code class="srow__selector">' +
            escapeHtml(row.selector) + '</code>' : '') +
        '</div>' +
        '<div class="srow__actions">' +
          '<button type="button" class="btn btn--ghost btn--sm btn--icon" data-src-act="test"' +
          (canManage ? '' : ' disabled') +
          ' title="Test now" aria-label="Test ' + name + '">' + icon('play', '') + '</button>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-src-act="toggle"' +
          (canManage ? '' : ' disabled') +
          ' aria-pressed="' + (row.enabled ? 'true' : 'false') + '">' +
          (row.enabled ? 'On' : 'Off') + '</button>' +
          '<button type="button" class="btn btn--ghost btn--sm btn--icon" data-src-act="delete"' +
          (canManage ? '' : ' disabled') +
          ' title="Remove source" aria-label="Remove ' + name + '">' + icon('trash', '') +
          '</button>' +
        '</div>' +
        '<div class="srow__result" hidden></div>' +
      '</div>';
    }).join('');

    if (focusName) {
      var focused = el.sourceList.querySelector('.srow--focus');
      if (focused) focused.scrollIntoView({ block: 'center' });
    }
  }

  function renderPreview(target, result) {
    if (result.error && !result.count) {
      target.hidden = false;
      target.innerHTML = '<p class="preview__fail">' + icon('alert', '') +
        escapeHtml(result.error) +
        (result.http_status ? ' (HTTP ' + result.http_status + ')' : '') + '</p>';
      return;
    }

    target.hidden = false;
    target.innerHTML = '<p class="preview__ok">' + icon('check', '') +
      escapeHtml(plural(result.count, 'headline') + ' matched in ' +
                 Math.round(result.duration_ms / 100) / 10 + 's') + '</p>' +
      '<ul class="preview__list">' + result.preview.map(function (item) {
        return '<li><span class="badge badge--sm badge--' + scoreTone(item.signal_score) +
          '">' + item.signal_score + '</span><span>' + escapeHtml(item.title) + '</span></li>';
      }).join('') + '</ul>';
  }

  var sourceCandidates = [];
  var selectedCandidate = -1;

  function resetDiscovery() {
    sourceCandidates = [];
    selectedCandidate = -1;
    el.sourceDiscovery.hidden = true;
    el.sourceDiscovery.innerHTML = '';
    el.sourceType.value = 'static';
    el.sourceFeedUrl.value = '';
  }

  function candidateLabel(candidate) {
    if (candidate.type === 'rss') return 'RSS feed';
    return candidate.selector || 'CSS selector';
  }

  function candidateDetail(candidate) {
    if (candidate.type === 'rss') return candidate.feed_url || '';
    return candidate.selector + (candidate.fallback ? ' | fallback ' + candidate.fallback : '');
  }

  function renderDiscovery(result) {
    sourceCandidates = result.candidates || [];
    selectedCandidate = sourceCandidates.length ? 0 : -1;
    el.sourceDiscovery.hidden = false;

    if (result.error && !sourceCandidates.length) {
      el.sourceDiscovery.innerHTML = '<p class="preview__fail">' + icon('alert', '') +
        escapeHtml(result.error) +
        (result.http_status ? ' (HTTP ' + result.http_status + ')' : '') + '</p>';
      return;
    }

    if (!sourceCandidates.length) {
      el.sourceDiscovery.innerHTML = '<p class="preview__fail">' + icon('alert', '') +
        'No working options found.</p>';
      return;
    }

    el.sourceDiscovery.innerHTML =
      '<div class="discovery__head">' +
        '<span>' + escapeHtml(plural(sourceCandidates.length, 'option')) + ' found</span>' +
      '</div>' +
      '<div class="candidate-list">' + sourceCandidates.map(function (candidate, index) {
        var preview = (candidate.preview || []).slice(0, 5).map(function (item) {
          return '<li><span>' + escapeHtml(item.title) + '</span></li>';
        }).join('');
        return '<section class="candidate' + (index === selectedCandidate ? ' candidate--selected' : '') +
          '" data-candidate="' + index + '">' +
          '<div class="candidate__top">' +
            '<div class="candidate__title">' +
              '<strong>' + escapeHtml(candidateLabel(candidate)) + '</strong>' +
              '<span>' + escapeHtml(candidate.count || 0) + ' headlines · ' +
                escapeHtml(candidate.confidence || 0) + '% confidence</span>' +
            '</div>' +
            '<button type="button" class="btn btn--outline btn--sm" data-candidate-pick="' +
              index + '">' + (index === selectedCandidate ? 'Selected' : 'Use') + '</button>' +
          '</div>' +
          '<code class="candidate__selector">' + escapeHtml(candidateDetail(candidate)) + '</code>' +
          '<ul class="candidate__preview">' + preview + '</ul>' +
        '</section>';
      }).join('') + '</div>';

    applyCandidate(sourceCandidates[selectedCandidate], { quiet: true });
  }

  function applyCandidate(candidate, options) {
    if (!candidate) return;
    el.sourceType.value = candidate.type || 'static';
    el.sourceFeedUrl.value = candidate.feed_url || '';
    el.sourceSelector.value = candidate.selector || '';
    el.sourceFallback.value = candidate.fallback || '';

    if (!options || !options.quiet) {
      Array.prototype.forEach.call(el.sourceDiscovery.querySelectorAll('.candidate'), function (node) {
        node.classList.toggle('candidate--selected',
          Number(node.dataset.candidate) === selectedCandidate);
        var button = node.querySelector('[data-candidate-pick]');
        if (button) button.textContent =
          Number(button.dataset.candidatePick) === selectedCandidate ? 'Selected' : 'Use';
      });
      toast('success', candidateLabel(candidate) + ' selected');
    }
  }

  function sourceConfig(name) {
    if (state.adminSources[name]) return state.adminSources[name];
    var row = state.health && state.health.sources.filter(function (item) {
      return item.name === name;
    })[0];
    return row || null;
  }

  function discoverSource(payload, button) {
    if (hostedSourceMode()) {
      return submitSourceToolJob('discover', payload, el.sourceDiscovery, button, renderDiscovery);
    }
    button.disabled = true;
    el.sourceDiscovery.hidden = false;
    el.sourceDiscovery.innerHTML = '<p class="preview__pending">Finding options…</p>';

    return fetchJson('/api/sources/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (result) {
      renderDiscovery(result);
    }).catch(function (error) {
      renderDiscovery({ error: error.message, candidates: [] });
    }).finally(function () {
      button.disabled = false;
    });
  }

  function testSource(payload, target, button) {
    if (hostedSourceMode()) {
      return submitSourceToolJob('test', payload, target, button, function (result) {
        renderPreview(target, result);
      });
    }
    button.disabled = true;
    target.hidden = false;
    target.innerHTML = '<p class="preview__pending">Fetching…</p>';

    return fetchJson('/api/sources/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (result) {
      renderPreview(target, result);
    }).catch(function (error) {
      renderPreview(target, { error: error.message, count: 0 });
    }).finally(function () {
      button.disabled = false;
    });
  }

  function submitSourceToolJob(kind, payload, target, button, onComplete) {
    if (!state.adminToken) {
      toast('error', 'Enter the owner token first.');
      return Promise.reject(new Error('Owner token required'));
    }
    button.disabled = true;
    target.hidden = false;
    target.innerHTML = '<p class="preview__pending">Queueing with GitHub Actions…</p>';
    return fetchJson('/api/admin/jobs', {
      admin: true, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: kind, payload: payload })
    }).then(function (job) {
      var sourceName = target.classList.contains('srow__result') ? payload.name : '';
      state.sourceToolJob = { id: job.id, kind: kind, target: target,
        button: button, onComplete: onComplete, delay: 1500, sourceName: sourceName };
      writeJson('hs.sourceToolJob', { id: job.id, kind: kind, sourceName: sourceName });
      renderSourceToolPending(target, job);
      scheduleSourceToolPoll();
      return job;
    }).catch(function (error) {
      var failedId = error.body && error.body.id;
      target.innerHTML = '<p class="preview__fail">' + icon('alert', '') +
        escapeHtml(error.message) + '</p>' + (failedId
          ? '<button type="button" class="btn btn--outline btn--sm" data-job-retry="' +
            escapeHtml(failedId) + '" data-job-kind="' + escapeHtml(kind) + '">Retry job</button>'
          : '');
      return null;
    }).finally(function () {
      if (!state.sourceToolJob || state.sourceToolJob.button !== button) button.disabled = false;
    });
  }

  function renderSourceToolPending(target, job) {
    target.hidden = false;
    target.innerHTML = '<p class="preview__pending">' +
      (job.state === 'running' ? 'Testing source…' :
       'Queued. GitHub Actions may take a few minutes to start…') + '</p>';
  }

  function scheduleSourceToolPoll() {
    if (!state.sourceToolJob || state.sourceToolTimer || document.hidden) return;
    state.sourceToolTimer = setTimeout(pollSourceToolJob, state.sourceToolJob.delay || 1500);
  }

  function pollSourceToolJob() {
    state.sourceToolTimer = null;
    var active = state.sourceToolJob;
    if (!active || document.hidden || !state.adminToken) return;
    fetchJson('/api/admin/jobs/' + encodeURIComponent(active.id), { admin: true })
      .then(function (job) {
        if (!state.sourceToolJob || state.sourceToolJob.id !== job.id) return;
        if (job.state === 'queued' || job.state === 'running') {
          renderSourceToolPending(active.target, job);
          active.delay = Math.min((active.delay || 1500) * 1.7, 10000);
          scheduleSourceToolPoll();
          return;
        }
        if (active.button) active.button.disabled = false;
        if (job.state === 'completed' && job.result) {
          active.onComplete(job.result);
          writeJson('hs.sourceToolJob', { id: job.id, kind: active.kind,
            completed: true });
        } else {
          active.target.innerHTML = '<p class="preview__fail">' + icon('alert', '') +
            escapeHtml(job.error || 'Source tool failed') + '</p>' +
            '<button type="button" class="btn btn--outline btn--sm" data-job-retry="' +
            escapeHtml(job.id) + '" data-job-kind="' + escapeHtml(active.kind) + '">Retry job</button>';
          writeJson('hs.sourceToolJob', { id: job.id, kind: active.kind,
            failed: true });
        }
        state.sourceToolJob = null;
      }).catch(function (error) {
        active.target.innerHTML = '<p class="preview__fail">' + icon('alert', '') +
          escapeHtml(error.message) + '</p>';
        active.delay = Math.min((active.delay || 1500) * 2, 10000);
        scheduleSourceToolPoll();
      });
  }

  function resumeStoredSourceToolJob() {
    if (state.sourceToolJob || !state.adminToken) return;
    var saved = readJson('hs.sourceToolJob', null);
    if (!saved || !saved.id || saved.completed || saved.failed) return;
    var row = saved.sourceName && el.sourceList.querySelector(
      '.srow[data-name="' + cssEscape(saved.sourceName) + '"]');
    var target = saved.kind === 'discover' ? el.sourceDiscovery
      : (row ? row.querySelector('.srow__result') : el.testPreview);
    state.sourceToolJob = {
      id: saved.id, kind: saved.kind, target: target,
      button: saved.kind === 'discover' ? el.discoverSourceBtn
        : (row ? row.querySelector('[data-src-act="test"]') : el.testSourceBtn),
      onComplete: saved.kind === 'discover' ? renderDiscovery : function (result) {
        renderPreview(target, result);
      }, delay: 500, sourceName: saved.sourceName || ''
    };
    renderSourceToolPending(target, { state: 'queued' });
    scheduleSourceToolPoll();
  }

  el.sourcesDialog.addEventListener('click', function (event) {
    var retry = event.target.closest('[data-job-retry]');
    if (!retry) return;
    var target = retry.closest('.discovery, .preview, .srow__result') || el.testPreview;
    var retryRow = retry.closest('.srow');
    var sourceName = retryRow ? retryRow.dataset.name : '';
    retry.disabled = true;
    fetchJson('/api/admin/jobs/' + encodeURIComponent(retry.dataset.jobRetry) + '/retry', {
      admin: true, method: 'POST'
    }).then(function (job) {
      state.sourceToolJob = {
        id: job.id, kind: retry.dataset.jobKind, target: target, button: null,
        onComplete: retry.dataset.jobKind === 'discover' ? renderDiscovery : function (result) {
          renderPreview(target, result);
        }, delay: 1500, sourceName: sourceName
      };
      writeJson('hs.sourceToolJob', { id: job.id, kind: retry.dataset.jobKind,
        sourceName: sourceName });
      renderSourceToolPending(target, job);
      scheduleSourceToolPoll();
    }).catch(function (error) {
      toast('error', error.message);
      retry.disabled = false;
    });
  });

  /* == Toasts ============================================================== */

  function toast(kind, message, undo) {
    var node = document.createElement('div');
    node.className = 'card toast toast--' + kind;
    node.innerHTML = icon(kind === 'success' ? 'check' : 'alert', '') +
                     '<span>' + escapeHtml(message) + '</span>';

    if (undo) {
      var button = document.createElement('button');
      button.className = 'btn btn--ghost btn--sm toast__undo';
      button.textContent = 'Undo';
      button.addEventListener('click', function () {
        undo();
        node.remove();
      });
      node.appendChild(button);
      node.style.pointerEvents = 'auto';
    }

    el.toasts.appendChild(node);

    setTimeout(function () {
      node.dataset.leaving = 'true';
      setTimeout(function () { node.remove(); }, 200);
    }, undo ? 6000 : 3600);
  }

  /* == Theme =============================================================== */

  var THEMES = ['light', 'dark'];

  // No usable stored choice — nothing yet, or the retired 'system' — opens in
  // whichever theme the machine asks for. The button owns it from then on.
  function storedTheme() {
    var stored = readPref('hs.theme', '');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(preference) {
    var resolved = preference === 'dark' ? 'dark' : 'light';

    document.documentElement.dataset.theme = resolved;
    el.themeIcon.innerHTML = '<use href="#i-' +
      (resolved === 'dark' ? 'moon' : 'sun') + '"/>';
    el.themeBtn.setAttribute('aria-label', 'Colour theme: ' + resolved +
      '. Click for ' + THEMES[(THEMES.indexOf(resolved) + 1) % THEMES.length] + '.');
    el.themeBtn.title = 'Theme: ' + resolved;
    writePref('hs.theme', resolved);
  }

  // Same swap, wrapped in a circular wipe out of the control that caused it.
  // Only the click path animates: the initial paint has no origin to open
  // from, and no gesture to explain the motion.
  function switchTheme(preference, origin) {
    if (!document.startViewTransition ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      applyTheme(preference);
      return;
    }

    var root = document.documentElement;
    var box = origin.getBoundingClientRect();
    var x = box.left + box.width / 2;
    var y = box.top + box.height / 2;

    root.style.setProperty('--theme-x', x + 'px');
    root.style.setProperty('--theme-y', y + 'px');
    // Reach the furthest corner, or the circle stops short of the page.
    root.style.setProperty('--theme-r', Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    ) + 'px');

    root.dataset.themeSwitching = 'true';
    document.startViewTransition(function () {
      applyTheme(preference);
    }).finished.then(clear, clear);

    function clear() { delete root.dataset.themeSwitching; }
  }

  /* == URL and selectors =================================================== */

  function readParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (error) {
      return null;
    }
  }

  function syncUrl() {
    try {
      var params = new URLSearchParams();
      params.set('view', state.view);
      if (state.source) params.set('source', state.source);
      if (state.category) params.set('category', state.category);
      if (state.minScore) params.set('min_score', String(state.minScore));
      history.replaceState(null, '', window.location.pathname + '?' + params);
    } catch (error) { /* older browser: the URL just stays put */ }
  }

  function checkRadios(container, attribute, value) {
    Array.prototype.forEach.call(container.children, function (button) {
      var checked = button.dataset[attribute] === String(value);
      button.setAttribute('aria-checked', checked ? 'true' : 'false');
      button.tabIndex = checked ? 0 : -1;
    });
  }

  // Anything that changes which headlines qualify puts the feed back on its
  // first page: a reader who has just narrowed the list did not ask to stay
  // eight pages deep in the one they narrowed away.
  function resetPaging() {
    state.limit = FEED_PAGE;
  }

  function selectScore(score, options) {
    if (SCORE_FLOORS.indexOf(score) === -1) score = 0;
    state.minScore = score;
    resetPaging();
    writePref('hs.minScore', String(score));
    checkRadios(el.scoreSwitch, 'score', score);
    syncUrl();
    if (!options || !options.quiet) render();
  }

  // The drawer tabs overlap, so stacking is part of the state: the open one
  // sits on top and the rest step down from left to right.
  function syncViewTabs(view) {
    var depth = 3;
    Array.prototype.forEach.call(el.viewSwitch.children, function (tab) {
      var current = tab.dataset.view === view;
      if (current) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
      tab.style.zIndex = current ? 5 : Math.max(depth--, 1);
    });

    // On a narrow screen the tabs scroll sideways; keep the open one in view.
    var strip = el.viewSwitch;
    var open = strip.querySelector('[aria-current]');
    if (open && strip.scrollWidth > strip.clientWidth) {
      var offset = open.getBoundingClientRect().left - strip.getBoundingClientRect().left;
      strip.scrollLeft += offset - (strip.clientWidth - open.offsetWidth) / 2;
    }
  }

  function selectView(view, options) {
    view = VIEW_ALIASES[view] || view;
    if (VIEWS.indexOf(view) === -1) view = 'today';
    state.view = view;
    state.expandedId = null;
    resetPaging();
    writePref('hs.view', view);
    syncViewTabs(view);
    syncUrl();
    if (!options || !options.quiet) render();
  }

  function setFilter(kind, value) {
    if (kind === 'source') state.source = state.source === value ? '' : value;
    if (kind === 'category') state.category = state.category === value ? '' : value;
    resetPaging();
    syncUrl();
    render();
  }

  function dropFilter(kind) {
    if (kind === 'all') {
      state.source = '';
      state.category = '';
      state.query = '';
      el.search.value = '';
      selectScore(0, { quiet: true });
    }
    if (kind === 'query') { state.query = ''; el.search.value = ''; }
    if (kind === 'score') selectScore(0, { quiet: true });
    if (kind === 'source') state.source = '';
    if (kind === 'category') state.category = '';
    resetPaging();
    syncUrl();
    render();
  }

  /* == Wiring ============================================================== */

  function debounce(fn, wait) {
    var timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  // Radiogroups owe the keyboard arrow keys and Home/End, not just clicks.
  function wireSegment(container, attribute, onSelect) {
    container.addEventListener('click', function (event) {
      var button = event.target.closest('[data-' + attribute + ']');
      if (button && container.contains(button)) onSelect(button.dataset[attribute], button);
    });

    container.addEventListener('keydown', function (event) {
      var items = Array.prototype.slice.call(container.children);
      var index = items.indexOf(document.activeElement);
      if (index === -1) return;

      var next = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else return;

      event.preventDefault();
      var target = items[(next + items.length) % items.length];
      target.focus();
      onSelect(target.dataset[attribute], target);
    });
  }

  wireSegment(el.scoreSwitch, 'score', function (value) {
    selectScore(Number(value));
  });

  // The tabs are links, so a modified click still opens the view in a new
  // tab; a plain one switches in place.
  el.viewSwitch.addEventListener('click', function (event) {
    var tab = event.target.closest('[data-view]');
    if (!tab || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        event.button !== 0) return;
    event.preventDefault();
    if (tab.dataset.view !== state.view) selectView(tab.dataset.view);
  });

  el.search.addEventListener('input', debounce(function () {
    state.query = el.search.value;
    resetPaging();
    render();
  }, 120));

  el.refreshFromDialog.addEventListener('click', refresh);
  el.newPill.addEventListener('click', applyPending);
  el.helpBtn.addEventListener('click', function () { el.helpDialog.showModal(); });
  el.statusChip.addEventListener('click', function (event) {
    event.stopPropagation();
    var open = el.statusPanel.hidden;
    el.statusPanel.hidden = !open;
    el.statusChip.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  el.markReadBtn.addEventListener('click', function () {
    var articles = renderedArticles();
    var changed = 0;
    articles.forEach(function (article) {
      if (markRead(article.id, true)) changed++;
    });
    render();
    toast('success', changed
      ? plural(changed, 'headline') + ' marked read'
      : 'Everything shown was already read');
  });

  /* -- Grid delegation ---------------------------------------------------- */

  el.grid.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-act]');
    if (!trigger) return;

    var act = trigger.dataset.act;
    var rowNode = trigger.closest('[data-item][data-id]');
    var article = rowNode ? articleById(rowNode.dataset.id) : null;

    if (act === 'open') {
      // Let the browser follow the link; only the read flag is ours.
      openArticle(article, false);
      return;
    }

    event.preventDefault();

    if (act === 'expand') toggleExpanded(rowNode.dataset.id);
    else if (act === 'hide') handleHide(article);
    else if (act === 'toggle-read') {
      markRead(article.id, !isRead(article.id));
      render();
      select(article.id);
    } else if (act === 'toggle-pin') {
      togglePinned(trigger.dataset.value);
      render();
    } else if (act === 'expand-topic') toggleOpen(state.openTopics, trigger.dataset.value, 'topic-');
    else if (act === 'expand-source') toggleOpen(state.openSources, trigger.dataset.value, 'source-');
    else if (act === 'load-more') {
      state.limit += FEED_PAGE;
      render();
    } else if (act === 'filter-source') setFilter('source', trigger.dataset.value);
    else if (act === 'filter-category') setFilter('category', trigger.dataset.value);
    else if (act === 'clear-filters') dropFilter('all');
    else if (act === 'retry') load();
  });

  el.grid.addEventListener('mousedown', function (event) {
    var row = event.target.closest('[data-item][data-id]');
    if (row) select(row.dataset.id);
  });

  el.filters.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-act="drop-filter"]');
    if (trigger) dropFilter(trigger.dataset.value);
  });

  // Anchors in the category index scroll rather than jump, so the reader keeps
  // their place in the page instead of being teleported into it.
  el.catIndexNav.addEventListener('click', function (event) {
    var pin = event.target.closest('[data-act="toggle-pin"]');
    if (pin) {
      event.preventDefault();
      togglePinned(pin.dataset.value);
      render();
      return;
    }

    var link = event.target.closest('.catindex__link');
    if (!link) return;
    event.preventDefault();
    scrollToAnchor(link.getAttribute('href').slice(1));
  });

  el.jump.addEventListener('change', function () { scrollToAnchor(el.jump.value); });

  window.addEventListener('scroll', updateActiveTopic, { passive: true });

  el.themeBtn.addEventListener('click', function () {
    var current = storedTheme();
    switchTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length], el.themeBtn);
  });

  /* -- Reading tools menu ------------------------------------------------- */

  function closeMoreMenu() {
    el.moreMenu.hidden = true;
    el.moreBtn.setAttribute('aria-expanded', 'false');
  }

  el.moreBtn.addEventListener('click', function (event) {
    event.stopPropagation();
    var open = el.moreMenu.hidden;
    el.moreMenu.hidden = !open;
    el.moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  el.moreMenu.addEventListener('click', function (event) {
    // Everything left in here is an errand -- it runs once and it is done --
    // so any click dismisses the menu on its way out.
    closeMoreMenu();

    var transfer = event.target.closest('[data-state]');
    if (transfer) {
      if (transfer.dataset.state === 'import') el.stateFile.click();
      else downloadReadingState();
      return;
    }

    var trigger = event.target.closest('[data-export]');
    if (!trigger) return;

    var articles = renderedArticles();
    var text = trigger.dataset.export === 'markdown'
      ? articles.map(function (a) {
          return '- [' + a.title + '](' + a.link + ') — ' + a.source +
                 ' (' + scoreOf(a) + ')';
        }).join('\n')
      : articles.map(function (a) { return a.link; }).join('\n');

    if (!navigator.clipboard) {
      toast('error', 'Clipboard is unavailable in this browser.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      toast('success', plural(articles.length, 'link') + ' copied');
    }).catch(function () {
      toast('error', 'Could not write to the clipboard.');
    });
  });

  function downloadReadingState() {
    var blob = new Blob([JSON.stringify(readingStateDocument(), null, 2)],
      { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'high-signal-reading-state.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('success', plural(store.read.length, 'read headline') + ' and ' +
      plural(store.hidden.length, 'hidden headline') + ' saved to a file');
  }

  el.stateFile.addEventListener('change', function () {
    var file = el.stateFile.files && el.stateFile.files[0];
    if (!file) return;
    // Reset first: choosing the same file twice should still fire a change.
    el.stateFile.value = '';
    if (file.size > 8 * 1024 * 1024) {
      toast('error', 'That file is too large to be a reading state export.');
      return;
    }
    file.text().then(function (text) {
      var added = mergeReadingState(JSON.parse(text));
      var counts = [
        added.read ? plural(added.read, 'read headline') : '',
        added.hidden ? plural(added.hidden, 'hidden headline') : '',
        added.pinned ? plural(added.pinned, 'pinned category') : ''
      ].filter(Boolean);
      render();
      toast('success', counts.length
        ? 'Merged ' + counts.join(', ')
        : 'That file held nothing this browser did not already have');
    }).catch(function (error) {
      toast('error', error instanceof SyntaxError
        ? 'That file is not valid JSON.'
        : error.message || 'Could not read that file.');
    });
  });

  document.addEventListener('click', function (event) {
    if (!el.moreMenu.hidden && !event.target.closest('.menu')) closeMoreMenu();
    if (!el.statusPanel.hidden && !event.target.closest('.status')) closeStatusPanel();
  });

  /* -- Dialogs ------------------------------------------------------------ */

  [el.sourcesDialog, el.helpDialog].forEach(function (dialog) {
    dialog.addEventListener('click', function (event) {
      if (event.target.closest('[data-close]')) dialog.close();
      // A click on the backdrop lands on the dialog element itself.
      if (event.target === dialog) dialog.close();
    });
  });

  el.adminToken.addEventListener('input', debounce(function () {
    state.adminToken = el.adminToken.value.trim();
    state.adminSources = {};
    if (!state.adminToken) {
      el.adminStatus.textContent = hostedSourceMode()
        ? 'Public source health is visible. Owner actions require the token for this session.'
        : 'Local source controls do not require an owner token.';
      renderSourceList();
      return;
    }
    loadAdminSources().catch(function () {});
  }, 250));

  el.sourceList.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-src-act]');
    if (!trigger) return;

    var rowNode = trigger.closest('.srow');
    var name = rowNode.dataset.name;
    var config = sourceConfig(name);
    if (!config) return;

    var act = trigger.dataset.srcAct;
    if (!canManageSources()) {
      toast('error', 'Enter the owner token first.');
      return;
    }

    if (act === 'test') {
      var target = rowNode.querySelector('.srow__result');
      testSource({
        name: name, url: config.url, selector: config.selector,
        fallback: config.fallback, tier: config.tier, category: config.category,
        type: config.type, feed_url: config.feed_url,
        fetch_strategies: config.fetch_strategies,
        retention_hours: config.retention_hours,
        allow_empty: config.allow_empty,
        allowed_hosts: config.allowed_hosts,
        path_prefixes: config.path_prefixes
      }, target, trigger);
      return;
    }

    if (act === 'toggle') {
      var enable = trigger.getAttribute('aria-pressed') !== 'true';
      var toggleUrl = hostedSourceMode()
        ? '/api/admin/sources/' + encodeURIComponent(config.id)
        : '/api/sources/' + encodeURIComponent(name);
      fetchJson(toggleUrl, {
        admin: hostedSourceMode(),
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hostedSourceMode()
          ? { revision: config.revision, changes: { enabled: enable } }
          : { enabled: enable })
      }).then(function () {
        return hostedSourceMode() ? loadAdminSources() : fetchJson('/api/sources').then(applyHealth);
      }).then(function () {
        renderSourceList(name);
        render();
        toast('success', name + (enable ? ' enabled' : ' disabled'));
      }).catch(function (error) {
        toast('error', error.message);
      });
      return;
    }

    if (act === 'delete') {
      if (!window.confirm('Remove "' + name + '" from shared sources?')) return;
      var deleteUrl = hostedSourceMode()
        ? '/api/admin/sources/' + encodeURIComponent(config.id)
        : '/api/sources/' + encodeURIComponent(name);
      fetchJson(deleteUrl, {
        admin: hostedSourceMode(), method: 'DELETE',
        headers: hostedSourceMode() ? { 'Content-Type': 'application/json' } : {},
        body: hostedSourceMode() ? JSON.stringify({ revision: config.revision }) : undefined
      })
        .then(function () {
          return hostedSourceMode() ? loadAdminSources() : fetchJson('/api/sources').then(applyHealth);
        })
        .then(function () {
          renderSourceList();
          render();
          toast('success', name + ' removed');
        }).catch(function (error) {
          toast('error', error.message);
        });
    }
  });

  function addSourcePayload() {
    var data = new FormData(el.addSourceForm);
    var payload = {};
    ['name', 'url', 'selector', 'fallback', 'tier', 'category', 'type', 'feed_url'].forEach(function (key) {
      payload[key] = (data.get(key) || '').toString().trim();
    });
    return payload;
  }

  el.discoverSourceBtn.addEventListener('click', function () {
    var payload = addSourcePayload();
    if (!payload.url) {
      toast('error', 'Add a URL first.');
      return;
    }
    discoverSource(payload, el.discoverSourceBtn);
  });

  el.testSourceBtn.addEventListener('click', function () {
    var payload = addSourcePayload();
    if (!payload.url) {
      toast('error', 'Add a URL first.');
      return;
    }
    testSource(payload, el.testPreview, el.testSourceBtn);
  });

  el.sourceDiscovery.addEventListener('click', function (event) {
    var button = event.target.closest('[data-candidate-pick]');
    if (!button) return;
    selectedCandidate = Number(button.dataset.candidatePick);
    applyCandidate(sourceCandidates[selectedCandidate]);
  });

  el.addSourceForm.elements.url.addEventListener('input', function () {
    resetDiscovery();
    el.testPreview.hidden = true;
  });

  [el.sourceSelector, el.sourceFallback].forEach(function (input) {
    input.addEventListener('input', function () {
      el.sourceType.value = 'static';
      el.sourceFeedUrl.value = '';
    });
  });

  el.addSourceForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var payload = addSourcePayload();

    if (!canManageSources()) {
      toast('error', 'Enter the owner token first.');
      return;
    }
    fetchJson(hostedSourceMode() ? '/api/admin/sources' : '/api/sources', {
      admin: hostedSourceMode(),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function () {
      el.addSourceForm.reset();
      resetDiscovery();
      el.testPreview.hidden = true;
      el.addSource.open = false;
      return hostedSourceMode() ? loadAdminSources() : fetchJson('/api/sources').then(applyHealth);
    }).then(function () {
      renderSourceList(payload.name);
      toast('success', payload.name + ' added — it will appear after the next scrape');
    }).catch(function (error) {
      toast('error', error.message);
    });
  });

  /* -- Keyboard ----------------------------------------------------------- */

  function isTyping(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
                      target.tagName === 'SELECT' || target.isContentEditable);
  }

  document.addEventListener('keydown', function (event) {
    // A modal <dialog> handles its own Escape; stepping on it here would also
    // collapse the row behind the dialog.
    if (el.sourcesDialog.open || el.helpDialog.open) return;

    if (event.key === 'Escape') {
      if (!el.moreMenu.hidden) { closeMoreMenu(); return; }
      if (!el.statusPanel.hidden) { closeStatusPanel(); el.statusChip.focus(); return; }
      if (document.activeElement === el.search) {
        el.search.value = '';
        state.query = '';
        resetPaging();
        render();
        el.search.blur();
      } else if (state.expandedId) {
        state.expandedId = null;
        render();
      }
      return;
    }

    if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

    var article = selectedArticle();

    switch (event.key) {
      case 'j': event.preventDefault(); moveSelection(1); break;
      case 'k': event.preventDefault(); moveSelection(-1); break;
      case 'o':
      case 'Enter':
        if (article) { event.preventDefault(); openArticle(article, true); }
        break;
      case ' ':
        if (article) { event.preventDefault(); toggleExpanded(article.id); }
        break;
      case 'm':
        if (article) {
          event.preventDefault();
          markRead(article.id, !isRead(article.id));
          render();
          select(article.id);
        }
        break;
      case 'x':
        if (article) { event.preventDefault(); handleHide(article); }
        break;
      case '/':
        event.preventDefault();
        el.search.focus();
        el.search.select();
        break;
      case '?':
        event.preventDefault();
        el.helpDialog.showModal();
        break;
      case '1': selectView('today'); break;
      case '2': selectView('latest'); break;
      case '3': selectView('topics'); break;
      case '4': selectView('sources'); break;
      default: break;
    }
  });

  /* == Boot ================================================================ */

  applyTheme(storedTheme());

  // Read every stored and linked preference before applying any of them: each
  // selector rewrites the URL, which would clobber the others mid-boot.
  var boot = {
    view: readParam('view') || readPref('hs.view', 'today'),
    score: Number(readParam('min_score') || readPref('hs.minScore', '0')) || 0,
    source: readParam('source') || '',
    category: readParam('category') || ''
  };

  state.source = boot.source;
  state.category = boot.category;

  selectView(boot.view, { quiet: true });
  selectScore(boot.score, { quiet: true });

  // Stamp the visit on the way out, not on the way in, so the tags are there
  // for as long as the reader is.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stampVisit();
  });
  window.addEventListener('pagehide', stampVisit);

  load().catch(function () {});

  setInterval(function () {
    if (!document.hidden) load({ silent: true }).catch(function () {});
  }, POLL_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      load({ silent: true }).catch(function () {});
      scheduleSourceToolPoll();
    }
  });
  setInterval(function () {
    if (state.status === 'ready') { renderDateline(); renderStatus(); }
  }, 20000);
})();
