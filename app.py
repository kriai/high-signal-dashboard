from flask import Flask, render_template, jsonify, request
from scraper import HighSignalScraper
import json
from apscheduler.schedulers.background import BackgroundScheduler
import atexit
from datetime import datetime

app = Flask(__name__)
scraper = HighSignalScraper()
cached_articles = []

def scrape_and_cache():
    global cached_articles
    print("🔄 Running scheduled scrape...")
    articles = scraper.scrape_all()
    
    for article in articles[:30]:
        if not article.get('summary'):
            article['summary'] = f"From {article['source']}: {article['title'][:150]}..."
    
    cached_articles = articles
    scraper.save_to_cache()
    print(f"✅ Cached {len(articles)} articles")

scheduler = BackgroundScheduler()
scheduler.add_job(func=scrape_and_cache, trigger="interval", minutes=30)
scheduler.start()
scrape_and_cache()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/articles')
def get_articles():
    limit = request.args.get('limit', 50, type=int)
    source = request.args.get('source', '')
    min_score = request.args.get('min_score', 0, type=int)
    
    articles = cached_articles
    
    if source:
        articles = [a for a in articles if a['source'] == source]
    
    if min_score:
        articles = [a for a in articles if a.get('signal_score', 0) >= min_score]
    
    return jsonify(articles[:limit])

@app.route('/api/sources')
def get_sources():
    sources = {}
    for article in cached_articles:
        source = article['source']
        if source not in sources:
            sources[source] = 0
        sources[source] += 1
    
    return jsonify([{'name': k, 'count': v} for k, v in sources.items()])

@app.route('/api/high_signal')
def get_high_signal():
    articles = [a for a in cached_articles if a.get('signal_score', 0) >= 80]
    return jsonify(articles[:30])

@app.route('/api/refresh', methods=['POST'])
def refresh():
    scrape_and_cache()
    return jsonify({'status': 'success', 'count': len(cached_articles)})

@app.route('/api/stats')
def get_stats():
    sources = set([a['source'] for a in cached_articles])
    high_signal = [a for a in cached_articles if a.get('signal_score', 0) >= 80]
    
    return jsonify({
        'total_articles': len(cached_articles),
        'total_sources': len(sources),
        'high_signal_count': len(high_signal),
        'last_update': datetime.now().isoformat()
    })

atexit.register(lambda: scheduler.shutdown())

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)