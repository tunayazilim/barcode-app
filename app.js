require("dotenv").config();
const express = require("express");
const path = require("path");
const axios = require("axios");
const PDFDocument = require("pdfkit");
const qs = require("querystring");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// sağlık testi
app.get("/health", (req, res) => res.json({ ok: true }));

// ===== T-Soft (Rest1) ayarları (ENV'den okunur) =====
const TS_BASE_URL = process.env.TS_BASE_URL || "https://maxstyle.com.tr";
const TS_API_PREFIX = process.env.TS_API_PREFIX || "/rest1";
const TS_USERNAME = process.env.TS_USERNAME || "barcode";
const TS_PASSWORD = process.env.TS_PASSWORD || "Barcode2026";

// token cache (memory)
let tsToken = null;
let tsTokenExp = 0; // epoch seconds

function tsUrl(apiPath) {
  const base = TS_BASE_URL.replace(/\/$/, "");
  const pref = TS_API_PREFIX.startsWith("/") ? TS_API_PREFIX : `/${TS_API_PREFIX}`;
  const p = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return `${base}${pref}${p}`;
}

async function tsLogin() {
  if (!TS_USERNAME || !TS_PASSWORD) {
    throw new Error("T-Soft env eksik: TS_USERNAME / TS_PASSWORD");
  }

  const url = tsUrl(`/auth/login/${encodeURIComponent(TS_USERNAME)}`);
  const body = qs.stringify({ pass: TS_PASSWORD });

  const r = await axios.post(url, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    timeout: 10000,
  });

  const token = r?.data?.data?.[0]?.token;
  if (!token) {
    throw new Error("T-Soft login başarılı ama token bulunamadı (response formatı farklı olabilir).");
  }

  tsToken = token;
  tsTokenExp = Math.floor(Date.now() / 1000) + 25 * 60; // 25 dk cache
  return token;
}

async function tsGetToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tsToken && tsTokenExp - 30 > now) return tsToken; // 30 sn buffer
  return tsLogin();
}

async function tsCall(method, apiPath, params = {}) {
  const token = await tsGetToken();
  const url = tsUrl(apiPath);

  const withToken = { token, ...params };

  if (method === "GET") {
    const r = await axios.get(url, { params: withToken, timeout: 10000 });
    return r.data;
  }

  const body = qs.stringify(withToken);
  const r = await axios.post(url, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    timeout: 10000,
  });
  return r.data;
}

function pickFirstProduct(json) {
  const d = json?.data;

  if (Array.isArray(d) && d.length) {
    if (d[0] && typeof d[0] === "object" && !Array.isArray(d[0])) return d[0];
    if (d[0]?.Products && Array.isArray(d[0].Products) && d[0].Products.length) return d[0].Products[0];
  }

  if (d?.Products && Array.isArray(d.Products) && d.Products.length) return d.Products[0];

  return null;
}

function mapProduct(p, barcodeFallback) {
  const name = p.ProductName || p.Name || p.Title || p.productName || "Ürün";
  const stockCode = p.StockCode || p.Stockcode || p.Sku || p.Code || p.ProductCode || "";

  const priceCandidates = [
    p.VatIncludedSellingPrice,
    p.VatIncludedSalePrice,
    p.VatIncludedPrice,
    p.SalePriceVatIncluded,
    p.SellingPriceVatIncluded,
    p.SalePrice,
    p.Price,
    p.SellingPrice,
  ].filter(v => v !== undefined && v !== null);

  const price = priceCandidates.length ? Number(priceCandidates[0]) : 0;
  const stock = Number(p.Stock ?? p.Quantity ?? p.TotalStock ?? 0);

  // ===== GÖRSEL ÇÖZÜMÜ =====
  // Not: T-Soft alanları entegrasyona göre değişebiliyor.
  // Bu blok: mümkün olan tüm varyasyonlardan "uzantılı" gerçek görsel URL'ini seçmeye çalışır.

  const candidates = [];

  // Array(object) varyasyonları
  const pushFromArray = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      if (!it) continue;
      if (typeof it === "string") {
        candidates.push(it);
        continue;
      }
      if (typeof it === "object") {
        candidates.push(
          it.ImageUrl,
          it.ImagePath,
          it.Path,
          it.Url,
          it.BigImageUrl,
          it.BigImagePath,
          it.OriginalImageUrl,
          it.OriginalImagePath
        );
      }
    }
  };

  pushFromArray(p.ImageUrls);
  pushFromArray(p.Images);
  pushFromArray(p.ProductImages);
  pushFromArray(p.ProductPictures);
  pushFromArray(p.Pictures);

  // Tekil alanlar
  candidates.push(
    p.ImageUrl,
    p.Image,
    p.PictureUrl,
    p.Picture,
    p.BigImageUrl,
    p.BigImage,
    p.MainImageUrl,
    p.MainImage
  );

  // temizle
  const cleaned = candidates
    .filter(Boolean)
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0);

  let imageUrl = cleaned[0] || "";

  // 1) Öncelik: uzantılı URL (jpg/png/webp) içeren ilk aday
  const extRe = /\.(jpg|jpeg|png|webp)$/i;
  const best = cleaned.find((x) => extRe.test(x));
  if (best) imageUrl = best;

  // 2) Relative path → CDN
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    const clean = imageUrl.replace(/^\/+/, "");
    // Bazı cevaplar zaten "Data/B/D22/3836.jpg" gibi gelir, bazıları sadece "D22/3836.jpg" gelir.
    if (clean.toLowerCase().startsWith("data/")) {
      imageUrl = `https://maxstyle.tsoftcdn.com/${clean}`;
    } else {
      imageUrl = `https://maxstyle.tsoftcdn.com/Data/B/${clean}`;
    }
  }

  // 3) maxstyle.com.tr → CDN
  if (imageUrl.startsWith("https://maxstyle.com.tr/")) {
    imageUrl = imageUrl.replace(
      "https://maxstyle.com.tr/",
      "https://maxstyle.tsoftcdn.com/Data/B/"
    );
  }

  // 4) SEO slug/uzantısız URL geldiyse:
  //    - önce ".jpg" dene (bazı CDN'lerde çalışıyor)
  //    - yine de uzantı yoksa boşalt (placeholder'a düşsün)
  if (imageUrl && !extRe.test(imageUrl)) {
    const tryJpg = `${imageUrl}.jpg`;
    // burada HEAD atıp doğrulamak mümkün ama Hostinger ortamında ek latency yaratır.
    // Kullanıcı tarafında onerror ile placeholder'a düşeceği için hızlı çözüm: .jpg ekle.
    imageUrl = extRe.test(tryJpg) ? tryJpg : "";
  }

  // 5) HÂLÂ YOKSA → placeholder (UX için şart)
  if (!imageUrl) {
    imageUrl = "https://via.placeholder.com/400x400.png?text=Gorsel+Yok";
  }

  const cur = String(p.Currency || "TRY").toUpperCase();

  return {
    barcode: String(p.Barcode || p.ProductBarcode || barcodeFallback || ""),
    stockCode,
    name,
    price: Number.isFinite(price) ? Number(price.toFixed(2)) : 0,
    stock,
    imageUrl,
    currency: cur === "TL" ? "TRY" : cur,
  };
}



// ===== Ürün endpoint'i (T-Soft) =====
app.get("/api/product", async (req, res) => {
  const barcode = String(req.query.barcode || "").trim();
  if (!barcode) return res.status(400).json({ error: "barcode gerekli" });

  try {
    const tries = [
      ["POST", "/product/getProductByBarcode", { barcode }],
      ["POST", "/product/getProductByBarcode", { Barcode: barcode }],
      ["POST", "/product/getProducts", { Barcode: barcode, Page: 1, PageSize: 1, FetchImageUrls: "true" }],
      ["GET", "/product/getProductByBarcode", { barcode }],
    ];

    for (const [m, apiPath, params] of tries) {
      const json = await tsCall(m, apiPath, params);
      const p = pickFirstProduct(json);
      if (p) return res.json({ source: "tsoft", product: mapProduct(p, barcode) });
    }

    return res.status(404).json({ error: "Ürün bulunamadı" });
  } catch (e) {
    return res.status(502).json({ error: "Upstream hata", detail: String(e.message || e) });
  }
});

// ===== PDF endpoint'i =====
app.post("/api/pdf", async (req, res) => {
  try {
    const body = req.body || {};
    const customer = body.customer || {};
    const items = Array.isArray(body.items) ? body.items : [];

    if (!items.length) return res.status(400).json({ error: "Sepet boş. PDF üretilemez." });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="siparis-formu.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    doc.fontSize(18).text("Sipariş / Teklif Formu");
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Tarih: ${new Date().toLocaleString("tr-TR")}`);
    doc.moveDown(0.8);

    doc.fontSize(12).text("Müşteri Bilgileri", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Ad: ${customer.name || "-"}`);
    doc.fontSize(10).text(`Telefon: ${customer.phone || "-"}`);
    if (customer.note) doc.fontSize(10).text(`Not: ${customer.note}`);
    doc.moveDown(0.8);

    doc.fontSize(12).text("Ürünler", { underline: true });
    doc.moveDown(0.4);

    const startX = 40;
    let y = doc.y;
    const col = { name: startX, barcode: startX + 260, qty: startX + 390, price: startX + 430, total: startX + 500 };

    doc.fontSize(9).text("Ürün", col.name, y);
    doc.text("Barkod", col.barcode, y);
    doc.text("Adet", col.qty, y, { width: 30, align: "right" });
    doc.text("Fiyat", col.price, y, { width: 60, align: "right" });
    doc.text("Tutar", col.total, y, { width: 60, align: "right" });

    y += 14;
    doc.moveTo(startX, y).lineTo(555, y).stroke();
    y += 8;

    let grandTotal = 0;
    for (const it of items) {
      const name = (it.name || "-").slice(0, 45);
      const b = String(it.barcode || "-");
      const qty = Number(it.qty || 0);
      const price = Number(it.price || 0);
      const total = qty * price;
      grandTotal += total;

      doc.fontSize(9).text(name, col.name, y);
      doc.text(b, col.barcode, y);
      doc.text(String(qty), col.qty, y, { width: 30, align: "right" });
      doc.text(price.toFixed(2), col.price, y, { width: 60, align: "right" });
      doc.text(total.toFixed(2), col.total, y, { width: 60, align: "right" });

      y += 16;
      if (y > 760) { doc.addPage(); y = 60; }
    }

    y += 10;
    doc.moveTo(startX, y).lineTo(555, y).stroke();
    y += 10;
    doc.fontSize(12).text(`Genel Toplam: ${grandTotal.toFixed(2)} TRY`, startX, y, { align: "right" });

    doc.end();
  } catch (e) {
    res.status(500).json({ error: "PDF üretim hatası" });
  }
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
