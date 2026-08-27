import requests
from bs4 import BeautifulSoup
import cloudscraper
import json
import hashlib
from datetime import datetime
import time
import random
from urllib.parse import urljoin
import re

class HighSignalScraper:
    def __init__(self, sources_file='sources.json'):
        with open(sources_file, 'r') as f:
            data = json.load(f)
            self.sources = data.get('sources', [])
        
        self.articles = []
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
        
        return soup.find_all('a', href=True)[:20]
    
    def extract_articles_from_items(self, items, source):
        articles = []
        seen_titles = set()
        
        for item in items[:15]:
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
                    continue
                
                if not link.startswith('http'):
                    link = urljoin(source['url'], link)
                
                title_key = title[:50].lower()
                if title_key in seen_titles:
                    continue
                seen_titles.add(title_key)
                
                articles.append({
                    'title': title[:200],
                    'link': link,
                    'source': source['name'],
                    'type': source.get('type', 'static'),
                    'timestamp': datetime.now().isoformat(),
                    'id': hashlib.md5(f"{title}{link}".encode()).hexdigest(),
                    'summary': '',
                    'signal_score': self.calculate_signal_score(source['name'], title)
                })
                
            except Exception as e:
                continue
        
        return articles
    
    def calculate_signal_score(self, source_name, title):
        high_signal_sources = [
            'Import AI', 'Stratechery', 'Techmeme', 'Hacker News',
            'The Rundown AI', "Ben's Bites", 'The Algorithm'
        ]
        medium_signal = [
            'AI Breakfast', 'Last Week in AI', 'Deep Learning Weekly',
            'AI Weekly', 'Exploding Topics', 'TLDR Newsletter'
        ]
        
        if source_name in high_signal_sources:
            base_score = 95
        elif source_name in medium_signal:
            base_score = 85
        else:
            base_score = 75
        
        if any(word in title.lower() for word in ['breakthrough', 'state-of-the-art', 'new', 'research']):
            base_score += 5
        if '?' in title:
            base_score -= 5
        
        return min(max(base_score, 0), 100)
    
    def scrape_source(self, source):
        max_retries = 3
        for attempt in range(max_retries):
            try:
                headers = {'User-Agent': random.choice(self.user_agents)}
                
                if 'reddit' in source['url']:
                    headers['User-Agent'] = 'Mozilla/5.0 (compatible; RedditBot/1.0)'
                
                response = self.scraper.get(
                    source['url'], 
                    headers=headers, 
                    timeout=20,
                    allow_redirects=True
                )
                
                if response.status_code == 200:
                    soup = BeautifulSoup(response.text, 'html.parser')
                    items = self.scrape_with_selectors(source, soup)
                    articles = self.extract_articles_from_items(items, source)
                    
                    if articles:
                        print(f"✅ {source['name']}: {len(articles)} articles")
                        return articles
                
                time.sleep(random.uniform(1, 3))
                
            except Exception as e:
                print(f"❌ {source['name']} (attempt {attempt+1}): {str(e)[:100]}")
                time.sleep(random.uniform(2, 5))
        
        return []
    
    def scrape_all(self):
        all_articles = []
        total_sources = len(self.sources)
        
        print(f"\n🚀 Starting scrape of {total_sources} high-signal sources...\n")
        
        for idx, source in enumerate(self.sources, 1):
            print(f"[{idx}/{total_sources}] Scraping: {source['name']}...")
            articles = self.scrape_source(source)
            all_articles.extend(articles)
            time.sleep(random.uniform(0.5, 2))
        
        unique_articles = []
        seen_ids = set()
        for article in all_articles:
            if article['id'] not in seen_ids:
                seen_ids.add(article['id'])
                unique_articles.append(article)
        
        unique_articles.sort(key=lambda x: x['signal_score'], reverse=True)
        
        self.articles = unique_articles
        print(f"\n✅ Scraped {len(unique_articles)} unique articles from {total_sources} sources")
        
        return unique_articles
    
    def save_to_cache(self, filename='cache.json'):
        with open(filename, 'w') as f:
            json.dump(self.articles, f, indent=2)
        print(f"💾 Saved {len(self.articles)} articles to cache")
    
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