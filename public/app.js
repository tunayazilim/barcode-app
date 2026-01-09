/* global BarcodeDetector, Quagga */
(() => {
  const VERSION = "20260109-2";
  const $ = (id) => document.getElementById(id);

  const el = {
    pillHttps: $("pillHttps"),
    pillCam: $("pillCam"),
    pillMic: $("pillMic"),
    capabilities: $("capabilities"),
    scanState: $("scanState"),
    log: $("log"),

    input: $("barcodeInput"),
    btnSearch: $("btnSearch"),
    btnStartCam: $("btnStartCam"),
    btnStopCam: $("btnStopCam"),
    btnVoice: $("btnVoice"),
    btnClear: $("btnClear"),

    video: $("video"),
    quaggaViewport: $("quaggaViewport"),

    productBox: $("productBox"),
    cartBox: $("cartBox"),
    grandTotal: $("grandTotal"),
    btnPdf: $("btnPdf"),
    btnClearCart: $("btnClearCart"),

    customerName: $("customerName"),
    customerPhone: $("customerPhone"),
    customerNote: $("customerNote"),
  };

  // ---------- Helpers ----------
  const log = (msg) => {
    const t = new Date().toLocaleTimeString("tr-TR");
    el.log.textContent = `[${t}] ${msg}\n` + el.log.textContent;
  };

  const fmtMoney = (n) => {
    const v = Number(n || 0);
    return v.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const escapeHtml = (s) => String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const httpsOk = window.isSecureContext && location.protocol === "https:";

  function setPill(pill, ok, textOk, textBad) {
    pill.classList.remove("ok", "bad");
    if (ok) {
      pill.classList.add("ok");
      pill.textContent = textOk;
    } else {
      pill.classList.add("bad");
      pill.textContent = textBad;
    }
  }

  function setScanState(open, detail) {
    el.scanState.textContent = open ? (detail || "Açık") : "Kapalı";
    el.scanState.classList.remove("ok", "bad");
    el.scanState.classList.add(open ? "ok" : "bad");
  }

  // ---------- State ----------
  let stream = null;
  let detector = null;
  let scanTimer = null;
  let lastSeen = "";
  let lastSeenAt = 0;
  let quaggaRunning = false;
  let speechRec = null;

  const cart = new Map(); // key: barcode, value: {barcode, name, price, qty, stockCode, currency}

  // ---------- Capabilities ----------
  function initCapabilities() {
    setPill(el.pillHttps, httpsOk, "HTTPS OK", "HTTPS GEREKLİ");

    const hasGetUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const hasBarcodeDetector = "BarcodeDetector" in window;
    const hasQuagga = !!window.Quagga;
    const hasSpeech = "webkitSpeechRecognition" in window || "SpeechRecognition" in window;

    setPill(el.pillCam, hasGetUserMedia || hasQuagga, "Kamera Var", "Kamera Yok");
    setPill(el.pillMic, hasSpeech, "Ses Var", "Ses Yok");

    const engine = hasBarcodeDetector ? "BarcodeDetector" : (hasQuagga ? "Quagga2" : "Yok");
    el.capabilities.textContent = `Sürüm: ${VERSION} • Barkod: ${engine} • Kamera: ${hasGetUserMedia ? "getUserMedia" : (hasQuagga ? "Quagga" : "Yok")} • Ses: ${hasSpeech ? "Var" : "Yok"}`;

    if (!httpsOk) log("Uyarı: HTTPS değil. iOS kamera/mikrofon çalışmayabilir.");
  }

  // ---------- API ----------
  async function apiGetProduct(barcode) {
    const url = `/api/product?barcode=${encodeURIComponent(barcode)}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || `API hata (${r.status})`);
    return j;
  }

  async function apiMakePdf(payload) {
    const r = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j?.error || `PDF hata (${r.status})`);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // ---------- UI Rendering ----------
  function renderProduct(p) {
    if (!p) {
      el.productBox.className = "empty";
      el.productBox.textContent = "Henüz ürün yok. Barkod okut veya ara.";
      return;
    }

    const price = fmtMoney(p.price);
    const stock = Number(p.stock ?? 0);
    const cur = p.currency || "TRY";

    el.productBox.className = "";
    el.productBox.innerHTML = `
      <div class="productCard">
        <div class="productImg">
          <img src="${escapeHtml(p.imageUrl || "")}" alt="Ürün görseli" onerror="this.src='https://via.placeholder.com/400x400.png?text=Gorsel+Yok'"/>
        </div>
        <div>
          <div style="font-weight:800;font-size:16px;line-height:1.25">${escapeHtml(p.name || "-")}</div>
          <div class="kv" style="margin-top:8px">
            <div class="k">Barkod</div><div>${escapeHtml(p.barcode || "-")}</div>
            <div class="k">Stok Kodu</div><div>${escapeHtml(p.stockCode || "-")}</div>
            <div class="k">Stok</div><div>${stock}</div>
            <div class="k">Fiyat</div><div>${price} ${escapeHtml(cur)}</div>
          </div>
          <div class="productActions">
            <button class="btn primary" id="btnAddToCart">Sepete Ekle</button>
            <button class="btn" id="btnCopyBarcode">Barkodu Kopyala</button>
          </div>
        </div>
      </div>
    `;

    $("btnAddToCart").onclick = () => addToCart(p);
    $("btnCopyBarcode").onclick = async () => {
      try {
        await navigator.clipboard.writeText(String(p.barcode || ""));
        log("Barkod kopyalandı.");
      } catch {
        log("Barkod kopyalanamadı (izin yok). 😕");
      }
    };
  }

  function renderCart() {
    const items = Array.from(cart.values());
    el.btnPdf.disabled = items.length === 0;

    if (items.length === 0) {
      el.cartBox.className = "empty";
      el.cartBox.textContent = "Sepet boş.";
      el.grandTotal.textContent = "0.00";
      return;
    }

    let total = 0;
    el.cartBox.className = "";
    el.cartBox.innerHTML = items
      .map((it) => {
        const line = Number(it.qty) * Number(it.price);
        total += line;
        return `
        <div class="cartItem">
          <div>
            <div class="cartItemTitle">${escapeHtml(it.name || "-")}</div>
            <div class="cartItemMeta">
              Barkod: ${escapeHtml(it.barcode)} • Stok Kodu: ${escapeHtml(it.stockCode || "-")} • Fiyat: ${fmtMoney(it.price)}
            </div>
          </div>
          <div class="qtyBox">
            <button class="btn" data-act="dec" data-b="${escapeHtml(it.barcode)}">-</button>
            <div class="qty">${it.qty}</div>
            <button class="btn" data-act="inc" data-b="${escapeHtml(it.barcode)}">+</button>
            <button class="btn danger" data-act="rm" data-b="${escapeHtml(it.barcode)}">Sil</button>
          </div>
        </div>
      `;
      })
      .join("");

    el.grandTotal.textContent = fmtMoney(total);

    el.cartBox.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.onclick = () => {
        const act = btn.getAttribute("data-act");
        const b = btn.getAttribute("data-b");
        const item = cart.get(b);
        if (!item) return;

        if (act === "inc") item.qty += 1;
        if (act === "dec") item.qty = Math.max(1, item.qty - 1);
        if (act === "rm") cart.delete(b);

        renderCart();
      };
    });
  }

  function addToCart(p) {
    const b = String(p.barcode || "");
    if (!b) return;

    if (cart.has(b)) {
      cart.get(b).qty += 1;
    } else {
      cart.set(b, {
        barcode: b,
        name: p.name || "Ürün",
        price: Number(p.price || 0),
        qty: 1,
        stockCode: p.stockCode || "",
        currency: p.currency || "TRY",
      });
    }
    renderCart();
    log("Sepete eklendi.");
  }

  // ---------- Search ----------
  async function doSearch(code) {
    const barcode = String(code || "").trim();
    if (!barcode) return;

    try {
      log(`Aranıyor: ${barcode}`);
      const res = await apiGetProduct(barcode);
      renderProduct(res.product);
    } catch (e) {
      log(`Arama hatası: ${e.message || e}`);
      renderProduct(null);
    }
  }

  // ---------- Barcode (BarcodeDetector mode) ----------
  async function initBarcodeDetector() {
    detector = null;
    if (!("BarcodeDetector" in window)) return null;

    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      detector = new BarcodeDetector({ formats });
      log(`BarcodeDetector hazır. Format sayısı: ${formats.length}`);
      return detector;
    } catch (e) {
      detector = null;
      log(`BarcodeDetector başlatılamadı: ${e.message || e}`);
      return null;
    }
  }

  function startScanLoop() {
    if (!detector) return;

    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }

    // 400ms tarama aralığı: performans/kararlılık dengesi
    scanTimer = setInterval(async () => {
      try {
        if (!el.video || el.video.readyState < 2) return;
        const barcodes = await detector.detect(el.video);
        if (!barcodes || barcodes.length === 0) return;

        const code = String(barcodes[0]?.rawValue || "").trim();
        if (!code) return;

        const now = Date.now();
        if (code === lastSeen && now - lastSeenAt < 2500) return;

        lastSeen = code;
        lastSeenAt = now;

        el.input.value = code;
        log(`Okundu: ${code}`);
        await doSearch(code);
      } catch {
        // sessiz
      }
    }, 400);
  }

  // ---------- Quagga2 mode (BarcodeDetector yoksa) ----------
  function startQuagga() {
    if (!window.Quagga) {
      log("Quagga2 bulunamadı. (index.html script yüklenmedi)");
      return;
    }
    if (quaggaRunning) return;

    quaggaRunning = true;

    // UI: Quagga kendi video/canvas'ını basacak
    el.video.style.display = "none";
    el.quaggaViewport.style.display = "block";

    log("Quagga2 tarama başlatıldı.");

    Quagga.init(
      {
        inputStream: {
          type: "LiveStream",
          target: el.quaggaViewport,
          constraints: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        locate: true,
        decoder: {
          readers: ["ean_reader", "ean_8_reader", "code_128_reader", "upc_reader", "upc_e_reader"],
        },
        numOfWorkers: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 2,
      },
      (err) => {
        if (err) {
          quaggaRunning = false;
          log(`Quagga init hatası: ${err.message || err}`);
          return;
        }

        Quagga.start();

        Quagga.onDetected(async (res) => {
          try {
            const code = String(res?.codeResult?.code || "").trim();
            if (!code) return;

            const now = Date.now();
            if (code === lastSeen && now - lastSeenAt < 2500) return;

            lastSeen = code;
            lastSeenAt = now;

            el.input.value = code;
            log(`Okundu: ${code}`);
            await doSearch(code);
          } catch {
            // sessiz
          }
        });
      }
    );
  }

  function stopQuagga() {
    if (!quaggaRunning || !window.Quagga) return;
    try {
      Quagga.offDetected();
      Quagga.stop();
    } catch {
      // ignore
    }
    quaggaRunning = false;
    log("Quagga2 durduruldu.");

    // UI reset
    el.quaggaViewport.style.display = "none";
    el.quaggaViewport.innerHTML = "";
    el.video.style.display = "block";
  }

  // ---------- Camera controls ----------
  async function startCamera() {
    // BarcodeDetector yoksa: Quagga ile kamera yönetimini devret
    const hasBarcodeDetector = "BarcodeDetector" in window;

    if (!hasBarcodeDetector) {
      setScanState(true, "Açık (Quagga)");
      el.btnStartCam.disabled = true;
      el.btnStopCam.disabled = false;
      startQuagga();
      return;
    }

    // BarcodeDetector: getUserMedia ile kendi video akışımız
    try {
      const hasGetUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
      if (!hasGetUserMedia) {
        log("getUserMedia yok. Bu tarayıcıda kamera açılamıyor.");
        return;
      }

      log("Kamera açılıyor...");

      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      // UI: BarcodeDetector modunda video görünür
      el.quaggaViewport.style.display = "none";
      el.quaggaViewport.innerHTML = "";
      el.video.style.display = "block";

      el.video.srcObject = stream;
      await el.video.play();

      el.btnStartCam.disabled = true;
      el.btnStopCam.disabled = false;
      setScanState(true, "Açık (Detector)");

      await initBarcodeDetector();
      if (detector) startScanLoop();
    } catch (e) {
      log(`Kamera açılamadı: ${e.message || e}`);
      alert("Kamera açılamadı. Tarayıcı izinlerini kontrol edin.");
      stopCamera();
    }
  }

  function stopCamera() {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }

    stopQuagga();

    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    el.video.srcObject = null;

    el.btnStartCam.disabled = false;
    el.btnStopCam.disabled = true;
    setScanState(false);
    log("Kamera kapatıldı.");
  }

  // ---------- Voice ----------
  function startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("Bu tarayıcıda sesli arama desteklenmiyor.");
      return;
    }

    if (speechRec) {
      try { speechRec.stop(); } catch {}
      speechRec = null;
    }

    speechRec = new SR();
    speechRec.lang = "tr-TR";
    speechRec.interimResults = false;
    speechRec.maxAlternatives = 1;

    speechRec.onstart = () => log("Sesli arama başladı. Konuşabilirsin.");
    speechRec.onerror = (e) => log(`Ses hatası: ${e.error || "bilinmeyen"}`);
    speechRec.onend = () => log("Sesli arama bitti.");

    speechRec.onresult = async (event) => {
      const text = event?.results?.[0]?.[0]?.transcript || "";
      const cleaned = String(text).trim();
      log(`Ses algılandı: ${cleaned}`);

      const digits = cleaned.replace(/\D+/g, "");
      if (digits.length >= 6) {
        el.input.value = digits;
        await doSearch(digits);
      } else {
        el.input.value = cleaned;
        alert("Şu an API barkod ile arıyor. Ürün adı araması için ek endpoint gerekir.");
      }
    };

    try {
      speechRec.start();
    } catch {
      // bazı tarayıcılar ikinci start'a izin vermez
    }
  }

  // ---------- Events ----------
  el.btnSearch.onclick = () => doSearch(el.input.value);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch(el.input.value);
  });

  el.btnStartCam.onclick = startCamera;
  el.btnStopCam.onclick = stopCamera;
  el.btnVoice.onclick = startVoice;

  el.btnClear.onclick = () => {
    el.input.value = "";
    renderProduct(null);
    log("Temizlendi.");
  };

  el.btnClearCart.onclick = () => {
    cart.clear();
    renderCart();
    log("Sepet temizlendi.");
  };

  el.btnPdf.onclick = async () => {
    const items = Array.from(cart.values());
    if (items.length === 0) return;

    const payload = {
      customer: {
        name: el.customerName.value || "",
        phone: el.customerPhone.value || "",
        note: el.customerNote.value || "",
      },
      items: items.map((it) => ({
        barcode: it.barcode,
        stockCode: it.stockCode,
        name: it.name,
        qty: it.qty,
        price: it.price,
        currency: it.currency || "TRY",
      })),
    };

    try {
      log("PDF oluşturuluyor...");
      await apiMakePdf(payload);
      log("PDF hazır.");
    } catch (e) {
      log(`PDF hata: ${e.message || e}`);
    }
  };

  // ---------- Init ----------
  initCapabilities();
  renderProduct(null);
  renderCart();
  setScanState(false);
  log(`Frontend yüklendi (v${VERSION}).`);
})();
