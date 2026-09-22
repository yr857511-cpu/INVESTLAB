#!/usr/bin/env node
// INVEST LAB 대시보드용 "시장 데이터 미러" 생성 스크립트.
//
// 대시보드(index.html)가 브라우저에서 직접(또는 CORS 프록시를 거쳐) 매번 새로 불러오던
// 미국금리·환율·지수/원자재/VIX·코인 데이터를, GitHub Actions가 이 스크립트로 주기적으로
// 대신 받아와 data/market-data.json 하나로 묶어 GitHub Pages에 올려둔다.
//
// 여기 들어있는 조회·파싱 로직은 전부 이 프로젝트의 Cloudflare Workers 백엔드(worker.js)에
// 이미 있는 것과 완전히 동일하다 — 같은 API, 같은 파싱 방식, 같은 계산식을 그대로 옮겼을
// 뿐이다. 새로운 계산이나 추정치는 전혀 없고, 값을 못 받아온 항목은 그냥 결과에서 빠진다
// (0이나 null로 지어내지 않는다).
//
// 대시보드 쪽은 이 파일이 없거나, 오래됐거나, 형식이 이상해도 자동으로 기존 방식(백엔드→
// CORS 프록시)으로 넘어가도록 만들어져 있으므로, 이 스크립트가 어쩌다 실패해도 대시보드가
// 더 나빠지는 일은 없다.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "*/*",
};

const OUT_PATH = process.argv[2] || path.join(process.cwd(), "data", "market-data.json");

// ---------- 공통 유틸 ----------

async function fetchText(url, opts) {
  const res = await fetch(url, { headers: UA, ...(opts || {}) });
  if (!res.ok) throw new Error("HTTP " + res.status + " (" + url + ")");
  return await res.text();
}
async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}
async function settleNamed(map) {
  // { key: asyncFn } → { key: value } (+ errors: {key: message}) — worker.js의 fetchBundle과 동일한 모양.
  const keys = Object.keys(map);
  const results = await Promise.allSettled(keys.map((k) => map[k]()));
  const body = {};
  const errors = {};
  keys.forEach((k, i) => {
    const r = results[i];
    if (r.status === "fulfilled") body[k] = r.value;
    else errors[k] = String((r.reason && r.reason.message) || r.reason);
  });
  if (Object.keys(errors).length) body.__errors = errors;
  return body;
}
function nearestPoint(series, targetMs) {
  if (!Array.isArray(series) || !series.length) return null;
  let best = series[0];
  let bestDiff = Math.abs(series[0].t - targetMs);
  for (let i = 1; i < series.length; i++) {
    const d = Math.abs(series[i].t - targetMs);
    if (d < bestDiff) {
      best = series[i];
      bestDiff = d;
    }
  }
  return best;
}

// ---------- Yahoo Finance 차트(지수/원자재/VIX) ----------
// worker.js의 fetchChartHistory/fetchIndexQuoteViaChart와 완전히 동일.

async function fetchChartHistory(symbol, range) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    "?range=" +
    (range || "2y") +
    "&interval=1d";
  const json = await fetchJson(url);
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  const timestamps = result && result.timestamp;
  const closes =
    result &&
    result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0] &&
    result.indicators.quote[0].close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes) || !timestamps.length) {
    throw new Error("시세 이력 없음 (" + symbol + ")");
  }
  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    const v = closes[i];
    if (v == null || Number.isNaN(v)) continue;
    out.push({ t: timestamps[i] * 1000, v });
  }
  if (out.length < 2) throw new Error("시세 이력 부족 (" + symbol + ")");
  return out;
}
function quoteFromHistory(hist) {
  const latest = hist[hist.length - 1].v;
  const prev = hist.length > 1 ? hist[hist.length - 2].v : null;
  const chg = prev != null && !Number.isNaN(prev) && prev !== 0 ? ((latest - prev) / prev) * 100 : null;
  return { level: latest, chg };
}

const INDEX_SYMBOLS = {
  nasdaq: "^IXIC",
  sp500: "^GSPC",
  dow: "^DJI",
  vix: "^VIX",
  russell2000: "^RUT",
  soxx: "SOXX",
};
const COMMODITY_SYMBOLS = {
  gold: "GC=F",
  silver: "SI=F",
  copper: "HG=F",
  oil: "CL=F",
  brent: "BZ=F",
  natgas: "NG=F",
};

// ---------- 미국금리 ----------
// worker.js의 fetchTreasuryCurve/fetchTreasuryHistory/fetchBisPolicyRate/fetchFedRateChangeHistory와 완전히 동일.

const TREASURY_CURVE_MATURITIES = [
  { key: "BC_1MONTH", label: "1개월" },
  { key: "BC_2MONTH", label: "2개월" },
  { key: "BC_3MONTH", label: "3개월" },
  { key: "BC_6MONTH", label: "6개월" },
  { key: "BC_1YEAR", label: "1년" },
  { key: "BC_2YEAR", label: "2년" },
  { key: "BC_3YEAR", label: "3년" },
  { key: "BC_5YEAR", label: "5년" },
  { key: "BC_7YEAR", label: "7년" },
  { key: "BC_10YEAR", label: "10년" },
  { key: "BC_20YEAR", label: "20년" },
  { key: "BC_30YEAR", label: "30년" },
];
const TREASURY_TREND_MATURITIES = ["BC_2YEAR", "BC_10YEAR", "BC_30YEAR"];
const FED_RATE_HISTORY_COUNT = 6;

function treasuryYieldMonthUrl(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const mm = m < 10 ? "0" + m : String(m);
  return (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=" +
    y +
    mm
  );
}
export function parseTreasuryYieldXml(xmlText) {
  const entries = xmlText.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const rows = [];
  for (let i = 0; i < entries.length; i++) {
    const dm = entries[i].match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/);
    if (!dm) continue;
    const fields = {};
    const fieldRe = /<d:(BC_[A-Z0-9_]+)[^>]*>([^<]+)<\/d:\1>/g;
    let fm;
    while ((fm = fieldRe.exec(entries[i]))) {
      const v = parseFloat(fm[2]);
      if (!Number.isNaN(v)) fields[fm[1]] = v;
    }
    rows.push({ date: dm[1], fields });
  }
  return rows;
}
async function fetchTreasuryXmlText(d) {
  return await fetchText(treasuryYieldMonthUrl(d));
}
async function fetchTreasuryCurve() {
  const now = new Date();
  let rows = parseTreasuryYieldXml(await fetchTreasuryXmlText(now));
  if (rows.length < 2) {
    try {
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      rows = parseTreasuryYieldXml(await fetchTreasuryXmlText(prevMonth)).concat(rows);
    } catch (e) {
      /* 전월 조회 실패해도 이번 달 데이터만으로 계속 */
    }
  }
  if (!rows.length) throw new Error("국채 수익률 데이터 없음");
  const latestRow = rows[rows.length - 1];
  const prevRow = rows.length > 1 ? rows[rows.length - 2] : null;
  const curve = TREASURY_CURVE_MATURITIES.map((m) => {
    const v = latestRow.fields[m.key];
    const pv = prevRow ? prevRow.fields[m.key] : null;
    const chg = v != null && pv != null && !Number.isNaN(v) && !Number.isNaN(pv) && pv !== 0 ? ((v - pv) / pv) * 100 : null;
    return { key: m.key, label: m.label, yieldPct: v != null && !Number.isNaN(v) ? v : null, chg };
  }).filter((c) => c.yieldPct != null);
  if (!curve.length) throw new Error("국채 수익률 곡선 없음");
  return { date: latestRow.date.slice(0, 10), curve };
}
async function fetchTreasuryHistory(numMonths) {
  const now = new Date();
  const monthDates = [];
  for (let i = 0; i < numMonths; i++) monthDates.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const results = await Promise.allSettled(monthDates.map(fetchTreasuryXmlText));
  const byDate = {};
  results.forEach((r) => {
    if (r.status !== "fulfilled") return;
    parseTreasuryYieldXml(r.value).forEach((row) => {
      byDate[row.date.slice(0, 10)] = row;
    });
  });
  const dates = Object.keys(byDate).sort();
  if (!dates.length) throw new Error("국채 수익률 추이 없음");
  const series = {};
  TREASURY_TREND_MATURITIES.forEach((k) => (series[k] = []));
  dates.forEach((d) => {
    const t = new Date(d).getTime();
    const row = byDate[d];
    TREASURY_TREND_MATURITIES.forEach((k) => {
      const v = row.fields[k];
      if (v != null && !Number.isNaN(v)) series[k].push({ t, v });
    });
  });
  return series;
}
export function parseBisPolicyRateCsv(csvText) {
  const lines = (csvText || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const last = lines[lines.length - 1];
  const m = last.match(/,(\d{4}-\d{2}-\d{2}),(-?[\d.]+),[A-Z],[A-Z],\s*$/);
  if (!m) return null;
  const v = parseFloat(m[2]);
  if (Number.isNaN(v)) return null;
  return { ratePct: v, asOf: m[1] };
}
export function parseBisPolicyRateSeries(csvText) {
  const lines = (csvText || "").trim().split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/,(\d{4}-\d{2}-\d{2}),(-?[\d.]+),[A-Z],[A-Z],\s*$/);
    if (!m) continue;
    const v = parseFloat(m[2]);
    if (Number.isNaN(v)) continue;
    out.push({ date: m[1], ratePct: v });
  }
  return out;
}
async function fetchBisPolicyRate(areaCode) {
  const text = await fetchText(
    "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/D." + areaCode + "?format=csv&lastNObservations=1"
  );
  const result = parseBisPolicyRateCsv(text);
  if (!result) throw new Error("기준금리 데이터 없음 (" + areaCode + ")");
  return result;
}
async function fetchFedRateChangeHistory() {
  const text = await fetchText(
    "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/D.US?format=csv&lastNObservations=2200"
  );
  const series = parseBisPolicyRateSeries(text);
  if (series.length < 2) throw new Error("금리 변경 이력 없음");
  const changes = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1],
      cur = series[i];
    if (Math.abs(cur.ratePct - prev.ratePct) > 0.001) {
      changes.push({ date: cur.date, from: prev.ratePct, to: cur.ratePct, deltaPct: cur.ratePct - prev.ratePct });
    }
  }
  if (!changes.length) throw new Error("금리 변경 이력 없음");
  changes.reverse();
  return changes.slice(0, FED_RATE_HISTORY_COUNT);
}

// ---------- 환율(USD/KRW) ----------
// worker.js의 fetchFxFrankfurterWithChg/fetchFxFallback/fetchFxYearAgo와 완전히 동일.

async function fetchFxFrankfurterWithChg() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = "https://api.frankfurter.dev/v1/" + fmt(start) + ".." + fmt(end) + "?base=USD&symbols=KRW";
  const json = await fetchJson(url);
  const dates = Object.keys((json && json.rates) || {}).sort();
  if (!dates.length) throw new Error("환율 값 없음");
  const usdkrw = json.rates[dates[dates.length - 1]].KRW;
  if (usdkrw == null) throw new Error("환율 값 없음");
  let chg = null;
  if (dates.length >= 2) {
    const prev = json.rates[dates[dates.length - 2]].KRW;
    if (prev != null && prev !== 0) chg = ((usdkrw - prev) / prev) * 100;
  }
  return { usdkrw, chg };
}
async function fetchFxFallback() {
  const json = await fetchJson("https://open.er-api.com/v6/latest/USD");
  const v = json && json.rates && json.rates.KRW;
  if (!v) throw new Error("보조 환율 값 없음");
  return v;
}
async function fetchFxYearAgo() {
  const dateStr = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const json = await fetchJson("https://api.frankfurter.dev/v1/" + dateStr + "?base=USD&symbols=KRW");
  const v = json && json.rates && json.rates.KRW;
  if (!v) throw new Error("1년 전 환율 값 없음");
  return v;
}
async function fetchFx() {
  try {
    const v = await fetchFxFrankfurterWithChg();
    return { usdkrw: v.usdkrw, chg: v.chg, source: "프랑크푸르터(ECB)" };
  } catch (e) {
    /* 보조 환율 API로 이어짐 */
  }
  const v2 = await fetchFxFallback();
  return { usdkrw: v2, chg: null, source: "보조 환율 API" };
}

// ---------- 코인(BTC/ETH) ----------
// worker.js의 fetchKrakenOhlc/fetchBinanceKlines/fetchCryptoHistory와 완전히 동일
// (Binance가 서버 IP를 막는 경우가 있어 Kraken을 우선, Binance는 보강 경로).

const CRYPTO_CHART_FETCH_LIMIT = 365 + 210;

export function parseKrakenOhlc(json) {
  if (json && Array.isArray(json.error) && json.error.length) throw new Error(json.error.join("; "));
  const result = json && json.result;
  if (!result) throw new Error("시세 이력 없음 (Kraken)");
  const seriesKey = Object.keys(result).filter((k) => k !== "last")[0];
  const rows = seriesKey && result[seriesKey];
  if (!Array.isArray(rows) || rows.length < 2) throw new Error("시세 이력 없음 (Kraken)");
  return rows.map((r) => ({ t: r[0] * 1000, v: parseFloat(r[4]) }));
}
async function fetchKrakenOhlc(pair) {
  const json = await fetchJson("https://api.kraken.com/0/public/OHLC?pair=" + pair + "&interval=1440");
  return parseKrakenOhlc(json);
}
async function fetchBinanceKlines(symbol) {
  const json = await fetchJson(
    "https://api.binance.com/api/v3/klines?symbol=" + symbol + "&interval=1d&limit=" + CRYPTO_CHART_FETCH_LIMIT
  );
  if (!Array.isArray(json) || json.length < 2) throw new Error("시세 이력 없음 (" + symbol + ")");
  return json.map((k) => ({ t: k[6], v: parseFloat(k[4]) }));
}
async function fetchCryptoHistory(krakenPair, binanceSymbol) {
  try {
    return await fetchKrakenOhlc(krakenPair);
  } catch (eKraken) {
    return await fetchBinanceKlines(binanceSymbol);
  }
}

// ---------- 메인 ----------

export async function main(outPath) {
  const OUT = outPath || OUT_PATH;
  const [ratesResult, fxResult, indexHistResult, commoditiesResult, cryptoResult, fxYearAgoResult] = await Promise.allSettled([
    settleNamed({
      curve: fetchTreasuryCurve,
      history: () => fetchTreasuryHistory(12),
      usRate: () => fetchBisPolicyRate("US"),
      krRate: () => fetchBisPolicyRate("KR"),
      fedRateHistory: fetchFedRateChangeHistory,
    }),
    fetchFx(),
    settleNamed(
      Object.fromEntries(Object.entries(INDEX_SYMBOLS).map(([k, sym]) => [k, () => fetchChartHistory(sym, "2y")]))
    ),
    settleNamed(
      Object.fromEntries(Object.entries(COMMODITY_SYMBOLS).map(([k, sym]) => [k, () => fetchChartHistory(sym, "2y")]))
    ),
    settleNamed({
      btcHistory: () => fetchCryptoHistory("XBTUSD", "BTCUSDT"),
      ethHistory: () => fetchCryptoHistory("ETHUSD", "ETHUSDT"),
    }),
    fetchFxYearAgo().catch((e) => {
      console.warn("1년 전 환율 조회 실패", e.message);
      return null;
    }),
  ]);

  const out = { generatedAt: new Date().toISOString() };

  if (ratesResult.status === "fulfilled") out.rates = ratesResult.value;
  else console.warn("금리 전체 조회 실패", ratesResult.reason);

  if (fxResult.status === "fulfilled") out.fx = fxResult.value;
  else console.warn("환율 조회 실패", fxResult.reason);

  const indexHistory = indexHistResult.status === "fulfilled" ? indexHistResult.value : {};
  out.indexHistory = {};
  out.indices = {};
  Object.keys(INDEX_SYMBOLS).forEach((k) => {
    const hist = indexHistory[k];
    if (Array.isArray(hist) && hist.length > 1) {
      out.indexHistory[k] = hist;
      out.indices[k] = quoteFromHistory(hist);
    }
  });

  if (commoditiesResult.status === "fulfilled") {
    out.commodities = {};
    Object.keys(COMMODITY_SYMBOLS).forEach((k) => {
      const hist = commoditiesResult.value[k];
      if (Array.isArray(hist) && hist.length > 1) out.commodities[k] = hist;
    });
  }

  if (cryptoResult.status === "fulfilled") out.crypto = cryptoResult.value;

  // yearAgo: 이미 받아온 2년치 시계열에서 "1년 전"에 가장 가까운 값을 그대로 뽑는다(새 조회 없음).
  // FX만 별도 API(특정 날짜 조회)로 정확한 1년 전 값을 받아온다(2년치 일별 시계열이 없으므로).
  const yearAgoTarget = Date.now() - 365 * 86400000;
  out.yearAgo = {};
  ["sp500", "nasdaq", "dow", "vix", "russell2000", "soxx"].forEach((k) => {
    const hist = out.indexHistory[k];
    const p = hist && nearestPoint(hist, yearAgoTarget);
    if (p) out.yearAgo[k] = p.v;
  });
  if (out.crypto && Array.isArray(out.crypto.btcHistory)) {
    const p = nearestPoint(out.crypto.btcHistory, yearAgoTarget);
    if (p) out.yearAgo.btc = p.v;
  }
  if (fxYearAgoResult.status === "fulfilled" && fxYearAgoResult.value != null) {
    out.yearAgo.usdkrw = fxYearAgoResult.value;
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log("written:", OUT);
  console.log(
    "sections:",
    Object.keys(out)
      .filter((k) => k !== "generatedAt")
      .join(", ")
  );
  return out;
}

// 이 파일이 직접 실행될 때만 main()을 돈다 — import해서 파싱 함수/main()만 테스트할 수 있도록.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
