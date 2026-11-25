import crypto from 'node:crypto';
import type {
  OnlinePriceAvailability,
  OnlinePriceComparisonSummary,
  OnlinePriceCurrencyComparison,
  OnlinePriceLocalShopMatch,
  OnlinePriceMatchQuality,
  OnlinePriceProviderSource,
  OnlinePriceProviderStatus,
  OnlinePriceRegionFilter,
  OnlinePriceResolvedProductMeta,
  OnlinePriceResultItem,
  OnlinePriceSearchMode,
  OnlinePriceSearchResponse,
  Product,
} from './src/types/pos.ts';

const DEFAULT_GOOGLE_CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const DEFAULT_SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';
const DEFAULT_OPENFOODFACTS_ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const UPSTREAM_TIMEOUT_MS = 8000;
const DEFAULT_RATE_LIMIT_PER_MIN = 30;

const PAKISTANI_DOMAINS = new Set([
  'daraz.pk',
  'priceoye.pk',
  'naheed.pk',
  'alfatah.pk',
  'hummart.com',
  'imtiaz.com.pk',
  'metro-online.pk',
  'telemart.pk',
  'homeshopping.pk',
  'shophive.com',
  'czone.com.pk',
  'mega.pk',
  'yayvo.com',
  'springs.com.pk',
  'grocerapp.pk',
  'krave.pk',
  'chasevalue.pk',
  'qne.com.pk',
  'bagallery.com',
  'vegas.pk',
  'symbios.pk',
  'ishopping.pk',
  'goto.com.pk',
  'myshop.pk',
  'paklap.pk',
  'olx.com.pk',
  'whatmobile.com.pk',
  'hamariweb.com',
  'proshopping.pk',
]);

const PAKISTANI_STORE_DISPLAY_NAMES: Record<string, string> = {
  'daraz.pk': 'Daraz Pakistan',
  'priceoye.pk': 'PriceOye',
  'naheed.pk': 'Naheed Supermarket',
  'alfatah.pk': 'Al-Fatah',
  'hummart.com': 'HumMart',
  'imtiaz.com.pk': 'Imtiaz Super Market',
  'metro-online.pk': 'METRO Pakistan',
  'telemart.pk': 'Telemart',
  'homeshopping.pk': 'HomeShopping.pk',
  'shophive.com': 'Shophive',
  'czone.com.pk': 'Computer Zone (CZone)',
  'mega.pk': 'Mega.pk',
  'springs.com.pk': 'Springs Store',
  'grocerapp.pk': 'GrocerApp',
  'qne.com.pk': 'QNE.com.pk',
  'bagallery.com': 'Bagallery',
  'vegas.pk': 'Vegas.pk',
  'symbios.pk': 'Symbios.pk',
  'ishopping.pk': 'iShopping.pk',
  'paklap.pk': 'Paklap',
};

interface CachedSearchEntry {
  response: OnlinePriceSearchResponse;
  expiresAtMs: number;
}

const searchCache = new Map<string, CachedSearchEntry>();
const shopRateBuckets = new Map<string, number[]>();

export function clearPriceSearchCachesForTest(): void {
  searchCache.clear();
  shopRateBuckets.clear();
}

export function getPriceSearchProviderStatus(): OnlinePriceProviderStatus {
  const googleKey = (process.env.GOOGLE_CSE_API_KEY || '').trim();
  const googleCx = (process.env.GOOGLE_CSE_CX || '').trim();
  const serpKey = (process.env.SERPAPI_API_KEY || '').trim();

  const googleCseConfigured = Boolean(googleKey && googleCx);
  const serpApiConfigured = Boolean(serpKey);
  const hasLiveShoppingOrSearchProvider = googleCseConfigured || serpApiConfigured;

  const setupInstructions: string[] = [];
  if (!googleCseConfigured) {
    setupInstructions.push(
      'Set GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX in server environment variables (.env / deployment secrets) to enable live Google Programmable Search.'
    );
  }
  if (!serpApiConfigured) {
    setupInstructions.push(
      'Optional: Set SERPAPI_API_KEY in server environment variables to enable live Google Shopping structured store prices (Pakistan gl=pk & International).'
    );
  }

  let missingConfigSummary = '';
  if (!hasLiveShoppingOrSearchProvider) {
    missingConfigSummary =
      'Google live search API keys are not configured on the server yet. Barcode metadata lookup (Open Food Facts) remains active, and no simulated or fake online prices will be shown.';
  } else if (!serpApiConfigured) {
    missingConfigSummary =
      'Google Programmable Search is active. Results with verified offer metadata display prices; ordinary web pages without offer pricing display "Price Not Available".';
  }

  return {
    googleCseConfigured,
    serpApiConfigured,
    openFoodFactsEnabled: true,
    hasLiveShoppingOrSearchProvider,
    missingConfigSummary,
    setupInstructions,
  };
}

export function checkPriceSearchRateLimit(
  shopId: string
): { allowed: true; remaining: number; limit: number } | { allowed: false; retryAfterSeconds: number; limit: number } {
  const configuredLimit = Number(process.env.PRICE_SEARCH_RATE_LIMIT_PER_MIN || DEFAULT_RATE_LIMIT_PER_MIN);
  const limit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : DEFAULT_RATE_LIMIT_PER_MIN;
  const now = Date.now();
  const windowMs = 60_000;
  const existing = (shopRateBuckets.get(shopId) || []).filter((ts) => now - ts < windowMs);
  if (existing.length >= limit) {
    const oldest = existing[0] || now;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    shopRateBuckets.set(shopId, existing);
    return { allowed: false, retryAfterSeconds, limit };
  }
  existing.push(now);
  shopRateBuckets.set(shopId, existing);
  return { allowed: true, remaining: Math.max(0, limit - existing.length), limit };
}

export function sanitizeExternalHttpUrl(rawUrl?: string | null): string | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function extractDomain(urlStr: string): string {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function classifyWebsiteRegion(
  domain: string,
  currency: string | null,
  preferredGl?: string
): 'pakistan' | 'international' {
  const clean = domain.toLowerCase().replace(/^www\./, '');
  if (clean.endsWith('.pk')) return 'pakistan';
  for (const pkDom of PAKISTANI_DOMAINS) {
    if (clean === pkDom || clean.endsWith(`.${pkDom}`)) {
      return 'pakistan';
    }
  }
  if (currency === 'PKR' && (!clean || preferredGl === 'pk')) {
    return 'pakistan';
  }
  return 'international';
}

function friendlyWebsiteName(domain: string, explicitSource?: string): string {
  const clean = domain.toLowerCase().replace(/^www\./, '');
  for (const [dom, label] of Object.entries(PAKISTANI_STORE_DISPLAY_NAMES)) {
    if (clean === dom || clean.endsWith(`.${dom}`)) return label;
  }
  if (explicitSource && explicitSource.trim()) {
    return explicitSource.trim();
  }
  if (!clean) return 'Online Store';
  return clean;
}

function normalizeCurrencyCode(rawCurrency?: string | null, rawPriceText?: string | null, domain?: string): string | null {
  const c = (rawCurrency || '').trim().toUpperCase();
  const text = (rawPriceText || '').trim();
  if (c === 'PKR' || c === 'RS' || c === 'RS.') return 'PKR';
  if (c === 'USD' || c === 'US$') return 'USD';
  if (c === 'GBP') return 'GBP';
  if (c === 'EUR') return 'EUR';
  if (c === 'AED') return 'AED';
  if (c === 'SAR') return 'SAR';
  if (/^[A-Z]{3}$/.test(c)) return c;

  if (/(^|\s)(pkr|rs\.?)/i.test(text)) return 'PKR';
  if (/£/.test(text)) return 'GBP';
  if (/€/.test(text)) return 'EUR';
  if (/\baed\b/i.test(text)) return 'AED';
  if (/\bsar\b/i.test(text)) return 'SAR';
  if (/\$/.test(text)) return 'USD';

  const cleanDom = (domain || '').toLowerCase();
  if (cleanDom.endsWith('.pk') || PAKISTANI_DOMAINS.has(cleanDom)) {
    return 'PKR';
  }
  return null;
}

function parseNumericPrice(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isFinite(val) && val > 0 ? Math.round(val * 100) / 100 : null;
  }
  if (typeof val !== 'string') return null;
  const cleaned = val.replace(/[, ]+/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  if (!cleaned) return null;
  const parsed = Number(cleaned[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

export function formatCurrencyPriceDisplay(price: number | null, currency: string | null): string {
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return 'Price Not Available';
  }
  const formatted = price.toLocaleString('en-US', {
    minimumFractionDigits: price % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  if (!currency || currency === 'PKR') {
    return `Rs. ${formatted}`;
  }
  if (currency === 'USD') return `$${formatted}`;
  if (currency === 'GBP') return `£${formatted}`;
  if (currency === 'EUR') return `€${formatted}`;
  return `${currency} ${formatted}`;
}

function normalizeAvailability(raw?: string | null): { status: OnlinePriceAvailability; label: string } {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return { status: 'unverified', label: 'Availability Unverified' };
  if (s.includes('outofstock') || s.includes('out of stock') || s.includes('out_of_stock') || s.includes('sold out')) {
    return { status: 'out_of_stock', label: 'Out of Stock' };
  }
  if (s.includes('limited') || s.includes('low stock') || s.includes('few left')) {
    return { status: 'limited', label: 'Limited Stock' };
  }
  if (s.includes('instock') || s.includes('in stock') || s.includes('in_stock') || s.includes('available')) {
    return { status: 'in_stock', label: 'In Stock' };
  }
  return { status: 'unverified', label: 'Availability Unverified' };
}

interface ExtractedSpecTokens {
  weightsGrams: number[];
  volumesMl: number[];
  packCounts: number[];
  storageGb: number[];
  modelCodes: string[];
  words: Set<string>;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'online',
  'price',
  'pakistan',
  'buy',
  'shop',
  'store',
  'original',
  'new',
  'best',
  'in',
  'of',
  'at',
  'on',
  'to',
]);

function extractSpecTokens(text: string): ExtractedSpecTokens {
  const lower = (text || '').toLowerCase();
  const weightsGrams: number[] = [];
  const volumesMl: number[] = [];
  const packCounts: number[] = [];
  const storageGb: number[] = [];
  const modelCodes: string[] = [];

  for (const m of lower.matchAll(/\b(\d+(?:\.\d+)?)\s*(kg|kilogram|g|gm|gram|grams)\b/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) {
      weightsGrams.push(m[2].startsWith('k') ? Math.round(n * 1000) : Math.round(n));
    }
  }
  for (const m of lower.matchAll(/\b(\d+(?:\.\d+)?)\s*(l|ltr|liter|litre|ml)\b/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) {
      volumesMl.push(m[2].startsWith('m') ? Math.round(n) : Math.round(n * 1000));
    }
  }
  for (const m of lower.matchAll(/\b(?:pack\s*of\s*(\d+)|(\d+)\s*(?:pack|pcs|pieces|sachets|tea\s*bags))\b/g)) {
    const n = Number(m[1] || m[2]);
    if (Number.isFinite(n) && n > 1) {
      packCounts.push(Math.round(n));
    }
  }
  for (const m of lower.matchAll(/\b(\d+(?:\.\d+)?)\s*(gb|tb)\b/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) {
      storageGb.push(m[2] === 'tb' ? Math.round(n * 1024) : Math.round(n));
    }
  }

  const rawWords = lower.replace(/[^a-z0-9-]+/g, ' ').split(/\s+/).filter(Boolean);
  const words = new Set<string>();
  for (const w of rawWords) {
    if (/^\d+(kg|g|gm|ml|l|ltr|gb|tb|pcs|pack)$/.test(w)) continue;
    if (/[a-z]/.test(w) && /\d/.test(w) && w.length >= 2 && !/^\d+(st|nd|rd|th)$/.test(w)) {
      modelCodes.push(w);
    }
    if (w.length >= 2 && !STOP_WORDS.has(w)) {
      words.add(w);
    }
  }

  return { weightsGrams, volumesMl, packCounts, storageGb, modelCodes, words };
}

function evaluateMatchQuality(
  targetText: string,
  targetBrand: string | undefined,
  targetModel: string | undefined,
  targetBarcode: string | undefined,
  candidateTitle: string,
  candidateSnippet: string | undefined,
  candidateBrand: string | undefined,
  candidateModel: string | undefined,
  candidateBarcode: string | undefined
): {
  matchQuality: OnlinePriceMatchQuality;
  matchScore: number;
  matchReason: string;
  mismatchWarning?: string;
} {
  const cleanTargetBarcode = (targetBarcode || '').trim();
  const cleanCandidateBarcode = (candidateBarcode || '').trim();

  const targetFull = [targetText, targetBrand, targetModel].filter(Boolean).join(' ');
  const candidateFull = [candidateTitle, candidateBrand, candidateModel, candidateSnippet].filter(Boolean).join(' ');

  const targetSpecs = extractSpecTokens(targetFull);
  const candSpecs = extractSpecTokens(candidateFull);

  // Variant / Size / Model Conflict Checks
  if (targetSpecs.weightsGrams.length > 0 && candSpecs.weightsGrams.length > 0) {
    const anyOverlap = targetSpecs.weightsGrams.some((w) => candSpecs.weightsGrams.includes(w));
    if (!anyOverlap) {
      return {
        matchQuality: 'mismatch',
        matchScore: 28,
        matchReason: 'Weight/size difference detected',
        mismatchWarning: `Weight mismatch: searched ${targetSpecs.weightsGrams[0]}g vs result ${candSpecs.weightsGrams[0]}g`,
      };
    }
  }

  if (targetSpecs.volumesMl.length > 0 && candSpecs.volumesMl.length > 0) {
    const anyOverlap = targetSpecs.volumesMl.some((v) => candSpecs.volumesMl.includes(v));
    if (!anyOverlap) {
      return {
        matchQuality: 'mismatch',
        matchScore: 28,
        matchReason: 'Volume difference detected',
        mismatchWarning: `Volume mismatch: searched ${targetSpecs.volumesMl[0]}ml vs result ${candSpecs.volumesMl[0]}ml`,
      };
    }
  }

  if (targetSpecs.packCounts.length > 0 && candSpecs.packCounts.length > 0) {
    const anyOverlap = targetSpecs.packCounts.some((c) => candSpecs.packCounts.includes(c));
    if (!anyOverlap) {
      return {
        matchQuality: 'mismatch',
        matchScore: 30,
        matchReason: 'Pack quantity difference detected',
        mismatchWarning: `Pack size mismatch: searched ${targetSpecs.packCounts[0]} pcs vs result ${candSpecs.packCounts[0]} pcs`,
      };
    }
  }

  if (targetSpecs.storageGb.length > 0 && candSpecs.storageGb.length > 0) {
    const anyOverlap = targetSpecs.storageGb.some((s) => candSpecs.storageGb.includes(s));
    if (!anyOverlap) {
      return {
        matchQuality: 'mismatch',
        matchScore: 25,
        matchReason: 'Storage capacity difference detected',
        mismatchWarning: `Variant mismatch: searched ${targetSpecs.storageGb[0]}GB vs result ${candSpecs.storageGb[0]}GB`,
      };
    }
  }

  if (targetSpecs.modelCodes.length > 0 && candSpecs.modelCodes.length > 0) {
    const hasExactModel = targetSpecs.modelCodes.some((m) => candSpecs.modelCodes.includes(m));
    if (!hasExactModel) {
      return {
        matchQuality: 'mismatch',
        matchScore: 32,
        matchReason: 'Model number differs from query',
        mismatchWarning: `Model mismatch: searched "${targetSpecs.modelCodes[0].toUpperCase()}" vs result "${candSpecs.modelCodes[0].toUpperCase()}"`,
      };
    }
  }

  // Exact barcode verification
  if (cleanTargetBarcode && cleanCandidateBarcode && cleanTargetBarcode === cleanCandidateBarcode) {
    return {
      matchQuality: 'exact',
      matchScore: 99,
      matchReason: 'Exact barcode match verified',
    };
  }
  if (cleanTargetBarcode && candidateFull.includes(cleanTargetBarcode)) {
    return {
      matchQuality: 'exact',
      matchScore: 95,
      matchReason: 'Barcode matched in listing details',
    };
  }

  // Word overlap + brand/model scoring
  const targetTokens = Array.from(targetSpecs.words);
  if (targetTokens.length === 0) {
    return {
      matchQuality: 'possible',
      matchScore: 55,
      matchReason: 'Partial text match',
    };
  }

  const candTitleLower = candidateTitle.toLowerCase();
  const candFullLower = candidateFull.toLowerCase();
  let matched = 0;
  for (const tok of targetTokens) {
    if (candTitleLower.includes(tok) || candSpecs.words.has(tok) || candFullLower.includes(tok)) {
      matched += 1;
    }
  }
  const ratio = matched / targetTokens.length;

  let brandMatched = false;
  if (targetBrand && targetBrand.trim()) {
    const tb = targetBrand.trim().toLowerCase();
    brandMatched =
      (candidateBrand || '').toLowerCase().includes(tb) || candTitleLower.includes(tb) || candFullLower.includes(tb);
    if (!brandMatched && candidateBrand && candidateBrand.trim() && candidateBrand.trim().toLowerCase() !== tb) {
      return {
        matchQuality: 'mismatch',
        matchScore: 35,
        matchReason: 'Different brand listed',
        mismatchWarning: `Brand mismatch: expected "${targetBrand}" vs "${candidateBrand}"`,
      };
    }
  }

  const score = Math.min(96, Math.round(ratio * 78 + (brandMatched ? 15 : 0) + (targetSpecs.modelCodes.length > 0 ? 5 : 0)));
  if (ratio >= 0.72 || (targetTokens.length >= 2 && matched >= targetTokens.length - 1 && ratio >= 0.65 && brandMatched)) {
    return {
      matchQuality: 'exact',
      matchScore: Math.max(78, score),
      matchReason: brandMatched ? 'Exact product & brand match' : 'Strong product name & spec match',
    };
  }

  return {
    matchQuality: 'possible',
    matchScore: Math.max(40, score),
    matchReason: 'Possible match — verify pack size & specs on website',
  };
}

export function buildComparisonSummary(results: OnlinePriceResultItem[]): OnlinePriceComparisonSummary {
  const verifiedPriced = results.filter((r) => r.hasVerifiedPrice && typeof r.price === 'number' && r.price > 0);
  const exactMatches = results.filter((r) => r.matchQuality === 'exact');
  const pakistaniCount = results.filter((r) => r.region === 'pakistan').length;
  const internationalCount = results.filter((r) => r.region === 'international').length;

  // Group ONLY comparable items (exclude variant/size/model mismatches) strictly by currency
  const byCurrency = new Map<string, OnlinePriceResultItem[]>();
  for (const item of verifiedPriced) {
    if (item.matchQuality === 'mismatch') continue;
    const curr = (item.currency || 'PKR').toUpperCase();
    const arr = byCurrency.get(curr) || [];
    arr.push(item);
    byCurrency.set(curr, arr);
  }

  const currencyComparisons: OnlinePriceCurrencyComparison[] = [];
  for (const [currency, list] of byCurrency.entries()) {
    if (list.length === 0) continue;
    // Prefer exact matches if >= 2 exact priced items exist in that currency; otherwise use all compatible priced items
    const exactInCurr = list.filter((i) => i.matchQuality === 'exact');
    const pool = exactInCurr.length >= 2 ? exactInCurr : list;
    const sorted = [...pool].sort((a, b) => (a.price || 0) - (b.price || 0));
    const lowest = sorted[0];
    const highest = sorted[sorted.length - 1];
    const uniqueWebsites = new Set(pool.map((i) => i.websiteDomain || i.websiteName));
    const sum = pool.reduce((acc, i) => acc + (i.price || 0), 0);
    const averagePrice = pool.length >= 2 ? Math.round((sum / pool.length) * 100) / 100 : null;

    currencyComparisons.push({
      currency,
      comparableCount: pool.length,
      websiteCount: uniqueWebsites.size,
      lowestPrice: lowest.price || 0,
      lowestItemId: lowest.id,
      lowestWebsite: lowest.websiteName,
      highestPrice: highest.price || 0,
      highestItemId: highest.id,
      highestWebsite: highest.websiteName,
      averagePrice,
    });
  }

  currencyComparisons.sort((a, b) => {
    if (a.currency === 'PKR' && b.currency !== 'PKR') return -1;
    if (b.currency === 'PKR' && a.currency !== 'PKR') return 1;
    return b.comparableCount - a.comparableCount;
  });

  const primaryPkrComparison = currencyComparisons.find((c) => c.currency === 'PKR') || null;

  return {
    totalResults: results.length,
    verifiedPricedCount: verifiedPriced.length,
    exactMatchCount: exactMatches.length,
    pakistaniCount,
    internationalCount,
    hasExactMatch: exactMatches.length > 0,
    currencyComparisons,
    primaryPkrComparison,
  };
}

async function fetchJsonWithRetry(url: string, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<{ ok: boolean; status: number; data: any }> {
  let lastError: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'WaqasPosPriceSearch/1.0',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 500 || response.status === 429) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
      }
      const data = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, data };
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  throw lastError || new Error('Upstream request failed');
}

async function lookupOpenFoodFactsBarcode(barcode: string): Promise<{
  meta?: OnlinePriceResolvedProductMeta;
  item?: OnlinePriceResultItem;
}> {
  const cleanBarcode = barcode.replace(/[^0-9]/g, '');
  if (cleanBarcode.length < 6 || cleanBarcode.length > 14) {
    return {};
  }

  const base = (process.env.OPENFOODFACTS_ENDPOINT || DEFAULT_OPENFOODFACTS_ENDPOINT).replace(/\/+$/, '');
  const apiUrl = `${base}/${encodeURIComponent(cleanBarcode)}.json`;
  const res = await fetchJsonWithRetry(apiUrl);
  if (!res.ok || !res.data || res.data.status !== 1 || !res.data.product) {
    return {};
  }

  const p = res.data.product;
  const productName = String(p.product_name || p.product_name_en || p.generic_name || '').trim();
  const brand = String(p.brands || '').split(',')[0]?.trim() || undefined;
  const packSize = String(p.quantity || '').trim() || undefined;
  const category = String(p.categories || '').split(',')[0]?.trim() || undefined;
  const imageUrl = sanitizeExternalHttpUrl(p.image_front_url || p.image_url);
  const pageUrl = sanitizeExternalHttpUrl(`https://world.openfoodfacts.org/product/${encodeURIComponent(cleanBarcode)}`) ||
    'https://world.openfoodfacts.org';

  if (!productName) return {};

  const nowIso = new Date().toISOString();
  const meta: OnlinePriceResolvedProductMeta = {
    productName,
    brand,
    category,
    barcode: cleanBarcode,
    packSize,
    imageUrl,
    source: 'Open Food Facts Barcode Registry',
  };

  const item: OnlinePriceResultItem = {
    id: `off_${cleanBarcode}`,
    title: [productName, packSize].filter(Boolean).join(' - '),
    brand,
    category,
    barcode: cleanBarcode,
    packSize,
    websiteName: 'Open Food Facts',
    websiteDomain: 'world.openfoodfacts.org',
    websiteUrl: pageUrl,
    imageUrl,
    price: null,
    currency: null,
    priceDisplay: 'Price Not Available',
    hasVerifiedPrice: false,
    availability: 'unverified',
    availabilityLabel: 'Availability Unverified',
    region: 'international',
    sourceType: 'openfoodfacts',
    sourceLabel: 'Open Food Facts Barcode Registry (Metadata Only)',
    matchQuality: 'exact',
    matchScore: 99,
    matchReason: 'Exact barcode match verified',
    snippet: [brand ? `Brand: ${brand}` : '', packSize ? `Pack: ${packSize}` : '', category ? `Category: ${category}` : '']
      .filter(Boolean)
      .join(' · '),
    lastCheckedAt: nowIso,
    cached: false,
  };

  return { meta, item };
}

function extractStructuredCseOffer(item: any, domain: string): {
  price: number | null;
  currency: string | null;
  availability: { status: OnlinePriceAvailability; label: string };
  brand?: string;
  model?: string;
  barcode?: string;
  imageUrl?: string;
  sourceType: OnlinePriceProviderSource;
  sourceLabel: string;
} {
  const pagemap = item?.pagemap || {};
  const offers = Array.isArray(pagemap.offer) ? pagemap.offer : [];
  const products = Array.isArray(pagemap.product) ? pagemap.product : [];
  const metatags = Array.isArray(pagemap.metatags) ? pagemap.metatags : [];
  const cseImgs = Array.isArray(pagemap.cse_image) ? pagemap.cse_image : [];
  const cseThumbs = Array.isArray(pagemap.cse_thumbnail) ? pagemap.cse_thumbnail : [];

  const firstProduct = products[0] || {};
  const firstOffer = offers[0] || {};
  const firstMeta = metatags[0] || {};

  const imageUrl = sanitizeExternalHttpUrl(
    firstProduct.image || firstMeta['og:image'] || cseImgs[0]?.src || cseThumbs[0]?.src
  );

  const brand =
    String(firstProduct.brand || firstMeta['product:brand'] || firstMeta['og:brand'] || '').trim() || undefined;
  const model = String(firstProduct.model || firstProduct.mpn || firstProduct.sku || '').trim() || undefined;
  const barcode = String(firstProduct.gtin13 || firstProduct.gtin12 || firstProduct.gtin8 || '').trim() || undefined;

  const rawPrice =
    firstOffer.price ??
    firstProduct.price ??
    firstOffer.lowprice ??
    firstProduct.lowprice ??
    firstMeta['product:price:amount'] ??
    firstMeta['og:price:amount'];

  const rawCurrency =
    firstOffer.pricecurrency ||
    firstProduct.pricecurrency ||
    firstMeta['product:price:currency'] ||
    firstMeta['og:price:currency'];

  const rawAvail =
    firstOffer.availability ||
    firstProduct.availability ||
    firstMeta['product:availability'] ||
    firstMeta['og:availability'];

  const parsedPrice = parseNumericPrice(rawPrice);
  const currency = parsedPrice
    ? normalizeCurrencyCode(
        typeof rawCurrency === 'string' ? rawCurrency : null,
        typeof rawPrice === 'string' ? rawPrice : null,
        domain
      )
    : null;

  const hasVerifiedPrice = Boolean(parsedPrice && parsedPrice > 0);
  return {
    price: hasVerifiedPrice ? parsedPrice : null,
    currency: hasVerifiedPrice ? currency : null,
    availability: normalizeAvailability(typeof rawAvail === 'string' ? rawAvail : undefined),
    brand,
    model,
    barcode,
    imageUrl,
    sourceType: hasVerifiedPrice ? 'google_cse_offer' : 'google_cse_web',
    sourceLabel: hasVerifiedPrice
      ? 'Google Programmable Search · Structured Offer'
      : 'Google Web Listing · No Structured Offer Price',
  };
}

async function queryGoogleCustomSearch(
  query: string,
  gl: 'pk' | 'us',
  targetMeta: {
    targetText: string;
    brand?: string;
    model?: string;
    barcode?: string;
  }
): Promise<{ items: OnlinePriceResultItem[]; warning?: string }> {
  const apiKey = (process.env.GOOGLE_CSE_API_KEY || '').trim();
  const cx = (process.env.GOOGLE_CSE_CX || '').trim();
  if (!apiKey || !cx) return { items: [] };

  const endpoint = (process.env.GOOGLE_CSE_ENDPOINT || DEFAULT_GOOGLE_CSE_ENDPOINT).trim();
  const url = new URL(endpoint);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');
  url.searchParams.set('gl', gl);
  if (gl === 'pk') {
    url.searchParams.set('cr', 'countryPK');
  }

  const res = await fetchJsonWithRetry(url.toString());
  if (!res.ok) {
    const errMsg = res.data?.error?.message || `Google Custom Search responded with status ${res.status}`;
    return { items: [], warning: errMsg };
  }

  const rawItems = Array.isArray(res.data?.items) ? res.data.items : [];
  const nowIso = new Date().toISOString();
  const results: OnlinePriceResultItem[] = [];

  for (const item of rawItems) {
    const safeUrl = sanitizeExternalHttpUrl(item?.link);
    if (!safeUrl) continue;
    const domain = extractDomain(safeUrl);
    const offer = extractStructuredCseOffer(item, domain);
    const region = classifyWebsiteRegion(domain, offer.currency, gl);
    const evalMatch = evaluateMatchQuality(
      targetMeta.targetText,
      targetMeta.brand,
      targetMeta.model,
      targetMeta.barcode,
      String(item?.title || domain),
      String(item?.snippet || ''),
      offer.brand,
      offer.model,
      offer.barcode
    );

    results.push({
      id: `cse_${crypto.createHash('sha1').update(safeUrl).digest('hex').slice(0, 12)}`,
      title: String(item?.title || domain).trim(),
      brand: offer.brand,
      model: offer.model,
      barcode: offer.barcode,
      websiteName: friendlyWebsiteName(domain),
      websiteDomain: domain,
      websiteUrl: safeUrl,
      imageUrl: offer.imageUrl,
      price: offer.price,
      currency: offer.currency,
      priceDisplay: formatCurrencyPriceDisplay(offer.price, offer.currency),
      hasVerifiedPrice: Boolean(offer.price && offer.price > 0),
      availability: offer.availability.status,
      availabilityLabel: offer.availability.label,
      region,
      sourceType: offer.sourceType,
      sourceLabel: offer.sourceLabel,
      matchQuality: evalMatch.matchQuality,
      matchScore: evalMatch.matchScore,
      matchReason: evalMatch.matchReason,
      mismatchWarning: evalMatch.mismatchWarning,
      snippet: item?.snippet ? String(item.snippet).trim() : undefined,
      lastCheckedAt: nowIso,
      cached: false,
    });
  }

  return { items: results };
}

async function querySerpApiShopping(
  query: string,
  gl: 'pk' | 'us',
  targetMeta: {
    targetText: string;
    brand?: string;
    model?: string;
    barcode?: string;
  }
): Promise<{ items: OnlinePriceResultItem[]; warning?: string }> {
  const apiKey = (process.env.SERPAPI_API_KEY || '').trim();
  if (!apiKey) return { items: [] };

  const endpoint = (process.env.SERPAPI_ENDPOINT || DEFAULT_SERPAPI_ENDPOINT).trim();
  const url = new URL(endpoint);
  url.searchParams.set('engine', 'google_shopping');
  url.searchParams.set('q', query);
  url.searchParams.set('gl', gl);
  url.searchParams.set('hl', 'en');
  if (gl === 'pk') {
    url.searchParams.set('location', 'Pakistan');
  }
  url.searchParams.set('api_key', apiKey);

  const res = await fetchJsonWithRetry(url.toString());
  if (!res.ok) {
    const errMsg = res.data?.error || `Google Shopping API responded with status ${res.status}`;
    return { items: [], warning: errMsg };
  }

  const shoppingResults = Array.isArray(res.data?.shopping_results) ? res.data.shopping_results : [];
  const nowIso = new Date().toISOString();
  const results: OnlinePriceResultItem[] = [];

  for (const row of shoppingResults) {
    const safeUrl = sanitizeExternalHttpUrl(row?.link || row?.product_link);
    if (!safeUrl) continue;
    const domain = extractDomain(safeUrl);
    const parsedPrice = parseNumericPrice(row?.extracted_price ?? row?.price);
    const currency = parsedPrice
      ? normalizeCurrencyCode(row?.currency || null, typeof row?.price === 'string' ? row.price : null, domain)
      : null;
    const hasVerifiedPrice = Boolean(parsedPrice && parsedPrice > 0);
    const region = classifyWebsiteRegion(domain, currency, gl);
    const availText = [row?.delivery, row?.tag, row?.extensions?.join?.(' ')].filter(Boolean).join(' ');
    const avail = normalizeAvailability(availText);
    const evalMatch = evaluateMatchQuality(
      targetMeta.targetText,
      targetMeta.brand,
      targetMeta.model,
      targetMeta.barcode,
      String(row?.title || row?.source || domain),
      String(row?.snippet || row?.delivery || ''),
      row?.brand,
      row?.model,
      row?.gtin
    );

    results.push({
      id: `shop_${crypto.createHash('sha1').update(`${safeUrl}_${row?.source || ''}`).digest('hex').slice(0, 12)}`,
      title: String(row?.title || row?.source || 'Online Store Item').trim(),
      brand: row?.brand ? String(row.brand).trim() : undefined,
      model: row?.model ? String(row.model).trim() : undefined,
      barcode: row?.gtin ? String(row.gtin).trim() : undefined,
      websiteName: friendlyWebsiteName(domain, row?.source),
      websiteDomain: domain,
      websiteUrl: safeUrl,
      imageUrl: sanitizeExternalHttpUrl(row?.thumbnail),
      price: hasVerifiedPrice ? parsedPrice : null,
      currency: hasVerifiedPrice ? currency : null,
      priceDisplay: formatCurrencyPriceDisplay(hasVerifiedPrice ? parsedPrice : null, hasVerifiedPrice ? currency : null),
      hasVerifiedPrice,
      availability: avail.status,
      availabilityLabel: avail.label,
      region,
      sourceType: 'serpapi_shopping',
      sourceLabel: region === 'pakistan' ? 'Google Shopping Pakistan' : 'Google Shopping Global',
      matchQuality: evalMatch.matchQuality,
      matchScore: evalMatch.matchScore,
      matchReason: evalMatch.matchReason,
      mismatchWarning: evalMatch.mismatchWarning,
      snippet: row?.delivery ? String(row.delivery).trim() : undefined,
      lastCheckedAt: nowIso,
      cached: false,
    });
  }

  return { items: results };
}

export function findLocalProductMatch(
  products: Product[],
  params: {
    localProductId?: string;
    barcode?: string;
    itemCode?: string;
    query?: string;
  },
  canViewCostAndProfit: boolean
): OnlinePriceLocalShopMatch | null {
  if (!Array.isArray(products) || products.length === 0) return null;

  let matched: Product | undefined;

  if (params.localProductId) {
    matched = products.find((p) => p.id === params.localProductId);
  }
  const cleanBarcode = (params.barcode || '').trim().toLowerCase();
  if (!matched && cleanBarcode) {
    matched = products.find((p) => (p.barcode || '').trim().toLowerCase() === cleanBarcode);
  }
  const cleanCode = (params.itemCode || '').trim().toLowerCase();
  if (!matched && cleanCode) {
    matched = products.find(
      (p) =>
        (p.sku || '').trim().toLowerCase() === cleanCode ||
        (p.barcode || '').trim().toLowerCase() === cleanCode ||
        p.id.trim().toLowerCase() === cleanCode
    );
  }
  const cleanQ = (params.query || '').trim().toLowerCase();
  if (!matched && cleanQ) {
    matched =
      products.find(
        (p) =>
          (p.barcode || '').trim().toLowerCase() === cleanQ ||
          (p.sku || '').trim().toLowerCase() === cleanQ ||
          p.name.trim().toLowerCase() === cleanQ
      ) ||
      products.find((p) => cleanQ.length >= 4 && p.name.trim().toLowerCase().includes(cleanQ));
  }

  if (!matched) return null;

  return {
    id: matched.id,
    name: matched.name,
    barcode: matched.barcode || undefined,
    sku: matched.sku || undefined,
    category: matched.category || undefined,
    salePrice: Number(matched.price) || 0,
    purchasePrice: canViewCostAndProfit ? Number(matched.costPrice) || 0 : null,
    stock: Number(matched.stock) || 0,
    unit: matched.unit || 'Pcs',
    canViewPurchasePrice: canViewCostAndProfit,
  };
}

export interface RunOnlinePriceSearchInput {
  shopId: string;
  query: string;
  searchMode: OnlinePriceSearchMode;
  barcode?: string;
  itemCode?: string;
  brand?: string;
  model?: string;
  category?: string;
  region: OnlinePriceRegionFilter;
  forceRefresh?: boolean;
  localProductMatch?: OnlinePriceLocalShopMatch | null;
}

function buildPriceSearchCacheKey(input: RunOnlinePriceSearchInput): string {
  const rawQuery = (input.query || '').trim();
  const cleanBarcode = (input.barcode || (input.searchMode === 'barcode' ? rawQuery : '') || input.localProductMatch?.barcode || '').trim();
  const cleanItemCode = (input.itemCode || (input.searchMode === 'item_code' ? rawQuery : '') || input.localProductMatch?.sku || '').trim();
  return JSON.stringify({
    shopId: input.shopId,
    q: rawQuery.toLowerCase(),
    mode: input.searchMode,
    barcode: cleanBarcode.toLowerCase(),
    itemCode: cleanItemCode.toLowerCase(),
    brand: (input.brand || '').trim().toLowerCase(),
    model: (input.model || '').trim().toLowerCase(),
    category: (input.category || '').trim().toLowerCase(),
    region: input.region,
    localId: input.localProductMatch?.id || '',
  });
}

export function isOnlinePriceSearchCached(input: RunOnlinePriceSearchInput): boolean {
  if (input.forceRefresh) return false;
  const cached = searchCache.get(buildPriceSearchCacheKey(input));
  return Boolean(cached && cached.expiresAtMs > Date.now());
}

export async function executeOnlinePriceSearch(input: RunOnlinePriceSearchInput): Promise<OnlinePriceSearchResponse> {
  const providerStatus = getPriceSearchProviderStatus();
  const rawQuery = (input.query || '').trim();
  const cleanBarcode = (input.barcode || (input.searchMode === 'barcode' ? rawQuery : '') || input.localProductMatch?.barcode || '').trim();
  const cleanItemCode = (input.itemCode || (input.searchMode === 'item_code' ? rawQuery : '') || input.localProductMatch?.sku || '').trim();

  const cacheKey = buildPriceSearchCacheKey(input);

  if (!input.forceRefresh) {
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      const cloned: OnlinePriceSearchResponse = {
        ...cached.response,
        cached: true,
        cacheExpiresAt: new Date(cached.expiresAtMs).toISOString(),
        localProductMatch: input.localProductMatch ?? cached.response.localProductMatch,
        results: cached.response.results.map((r) => ({ ...r, cached: true })),
      };
      return cloned;
    }
  }

  const warnings: string[] = [];
  const notices: string[] = [];

  // 1. Optional Barcode Registry Lookup (Open Food Facts) when numeric barcode present
  let resolvedMeta: OnlinePriceResolvedProductMeta | undefined;
  const collected: OnlinePriceResultItem[] = [];

  if (cleanBarcode && /^\d{6,14}$/.test(cleanBarcode.replace(/\s+/g, ''))) {
    try {
      const off = await lookupOpenFoodFactsBarcode(cleanBarcode);
      if (off.meta) {
        resolvedMeta = off.meta;
      }
      if (off.item) {
        collected.push(off.item);
      }
    } catch {
      warnings.push('Barcode registry lookup timed out or was unreachable.');
    }
  }

  // 2. Build enriched search query (Local POS Name / OpenFoodFacts Name + Brand + Model + Query)
  const searchTerms: string[] = [];
  if (input.searchMode === 'item_code' && input.localProductMatch?.name) {
    searchTerms.push(input.localProductMatch.name);
    if (input.localProductMatch.barcode) searchTerms.push(input.localProductMatch.barcode);
  } else if (input.searchMode === 'barcode') {
    if (input.localProductMatch?.name) {
      searchTerms.push(input.localProductMatch.name);
    } else if (resolvedMeta?.productName) {
      searchTerms.push(resolvedMeta.productName);
      if (resolvedMeta.brand) searchTerms.push(resolvedMeta.brand);
      if (resolvedMeta.packSize) searchTerms.push(resolvedMeta.packSize);
    }
    if (cleanBarcode) searchTerms.push(cleanBarcode);
  } else {
    if (rawQuery) searchTerms.push(rawQuery);
    if (input.brand && !rawQuery.toLowerCase().includes(input.brand.toLowerCase())) {
      searchTerms.push(input.brand);
    }
    if (input.model && !rawQuery.toLowerCase().includes(input.model.toLowerCase())) {
      searchTerms.push(input.model);
    }
  }

  const normalizedQuery = searchTerms.join(' ').replace(/\s+/g, ' ').trim() || rawQuery || cleanBarcode || cleanItemCode;
  const targetText =
    input.localProductMatch?.name ||
    resolvedMeta?.productName ||
    [rawQuery, input.brand, input.model].filter(Boolean).join(' ') ||
    normalizedQuery;

  const targetMeta = {
    targetText,
    brand: input.brand || resolvedMeta?.brand,
    model: input.model,
    barcode: cleanBarcode || undefined,
  };

  if (!providerStatus.hasLiveShoppingOrSearchProvider) {
    notices.push(providerStatus.missingConfigSummary);
  } else {
    const glOrder: Array<'pk' | 'us'> =
      input.region === 'pakistan' ? ['pk'] : input.region === 'international' ? ['us'] : ['pk', 'us'];

    const tasks: Array<Promise<{ items: OnlinePriceResultItem[]; warning?: string }>> = [];
    for (const gl of glOrder) {
      if (providerStatus.serpApiConfigured) {
        tasks.push(querySerpApiShopping(normalizedQuery, gl, targetMeta));
      }
      if (providerStatus.googleCseConfigured) {
        tasks.push(queryGoogleCustomSearch(normalizedQuery, gl, targetMeta));
      }
    }

    const settled = await Promise.allSettled(tasks);
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        if (outcome.value.warning) warnings.push(outcome.value.warning);
        collected.push(...outcome.value.items);
      } else {
        warnings.push('One upstream search provider failed or timed out.');
      }
    }
  }

  // Filter out OpenFoodFacts or cross-region if user explicitly filtered region
  const regionFiltered = collected.filter((item) => {
    if (input.region === 'pakistan') return item.region === 'pakistan';
    if (input.region === 'international') return item.region === 'international';
    return true;
  });

  // Deduplicate by websiteUrl keeping the entry with verified price or higher matchScore
  const dedupedMap = new Map<string, OnlinePriceResultItem>();
  for (const item of regionFiltered) {
    const key = item.websiteUrl.toLowerCase();
    const prev = dedupedMap.get(key);
    if (!prev) {
      dedupedMap.set(key, item);
      continue;
    }
    const prevRank = (prev.hasVerifiedPrice ? 100 : 0) + prev.matchScore;
    const nextRank = (item.hasVerifiedPrice ? 100 : 0) + item.matchScore;
    if (nextRank > prevRank) {
      dedupedMap.set(key, item);
    }
  }

  const results = Array.from(dedupedMap.values()).sort((a, b) => {
    // Pakistani stores first when region is 'all', then exact matches, then verified prices
    if (a.region !== b.region) return a.region === 'pakistan' ? -1 : 1;
    if (a.hasVerifiedPrice !== b.hasVerifiedPrice) return a.hasVerifiedPrice ? -1 : 1;
    if (a.matchQuality !== b.matchQuality) {
      const order: Record<OnlinePriceMatchQuality, number> = { exact: 0, possible: 1, mismatch: 2 };
      return order[a.matchQuality] - order[b.matchQuality];
    }
    return b.matchScore - a.matchScore;
  });

  const comparison = buildComparisonSummary(results);
  const searchedAt = new Date().toISOString();
  const expiresAtMs = Date.now() + CACHE_TTL_MS;

  if (results.length > 0 && !comparison.hasExactMatch) {
    notices.push('Exact Match Not Found — review brand, model, or pack size carefully before using these prices.');
  }

  const response: OnlinePriceSearchResponse = {
    success: true,
    query: rawQuery || cleanBarcode || cleanItemCode,
    normalizedQuery,
    searchMode: input.searchMode,
    region: input.region,
    searchedAt,
    cached: false,
    cacheExpiresAt: new Date(expiresAtMs).toISOString(),
    providerStatus,
    resolvedMeta,
    localProductMatch: input.localProductMatch ?? null,
    results,
    comparison,
    warnings: Array.from(new Set(warnings)),
    notices: Array.from(new Set(notices)),
  };

  searchCache.set(cacheKey, { response, expiresAtMs });
  return response;
}
