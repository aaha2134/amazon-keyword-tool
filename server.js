const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Amazon JP オートコンプリート候補 (Google Suggest経由)
app.get('/api/suggest', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ suggestions: [] });

  try {
    const url = `https://suggestqueries.google.com/complete/search?output=toolbar&hl=ja&q=${encodeURIComponent('amazon ' + q)}&gl=jp`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ja-JP,ja;q=0.9' }
    });
    const xml = await response.text();
    const matches = [...xml.matchAll(/data="([^"]+)"/g)];
    const suggestions = matches
      .map(m => m[1].replace(/^amazon\s*/i, '').trim())
      .filter(s => s.length > 0);
    res.json({ suggestions: [...new Set(suggestions)].slice(0, 10) });
  } catch (e) {
    res.json({ suggestions: [] });
  }
});

// Google Suggest を使ったAmazonキーワード取得
app.get('/api/keywords', async (req, res) => {
  const keyword = req.query.q;
  if (!keyword) return res.json({ keywords: [] });

  try {
    // "amazon キーワード" でGoogle Suggestを叩くとAmazon検索キーワードが取れる
    const queries = [
      `amazon ${keyword}`,
      `${keyword} amazon`,
    ];

    const allKeywords = new Set();

    for (const q of queries) {
      const url = `https://suggestqueries.google.com/complete/search?output=toolbar&hl=ja&q=${encodeURIComponent(q)}&gl=jp`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const xml = await response.text();
      const matches = [...xml.matchAll(/data="([^"]+)"/g)];
      matches.forEach(m => {
        // "amazon " プレフィックスを除去してキーワードだけ残す
        const kw = m[1].replace(/^amazon\s*/i, '').replace(/\s*amazon$/i, '').trim();
        if (kw) allKeywords.add(kw);
      });
    }

    res.json({ keywords: [...allKeywords] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Amazon Japan 検索結果（競合商品）プロキシ
app.get('/api/competitors', async (req, res) => {
  const keyword = req.query.q;
  if (!keyword) return res.json({ products: [] });

  try {
    const url = `https://www.amazon.co.jp/s?k=${encodeURIComponent(keyword)}&language=ja_JP`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9',
        'Accept': 'text/html',
      }
    });
    const html = await response.text();

    // aria-label からタイトルとレビュー情報を抽出
    const titleAriaRegex = /aria-label="([^"]{15,300})"/g;
    const reviewAriaRegex = /aria-label="([0-9,]+)件のレビューで星5つ中([0-9.]+)と評価されました"/g;

    // タイトル候補（ナビゲーション・UI・広告文言を除外）
    const skipWords = ['ショートカット', 'スポンサー', '言語を選択', 'ベストセラー', '評価されました',
      'レビューセクション', 'Amazon日本', '広告フィードバック', 'カテゴリ', 'Alt', 'shift',
      'フォーワード', '注文履歴', '検索、', 'ホーム、', 'オトク', 'おトク便'];
    const allLabels = [...html.matchAll(titleAriaRegex)].map(m => m[1]);
    const productTitles = allLabels.filter(l =>
      !skipWords.some(w => l.includes(w)) &&
      l.length > 15 &&
      l.length < 250
    );

    // レビュー数と評価
    const reviewData = [...html.matchAll(reviewAriaRegex)].map(m => ({
      count: m[1],
      rating: m[2]
    }));

    // ASIN抽出（重複除去）
    const asinRegex = /data-asin="([A-Z0-9]{10})"/g;
    const asins = [...new Set([...html.matchAll(asinRegex)].map(m => m[1]))];

    // 価格抽出
    const priceRegex = /class="a-price-whole">([0-9,]+)/g;
    const prices = [...html.matchAll(priceRegex)].map(m => m[1]);

    const products = [];
    asins.slice(0, 10).forEach((asin, i) => {
      products.push({
        asin,
        title: productTitles[i] || '-',
        price: prices[i] ? `¥${prices[i]}` : '-',
        reviews: reviewData[i] ? `${reviewData[i].count}件 (★${reviewData[i].rating})` : '-',
        url: `https://www.amazon.co.jp/dp/${asin}`
      });
    });

    res.json({ products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const CATEGORIES = {
  electronics:    '家電・カメラ',
  computers:      'パソコン・周辺機器',
  hpc:            'ドラッグストア・ヘルスケア',
  toys:           'おもちゃ',
  sports:         'スポーツ・アウトドア',
  kitchen:        'ホーム・キッチン',
  beauty:         'コスメ・美容',
  'food-beverage':'食品・飲料',
  books:          '本',
  clothing:       '服・ファッション',
};

// 1カテゴリ・1ページ分のHTMLから商品を抽出
function parseProducts(html, categoryId, categoryName, pageOffset = 0) {
  const rankMatches  = [...html.matchAll(/zg-bdg-text[^>]*>\s*#([0-9]+)/g)].map(m => parseInt(m[1]));
  const titleMatches = [...html.matchAll(/_cDEzb_p13n-sc-css-line-clamp-[0-9]+_[^>]+>([^<]{10,250})/g)].map(m => m[1].trim());
  const priceMatches = [...html.matchAll(/_cDEzb_p13n-sc-price_[^>]+>\s*(￥[0-9,]+)/g)].map(m => m[1]);
  const ratingMatches= [...html.matchAll(/([0-9.]+)つ星のうち([0-9.]+)/g)].map(m => m[2]);
  const asinMatches  = [...new Set([...html.matchAll(/data-asin="([A-Z0-9]{10})"/g)].map(m => m[1]))];

  return asinMatches.map((asin, i) => ({
    rank:         rankMatches[i]  || (pageOffset + i + 1),
    asin,
    title:        titleMatches[i] || '-',
    price:        priceMatches[i] || '-',
    rating:       ratingMatches[i]|| '-',
    category_id:  categoryId,
    category_name:categoryName,
    url:          `https://www.amazon.co.jp/dp/${asin}`,
  }));
}

// 1カテゴリ分（最大100件）を取得
async function fetchCategory(period, categoryId) {
  const catName = CATEGORIES[categoryId];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ja-JP,ja;q=0.9',
    'Accept-Encoding': 'identity',
    'Accept': 'text/html',
  };

  const products = [];
  for (const pg of [1, 2]) {
    const url = `https://www.amazon.co.jp/gp/${period}/${categoryId}/ref=zg_bs_pg_${pg}?ie=UTF8&pg=${pg}`;
    try {
      const res = await fetch(url, { headers });
      const html = await res.text();
      const items = parseProducts(html, categoryId, catName, (pg - 1) * 50);
      products.push(...items);
      // Amazon に負荷をかけないよう少し待つ
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      // ページ取得失敗は無視して続行
    }
  }
  return products;
}

// Amazon トレンドランキング取得（単一カテゴリ）
app.get('/api/trends', async (req, res) => {
  const category = req.query.category || 'hpc';
  const period   = req.query.period   || 'bestsellers';

  if (!CATEGORIES[category] || !['bestsellers','new-releases'].includes(period)) {
    return res.status(400).json({ error: 'invalid parameter' });
  }

  try {
    const products = await fetchCategory(period, category);
    res.json({ products, category, period });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 全カテゴリ一括取得（最大1000件）＋ CSV
app.get('/api/trends/all', async (req, res) => {
  const period = req.query.period || 'bestsellers';
  if (!['bestsellers','new-releases'].includes(period)) {
    return res.status(400).json({ error: 'invalid parameter' });
  }

  const fmt = req.query.fmt || 'json'; // json | csv

  try {
    const allProducts = [];
    for (const catId of Object.keys(CATEGORIES)) {
      const items = await fetchCategory(period, catId);
      allProducts.push(...items);
    }

    if (fmt === 'csv') {
      const periodLabel = period === 'bestsellers' ? '売れ筋' : '新着ヒット';
      const dateStr = new Date().toISOString().slice(0,10);
      const filename = `amazon_trend_${periodLabel}_${dateStr}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

      // BOM付きUTF-8（Excelで文字化けしない）
      const BOM = '\uFEFF';
      const header = 'カテゴリ,順位,ASIN,商品名,価格,評価,URL\n';
      const rows = allProducts.map(p => {
        const title = p.title.replace(/"/g, '""');
        return `"${p.category_name}",${p.rank},"${p.asin}","${title}","${p.price}","${p.rating}","${p.url}"`;
      }).join('\n');

      res.send(BOM + header + rows);
    } else {
      res.json({ products: allProducts, total: allProducts.length });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
});
