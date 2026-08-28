/* ---------------------------------------------------------------------------
   High Signal dashboard.

   Four layouts over one corpus:

     feed        every source merged into a single stream, one headline per line
     sources     a panel per source, including the ones that are failing
     categories  a panel per category
     saved       the reading list, stored locally as snapshots

   The whole corpus is a few hundred headlines, so it is fetched once from
   /api/feed and every filter (score threshold, text query, source, category,
   unread) plus both groupings run client-side. That keeps switching views and
   filtering instant. Only the feed's order comes from the server, because
   ordering is the one thing the server can express better than the client (see
   /api/feed?sort=).

   Three things live only in the browser, because they are per-person and the
   server has no accounts: read state, the reading list, and hidden headlines.
   All three are snapshots or id sets in localStorage, capped so they cannot
   grow without bound.

   Scores are rule-based and arrive with their own arithmetic attached
   (`score_reasons`), which is what the expanded row renders. Nothing about the
   number is hidden from the reader.
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  var POLL_MS = 60000;
  var JOB_POLL_MS = 1500;
  var VIEWS = ['feed', 'sources', 'categories', 'saved'];
  var SORTS = ['score', 'recent', 'mixed'];
  var UNCATEGORIZED = 'Other';
  var READ_CAP = 4000;
  var HIDDEN_CAP = 1000;
  var SAVED_CAP = 500;

  var KNOWN_CATEGORIES = [
    'Security', 'Policy & Regulation', 'Funding & M&A', 'Chips & Hardware',
    'Crypto & Fintech', 'Science & Space', 'AI Research', 'Models & Releases',
    'AI Tools & Agents', 'Engineering & Open Source', 'Big Tech',
    'Business & Markets', 'Other'
  ];

  var state = {
    articles: [],
    pending: null,          // fetched but withheld so the list never jumps
    pendingCount: 0,
    stats: null,
    health: null,
    thresholds: { high: 75, mid: 60 },
    view: 'feed',
    sort: 'score',
    minScore: 0,
    query: '',
    source: '',
    category: '',
    unreadOnly: false,
    status: 'loading',      // loading | ready | error
    pollFailures: 0,
    lastSync: null,
    nextSync: null,
    selectedId: null,
    expandedId: null,
    job: null,
    jobTimer: null
  };

  var el = {};
  [
    'grid', 'search', 'scoreSwitch', 'viewSwitch', 'sortSwitch', 'refreshBtn',
    'themeBtn', 'clearBtn', 'resultCount', 'lastUpdated', 'toasts', 'nextSync',
    'statusDot', 'healthBtn', 'healthCount', 'sourcesBtn', 'helpBtn',
    'progress', 'progressBar', 'progressLabel', 'banner', 'bannerText',
    'bannerAction', 'filters', 'newPill', 'unreadBtn', 'exportBtn',
    'exportMenu', 'markReadBtn', 'sourcesDialog', 'helpDialog', 'sourceList',
    'sourcesSummary', 'addSource', 'addSourceForm', 'discoverSourceBtn',
    'testSourceBtn', 'testPreview', 'sourceDiscovery', 'sourceType',
    'sourceFeedUrl', 'sourceSelector', 'sourceFallback', 'categorySelect',
    'refreshFromDialog'
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

  // Read, saved and hidden are per-person and the server has no accounts, so
  // they live here. Ids are kept newest-first and truncated, which bounds the
  // storage without a migration.
  var store = {
    read: readJson('hs.read', []),
    saved: readJson('hs.saved', []),
    hidden: readJson('hs.hidden', [])
  };

  var readIndex = {};
  store.read.forEach(function (id) { readIndex[id] = true; });
  var hiddenIndex = {};
  store.hidden.forEach(function (id) { hiddenIndex[id] = true; });
  var savedIndex = {};
  store.saved.forEach(function (item) { savedIndex[item.id] = item; });

  function isRead(id) { return readIndex[id] === true; }
  function isSaved(id) { return savedIndex[id] !== undefined; }
  function isHidden(id) { return hiddenIndex[id] === true; }

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

  // Saved items are stored as snapshots, not ids: a reading list that empties
  // itself when the source drops off the front page is not a reading list.
  function toggleSaved(article) {
    if (isSaved(article.id)) {
      delete savedIndex[article.id];
      store.saved = store.saved.filter(function (item) { return item.id !== article.id; });
    } else {
      var snapshot = {
        id: article.id,
        title: article.title,
        link: article.link,
        source: article.source,
        category: categoryOf(article),
        signal_score: scoreOf(article),
        score_reasons: article.score_reasons || [],
        summary: article.summary || '',
        summary_source: article.summary_source || '',
        published: article.published || null,
        published_precision: article.published_precision || null,
        first_seen: article.first_seen || article.timestamp || null,
        also_in: article.also_in || [],
        saved_at: new Date().toISOString()
      };
      savedIndex[article.id] = snapshot;
      store.saved.unshift(snapshot);
      store.saved = store.saved.slice(0, SAVED_CAP);
    }
    writeJson('hs.saved', store.saved);
    return isSaved(article.id);
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

  function relativeFuture(date) {
    if (!date) return '—';
    var minutes = Math.round((date.getTime() - Date.now()) / 60000);
    if (minutes <= 0) return 'any moment';
    if (minutes < 60) return 'in ' + plural(minutes, 'min');
    return 'in ' + plural(Math.round(minutes / 60), 'hr');
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
    return state.view === 'saved' ? store.saved : state.articles;
  }

  // The query matches the source name as well as the title, so typing
  // "techmeme" narrows the feed to one source without leaving the flat view.
  function visibleArticles() {
    var query = state.query.trim().toLowerCase();
    var savedView = state.view === 'saved';

    return corpus().filter(function (article) {
      if (!savedView && isHidden(article.id)) return false;
      if (scoreOf(article) < state.minScore) return false;
      if (state.source && article.source !== state.source) return false;
      if (state.category && categoryOf(article) !== state.category) return false;
      if (state.unreadOnly && isRead(article.id)) return false;
      if (!query) return true;
      return String(article.title || '').toLowerCase().indexOf(query) !== -1 ||
             String(article.source || '').toLowerCase().indexOf(query) !== -1;
    });
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
    return savedIndex[id] || null;
  }

  function activeFilters() {
    var pills = [];
    if (state.query.trim()) pills.push({ kind: 'query', label: '“' + state.query.trim() + '”' });
    if (state.minScore) pills.push({ kind: 'score', label: 'score ' + state.minScore + '+' });
    if (state.source) pills.push({ kind: 'source', label: state.source });
    if (state.category) pills.push({ kind: 'category', label: state.category });
    if (state.unreadOnly) pills.push({ kind: 'unread', label: 'unread only' });
    return pills;
  }

  function isFiltered() {
    return activeFilters().length > 0;
  }

  /* == Rendering =========================================================== */

  function icon(name, className) {
    return '<svg class="' + className + '" viewBox="0 0 24 24" aria-hidden="true">' +
           '<use href="#i-' + name + '"/></svg>';
  }

  // Per-row controls are deliberately out of the tab sequence. With a few
  // hundred rows, six tab stops each would put the toolbar hundreds of presses
  // away; the keyboard reaches these through j/k plus s, x and Space instead,
  // and the search box filters by source name for the same effect as a chip.
  function chip(text, modifier, action) {
    var tag = action ? 'button' : 'span';
    var attrs = action
      ? ' type="button" tabindex="-1" data-act="' + action + '" data-value="' +
        escapeHtml(text) + '" title="Filter to ' + escapeHtml(text) + '"'
      : '';
    return '<' + tag + ' class="chip' + (modifier ? ' chip--' + modifier : '') +
           (action ? ' chip--action' : '') + '"' + attrs + '>' +
           escapeHtml(text) + '</' + tag + '>';
  }

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
        '<button type="button" class="btn btn--outline btn--sm" data-act="save">' +
        icon(isSaved(article.id) ? 'bookmark-on' : 'bookmark', '') +
        (isSaved(article.id) ? 'Saved' : 'Save') + '</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="toggle-read">' +
        (isRead(article.id) ? 'Mark unread' : 'Mark read') + '</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="filter-source"' +
        ' data-value="' + escapeHtml(article.source) + '">Only this source</button>' +
      '</div>' +
    '</div>';
  }

  // A row carries whatever context its surroundings do not. Inside a source
  // panel the header already names the source, so there is none; a category
  // panel adds the source under the title; the flat feed adds source and
  // category to the right of the title, which keeps every row one line tall.
  function renderRow(article, query, options) {
    var opts = options || {};
    var score = scoreOf(article);
    var age = ageOf(article);
    var id = escapeHtml(article.id);
    var expanded = state.expandedId === article.id;
    var saved = isSaved(article.id);

    var title = '<span class="row__title">' + highlight(article.title, query) + '</span>';
    var body = opts.meta
      ? '<span class="row__main">' + title + '<span class="row__meta">' + opts.meta + '</span></span>'
      : title;

    return '<li class="row' + (opts.className ? ' ' + opts.className : '') + '"' +
      ' data-id="' + id + '"' +
      ' data-read="' + (isRead(article.id) ? 'true' : 'false') + '"' +
      ' data-saved="' + (saved ? 'true' : 'false') + '"' +
      (state.selectedId === article.id ? ' data-selected="true"' : '') + '>' +
      '<div class="row__line">' +
        '<button type="button" class="badge badge--sm badge--' + scoreTone(score) +
        ' row__score" data-act="expand" aria-expanded="' + (expanded ? 'true' : 'false') +
        '" title="Signal score ' + score + ' — click for the breakdown">' + score + '</button>' +
        '<a class="row__link" href="' + escapeHtml(safeUrl(article.link)) + '"' +
        ' target="_blank" rel="noopener noreferrer" data-act="open">' + body + '</a>' +
        (opts.tags ? '<span class="row__tags">' + opts.tags + '</span>' : '') +
        (age.text
          ? '<span class="row__age' + (age.estimated ? ' row__age--est' : '') +
            '" title="' + escapeHtml(age.title) + '">' + escapeHtml(age.text) + '</span>'
          : '') +
        '<span class="row__icons">' +
          iconButton('save', saved ? 'bookmark-on' : 'bookmark',
                     saved ? 'Remove from saved' : 'Save for later', saved) +
          iconButton('hide', 'x', 'Hide this headline') +
        '</span>' +
      '</div>' +
      (expanded ? renderDetail(article) : '') +
    '</li>';
  }

  function feedTags(article) {
    var also = (article.also_in || []).length;
    return chip(article.source, 'source', 'filter-source') +
      chip(categoryOf(article), 'category', 'filter-category') +
      (also ? '<span class="chip chip--also" title="' +
        escapeHtml((article.also_in || []).join(', ')) + '">+' + also + '</span>' : '');
  }

  function renderFeed(articles, query) {
    // Day headers only earn their space when the list is actually in date
    // order; in score order they would cut the ranking into arbitrary blocks.
    var grouped = state.sort === 'recent' && state.view === 'feed';
    var html = '';
    var currentDay = null;

    articles.forEach(function (article) {
      if (grouped) {
        var day = dayBucket(ageOf(article).date);
        if (day !== currentDay) {
          if (currentDay !== null) html += '</ol></section>';
          html += '<section class="daygroup"><h2 class="daygroup__title">' +
                  escapeHtml(day) + '</h2><ol class="card feed">';
          currentDay = day;
        }
      }
      html += renderRow(article, query, {
        tags: feedTags(article),
        className: 'row--feed'
      });
    });

    if (grouped) return currentDay === null ? '' : html + '</ol></section>';
    return '<ol class="card feed">' + html + '</ol>';
  }

  function renderPanel(group, query, showSource) {
    var high = group.articles.filter(function (a) {
      return scoreOf(a) >= state.thresholds.high;
    }).length;
    var share = Math.round((high / group.articles.length) * 100);
    var name = escapeHtml(group.name);
    var sub = showSource
      ? plural(distinct(group.articles, function (a) { return a.source; }), 'source')
      : '';

    return '<section class="card panel">' +
      '<header class="panel__header">' +
        (group.health ? '<span class="dot dot--' + group.health + '" title="' +
          escapeHtml(healthLabel(group.health)) + '"></span>' : '') +
        '<h2 class="panel__title" title="' + name + '">' + name + '</h2>' +
        (sub ? '<span class="panel__sub">' + escapeHtml(sub) + '</span>' : '') +
        '<span class="badge badge--sm">' + group.articles.length + '</span>' +
        '<span class="panel__meter" style="width:' + share + '%"' +
        ' title="' + share + '% score ' + state.thresholds.high + ' or above"></span>' +
      '</header>' +
      '<ul class="panel__body" data-group="' + name + '">' +
        group.articles.map(function (article) {
          return renderRow(article, query, {
            meta: showSource ? chip(article.source, 'source', 'filter-source') : null
          });
        }).join('') +
      '</ul>' +
    '</section>';
  }

  // A source that fetched fine but matched nothing, or errored outright, gets a
  // card of its own. The old dashboard simply omitted it, so a broken selector
  // was indistinguishable from a quiet news day.
  function renderBrokenPanel(row) {
    var detail = row.state === 'empty'
      ? 'The page loaded but no headline matched the selector.'
      : (row.error || 'The fetch failed.');
    var since = row.last_success
      ? 'Last worked ' + relativePast(parseDate(row.last_success)).replace('updated ', '')
      : 'Never returned a headline';

    return '<section class="card panel panel--broken">' +
      '<header class="panel__header">' +
        '<span class="dot dot--' + row.state + '"></span>' +
        '<h2 class="panel__title" title="' + escapeHtml(row.name) + '">' +
        escapeHtml(row.name) + '</h2>' +
        '<span class="badge badge--sm badge--red">' +
        escapeHtml(row.state === 'empty' ? 'no match' : 'error') + '</span>' +
      '</header>' +
      '<div class="panel__broken">' +
        '<p>' + escapeHtml(detail) + '</p>' +
        '<p class="panel__since">' + escapeHtml(since) +
        (row.http_status ? ' · HTTP ' + row.http_status : '') + '</p>' +
        '<button type="button" class="btn btn--outline btn--sm" data-act="manage-source"' +
        ' data-value="' + escapeHtml(row.name) + '">Fix this source</button>' +
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
    for (var r = 0; r < 5; r++) {
      rows += '<div class="skeleton-row">' +
        '<span class="skeleton" style="width:2.125rem;height:1.25rem;border-radius:9999px"></span>' +
        '<span class="skeleton" style="flex:1;height:0.75rem"></span>' +
      '</div>';
    }

    if (state.view === 'feed' || state.view === 'saved') {
      var feed = '';
      for (var f = 0; f < 12; f++) feed += rows;
      el.grid.innerHTML = '<div class="card feed">' + feed + '</div>';
      return;
    }

    var panels = '';
    for (var p = 0; p < 6; p++) {
      panels += '<section class="card panel">' +
        '<header class="panel__header">' +
          '<span class="skeleton" style="width:40%;height:0.875rem"></span>' +
        '</header>' +
        '<div>' + rows + '</div>' +
      '</section>';
    }

    el.grid.innerHTML = panels;
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

  function captureScroll() {
    var offsets = {};
    Array.prototype.forEach.call(el.grid.querySelectorAll('.panel__body'), function (body) {
      if (body.scrollTop > 0) offsets[body.dataset.group] = body.scrollTop;
    });
    return offsets;
  }

  function restoreScroll(offsets) {
    Array.prototype.forEach.call(el.grid.querySelectorAll('.panel__body'), function (body) {
      var offset = offsets[body.dataset.group];
      if (offset) body.scrollTop = offset;
      markOverflow(body);
    });
  }

  // Flags the panel while there is still list left to scroll, which drives the
  // bottom fade in app.css.
  function markOverflow(body) {
    var remaining = body.scrollHeight - body.scrollTop - body.clientHeight;
    body.parentNode.dataset.more = remaining > 4 ? 'true' : 'false';
  }

  function renderFreshness() {
    el.lastUpdated.textContent = relativePast(state.lastSync);
    el.nextSync.textContent = state.nextSync
      ? 'next sync ' + relativeFuture(state.nextSync)
      : 'no schedule';

    var dot = 'live';
    if (state.job && state.job.state === 'running') dot = 'syncing';
    else if (state.pollFailures > 0) dot = 'offline';
    else if (state.lastSync && Date.now() - state.lastSync.getTime() > 3600000) dot = 'stale';
    el.statusDot.dataset.state = dot;
  }

  function renderBanner() {
    var message = null;
    var action = null;

    if (state.pollFailures >= 1) {
      message = 'Cannot reach the server — showing the last data we loaded. Retrying…';
      action = { label: 'Retry now', handler: function () { load({ silent: true }); } };
    } else if (state.status === 'ready' && state.lastSync &&
               Date.now() - state.lastSync.getTime() > 3600000) {
      message = 'These headlines are over an hour old. The scheduled scrape may not be running.';
      action = { label: 'Re-scrape', handler: refresh };
    } else if (state.health && state.health.failing >= 3) {
      message = plural(state.health.failing, 'source') + ' stopped returning headlines, ' +
                'so parts of the feed are missing.';
      action = { label: 'Review sources', handler: openSources };
    }

    el.banner.hidden = !message;
    if (!message) return;

    el.bannerText.textContent = message;
    el.banner.dataset.tone = state.pollFailures ? 'error' : 'warn';
    el.bannerAction.hidden = !action;
    if (action) {
      el.bannerAction.textContent = action.label;
      el.bannerAction.onclick = action.handler;
    }
  }

  function renderFilters() {
    var pills = activeFilters();
    el.filters.hidden = pills.length === 0;
    el.filters.innerHTML = pills.map(function (pill) {
      return '<button type="button" class="filter" data-act="drop-filter"' +
        ' data-value="' + pill.kind + '" title="Remove this filter">' +
        escapeHtml(pill.label) + icon('x', 'filter__x') + '</button>';
    }).join('') + (pills.length > 1
      ? '<button type="button" class="filter filter--clear" data-act="drop-filter"' +
        ' data-value="all">Clear all</button>'
      : '');
  }

  function renderCount(articles) {
    if (state.status !== 'ready') {
      el.resultCount.textContent = '';
      el.clearBtn.hidden = true;
      return;
    }

    var total = corpus().filter(function (a) {
      return state.view === 'saved' || !isHidden(a.id);
    }).length;
    var shown = articles.length;
    var scope = state.view === 'categories'
      ? plural(distinct(articles, categoryOf), 'category', 'categories')
      : plural(distinct(articles, function (a) { return a.source; }), 'source');

    el.resultCount.innerHTML = isFiltered()
      ? '<b>' + shown + '</b> of ' + total + ' headlines across <b>' + scope + '</b>'
      : '<b>' + total + '</b> headlines across <b>' + scope + '</b>';

    el.clearBtn.hidden = !isFiltered();
  }

  function render() {
    el.grid.dataset.view = state.view;
    el.sortSwitch.hidden = state.view !== 'feed';
    el.unreadBtn.setAttribute('aria-pressed', state.unreadOnly ? 'true' : 'false');

    renderFilters();
    renderBanner();

    if (state.status === 'loading') {
      renderSkeleton();
      renderCount([]);
      return;
    }

    if (state.status === 'error') {
      renderState('alert', 'Could not reach the server',
        'The dashboard could not load /api/feed. Check that the Flask app is still running.',
        'state__body--error', { act: 'retry', label: 'Try again' });
      renderCount([]);
      return;
    }

    var articles = visibleArticles();
    var query = state.query.trim();
    var offsets = captureScroll();
    var scrollY = window.scrollY;

    renderFreshness();
    renderCount(articles);

    if (!articles.length) {
      renderEmpty();
      return;
    }

    if (state.view === 'feed' || state.view === 'saved') {
      el.grid.innerHTML = renderFeed(articles, query);
      window.scrollTo(0, scrollY);
      return;
    }

    var showSource = state.view === 'categories';
    var groups = groupBy(articles, showSource ? categoryOf : function (a) { return a.source; });

    if (!showSource && state.health) {
      // Attach each panel's health so a working source and a stale one do not
      // look identical.
      var byName = {};
      state.health.sources.forEach(function (row) { byName[row.name] = row; });
      groups.forEach(function (group) {
        var row = byName[group.name];
        group.health = row ? row.state : null;
      });
    }

    var broken = '';
    if (!showSource && state.health && !isFiltered()) {
      broken = state.health.sources.filter(function (row) {
        return row.state === 'error' || row.state === 'empty';
      }).map(renderBrokenPanel).join('');
    }

    el.grid.innerHTML = groups.map(function (group) {
      return renderPanel(group, query, showSource);
    }).join('') + broken;

    restoreScroll(offsets);
    window.scrollTo(0, scrollY);
  }

  function renderEmpty() {
    if (state.view === 'saved') {
      renderState('bookmark', 'Nothing saved yet',
        'Press s on any headline, or use the bookmark button, to build a reading list. '
        + 'Saved headlines stay here even after they drop out of the feed.');
      return;
    }
    if (isFiltered()) {
      renderState('inbox', 'Nothing matches',
        'No headlines clear these filters.', '',
        { act: 'clear-filters', label: 'Clear filters' });
      return;
    }
    renderState('inbox', 'No headlines cached yet',
      'Run a scrape to pull the sources in.', '',
      { act: 'retry-scrape', label: 'Re-scrape sources' });
  }

  /* == Selection and keyboard navigation =================================== */

  function visibleIds() {
    return Array.prototype.map.call(
      el.grid.querySelectorAll('.row[data-id]'),
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
    var previous = el.grid.querySelector('.row[data-selected]');
    if (previous) previous.removeAttribute('data-selected');
    state.selectedId = id;
    var row = id && el.grid.querySelector('.row[data-id="' + cssEscape(id) + '"]');
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
    var row = el.grid.querySelector('.row[data-id="' + cssEscape(article.id) + '"]');
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

  function handleSave(article) {
    if (!article) return;
    var saved = toggleSaved(article);
    render();
    select(article.id);
    toast('success', saved ? 'Saved to reading list' : 'Removed from saved');
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
    return fetch(url, options).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; })
          .then(function (body) {
            var error = new Error(body.error || (url + ' ' + response.status));
            error.status = response.status;
            throw error;
          });
      }
      return response.json();
    });
  }

  var summaryRequests = {};

  function applySummary(article, result) {
    article.summary = result.summary || '';
    article.summary_source = result.summary_source || '';
    article.summary_error = result.summary_error || '';

    if (savedIndex[article.id]) {
      savedIndex[article.id].summary = article.summary;
      savedIndex[article.id].summary_source = article.summary_source;
      savedIndex[article.id].summary_error = article.summary_error;
      writeJson('hs.saved', store.saved);
    }
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

  // The two threshold buttons are labelled from the server's bands, so the
  // filter can never offer a cut that no longer means anything (the old 65+
  // button filtered nothing at all once every score sat above it).
  function syncScoreSwitch() {
    var bands = [0, state.thresholds.mid, state.thresholds.high];
    Array.prototype.forEach.call(el.scoreSwitch.children, function (button, index) {
      var score = bands[index];
      if (score === undefined) return;
      button.dataset.score = String(score);
      button.textContent = score ? score + '+' : 'All';
    });
    checkRadios(el.scoreSwitch, 'score', state.minScore);
  }

  function applyStats(stats) {
    state.stats = stats;
    if (stats && stats.thresholds) {
      state.thresholds = stats.thresholds;
      syncScoreSwitch();
    }
    state.lastSync = parseDate(stats && stats.last_update) || state.lastSync;
    state.nextSync = parseDate(stats && stats.next_update);
    if (stats && stats.refresh) followJob(stats.refresh);
  }

  function applyHealth(health) {
    state.health = health;
    if (!health) return;
    el.healthBtn.hidden = health.failing === 0;
    el.healthCount.textContent = plural(health.failing, 'source') + ' failing';
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

    return Promise.all([
      fetchJson('/api/feed?sort=' + encodeURIComponent(state.sort)),
      fetchJson('/api/stats').catch(function () { return null; }),
      fetchJson('/api/sources').catch(function () { return null; })
    ]).then(function (results) {
      var articles = results[0] || [];
      applyStats(results[1]);
      applyHealth(results[2]);
      state.pollFailures = 0;
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
          renderFreshness();
          renderBanner();
          return;
        }
      }

      state.articles = articles;
      state.pending = null;
      state.pendingCount = 0;
      hideNewPill();
      render();
    }).catch(function (error) {
      console.error(error);
      state.pollFailures++;
      if (silent) {
        renderFreshness();
        renderBanner();
      } else {
        state.status = 'error';
        render();
      }
      throw error;
    });
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

  function refresh() {
    el.refreshBtn.disabled = true;
    fetchJson('/api/refresh', { method: 'POST' })
      .then(function (result) {
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
      .catch(function () {
        el.refreshBtn.disabled = false;
        // A refresh that cannot even reach the server is the same connectivity
        // problem the status dot reports, so say so there too.
        state.pollFailures++;
        renderFreshness();
        renderBanner();
        toast('error', 'Could not start a scrape.');
      });
  }

  // The scrape takes minutes, so the UI follows it with a determinate bar and
  // reloads once when it finishes. This also picks up the scrape that the
  // server starts by itself on a cold boot.
  function followJob(job) {
    state.job = job;
    renderJob();

    if (!job || job.state !== 'running') {
      el.refreshBtn.disabled = false;
      if (state.jobTimer) {
        clearTimeout(state.jobTimer);
        state.jobTimer = null;
      }
      return;
    }

    el.refreshBtn.disabled = true;
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

        el.refreshBtn.disabled = false;
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
    el.refreshBtn.style.animation = running ? 'spin 1s linear infinite' : '';

    if (!running) return;

    var total = job.total || 1;
    var done = Math.min(job.done || 0, total);
    el.progressBar.style.width = Math.round((done / total) * 100) + '%';
    el.progressLabel.textContent = done + '/' + total +
      (job.source ? ' · ' + job.source : ' · finishing up');
    renderFreshness();
  }

  /* == Sources dialog ====================================================== */

  function openSources(focusName) {
    if (!el.sourcesDialog.open) el.sourcesDialog.showModal();
    renderSourceList(focusName);
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
            (row.state === 'empty' ? ' · selector matched nothing' : '') +
          '</span>' +
          (row.selector ? '<code class="srow__selector">' +
            escapeHtml(row.selector) + '</code>' : '') +
        '</div>' +
        '<div class="srow__actions">' +
          '<button type="button" class="btn btn--ghost btn--sm btn--icon" data-src-act="test"' +
          ' title="Test now" aria-label="Test ' + name + '">' + icon('play', '') + '</button>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-src-act="toggle"' +
          ' aria-pressed="' + (row.enabled ? 'true' : 'false') + '">' +
          (row.enabled ? 'On' : 'Off') + '</button>' +
          '<button type="button" class="btn btn--ghost btn--sm btn--icon" data-src-act="delete"' +
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
    var row = state.health && state.health.sources.filter(function (item) {
      return item.name === name;
    })[0];
    return row || null;
  }

  function discoverSource(payload, button) {
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

  var THEMES = ['system', 'light', 'dark'];

  function applyTheme(preference) {
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;

    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePref = preference;
    el.themeIcon.innerHTML = '<use href="#i-' +
      (preference === 'system' ? 'system' : (resolved === 'dark' ? 'moon' : 'sun')) + '"/>';
    el.themeBtn.setAttribute('aria-label', 'Colour theme: ' + preference +
      '. Click for ' + THEMES[(THEMES.indexOf(preference) + 1) % THEMES.length] + '.');
    el.themeBtn.title = 'Theme: ' + preference;
    writePref('hs.theme', preference);
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (readPref('hs.theme', 'system') === 'system') applyTheme('system');
  });

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
      params.set('sort', state.sort);
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

  function selectScore(score, options) {
    state.minScore = score;
    writePref('hs.minScore', String(score));
    checkRadios(el.scoreSwitch, 'score', score);
    syncUrl();
    if (!options || !options.quiet) render();
  }

  function selectView(view, options) {
    if (VIEWS.indexOf(view) === -1) view = 'feed';
    state.view = view;
    state.expandedId = null;
    writePref('hs.view', view);
    checkRadios(el.viewSwitch, 'view', view);
    syncUrl();
    if (!options || !options.quiet) render();
  }

  // The server owns feed order, so a change here needs fresh data. The current
  // list stays on screen while it arrives.
  function selectSort(sort, options) {
    if (SORTS.indexOf(sort) === -1) sort = 'score';
    state.sort = sort;
    writePref('hs.sort', sort);
    checkRadios(el.sortSwitch, 'sort', sort);
    syncUrl();
    if (options && options.reload) {
      load({ silent: true }).then(applyPending).catch(function () {});
    }
  }

  function setFilter(kind, value) {
    if (kind === 'source') state.source = state.source === value ? '' : value;
    if (kind === 'category') state.category = state.category === value ? '' : value;
    syncUrl();
    render();
  }

  function dropFilter(kind) {
    if (kind === 'all') {
      state.source = '';
      state.category = '';
      state.query = '';
      state.unreadOnly = false;
      el.search.value = '';
      selectScore(0, { quiet: true });
    }
    if (kind === 'query') { state.query = ''; el.search.value = ''; }
    if (kind === 'score') selectScore(0, { quiet: true });
    if (kind === 'source') state.source = '';
    if (kind === 'category') state.category = '';
    if (kind === 'unread') state.unreadOnly = false;
    syncUrl();
    render();
  }

  function setUnreadOnly(value) {
    state.unreadOnly = value;
    writePref('hs.unread', value ? '1' : '0');
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

  // Segmented controls are radiogroups, so they owe the keyboard arrow keys and
  // Home/End, not just clicks.
  function wireSegment(container, attribute, onSelect) {
    container.addEventListener('click', function (event) {
      var button = event.target.closest('.segment__item');
      if (button) onSelect(button.dataset[attribute], button);
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

  wireSegment(el.viewSwitch, 'view', function (value) {
    selectView(value);
  });

  wireSegment(el.sortSwitch, 'sort', function (value) {
    if (value !== state.sort) selectSort(value, { reload: true });
  });

  el.search.addEventListener('input', debounce(function () {
    state.query = el.search.value;
    render();
  }, 120));

  el.clearBtn.addEventListener('click', function () { dropFilter('all'); });
  el.unreadBtn.addEventListener('click', function () { setUnreadOnly(!state.unreadOnly); });
  el.refreshBtn.addEventListener('click', refresh);
  el.refreshFromDialog.addEventListener('click', refresh);
  el.newPill.addEventListener('click', applyPending);
  el.helpBtn.addEventListener('click', function () { el.helpDialog.showModal(); });
  el.sourcesBtn.addEventListener('click', function () { openSources(); });
  el.healthBtn.addEventListener('click', function () { openSources(); });

  el.markReadBtn.addEventListener('click', function () {
    var articles = visibleArticles();
    var changed = 0;
    articles.forEach(function (article) {
      if (markRead(article.id, true)) changed++;
    });
    render();
    toast('success', changed
      ? plural(changed, 'headline') + ' marked read'
      : 'Everything visible was already read');
  });

  /* -- Grid delegation ---------------------------------------------------- */

  el.grid.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-act]');
    if (!trigger) return;

    var act = trigger.dataset.act;
    var rowNode = trigger.closest('.row[data-id]');
    var article = rowNode ? articleById(rowNode.dataset.id) : null;

    if (act === 'open') {
      // Let the browser follow the link; only the read flag is ours.
      openArticle(article, false);
      return;
    }

    event.preventDefault();

    if (act === 'expand') toggleExpanded(rowNode.dataset.id);
    else if (act === 'save') handleSave(article);
    else if (act === 'hide') handleHide(article);
    else if (act === 'toggle-read') {
      markRead(article.id, !isRead(article.id));
      render();
      select(article.id);
    } else if (act === 'filter-source') setFilter('source', trigger.dataset.value);
    else if (act === 'filter-category') setFilter('category', trigger.dataset.value);
    else if (act === 'manage-source') openSources(trigger.dataset.value);
    else if (act === 'clear-filters') dropFilter('all');
    else if (act === 'retry') load();
    else if (act === 'retry-scrape') refresh();
  });

  el.grid.addEventListener('mousedown', function (event) {
    var row = event.target.closest('.row[data-id]');
    if (row) select(row.dataset.id);
  });

  el.filters.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-act="drop-filter"]');
    if (trigger) dropFilter(trigger.dataset.value);
  });

  // `scroll` does not bubble, so listen on the capture phase instead of binding
  // a handler per panel on every render.
  el.grid.addEventListener('scroll', function (event) {
    if (event.target.classList && event.target.classList.contains('panel__body')) {
      markOverflow(event.target);
    }
  }, true);

  el.themeBtn.addEventListener('click', function () {
    var current = readPref('hs.theme', 'system');
    applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  });

  /* -- Export menu -------------------------------------------------------- */

  function closeExportMenu() {
    el.exportMenu.hidden = true;
    el.exportBtn.setAttribute('aria-expanded', 'false');
  }

  el.exportBtn.addEventListener('click', function (event) {
    event.stopPropagation();
    var open = el.exportMenu.hidden;
    el.exportMenu.hidden = !open;
    el.exportBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  el.exportMenu.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-export]');
    closeExportMenu();
    if (!trigger) return;

    var articles = visibleArticles();
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

  document.addEventListener('click', function (event) {
    if (!el.exportMenu.hidden && !event.target.closest('.menu')) closeExportMenu();
  });

  /* -- Dialogs ------------------------------------------------------------ */

  [el.sourcesDialog, el.helpDialog].forEach(function (dialog) {
    dialog.addEventListener('click', function (event) {
      if (event.target.closest('[data-close]')) dialog.close();
      // A click on the backdrop lands on the dialog element itself.
      if (event.target === dialog) dialog.close();
    });
  });

  el.sourceList.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-src-act]');
    if (!trigger) return;

    var rowNode = trigger.closest('.srow');
    var name = rowNode.dataset.name;
    var config = sourceConfig(name);
    if (!config) return;

    var act = trigger.dataset.srcAct;

    if (act === 'test') {
      var target = rowNode.querySelector('.srow__result');
      testSource({
        name: name, url: config.url, selector: config.selector,
        fallback: config.fallback, tier: config.tier, category: config.category,
        type: config.type, feed_url: config.feed_url
      }, target, trigger);
      return;
    }

    if (act === 'toggle') {
      var enable = trigger.getAttribute('aria-pressed') !== 'true';
      fetchJson('/api/sources/' + encodeURIComponent(name), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enable })
      }).then(function () {
        return fetchJson('/api/sources');
      }).then(function (health) {
        applyHealth(health);
        renderSourceList(name);
        render();
        toast('success', name + (enable ? ' enabled' : ' disabled'));
      }).catch(function (error) {
        toast('error', error.message);
      });
      return;
    }

    if (act === 'delete') {
      if (!window.confirm('Remove "' + name + '" from sources.json?')) return;
      fetchJson('/api/sources/' + encodeURIComponent(name), { method: 'DELETE' })
        .then(function () { return fetchJson('/api/sources'); })
        .then(function (health) {
          applyHealth(health);
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

    fetchJson('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function () {
      el.addSourceForm.reset();
      resetDiscovery();
      el.testPreview.hidden = true;
      el.addSource.open = false;
      return fetchJson('/api/sources');
    }).then(function (health) {
      applyHealth(health);
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
      if (!el.exportMenu.hidden) { closeExportMenu(); return; }
      if (document.activeElement === el.search) {
        el.search.value = '';
        state.query = '';
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
      case 's':
        if (article) { event.preventDefault(); handleSave(article); }
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
      case 'u': event.preventDefault(); setUnreadOnly(!state.unreadOnly); break;
      case 'r': event.preventDefault(); refresh(); break;
      case 'g': event.preventDefault(); openSources(); break;
      case '/':
        event.preventDefault();
        el.search.focus();
        el.search.select();
        break;
      case '?':
        event.preventDefault();
        el.helpDialog.showModal();
        break;
      case '1': selectView('feed'); break;
      case '2': selectView('sources'); break;
      case '3': selectView('categories'); break;
      case '4': selectView('saved'); break;
      default: break;
    }
  });

  /* == Boot ================================================================ */

  applyTheme(readPref('hs.theme', 'system'));

  // Read every stored and linked preference before applying any of them: each
  // selector rewrites the URL, which would clobber the others mid-boot.
  var boot = {
    view: readParam('view') || readPref('hs.view', 'feed'),
    sort: readParam('sort') || readPref('hs.sort', 'score'),
    score: Number(readParam('min_score') || readPref('hs.minScore', '0')) || 0,
    source: readParam('source') || '',
    category: readParam('category') || ''
  };

  state.source = boot.source;
  state.category = boot.category;
  state.unreadOnly = readPref('hs.unread', '0') === '1';

  selectSort(boot.sort);
  selectView(boot.view, { quiet: true });
  selectScore(boot.score, { quiet: true });

  load().catch(function () {});

  setInterval(function () { load({ silent: true }).catch(function () {}); }, POLL_MS);
  setInterval(function () {
    if (state.status === 'ready') renderFreshness();
  }, 20000);
})();
