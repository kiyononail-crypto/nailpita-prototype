/**
 * ネイルピタ 商品データ連携バッチ(楽天版)
 *
 * 必要なもの:
 *   1. RAKUTEN_APP_ID    … 楽天ウェブサービス(https://webservice.rakuten.co.jp/)のApplication ID
 *   2. RAKUTEN_AFFILIATE_ID … 楽天アフィリエイトのID(登録済みのもの)
 *
 * 実行イメージ:
 *   RAKUTEN_APP_ID=xxx RAKUTEN_AFFILIATE_ID=yyy node rakuten_sync.js
 *
 * 必要なライブラリ: npm install node-fetch sharp
 */

const fetch = require('node-fetch');
const sharp = require('sharp');
const fs = require('fs');

const OUTPUT_PATH = 'products.json';

const APP_ID = process.env.RAKUTEN_APP_ID;
const AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID;

// バッチで巡回する検索キーワード(トレンドに応じて増減させる想定)
const SEARCH_KEYWORDS = [
  'ジェルカラー',
  'ジェルネイル パーツ',
  'ネイルストーン',
];

// --- ① 楽天商品検索APIから商品を取得 ---
async function fetchRakutenProducts(keyword, page = 1) {
  const url = new URL('https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601');
  url.searchParams.set('applicationId', APP_ID);
  url.searchParams.set('affiliateId', AFFILIATE_ID); // これを付けると商品URLに自動でアフィリエイトIDが反映される
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('page', String(page));
  url.searchParams.set('hits', '30');
  url.searchParams.set('sort', '-updateTimestamp'); // 新着・更新順(トレンド反映)

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`楽天API呼び出し失敗: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.Items || []).map(({ Item }) => ({
    productId: Item.itemCode,
    name: Item.itemName,
    price: Item.itemPrice,
    imageUrl: (Item.mediumImageUrls?.[0]?.imageUrl || '').replace('?_ex=128x128', ''),
    affiliateUrl: Item.affiliateUrl || Item.itemUrl, // affiliateIdを渡していればここに反映済みのリンクが入る
    aspSource: '楽天',
  }));
}

// --- ② 商品画像から代表色を自動抽出(Lab値の簡易版としてRGBを保存) ---
async function extractDominantColor(imageUrl) {
  const res = await fetch(imageUrl);
  const buffer = Buffer.from(await res.arrayBuffer());

  // 60x60にリサイズしてから平均色を計算(処理を軽くするため)
  const { data, info } = await sharp(buffer)
    .resize(60, 60, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0, g = 0, b = 0;
  const pixelCount = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  r = Math.round(r / pixelCount);
  g = Math.round(g / pixelCount);
  b = Math.round(b / pixelCount);

  const toHex = (v) => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// --- ③ シーン・テーマの簡易タグ付け(ルールベース、第一段階) ---
function assignSceneTags(name) {
  const tags = [];
  if (/シンプル|オフィス|ワンカラー/.test(name)) tags.push('オフィス・シンプル');
  if (/パール|ストーン|ロング|ラグジュアリー/.test(name)) tags.push('ロングネイル・ラグジュアリー');
  if (/クリスマス|桜|ハロウィン|春|夏|秋|冬/.test(name)) tags.push('シーン季節のネイルアート');
  return tags;
}

// --- ④ 商品データの保存
// 本格的なDBを用意するまでの間は、リポジトリ内のproducts.jsonに書き出す方式にしている。
// (GitHub Actionsでこのファイルを自動コミットすれば、簡易的な「商品DB」として機能する)
function loadExistingProducts() {
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveProducts(products) {
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(products, null, 2));
}

// --- 実行本体 ---
async function runBatch() {
  if (!APP_ID || !AFFILIATE_ID) {
    console.error('RAKUTEN_APP_ID / RAKUTEN_AFFILIATE_ID を環境変数に設定してください');
    return;
  }

  // 既存データをproductIdでMap化(同じ商品は上書き更新、新商品は追加)
  const existing = loadExistingProducts();
  const productMap = new Map(existing.map((p) => [p.productId, p]));

  for (const keyword of SEARCH_KEYWORDS) {
    console.log(`--- 「${keyword}」を検索中 ---`);
    const items = await fetchRakutenProducts(keyword);

    for (const item of items) {
      try {
        const hexColor = item.imageUrl ? await extractDominantColor(item.imageUrl) : null;
        const sceneTags = assignSceneTags(item.name);

        productMap.set(item.productId, {
          ...item,
          hexColor,
          sceneTags,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`商品処理エラー(${item.name}):`, err.message);
      }
    }
  }

  const merged = Array.from(productMap.values());
  saveProducts(merged);
  console.log(`完了: ${merged.length}件の商品データを ${OUTPUT_PATH} に保存しました`);
}

runBatch();
