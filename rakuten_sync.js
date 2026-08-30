/**
 * ネイルピタ 商品データ連携バッチ(楽天版)
 *
 * 必要なもの:
 *   1. RAKUTEN_APP_ID     … 楽天ウェブサービスのアプリケーションID
 *   2. RAKUTEN_ACCESS_KEY … 楽天ウェブサービスのアクセスキー(2026年の仕様変更で必須になったもの)
 *   3. RAKUTEN_AFFILIATE_ID … 楽天アフィリエイトのID
 *
 * 実行イメージ:
 *   RAKUTEN_APP_ID=xxx RAKUTEN_ACCESS_KEY=yyy RAKUTEN_AFFILIATE_ID=zzz node rakuten_sync.js
 *
 * 必要なライブラリ: npm install sharp undici
 * (fetchはNode.js標準搭載だが、Origin/Refererヘッダを確実に送るためundiciを使用)
 */

const sharp = require('sharp');
const fs = require('fs');
const { request: undiciRequest } = require('undici');

const APP_ID = process.env.RAKUTEN_APP_ID;
const ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID;
// 楽天デベロッパーコンソールの「アプリケーションURL」と同じドメインを指定
const SITE_ORIGIN = process.env.RAKUTEN_SITE_ORIGIN || 'https://github.com/kiyononail-crypto/nailpita-prototype';
const OUTPUT_PATH = 'products.json';

// バッチで巡回する検索キーワード(トレンドに応じて増減させる想定)
const SEARCH_KEYWORDS = [
  'ジェルカラー',
  'ジェルネイル パーツ',
  'ネイルストーン',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- ① 楽天商品検索APIから商品を取得(2026年新仕様: openapi.rakuten.co.jp + accessKey) ---
async function fetchRakutenProducts(keyword, page = 1, retriesLeft = 3) {
  const endpoint = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
  const params = new URLSearchParams({
    applicationId: APP_ID,
    accessKey: ACCESS_KEY, // ヘッダーに加えてクエリにも含めておく(仕様のブレに対する保険)
    affiliateId: AFFILIATE_ID, // これを付けると商品URLに自動でアフィリエイトIDが反映される
    keyword,
    page: String(page),
    hits: '30',
    format: 'json',
    formatVersion: '2',
    sort: '-updateTimestamp', // 新着・更新順(トレンド反映)
  });
  const url = `${endpoint}?${params.toString()}`;

  const { statusCode, body } = await undiciRequest(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'nailpita-prototype/1.0',
      Origin: SITE_ORIGIN,
      Referer: SITE_ORIGIN,
      accessKey: ACCESS_KEY,
    },
  });

  // レート制限にかかった場合は、少し待って自動で再試行する
  if (statusCode === 429 && retriesLeft > 0) {
    const errorText = await body.text();
    let waitMs = 2000;
    try {
      const parsed = JSON.parse(errorText);
      const match = /(\d+)\s*seconds?/.exec(parsed.message || '');
      if (match) waitMs = (Number(match[1]) + 1) * 1000; // 指定秒数+1秒待つ
    } catch {
      /* パース失敗時はデフォルトの待機時間を使う */
    }
    console.log(`  レート制限のため ${waitMs}ms 待機して再試行します(残り${retriesLeft}回)`);
    await sleep(waitMs);
    return fetchRakutenProducts(keyword, page, retriesLeft - 1);
  }

  if (statusCode < 200 || statusCode >= 300) {
    const errorText = await body.text();
    throw new Error(`楽天API呼び出し失敗: ${statusCode} ${errorText}`);
  }

  const data = await body.json();
  return (data.Items || []).map((entry) => {
    const item = entry.Item || entry; // formatVersion=2ではItemでラップされず直接オブジェクトになる
    const firstImage = item.mediumImageUrls?.[0];
    // formatVersion=2ではmediumImageUrlsが文字列の配列になる(旧仕様は{imageUrl:"..."}のオブジェクト配列)
    const rawImageUrl = typeof firstImage === 'string' ? firstImage : firstImage?.imageUrl;
    return {
      productId: item.itemCode,
      name: item.itemName,
      price: item.itemPrice,
      imageUrl: (rawImageUrl || '').replace('?_ex=128x128', ''),
      affiliateUrl: item.affiliateUrl || item.itemUrl, // affiliateIdを渡していればここに反映済みのリンクが入る
      aspSource: '楽天',
    };
  });
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
  if (!APP_ID || !ACCESS_KEY || !AFFILIATE_ID) {
    console.error('RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID を環境変数に設定してください');
    return;
  }

  // 既存データをproductIdでMap化(同じ商品は上書き更新、新商品は追加)
  const existing = loadExistingProducts();
  const productMap = new Map(existing.map((p) => [p.productId, p]));

  for (const keyword of SEARCH_KEYWORDS) {
    console.log(`--- 「${keyword}」を検索中 ---`);
    const items = await fetchRakutenProducts(keyword);
    await sleep(1000); // 次のキーワード検索まで1秒あける(レート制限対策)

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
