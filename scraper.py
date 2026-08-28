import requests
from bs4 import BeautifulSoup
import cloudscraper
import feedparser

import store
import json
import hashlib
import os
from datetime import datetime, timedelta
import time
import random
from urllib.parse import urljoin, urlparse
import re

# Navigation, legal and site-chrome labels that get picked up alongside real
# headlines. Compared against a lowercased, punctuation-stripped title.
BOILERPLATE_TITLES = {
    'about', 'about us', 'accessibility', 'account', 'ad choices', 'advertise',
    'advertise with us', 'api', 'apply now', 'archive', 'archives', 'articles',
    'blog', 'book a demo', 'careers', 'comments', 'company', 'compute index',
    'contact', 'contact us', 'cookie policy', 'cookie settings', 'courses',
    'dashboard', 'docs', 'documentation', 'donate', 'download', 'download report',
    'enterprise', 'events', 'faq', 'follow us', 'get started', 'guides', 'help',
    'home', 'homepage', 'imprint', 'information collection notice', 'investors',
    'jobs', 'join now', 'latest', 'learn more', 'legal', 'load more', 'log in',
    'login', 'manage cookies', 'members', 'membership', 'menu', 'more',
    'my account', 'newsletter', 'newsletters', 'next', 'our team', 'partners',
    'popular', 'press', 'previous', 'pricing', 'pricing plans', 'privacy',
    'privacy policy', 'profile', 'read more', 'register', 'request demo', 'rss',
    'search', 'see all', 'settings', 'share', 'shop', 'sign in', 'sign up',
    'site news', 'sitemap', 'sponsor', 'sponsors', 'store', 'subscribe',
    'support', 'survey results', 'team', 'terms', 'terms of service',
    'terms of use', 'tools', 'topics', 'trending', 'try free', 'videos',
    'view all',
}

JUNK_TITLE_PATTERNS = [
    re.compile(r'^(sign|log)\s*(in|up|out)\b', re.I),
    re.compile(r'^subscribe\b', re.I),
    re.compile(r'^(read|learn|see|view|show|browse)\s+(more|all)\b', re.I),
    re.compile(r'^[a-z]{3}\s*\d{1,2}\s*\|', re.I),   # TLDR date rails: "Aug 26|AI"
    re.compile(r'\+\d[\d,.]*%\s*$'),                  # trend rows: "Soursop bitters+1011%"
    re.compile(r'^[\w-]+\.(com|ai|io|org|net|co)\d'),  # traffic rows: "google.com105.8B"
    re.compile(r'^\d{4}\s+edition$', re.I),
    re.compile(r'^skip to\b', re.I),
    re.compile(r'^turn on\b', re.I),
    re.compile(r'^(all|more)\s+\w+$', re.I),          # "All Topics", "All Startups"
    re.compile(r'^©'),
]

# Path segments that mark a link as site chrome rather than a story.
JUNK_PATH_SEGMENTS = {
    'about', 'about-us', 'account', 'advertise', 'advertising', 'archive',
    'archives', 'author', 'authors', 'career', 'careers', 'categories',
    'category', 'contact', 'contact-us', 'cookie', 'cookies', 'courses', 'dmca',
    'events', 'faq', 'feed', 'guides', 'help', 'imprint', 'jobs', 'legal',
    'login', 'newsletter', 'newsletters', 'signin', 'sign-in', 'signup',
    'sign-up', 'pricing', 'privacy', 'register', 'rss', 'sponsor', 'sponsors',
    'subscribe', 'support', 'tag', 'tags', 'team', 'terms', 'tools', 'tos',
}

LEGAL_SLUGS = re.compile(
    r'(terms[-_]of[-_](use|service)|privacy[-_]policy|cookie[-_]policy'
    r'|information[-_]collection)', re.I
)

# Social profile links live in every header and footer. Reddit and YouTube are
# deliberately absent -- they are real sources here.
SOCIAL_DOMAINS = (
    'twitter.com', 'x.com', 'facebook.com', 'linkedin.com', 'instagram.com',
    'pinterest.com', 't.me', 'discord.gg', 'discord.com', 'mastodon.',
    'bsky.app', 'threads.net', 'tiktok.com',
)

# Boilerplate footer destinations that are never articles.
NON_ARTICLE_DOMAINS = (
    'creativecommons.org', 'w3.org', 'gnu.org', 'validator.w3.org',
)

ARXIV_ID = re.compile(r'^arxiv:\s*\d{4}\.\d{4,5}', re.I)

# == Signal scoring =========================================================
# The score answers one question: "how likely is this headline to be worth a
# click?" It is deliberately a transparent rule set rather than a model, so
# every point can be shown back to the reader (see `score_reasons` on each
# article and the breakdown popover in the UI).
#
# A source's tier sets the base. Title rules then add or subtract, each at most
# once, and the positive and negative sides are capped so no single headline can
# be pushed to the rails by keyword stuffing.

SOURCE_TIERS = {'high': 68, 'medium': 56, 'low': 46}

TIER_LABELS = {
    'high': 'first-party, high-signal source',
    'medium': 'roundup or aggregator',
    'low': 'general tech press',
}

# Legacy fallback for sources.json entries with no explicit "tier". Matched as a
# substring so "Import AI (Jack Clark)" still resolves -- the old exact-match
# lookup silently graded every parenthesised source as low tier.
LEGACY_TIERS = [
    ('high', ('import ai', 'stratechery', 'techmeme', 'hacker news',
              'the information', 'y combinator', 'arxiv', 'state of ai')),
    ('medium', ('rundown', "ben's bites", 'algorithm', 'tldr', 'last week in ai',
                'deep learning weekly', 'ai weekly', 'ai breakfast', 'lobsters',
                'axios', 'strictlyvc', 'term sheet', 'product hunt')),
]

SCORE_SIGNALS = [
    ('ships something concrete', 11, re.compile(
        r'\b(launch(es|ed|ing)?|releases?d?|unveil\w+|introduc\w+|debuts?'
        r'|rolls? out|ships?|shipped|now (generally )?available|open-?sourc\w+'
        r'|announc\w+)\b', re.I)),

    ('money or a deal', 10, re.compile(
        r'(\$\d[\d.,]*\s*(b|bn|m|k|billion|million|trillion)?)'
        r'|\b(raises?d?|funding|series [a-f]\b|valuation|valued at'
        r'|acqui(re|res|red|sition)|merger|buyout|ipo\b)\b', re.I)),

    ('names a frontier lab or model', 8, re.compile(
        r'\b(openai|anthropic|deepmind|nvidia|mistral|deepseek|qwen|kimi'
        r'|gpt-?\d\w*|claude|gemini|llama|grok|sora|veo|o[1-9]\b)\b', re.I)),

    ('a result, not a take', 7, re.compile(
        r'\b(benchmark\w*|state[- ]of[- ]the[- ]art|sota\b|outperform\w+'
        r'|beats?|record|breakthrough|papers?|preprint|arxiv|study finds'
        r'|new study|dataset|evaluat\w+)\b', re.I)),

    ('regulatory or legal action', 6, re.compile(
        r'\b(sues?|sued|suing|lawsuits?|court|ruling|judge|antitrust'
        r'|bans?|banned|regulat\w+|investigat\w+|subpoena|fined?|settle\w+)\b',
        re.I)),

    ('carries a specific number', 4, re.compile(r'\d')),

    ('question headline', -9, re.compile(r'\?\s*$')),

    ('listicle', -12, re.compile(
        r'^\d+\s+\w+|\b(top \d+|best \d+|\d+ (things|ways|tools|tips|reasons'
        r'|lessons|prompts))\b', re.I)),

    ('how-to or opinion', -8, re.compile(
        r'^(how|why|what|when|should)\b|\b(guide|tutorial|explained|explainer'
        r'|opinion|i tried|we tried|my take|thoughts on)\b', re.I)),

    ('hype language', -7, re.compile(
        r'\b(game[- ]?changer|revolutioni[sz]\w+|insane|mind-?blowing'
        r'|you (need|won\'?t believe)|the future of|everything you need)\b', re.I)),

    ('meme or engagement bait', -6, re.compile(
        r'\b(meme|lol|goes viral|this is (why|how))\b', re.I)),
]

POSITIVE_CAP = 26
NEGATIVE_FLOOR = -24
SCORE_MIN = 5
SCORE_MAX = 100

# == Publish dates ==========================================================
# Scraped pages express dates four ways, in descending order of trust: a
# machine-readable <time datetime>, a "3 hours ago" label, a written-out date,
# or a dated URL slug. Anything else leaves `published` null rather than
# guessing -- an invented date is worse than an absent one.

RELATIVE_AGE = re.compile(
    r'\b(\d+)\s*(minute|min|hour|hr|h|day|d|week|w|month|mo|year|yr)s?\b\s*(ago)?',
    re.I)

RELATIVE_UNITS = {
    'minute': 60, 'min': 60,
    'hour': 3600, 'hr': 3600, 'h': 3600,
    'day': 86400, 'd': 86400,
    'week': 604800, 'w': 604800,
    'month': 2592000, 'mo': 2592000,
    'year': 31536000, 'yr': 31536000,
}

MONTHS = {m: i + 1 for i, m in enumerate(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
     'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}

TEXT_DATE = re.compile(
    r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+'
    r'(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b', re.I)

URL_DATE = re.compile(r'/(20\d{2})/(\d{1,2})(?:/(\d{1,2}))?')

# Blogs commonly spell the month out in the slug: /2026/Aug/19/title.
URL_DATE_TEXT = re.compile(
    r'/(20\d{2})/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*'
    r'(?:/(\d{1,2}))?', re.I)


# Categorisation is pure keyword matching against the headline -- no model call,
# no network, no tokens. Rules are evaluated in order and the first hit wins, so
# the narrow buckets sit above the broad ones ("Google sued over ads" is Policy,
# not Big Tech). A source may name its own fallback category in sources.json for
# the headlines that match nothing.
CATEGORY_RULES = [
    ('Security', re.compile(
        r'\b(breach(es|ed)?|hack(s|ed|er|ers|ing)?|vulnerabilit(y|ies)|exploits?'
        r'|cve-\d|ransomware|malware|phishing|zero-?day|backdoor|spyware'
        r'|cyber\w*|infostealer|botnet|ddos|jailbreaks?|prompt injection)\b', re.I)),

    ('Policy & Regulation', re.compile(
        r'\b(regulat\w+|lawsuits?|sues?|sued|suing|court|judge|antitrust'
        r'|ftc|doj|fcc|sec\b|eu ai act|ai act|dma\b|gdpr|copyright|trademark'
        r'|legislat\w+|congress|senate|parliament|white house|executive order'
        r'|bans?|banned|banning|export controls?|tariffs?|sanctions?|subpoena'
        r'|privacy|surveillance|watchdog|probe|investigat\w+ by)\b', re.I)),

    ('Funding & M&A', re.compile(
        r'\b(raises?|raised|raising|funding|fundraise|seed round|pre-?seed'
        r'|series [a-f]\b|valuation|valued at|term sheet|cap table|acqui(re|res|red|sition|hire)\w*'
        r'|merger|buyout|ipo\b|spac\b|tender offer|down round|led the round'
        r'|venture capital|\bvcs?\b|limited partners?|\blps?\b'
        r'|(\$\d[\d.,]*\s*(m|b|bn|k)?\b.{0,20}\b(round|raise|fund|investment)))\b', re.I)),

    ('Chips & Hardware', re.compile(
        r'\b(chips?|chipmaker|gpus?|tpus?|npus?|cpus?|semiconductors?|nvidia|tsmc'
        r'|asml|amd\b|arm holdings|wafers?|foundr(y|ies)|lithograph\w+|hbm\b'
        r'|h100|h200|b200|blackwell|rubin|trainium|data ?cent(er|re)s?'
        r'|robots?|robotics|humanoids?|drones?|wearables?|headsets?|hardware'
        r'|silicon|fab\b|fabs\b|nanometer|\d+\s?nm\b)\b', re.I)),

    ('Crypto & Fintech', re.compile(
        r'\b(crypto\w*|bitcoin|btc\b|ethereum|eth\b|solana|blockchain'
        r'|stablecoins?|defi|web3|nfts?|tokenomics|mining rig|fintech'
        r'|neobank|stripe|payments?|banking|cbdc)\b', re.I)),

    ('Science & Space', re.compile(
        r'\b(quantum|qubits?|space|nasa|spacex|rockets?|satellites?|orbit\w*'
        r'|mars|moon|asteroid|telescope|astronom\w+|physics|fusion|reactor'
        r'|climate|emissions?|biotech|genomics?|crispr|proteins?|clinical trial'
        r'|cancer|vaccines?|neuroscience|brain-?computer)\b', re.I)),

    ('AI Research', re.compile(
        r'\b(arxiv|papers?|preprint|benchmarks?|state[- ]of[- ]the[- ]art|sota\b'
        r'|fine-?tun\w+|pre-?train\w+|post-?train\w+|transformers?|diffusion'
        r'|reinforcement learning|\brl\b|rlhf|rlvr|neural (net|network)s?'
        r'|embeddings?|tokeni[sz]\w+|distillation|quanti[sz]ation|scaling laws?'
        r'|mixture of experts|\bmoe\b|interpretability|alignment|red[- ]team\w*'
        r'|hallucinat\w+|context window|chain[- ]of[- ]thought|inference[- ]time'
        r'|researchers?|study finds|new study|dataset)\b', re.I)),

    ('Models & Releases', re.compile(
        r'\b(gpt-?\d\w*|claude|gemini|llama|mistral|qwen|deepseek|kimi|grok'
        r'|sora|veo\b|midjourney|stable diffusion|flux\b|whisper|o[1-9]\b'
        r'|releases?|released|launch(es|ed|ing)?|unveil\w+|introduc\w+|debuts?'
        r'|rolls? out|now (available|generally available|in preview)|ships?|shipped'
        r'|open-?sourc\w+|weights?|checkpoints?|v\d+(\.\d+)?\b|version \d)\b', re.I)),

    ('AI Tools & Agents', re.compile(
        r'\b(agents?|agentic|copilots?|assistants?|chatbots?|\bapis?\b|sdks?'
        r'|plugins?|extensions?|mcp\b|prompts?|prompting|workflows?|automat\w+'
        r'|no-?code|low-?code|vibe coding|code (review|completion|generation)'
        r'|ide\b|cli\b|integrat\w+ with)\b', re.I)),

    ('Engineering & Open Source', re.compile(
        r'\b(rust|python|javascript|typescript|golang|zig\b|c\+\+'
        r'|kernel|linux|unix|bsd|database|postgres\w*|sqlite|mysql|redis|\bsql\b'
        r'|docker|kubernetes|compilers?|runtimes?|librar(y|ies)|frameworks?'
        r'|github|gitlab|open source|self-?host\w*|browsers?|webassembly|wasm'
        r'|\bcss\b|\bapi design|latency|benchmarking|debugg\w+|refactor\w*)\b', re.I)),

    ('Big Tech', re.compile(
        r'\b(openai|anthropic|google|alphabet|deepmind|microsoft|apple|meta\b'
        r'|amazon|aws\b|azure|tesla|\bx\.?ai\b|bytedance|tiktok|netflix|oracle'
        r'|\bibm\b|salesforce|adobe|uber|airbnb|snap\b|spotify|samsung|baidu'
        r'|alibaba|tencent|huawei)\b', re.I)),

    ('Business & Markets', re.compile(
        r'\b(earnings|revenue|profits?|losses?|stocks?|shares?|market cap|q[1-4] '
        r'|layoffs?|job cuts?|hiring|headcount|\bceo\b|\bcfo\b|\bcto\b'
        r'|resigns?|steps? down|ousted|restructur\w+|billion|trillion|million'
        r'|subscri\w+|pricing|paywall|ad revenue|market share|shutting down'
        r'|shuts? down|bankrupt\w*)\b', re.I)),
]

# Display order for the category view; anything unmatched lands in the tail.
CATEGORIES = [name for name, _ in CATEGORY_RULES] + ['Other']
CATEGORY_FALLBACK = 'Other'


def categorize(title, default=None):
    """Bucket a headline by keyword rule, falling back to the source's own tag."""
    for name, pattern in CATEGORY_RULES:
        if pattern.search(title):
            return name
    return default or CATEGORY_FALLBACK


def _normalize_title(title):
    return re.sub(r'[^a-z0-9 ]+', ' ', title.lower()).strip()


def _normalize_url(url):
    return url.split('#')[0].split('?')[0].rstrip('/').lower()


def _host_matches(netloc, domains):
    host = netloc.lower().split(':')[0]
    if host.startswith('www.'):
        host = host[4:]
    return any(host == d or host.endswith('.' + d) for d in domains)


def _is_social_host(netloc):
    return _host_matches(netloc, SOCIAL_DOMAINS)


def is_junk(title, link, source_url):
    """True when a scraped link is navigation/legal/chrome rather than an article."""
    normalized = re.sub(r'\s+', ' ', _normalize_title(title))
    if not normalized:
        return True
    if normalized in BOILERPLATE_TITLES:
        return True
    if any(pattern.search(title) for pattern in JUNK_TITLE_PATTERNS):
        return True

    parsed = urlparse(link)
    if parsed.scheme not in ('http', 'https'):
        return True

    if _host_matches(parsed.netloc, NON_ARTICLE_DOMAINS):
        return True

    segments = [s for s in parsed.path.lower().split('/') if s]
    if any(segment in JUNK_PATH_SEGMENTS for segment in segments):
        return True
    if LEGAL_SLUGS.search(parsed.path):
        return True
    if _normalize_url(link) == _normalize_url(source_url):
        return True

    words = title.split()
    has_digit = any(c.isdigit() for c in title)
    # A story slug is at least two path segments deep; nav sits at the root.
    shallow = len(segments) <= 1

    # A one-word title with no number is a source label ("PCMag", "Fortune"),
    # never a headline -- even when it points at a real article.
    if len(words) == 1 and not has_digit:
        return True

    # Headlines get capitalized; short all-lowercase phrases are footer copy
    # ("one daily email", "our accuracy audit").
    if len(words) <= 3 and title == title.lower():
        return True

    # The rules below are weak on their own, so each needs a shallow URL to
    # corroborate it. That keeps real short headlines that live on deep slugs,
    # like Stratechery's "Amazon's Durability" at /2026/amazons-durability/.
    if _is_social_host(parsed.netloc) and shallow:
        return True  # footer profile link, not a linked-to post
    if not segments and len(words) <= 3:
        return True  # bare domain root with a stubby label
    if len(words) <= 2 and not has_digit and shallow:
        return True

    return False


CHALLENGE_MARKERS = (
    '<title>just a moment',
    'cf-browser-verification',
    'challenge-platform',
    'enable javascript and cookies to continue',
)


def is_challenge_page(html):
    """True when a 200 response is really a bot-check interstitial.

    Checked against a small body only: a genuine article page can mention
    Cloudflare in passing, and these pages are always tiny.
    """
    if not html or len(html) > 20000:
        return False
    head = html[:4000].lower()
    return any(marker in head for marker in CHALLENGE_MARKERS)


SUMMARY_LIMIT = 280

SUMMARY_META_SELECTORS = (
    ('meta[property="og:description"]', 'content'),
    ('meta[name="description"]', 'content'),
    ('meta[name="twitter:description"]', 'content'),
)

SUMMARY_SKIP_PATTERNS = re.compile(
    r'\b(cookie|cookies|subscribe|subscription|sign in|sign up|newsletter'
    r'|advertisement|enable javascript|privacy policy|terms of service)\b',
    re.I)

SUMMARY_SENTENCE = re.compile(r'(?<=[.!?])\s+(?=[A-Z0-9"\'])')

LEGACY_SUMMARY_PREFIX = 'Headline picked up from '


def is_generated_summary(summary):
    """True for summaries created by this app rather than a publisher."""
    return bool(summary and summary.startswith(LEGACY_SUMMARY_PREFIX))


def clean_summary_text(value):
    text = re.sub(r'<[^>]+>', ' ', value or '')
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def trim_summary(value, limit=SUMMARY_LIMIT):
    text = clean_summary_text(value)
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(' ', 1)[0].rstrip(' ,;:')
    return (cut or text[:limit]).rstrip() + '...'


def is_useful_summary(summary, title=''):
    text = clean_summary_text(summary)
    if len(text) < 45:
        return False
    if SUMMARY_SKIP_PATTERNS.search(text[:180]):
        return False

    title_text = clean_summary_text(title).lower()
    if title_text and text.lower().strip(' .') == title_text.strip(' .'):
        return False
    return True


def metadata_summary(article):
    """Last-resort deterministic context line from fields already in the cache."""
    reasons = []
    for reason in article.get('score_reasons', []):
        try:
            delta = int(reason.get('delta', 0))
        except (TypeError, ValueError):
            delta = 0
        label = reason.get('label')
        if label and delta > 0 and 'source' not in label.lower():
            reasons.append(label)

    bits = []
    score = article.get('signal_score')
    if score is not None and reasons:
        bits.append('Scored %s for %s.' % (score, '; '.join(reasons[:3])))
    elif score is not None:
        bits.append('Scored %s by the transparent headline rules.' % score)

    also = article.get('also_in') or []
    if also:
        bits.append('Also carried by %s.' % ', '.join(also[:4]))

    bits.append('Open %s for the full story.' % article.get('source', 'the source'))
    return trim_summary(' '.join(bits))


def summary_from_meta(soup, title=''):
    for selector, attribute in SUMMARY_META_SELECTORS:
        node = soup.select_one(selector)
        if not node:
            continue
        summary = node.get(attribute, '')
        if is_useful_summary(summary, title):
            return trim_summary(summary)
    return ''


def summary_from_body(soup, title=''):
    root = soup.select_one('article') or soup.select_one('main') or soup.body
    if not root:
        return ''

    paragraphs = []
    for node in root.select('p'):
        text = clean_summary_text(node.get_text(' ', strip=True))
        if len(text) < 45 or SUMMARY_SKIP_PATTERNS.search(text[:180]):
            continue
        paragraphs.append(text)
        if sum(len(p) for p in paragraphs) >= 900:
            break

    body = ' '.join(paragraphs)
    if not body:
        return ''

    sentences = [s.strip() for s in SUMMARY_SENTENCE.split(body) if s.strip()]
    summary = ' '.join(sentences[:2]) if sentences else body
    if is_useful_summary(summary, title):
        return trim_summary(summary)
    return ''


def write_json_atomic(path, payload):
    """Persist JSON state under `path`.

    Named for what it guarantees rather than where it lands: the local backend
    still writes through a temp file so a crash mid-write cannot truncate the
    cache, and the Blob backend replaces the object in one request.
    """
    store.write_json(path, payload)


def parse_iso(value):
    """Lenient ISO-8601 parse. Python 3.9's fromisoformat rejects 'Z'."""
    if not value:
        return None
    text = str(value).strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        # Date-only or truncated values still carry useful precision.
        try:
            parsed = datetime.strptime(text[:10], '%Y-%m-%d')
        except ValueError:
            return None
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def published_from_relative(text, now):
    """'3 hours ago' -> a timestamp. Returns None when the phrase is absent."""
    match = RELATIVE_AGE.search(text)
    if not match:
        return None
    # Bare "5 min" without "ago" shows up in read-time labels ("6 min read"),
    # which are not dates at all.
    if not match.group(3) and 'ago' not in text.lower():
        return None
    seconds = RELATIVE_UNITS.get(match.group(2).lower())
    if not seconds:
        return None
    amount = int(match.group(1))
    if amount > 999:
        return None
    return now - timedelta(seconds=amount * seconds)


def published_from_text(text, now):
    """'Aug 26' / 'August 26, 2026' -> a timestamp, never in the future."""
    match = TEXT_DATE.search(text)
    if not match:
        return None
    month = MONTHS.get(match.group(1).lower()[:3])
    day = int(match.group(2))
    if not month or not 1 <= day <= 31:
        return None
    year = int(match.group(3)) if match.group(3) else now.year
    try:
        parsed = datetime(year, month, day)
    except ValueError:
        return None
    # A bare "Dec 20" seen in January means last December, not this one.
    if not match.group(3) and parsed > now + timedelta(days=1):
        parsed = parsed.replace(year=year - 1)
    return parsed


def published_from_url(link):
    """Dated slugs: /2026/08/27/story, /2026/08/story or /2026/Aug/27/story."""
    match = URL_DATE.search(link)
    month = None
    if match:
        month = match.group(2)
    else:
        match = URL_DATE_TEXT.search(link)
        if match:
            month = MONTHS.get(match.group(2).lower()[:3])
    if not match or not month:
        return None, None
    year, day = match.group(1), match.group(3)
    try:
        if day:
            return datetime(int(year), int(month), int(day)), 'day'
        return datetime(int(year), int(month), 1), 'month'
    except ValueError:
        return None, None


def resolve_published(item, link, now=None):
    """Best available publish time for a scraped item.

    Sources are tried in order of how tightly they are bound to *this* headline,
    not how precise they look:

      1. a <time datetime> on the item or its nearest ancestors
      2. a dated URL slug -- unambiguously this story's own date
      3. a relative age or written date in the item's immediate surroundings

    The text scan is last and deliberately narrow. Widening it picks up the
    neighbouring card's date, and a confidently wrong date is worse than none.

    Returns (iso_string_or_None, precision) where precision is 'exact', 'day' or
    'month' -- the UI shows "2h" for exact times and "27 Aug" for the coarser
    ones, so it never implies more accuracy than the page gave us.
    """
    now = now or datetime.now()
    horizon = now + timedelta(days=1)

    node = item
    for _ in range(4):
        if node is None or not hasattr(node, 'select_one'):
            break
        stamp = node.select_one('time[datetime], [datetime], [data-timestamp]')
        if stamp is not None:
            raw = (stamp.get('datetime') or stamp.get('data-timestamp') or '').strip()
            parsed = parse_iso(raw)
            if parsed and parsed <= horizon:
                return parsed.isoformat(), 'exact' if len(raw) > 10 else 'day'
        node = node.parent

    from_url, precision = published_from_url(link)
    if from_url and from_url <= horizon:
        return from_url.isoformat(), precision

    # Climb towards the byline, but stop as soon as the container holds more
    # than one story: past that point the text belongs to a neighbouring card,
    # and its date would be attributed to this headline.
    own = item.get_text(' ', strip=True) if hasattr(item, 'get_text') else ''
    node = item

    for _ in range(3):
        node = getattr(node, 'parent', None)
        if node is None or not hasattr(node, 'get_text'):
            break

        headlines = [link for link in node.find_all('a')
                     if len(link.get_text(strip=True)) > 25]
        if len(headlines) > 1:
            break

        # The headline itself is not metadata about the headline. Without this,
        # "Mechanical Turk shutting down September 30" was filed as published on
        # 30 September.
        text = node.get_text(' ', strip=True)
        if own:
            text = text.replace(own, ' ')
        text = text[:240]

        relative = published_from_relative(text, now)
        if relative:
            return relative.isoformat(), 'exact'

        written = published_from_text(text, now)
        if written and written <= horizon:
            return written.isoformat(), 'day'

    return None, None


def resolve_tier(source):
    """Signal tier for a source: explicit in sources.json, else inferred."""
    tier = (source.get('tier') or '').lower()
    if tier in SOURCE_TIERS:
        return tier
    name = source.get('name', '').lower()
    for candidate, needles in LEGACY_TIERS:
        if any(needle in name for needle in needles):
            return candidate
    return 'low'


def score_headline(source, title):
    """Score a headline 5-100 and return the arithmetic that produced it.

    The second return value is the list the UI renders in its score popover:
    [{'label': 'Techmeme -- first-party, high-signal source', 'delta': 68}, ...]
    Its deltas always sum to the score, so the explanation can never drift from
    the number it explains.
    """
    tier = resolve_tier(source)
    base = SOURCE_TIERS[tier]
    reasons = [{
        'label': '%s -- %s' % (source.get('name', 'Unknown'), TIER_LABELS[tier]),
        'delta': base,
        'kind': 'source',
    }]

    positive = 0
    negative = 0
    for label, delta, pattern in SCORE_SIGNALS:
        if not pattern.search(title):
            continue
        if delta > 0:
            allowed = min(delta, POSITIVE_CAP - positive)
            if allowed <= 0:
                continue
            positive += allowed
            reasons.append({'label': label, 'delta': allowed, 'kind': 'bonus'})
        else:
            allowed = max(delta, NEGATIVE_FLOOR - negative)
            if allowed >= 0:
                continue
            negative += allowed
            reasons.append({'label': label, 'delta': allowed, 'kind': 'penalty'})

    raw = base + positive + negative
    score = min(max(raw, SCORE_MIN), SCORE_MAX)

    # Clamping would otherwise make the reasons stop adding up to the score.
    if score != raw:
        reasons.append({
            'label': 'capped at %d' % score,
            'delta': score - raw,
            'kind': 'clamp',
        })

    return score, reasons


def cluster_key(title):
    """Signature used to spot the same story arriving from several sources."""
    words = [w for w in _normalize_title(title).split() if len(w) > 3]
    return ' '.join(sorted(words[:6])) if len(words) >= 3 else ''


def resolve_arxiv_title(item, title):
    """arXiv listings link the paper id; the human title sits in the sibling <dd>."""
    dt = item.find_parent('dt')
    dd = dt.find_next_sibling('dd') if dt else None
    node = dd.select_one('.list-title') if dd else None
    if not node:
        return title
    text = re.sub(r'^\s*title:\s*', '', node.get_text(' ', strip=True), flags=re.I)
    return re.sub(r'\s+', ' ', text).strip() or title


class HighSignalScraper:
    def __init__(self, sources_file='sources.json'):
        data = store.read_json_seeded(sources_file) or {}
        self.sources = data.get('sources', [])
        
        self.source_by_name = {s['name']: s for s in self.sources}
        # Source names visited by the most recent pass. A deadline-limited pass
        # covers only some of them; see scrape_all.
        self.covered = set()
        self.articles = []
        self.previous_by_id = {}
        self.health = {}
        self.last_run = None
        self.scraper = cloudscraper.create_scraper(
            browser={
                'browser': 'chrome',
                'platform': 'windows',
                'mobile': False
            }
        )
        
        self.user_agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
    
    def scrape_with_selectors(self, source, soup):
        selectors = source.get('selector', 'h2 a').split(', ')
        fallbacks = source.get('fallback', '').split(', ') if source.get('fallback') else []
        
        all_selectors = selectors + fallbacks
        
        for selector in all_selectors:
            if not selector.strip():
                continue
            try:
                items = soup.select(selector.strip())
                if items and len(items) > 0:
                    return items
            except:
                continue
        
        # Last resort: prefer links that sit in content regions over a blanket
        # sweep of every anchor, which is mostly header and footer nav.
        content_links = soup.select(
            'article a[href], main a[href], h1 a[href], h2 a[href], h3 a[href]'
        )
        if content_links:
            return content_links[:40]

        return soup.find_all('a', href=True)[:40]

    def extract_articles_from_items(self, items, source):
        articles = []
        seen_titles = set()
        seen_links = set()

        limit = int(source.get('limit', 15))

        for item in items:
            if len(articles) >= limit:
                break
            try:
                title = item.get_text(strip=True)
                if not title or len(title) < 5:
                    continue

                title = re.sub(r'\s+', ' ', title).strip()

                link = item.get('href', '')
                if not link:
                    link_elem = item.find('a')
                    if link_elem:
                        link = link_elem.get('href', '')
                if not link:
                    # Selectors often target the heading inside the card link,
                    # which keeps the title clean of bylines and category tags.
                    parent_link = item.find_parent('a')
                    if parent_link:
                        link = parent_link.get('href', '')

                if not link:
                    continue

                if not link.startswith('http'):
                    link = urljoin(source['url'], link)

                if ARXIV_ID.match(title):
                    title = resolve_arxiv_title(item, title)

                if is_junk(title, link, source['url']):
                    continue

                title_key = title[:50].lower()
                if title_key in seen_titles:
                    continue
                seen_titles.add(title_key)

                link_key = _normalize_url(link)
                if link_key in seen_links:
                    continue
                seen_links.add(link_key)

                score, reasons = score_headline(source, title)
                published, precision = resolve_published(item, link)
                now = datetime.now().isoformat()

                articles.append({
                    'title': title[:200],
                    'link': link,
                    'source': source['name'],
                    'category': self.resolve_category(source, title),
                    'type': source.get('type', 'static'),
                    'timestamp': now,
                    'first_seen': now,
                    'published': published,
                    'published_precision': precision,
                    'id': hashlib.md5(f"{title}{link}".encode()).hexdigest(),
                    'summary': '',
                    'summary_source': '',
                    'signal_score': score,
                    'score_reasons': reasons,
                    'also_in': []
                })
                
            except Exception as e:
                continue
        
        return articles
    
    def resolve_category(self, source, title):
        """Category for one headline.

        A source can set `"lock_category": true` when its whole feed belongs to
        one bucket regardless of wording -- arXiv listings are papers even when
        the title happens to say "agents". Everything else runs the keyword
        rules and uses the source's `category` only as the fallback.
        """
        source_category = source.get('category')
        if source_category and source.get('lock_category'):
            return source_category
        return categorize(title, source_category)

    def calculate_signal_score(self, source_name, title):
        """Kept for callers that only have a source name (tests, one-offs)."""
        source = self.source_by_name.get(source_name, {'name': source_name})
        return score_headline(source, title)[0]

    def fetch_article_summary(self, article, timeout=12):
        """Return (summary, source, error) without using model calls.

        The caller decides whether the URL is safe to fetch. This method only
        handles extraction quality and network failures.
        """
        link = article.get('link') or ''
        if not link.startswith(('http://', 'https://')):
            return metadata_summary(article), 'metadata', 'Article has no fetchable URL'

        try:
            response = self.scraper.get(
                link,
                headers={'User-Agent': random.choice(self.user_agents)},
                timeout=timeout,
                allow_redirects=True
            )
        except Exception as exc:                            # noqa: BLE001
            return metadata_summary(article), 'metadata', (
                f'{type(exc).__name__}: {str(exc)[:160]}')

        if response.status_code != 200:
            return metadata_summary(article), 'metadata', f'HTTP {response.status_code}'

        if is_challenge_page(response.text):
            return metadata_summary(article), 'metadata', 'Blocked by a bot challenge'

        soup = BeautifulSoup(response.text, 'html.parser')
        title = article.get('title', '')

        summary = summary_from_meta(soup, title)
        if summary:
            return summary, 'meta', None

        summary = summary_from_body(soup, title)
        if summary:
            return summary, 'body', None

        return metadata_summary(article), 'metadata', 'No usable page summary found'

    def build_article(self, source, title, link, published=None,
                      precision=None, summary=''):
        """Assemble one article dict from an already-parsed title and link.

        The HTML path gets its fields from `extract_articles_from_items`, which
        needs a soup node to hunt for dates and parent links. Feeds hand us the
        title, link and timestamp directly, so they build the same record here
        rather than being forced back through a fake soup tree. Both paths share
        the junk filter, scoring and category rules so a feed-backed source is
        ranked identically to a scraped one.
        """
        title = re.sub(r'\s+', ' ', title or '').strip()
        if not title or len(title) < 5 or not link:
            return None

        if not link.startswith('http'):
            link = urljoin(source['url'], link)

        if is_junk(title, link, source['url']):
            return None

        score, reasons = score_headline(source, title)
        now = datetime.now().isoformat()

        return {
            'title': title[:200],
            'link': link,
            'source': source['name'],
            'category': self.resolve_category(source, title),
            'type': source.get('type', 'static'),
            'timestamp': now,
            'first_seen': now,
            'published': published,
            'published_precision': precision,
            'id': hashlib.md5(f"{title}{link}".encode()).hexdigest(),
            'summary': trim_summary(summary) if summary else '',
            'summary_source': 'feed' if summary else '',
            'signal_score': score,
            'score_reasons': reasons,
            'also_in': []
        }

    def dedupe_new(self, articles):
        """Drop repeats within one source's batch, by title and by link."""
        out, seen_titles, seen_links = [], set(), set()
        for article in articles:
            title_key = article['title'][:50].lower()
            link_key = _normalize_url(article['link'])
            if title_key in seen_titles or link_key in seen_links:
                continue
            seen_titles.add(title_key)
            seen_links.add(link_key)
            out.append(article)
        return out

    def fetch_feed(self, source, response):
        """Parse an RSS/Atom response body into articles."""
        parsed = feedparser.parse(response.text)
        limit = int(source.get('limit', 15))
        articles = []

        for entry in parsed.entries:
            if len(articles) >= limit:
                break

            published, precision = None, None
            stamp = entry.get('published_parsed') or entry.get('updated_parsed')
            if stamp:
                try:
                    # Feeds carry a real publish time, so the UI can show "2h"
                    # instead of falling back to the coarse page-scrape guess.
                    published = datetime(*stamp[:6]).isoformat()
                    precision = 'exact'
                except (TypeError, ValueError):
                    published = None

            summary = re.sub(r'<[^>]+>', ' ', entry.get('summary', '') or '')
            article = self.build_article(
                source, entry.get('title', ''), entry.get('link', ''),
                published, precision, re.sub(r'\s+', ' ', summary).strip())
            if article:
                articles.append(article)

        return self.dedupe_new(articles)

    def fetch_json(self, source, response):
        """Parse a Reddit-style JSON listing into articles."""
        data = response.json()
        limit = int(source.get('limit', 15))
        articles = []

        children = data.get('data', {}).get('children', []) \
            if isinstance(data, dict) else []

        for child in children:
            if len(articles) >= limit:
                break
            post = child.get('data', {}) or {}
            if post.get('stickied'):
                continue

            published, precision = None, None
            created = post.get('created_utc')
            if created:
                try:
                    published = datetime.fromtimestamp(created).isoformat()
                    precision = 'exact'
                except (TypeError, ValueError, OSError):
                    published = None

            # `permalink` keeps discussion posts pointing at the thread; `url`
            # alone sends self-posts to a bare reddit.com/r/... redirect.
            link = post.get('url') or ''
            if post.get('is_self') and post.get('permalink'):
                link = urljoin('https://www.reddit.com', post['permalink'])

            article = self.build_article(
                source, post.get('title', ''), link, published, precision,
                (post.get('selftext') or '')[:280])
            if article:
                articles.append(article)

        return self.dedupe_new(articles)

    def scrape_source(self, source):
        """Fetch one source. Returns (articles, health).

        Health is reported for every source, including the ones that fail. A
        source that quietly returns nothing used to vanish from the dashboard
        with no trace; now it stays visible with a state the UI can render.
        """
        started = time.time()
        max_retries = int(source.get('retries', 3))
        source_type = (source.get('type') or 'static').lower()
        http_status = None
        error = None
        attempts = 0

        for attempt in range(max_retries):
            attempts = attempt + 1
            try:
                # Rotating the UA helps on plain page scrapes, but it overrides
                # the one cloudscraper picked to match its own TLS fingerprint.
                # Feed endpoints behind a bot check (Reddit) read that mismatch
                # as a spoof and answer 403, so leave their headers alone.
                headers = {}
                if source_type not in ('rss', 'json'):
                    headers = {'User-Agent': random.choice(self.user_agents)}

                # `feed_url` lets a source keep its human-facing homepage in
                # `url` (what the UI links to) while fetching from the feed or
                # JSON endpoint that actually serves the headlines.
                fetch_url = source.get('feed_url') or source['url']

                response = self.scraper.get(
                    fetch_url,
                    headers=headers,
                    timeout=20,
                    allow_redirects=True
                )
                http_status = response.status_code

                if response.status_code == 200:
                    if source_type == 'rss':
                        articles = self.fetch_feed(source, response)
                        empty_error = 'Fetched the feed but it contained no usable entries'
                    elif source_type == 'json':
                        articles = self.fetch_json(source, response)
                        empty_error = 'Fetched the endpoint but it contained no usable posts'
                    elif is_challenge_page(response.text):
                        # A bot challenge answers 200 with a near-empty body, so
                        # the selector "misses" and the real cause -- being
                        # blocked -- never surfaces. Name it instead.
                        articles = []
                        empty_error = ('Blocked by a bot challenge '
                                       '(the page returned 200 but served no content)')
                    else:
                        soup = BeautifulSoup(response.text, 'html.parser')
                        items = self.scrape_with_selectors(source, soup)
                        articles = self.extract_articles_from_items(items, source)
                        empty_error = 'Fetched the page but no headline matched the selector'

                    if articles:
                        print(f"✅ {source['name']}: {len(articles)} articles")
                        return articles, self.record_health(
                            source, 'ok', len(articles), http_status, None,
                            attempts, started)

                    error = empty_error
                else:
                    error = f'HTTP {response.status_code}'

                time.sleep(random.uniform(1, 3))

            except Exception as exc:
                error = f'{type(exc).__name__}: {str(exc)[:160]}'
                print(f"❌ {source['name']} (attempt {attempts}): {error[:100]}")
                time.sleep(random.uniform(2, 5))

        state = 'empty' if http_status == 200 else 'error'
        return [], self.record_health(source, state, 0, http_status, error,
                                      attempts, started)

    def record_health(self, source, state, count, http_status, error,
                      attempts, started):
        """Build one source's health row, carrying its last success forward."""
        name = source['name']
        previous = self.health.get(name, {})
        checked_at = datetime.now().isoformat()

        return {
            'name': name,
            'url': source.get('url', ''),
            'tier': resolve_tier(source),
            'category': source.get('category', ''),
            'enabled': source.get('enabled', True) is not False,
            'state': state,
            'articles': count,
            'http_status': http_status,
            'error': error,
            'attempts': attempts,
            'duration_ms': int((time.time() - started) * 1000),
            'checked_at': checked_at,
            'last_success': checked_at if state == 'ok' else previous.get('last_success'),
            'consecutive_failures': 0 if state == 'ok'
                                    else previous.get('consecutive_failures', 0) + 1,
        }

    def scrape_all(self, progress=None, deadline=None):
        """Scrape every enabled source.

        `progress(done, total, name)` is called before each source so the UI can
        show a determinate bar instead of an indefinite spinner -- a full pass
        takes minutes, which an indeterminate spinner reads as "hung".

        `deadline` (a `time.time()` value) makes the pass partial instead of
        complete: sources are visited least-recently-checked first and the loop
        stops when the clock runs out. A serverless invocation is capped at a
        few minutes, which a full pass can exceed, so the scheduled scrape there
        covers what it can and the next run picks up the sources it missed.
        `covered` afterwards names the sources this pass actually visited.
        """
        all_articles = []
        enabled = [s for s in self.sources if s.get('enabled', True) is not False]
        skipped = [s for s in self.sources if s.get('enabled', True) is False]

        if deadline:
            enabled.sort(key=lambda s: (self.health.get(s['name'], {})
                                        .get('checked_at') or ''))

        total_sources = len(enabled)
        self.covered = set()

        print(f"\n🚀 Starting scrape of {total_sources} high-signal sources...\n")

        for idx, source in enumerate(enabled, 1):
            if deadline and idx > 1 and time.time() >= deadline:
                print(f"⏱️  Out of time after {idx - 1}/{total_sources} sources; "
                      f"the rest go first next run")
                break
            if progress:
                progress(idx - 1, total_sources, source['name'])
            print(f"[{idx}/{total_sources}] Scraping: {source['name']}...")
            articles, health = self.scrape_source(source)
            self.health[source['name']] = health
            self.covered.add(source['name'])
            all_articles.extend(articles)
            time.sleep(random.uniform(0.5, 2))

        for source in skipped:
            self.health[source['name']] = self.record_health(
                source, 'disabled', 0, None, None, 0, time.time())
            self.covered.add(source['name'])

        if progress:
            progress(total_sources, total_sources, None)

        # Drop sources that are no longer configured from the health table.
        configured = {s['name'] for s in self.sources}
        self.health = {k: v for k, v in self.health.items() if k in configured}

        # A deadline-limited pass only re-scraped some sources. Carry the last
        # known articles for the untouched ones through dedupe, or the sources
        # that did not fit in this invocation would vanish from the dashboard
        # until their turn came round again.
        carried = [a for a in self.articles if a.get('source') not in self.covered]
        if carried:
            print(f"↩️  Carrying {len(carried)} articles from "
                  f"{len({a['source'] for a in carried})} un-scraped sources")

        unique_articles = self.merge_with_previous(
            self.dedupe(all_articles + carried))
        unique_articles.sort(key=lambda x: x['signal_score'], reverse=True)

        self.articles = unique_articles
        # Re-index for the next pass: without this, `first_seen` is only carried
        # forward from the cache loaded at boot, so anything discovered by this
        # scrape would look brand new again on the one after it.
        self.previous_by_id = {a['id']: a for a in unique_articles if a.get('id')}
        self.last_run = datetime.now().isoformat()
        self.save_health()

        ok = sum(1 for h in self.health.values() if h['state'] == 'ok')
        print(f"\n✅ Scraped {len(unique_articles)} unique articles "
              f"from {ok}/{total_sources} working sources")

        return unique_articles

    def dedupe(self, articles):
        """Collapse identical ids, then cluster the same story across sources.

        Techmeme, Hacker News and Lobsters routinely carry the same link. The
        strongest copy leads the cluster and the rest are recorded in `also_in`,
        so one story occupies one row and still shows how widely it was picked
        up. Two keys per story -- the normalised URL and a sorted-word title
        signature -- catch both the same link and the same story reworded.
        """
        by_id = {}
        for article in articles:
            by_id.setdefault(article['id'], article)

        leads = []
        index = {}

        for article in sorted(by_id.values(), key=lambda a: -a['signal_score']):
            keys = [k for k in ('url:' + _normalize_url(article['link']),
                                'title:' + cluster_key(article['title']))
                    if not k.endswith(':')]

            lead = next((index[k] for k in keys if k in index), None)
            if lead is None:
                article['also_in'] = []
                leads.append(article)
                for key in keys:
                    index[key] = article
                continue

            if article['source'] != lead['source'] and \
                    article['source'] not in lead['also_in']:
                lead['also_in'].append(article['source'])
            for key in keys:
                index.setdefault(key, lead)

        return leads

    def merge_with_previous(self, articles):
        """Preserve `first_seen` for headlines we have seen before.

        Recency in this app means "new to the dashboard", because most scraped
        pages do not publish a date. That only works if the first sighting
        survives later scrapes.
        """
        for article in articles:
            previous = self.previous_by_id.get(article['id'])
            if previous:
                article['first_seen'] = previous.get('first_seen') \
                                        or previous.get('timestamp') \
                                        or article['first_seen']
                if not article.get('published') and previous.get('published'):
                    article['published'] = previous['published']
                    article['published_precision'] = previous.get('published_precision')
                if not article.get('summary') and previous.get('summary'):
                    article['summary'] = previous['summary']
                    article['summary_source'] = previous.get('summary_source', 'cached')
                    if previous.get('summary_checked_at'):
                        article['summary_checked_at'] = previous['summary_checked_at']
                    if previous.get('summary_error'):
                        article['summary_error'] = previous['summary_error']
        return articles

    def save_to_cache(self, filename='cache.json'):
        payload = {
            'version': 2,
            'generated_at': self.last_run or datetime.now().isoformat(),
            'articles': self.articles,
            'health': list(self.health.values()),
        }
        write_json_atomic(filename, payload)
        print(f"💾 Saved {len(self.articles)} articles to cache")

    def load_cache(self, filename='cache.json'):
        """Warm the scraper from disk so the app can serve instantly on boot."""
        data = store.read_json(filename)
        if data is None:
            return []

        # v1 caches were a bare list of articles.
        if isinstance(data, list):
            articles, health, generated = data, [], None
        else:
            articles = data.get('articles', [])
            health = data.get('health', [])
            generated = data.get('generated_at')

        for article in articles:
            article.setdefault('first_seen', article.get('timestamp'))
            article.setdefault('published', None)
            article.setdefault('published_precision', None)
            article.setdefault('also_in', [])
            article.setdefault('score_reasons', [])
            if is_generated_summary(article.get('summary')):
                article['summary'] = ''
                article['summary_source'] = ''
            elif article.get('summary') and not article.get('summary_source'):
                article['summary_source'] = 'cached'
            else:
                article.setdefault('summary_source', '')

        # A v1 file has no generated_at. Falling back to the newest article
        # timestamp keeps the app from treating every restart as a cold cache
        # and kicking off a needless scrape.
        if generated is None and articles:
            stamps = [a.get('timestamp') for a in articles if a.get('timestamp')]
            generated = max(stamps) if stamps else None

        self.articles = articles
        self.previous_by_id = {a['id']: a for a in articles if a.get('id')}
        if health and not self.health:
            self.health = {h['name']: h for h in health if h.get('name')}
        self.last_run = generated
        return articles

    def save_health(self, filename='health.json'):
        write_json_atomic(filename, {
            'checked_at': self.last_run or datetime.now().isoformat(),
            'sources': list(self.health.values()),
        })

    def load_health(self, filename='health.json'):
        data = store.read_json(filename)
        if data is None:
            return
        self.health = {h['name']: h for h in data.get('sources', [])
                       if h.get('name')}

    def health_summary(self):
        """Health for every configured source, including never-scraped ones."""
        rows = []
        for source in self.sources:
            row = self.health.get(source['name'])
            if not row:
                row = {
                    'name': source['name'],
                    'url': source.get('url', ''),
                    'tier': resolve_tier(source),
                    'category': source.get('category', ''),
                    'enabled': source.get('enabled', True) is not False,
                    'state': 'pending',
                    'articles': 0,
                    'http_status': None,
                    'error': None,
                    'attempts': 0,
                    'duration_ms': 0,
                    'checked_at': None,
                    'last_success': None,
                    'consecutive_failures': 0,
                }
            rows.append(dict(
                row,
                selector=source.get('selector', ''),
                fallback=source.get('fallback', ''),
                type=source.get('type', 'static'),
                feed_url=source.get('feed_url', ''),
            ))
        return rows

    def reload_sources(self, sources_file='sources.json'):
        self.sources = (store.read_json_seeded(sources_file) or {}).get('sources', [])
        self.source_by_name = {s['name']: s for s in self.sources}

    def get_high_signal_articles(self, min_score=80):
        return [a for a in self.articles if a['signal_score'] >= min_score]

if __name__ == "__main__":
    scraper = HighSignalScraper()
    articles = scraper.scrape_all()
    scraper.save_to_cache()
    
    high_signal = scraper.get_high_signal_articles(min_score=80)
    print(f"\n🌟 High-signal articles ({len(high_signal)}):")
    for article in high_signal[:10]:
        print(f"  • [{article['source']}] {article['title'][:60]}... (Score: {article['signal_score']})")
