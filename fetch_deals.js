const fs = require('fs');
const https = require('https');

// Helper to fetch with custom browser headers and timeout
function fetchBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.nseindia.com/all-reports',
      ...headers
    };

    const req = https.get(url, { headers: defaultHeaders, timeout: 15000 }, (res) => {
      // Follow standard redirects (301, 302, 307)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location, headers).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download. Status code: ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });

    req.on('error', reject);
  });
}

// Generate recent trading day strings (YYYYMMDD & DDMMYYYY)
function getRecentTradingDates(daysBack = 5) {
  const dates = [];
  let d = new Date();
  while (dates.length < daysBack) {
    const day = d.getDay();
    // Skip weekends (0 = Sun, 6 = Sat)
    if (day !== 0 && day !== 6) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const mon = months[d.getMonth()];
      
      dates.push({ yyyy, mm, dd, mon });
    }
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

async function downloadLatestBhavcopy() {
  const recentDates = getRecentTradingDates(5);

  for (const dateObj of recentDates) {
    const { yyyy, mm, dd, mon } = dateObj;
    
    // NSE Bhavcopy URLs
    // URL Pattern 1: Modern UDiFF Bhavcopy CSV (BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv)
    const udiffUrl = `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${yyyy}${mm}${dd}_F_0000.csv`;
    // URL Pattern 2: Standard PR Bhavcopy (sec_bhavdata_full_DDMMYYYY.csv)
    const prUrl = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${dd}${mm}${yyyy}.csv`;

    console.log(`Attempting Bhavcopy scan for session date: ${dd}-${mm}-${yyyy}...`);

    try {
      const csvBuffer = await fetchBuffer(udiffUrl);
      console.log(`Successfully fetched UDiFF Bhavcopy for ${dd}-${mm}-${yyyy}`);
      return { csv: csvBuffer.toString('utf-8'), type: 'UDIFF' };
    } catch (e1) {
      try {
        const prBuffer = await fetchBuffer(prUrl);
        console.log(`Successfully fetched standard Bhavcopy for ${dd}-${mm}-${yyyy}`);
        return { csv: prBuffer.toString('utf-8'), type: 'PR' };
      } catch (e2) {
        console.log(`Date ${dd}-${mm}-${yyyy} not yet released or exchange holiday.`);
      }
    }
  }

  throw new Error("Unable to locate published Bhavcopy in exchange archive window.");
}

async function runCollector() {
  let fileData;
  try {
    fileData = await downloadLatestBhavcopy();
  } catch (err) {
    console.error("Market-wide download failed:", err.message);
    process.exit(1);
  }

  const lines = fileData.csv.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    console.error("CSV file is empty or corrupted.");
    process.exit(1);
  }

  const header = lines[0].split(',').map(h => h.trim().toUpperCase());
  const rows = lines.slice(1);

  // Column Index Resolvers
  const getIdx = (candidates) => header.findIndex(h => candidates.includes(h));

  const symIdx = getIdx(['TckrSymb', 'SYMBOL']);
  const seriesIdx = getIdx(['SctySrs', 'SERIES']);
  const closeIdx = getIdx(['ClsPric', 'CLOSE_PRICE', 'CLOSEPRICE']);
  const prevCloseIdx = getIdx(['PrvsClsgPric', 'PREV_CLOSE', 'PREVCLOSE']);
  const highIdx = getIdx(['HgstPric', 'HIGH_PRICE', 'HIGHPRICE']);
  const lowIdx = getIdx(['LwstPric', 'LOW_PRICE', 'LOWPRICE']);
  const qtyIdx = getIdx(['TtlTradgVol', 'TOTAL_TRADED_QUANTITY', 'TTL_TRD_QNTY', 'TRADED_QTY']);
  const valIdx = getIdx(['TtlTrfVal', 'TOTAL_TRADED_VALUE', 'TURNOVER_LACS', 'TOT_TRD_VAL']);
  const vwapIdx = getIdx(['AvrgPric', 'AVG_PRICE', 'WATP']);

  console.log(`Processing entire NSE universe (${rows.length} records)...`);

  const results = [];

  for (const row of rows) {
    const cols = row.split(',').map(c => c.trim());
    if (cols.length < header.length) continue;

    const series = cols[seriesIdx];
    // Filter strictly for standard equity shares ('EQ') to omit bonds, debentures, or warrants
    if (series !== 'EQ') continue;

    const sym = cols[symIdx];
    const ltp = parseFloat(cols[closeIdx]) || 0;
    const prevClose = parseFloat(cols[prevCloseIdx]) || ltp;
    const high = parseFloat(cols[highIdx]) || ltp;
    const low = parseFloat(cols[lowIdx]) || ltp;
    const qty = parseFloat(cols[qtyIdx]) || 0;
    
    // Determine turnover in Crore ₹
    let turnoverCr = 0;
    if (valIdx !== -1 && parseFloat(cols[valIdx])) {
      const rawVal = parseFloat(cols[valIdx]);
      // If header is in Lacs vs Raw Currency
      turnoverCr = header[valIdx].includes('LACS') ? (rawVal / 100) : (rawVal / 10000000);
    } else {
      turnoverCr = (qty * ltp) / 10000000;
    }

    // Inst. VWAP calculation
    let vwap = vwapIdx !== -1 ? parseFloat(cols[vwapIdx]) : 0;
    if (!vwap || isNaN(vwap) || vwap <= 0) {
      vwap = (high + low + ltp) / 3;
    }

    if (ltp <= 0 || prevClose <= 0 || qty <= 0) continue;

    const priceDiffPct = ((ltp - prevClose) / prevClose) * 100;
    // Institutional net flow metric proportional to session participation and price delta
    const netFlow = parseFloat(((turnoverCr * priceDiffPct) / 100).toFixed(2));
    const momScore = parseFloat((priceDiffPct * Math.log10(Math.max(turnoverCr, 1) + 10)).toFixed(1));
    const signal = netFlow > 15 ? "STRONG BUY" : netFlow > 0 ? "BUY" : netFlow < -15 ? "STRONG SELL" : "SELL";

    results.push({
      sym: sym,
      ltp: parseFloat(ltp.toFixed(2)),
      vwap: parseFloat(vwap.toFixed(2)),
      price: parseFloat(ltp.toFixed(2)),
      netFlow: netFlow,
      totalQty: Math.round(qty),
      momScore: momScore,
      signal: signal
    });
  }

  console.log(`Parsed complete stock universe: ${results.length} active listed equities.`);

  const output = {
    updatedAt: new Date().toISOString(),
    totalStocksTraded: results.length,
    allStocks: results.slice().sort((a, b) => b.netFlow - a.netFlow),
    buys: results.filter(d => d.netFlow > 0).sort((a, b) => b.netFlow - a.netFlow),
    sells: results.filter(d => d.netFlow < 0).sort((a, b) => a.netFlow - b.netFlow),
    momUp: results.filter(d => d.momScore > 0).sort((a, b) => b.momScore - a.momScore),
    momDown: results.filter(d => d.momScore < 0).sort((a, b) => a.momScore - b.momScore)
  };

  fs.writeFileSync("today.json", JSON.stringify(output, null, 2));
  console.log("today.json created with full market universe data.");
}

runCollector();
