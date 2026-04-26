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

// サブカテゴリ: { カテゴリID: [ { id: nodeId, name: 表示名 } ] }
const SUBCATEGORIES = {
  hpc: [
    { id: '76461051',   name: 'サプリメント・ビタミン' },
    { id: '76535051',   name: 'ダイエット・健康食品' },
    { id: '76534051',   name: '医薬品・衛生用品' },
    { id: '3776271',    name: 'スポーツ栄養食品' },
    { id: '76542051',   name: '健康器具・計測器' },
  ],
  beauty: [
    { id: '2016929051', name: 'スキンケア・フェイスケア' },
    { id: '2016930051', name: 'メイクアップ' },
    { id: '2016931051', name: 'ヘアケア・スタイリング' },
    { id: '2016932051', name: 'ボディケア' },
    { id: '2016933051', name: '香水・フレグランス' },
  ],
  electronics: [
    { id: '2127214051', name: 'テレビ・レコーダー' },
    { id: '2127216051', name: 'カメラ・ビデオカメラ' },
    { id: '2127213051', name: 'オーディオ・ヘッドフォン' },
    { id: '2127217051', name: 'スマートフォン・携帯電話' },
    { id: '2127218051', name: '照明・電気設備' },
  ],
  computers: [
    { id: '2127219051', name: 'パソコン本体' },
    { id: '2127220051', name: 'PCアクセサリ・周辺機器' },
    { id: '2127221051', name: 'プリンター・スキャナー' },
    { id: '2127222051', name: 'ネットワーク機器' },
    { id: '2127223051', name: 'PCゲーミング' },
  ],
  kitchen: [
    { id: '2016924051', name: 'キッチン用品・調理器具' },
    { id: '2016925051', name: '収納・インテリア雑貨' },
    { id: '2016926051', name: '掃除・洗濯用品' },
    { id: '2016927051', name: '寝具・ベッド用品' },
    { id: '2016928051', name: 'バス・トイレ用品' },
  ],
  sports: [
    { id: '14304371',   name: 'フィットネス・トレーニング' },
    { id: '14304381',   name: 'アウトドア・キャンプ' },
    { id: '14304391',   name: 'スポーツ用品' },
    { id: '14304401',   name: 'ゴルフ' },
    { id: '14304411',   name: '自転車・サイクリング' },
  ],
  toys: [
    { id: '2016936051', name: '乳幼児向けおもちゃ' },
    { id: '2016937051', name: '知育玩具・学習教材' },
    { id: '2016938051', name: 'ホビー・コレクション' },
    { id: '637394',     name: 'テレビゲーム' },
    { id: '2016939051', name: 'フィギュア・ドール' },
  ],
  'food-beverage': [
    { id: '2427015051', name: '飲料・お酒' },
    { id: '2427016051', name: 'お菓子・スナック' },
    { id: '2427017051', name: 'パスタ・シリアル・調理食品' },
    { id: '2427018051', name: '調味料・料理の素' },
    { id: '2427019051', name: '健康食品・オーガニック' },
  ],
  books: [
    { id: '466284',     name: '文学・評論' },
    { id: '466282',     name: 'ビジネス・経済' },
    { id: '466294',     name: '趣味・実用' },
    { id: '466290',     name: '資格・検定・就職' },
    { id: '466286',     name: 'コミック・ラノベ' },
  ],
  clothing: [
    { id: '352484011',  name: 'レディースファッション' },
    { id: '352483011',  name: 'メンズファッション' },
    { id: '2016968051', name: 'バッグ・財布' },
    { id: '2016969051', name: 'シューズ' },
    { id: '2016970051', name: 'アクセサリー・時計' },
  ],
};

// サブカテゴリ一覧API
app.get('/api/subcategories', (req, res) => {
  const category = req.query.category;
  const subs = SUBCATEGORIES[category] || [];
  res.json({ subcategories: subs });
});

// 1カテゴリ・1ページ分のHTMLから商品を抽出
function parseProducts(html, categoryId, categoryName, subcatName, pageOffset = 0) {
  const rankMatches        = [...html.matchAll(/zg-bdg-text[^>]*>\s*#([0-9]+)/g)].map(m => parseInt(m[1]));
  const titleMatches       = [...html.matchAll(/_cDEzb_p13n-sc-css-line-clamp-[0-9]+_[^>]+>([^<]{10,250})/g)].map(m => m[1].trim());
  const priceMatches       = [...html.matchAll(/_cDEzb_p13n-sc-price_[^>]+>\s*(￥[0-9,]+)/g)].map(m => m[1]);
  const ratingMatches      = [...html.matchAll(/([0-9.]+)つ星のうち([0-9.]+)/g)].map(m => m[2]);
  const reviewCountMatches = [...html.matchAll(/([0-9,]+)個の評価/g)].map(m => m[1]);
  const asinMatches        = [...new Set([...html.matchAll(/data-asin="([A-Z0-9]{10})"/g)].map(m => m[1]))];

  const displayCatName = subcatName ? `${categoryName} > ${subcatName}` : categoryName;

  return asinMatches.map((asin, i) => ({
    rank:          rankMatches[i]        || (pageOffset + i + 1),
    asin,
    title:         titleMatches[i]       || '-',
    price:         priceMatches[i]       || '-',
    rating:        ratingMatches[i]      || '-',
    review_count:  reviewCountMatches[i] || '-',
    category_id:   categoryId,
    category_name: displayCatName,
    url:           `https://www.amazon.co.jp/dp/${asin}`,
  }));
}

// 1カテゴリ分（最大100件）を取得。subcatId があればサブカテゴリURL
async function fetchCategory(period, categoryId, subcatId = '') {
  const catName    = CATEGORIES[categoryId];
  const subcatName = subcatId
    ? (SUBCATEGORIES[categoryId] || []).find(s => s.id === subcatId)?.name || ''
    : '';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ja-JP,ja;q=0.9',
    'Accept-Encoding': 'identity',
    'Accept': 'text/html',
  };

  const products = [];
  for (const pg of [1, 2]) {
    const basePath = subcatId
      ? `${period}/${categoryId}/${subcatId}`
      : `${period}/${categoryId}`;
    const url = `https://www.amazon.co.jp/gp/${basePath}/ref=zg_bs_pg_${pg}?ie=UTF8&pg=${pg}`;
    try {
      const res = await fetch(url, { headers });
      const html = await res.text();
      const items = parseProducts(html, categoryId, catName, subcatName, (pg - 1) * 50);
      products.push(...items);
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      // ページ取得失敗は無視して続行
    }
  }
  return products;
}

// Amazon トレンドランキング取得（単一カテゴリ・サブカテゴリ対応）
app.get('/api/trends', async (req, res) => {
  const category = req.query.category || 'hpc';
  const period   = req.query.period   || 'bestsellers';
  const subcat   = req.query.subcat   || '';

  if (!CATEGORIES[category] || !['bestsellers','new-releases'].includes(period)) {
    return res.status(400).json({ error: 'invalid parameter' });
  }

  try {
    const products = await fetchCategory(period, category, subcat);
    res.json({ products, category, period, subcat });
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
      const header = 'カテゴリ,順位,ASIN,商品名,価格,評価,レビュー件数,URL\n';
      const rows = allProducts.map(p => {
        const title = p.title.replace(/"/g, '""');
        return `"${p.category_name}",${p.rank},"${p.asin}","${title}","${p.price}","${p.rating}","${p.review_count}","${p.url}"`;
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
