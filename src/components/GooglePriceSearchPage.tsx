import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  Bookmark,
  BookmarkCheck,
  CheckCircle2,
  Clock,
  DollarSign,
  ExternalLink,
  Filter,
  Globe,
  History,
  Info,
  Package,
  RefreshCw,
  Save,
  ScanBarcode,
  Search,
  ShoppingBag,
  Sparkles,
  Store,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  OnlinePriceFavouriteItem,
  OnlinePriceProviderStatus,
  OnlinePriceRegionFilter,
  OnlinePriceResultItem,
  OnlinePriceSearchMode,
  OnlinePriceSearchQueryRecord,
  OnlinePriceSearchResponse,
  Product,
  SavedPriceComparisonRecord,
  StoreBranding,
} from '../types/pos';
import { FullScreenPageHeader } from './FullScreenPageHeader';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import {
  clearPriceSearchHistoryApi,
  fetchPriceSearchConfig,
  removePriceComparisonApi,
  removePriceSearchFavouriteApi,
  runOnlinePriceSearchApi,
  sanitizeUiExternalUrl,
  savePriceComparisonApi,
  savePriceSearchFavouriteApi,
} from '../utils/priceSearchClient';

interface GooglePriceSearchPageProps {
  products: Product[];
  branding?: StoreBranding;
  activeShopId?: string;
  canViewCostAndProfit: boolean;
  canEditPrice: boolean;
  initialHistory?: OnlinePriceSearchQueryRecord[];
  initialFavourites?: OnlinePriceFavouriteItem[];
  initialComparisons?: SavedPriceComparisonRecord[];
  onUpdateProduct?: (updated: Product) => { ok: boolean; message?: string };
  onBack?: () => void;
  onBackToHome?: () => void;
  onShowToast?: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

type ActiveTab = 'results' | 'compare_shop' | 'favourites' | 'history';
type SortOption = 'relevance' | 'price_asc' | 'price_desc';

const RESULTS_PER_PAGE = 12;

function formatDateTimeShort(iso?: string): string {
  if (!iso) return 'Just now';
  try {
    return new Date(iso).toLocaleString('en-PK', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatMoney(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return 'Price Not Available';
  }
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  if (!currency || currency === 'PKR') return `Rs. ${formatted}`;
  if (currency === 'USD') return `$${formatted}`;
  if (currency === 'GBP') return `£${formatted}`;
  if (currency === 'EUR') return `€${formatted}`;
  return `${currency} ${formatted}`;
}

const ProductResultThumbnail: React.FC<{ imageUrl?: string; alt: string }> = ({ imageUrl, alt }) => {
  const safeSrc = sanitizeUiExternalUrl(imageUrl);
  const [failed, setFailed] = useState(false);

  if (!safeSrc || failed) {
    return (
      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0 text-slate-400">
        <Package className="w-7 h-7" />
      </div>
    );
  }

  return (
    <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl bg-white border border-slate-200 overflow-hidden shrink-0 flex items-center justify-center p-1">
      <img
        src={safeSrc}
        alt={alt}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className="w-full h-full object-contain"
      />
    </div>
  );
};

export const GooglePriceSearchPage: React.FC<GooglePriceSearchPageProps> = ({
  products,
  branding,
  activeShopId,
  canViewCostAndProfit,
  canEditPrice,
  initialHistory = [],
  initialFavourites = [],
  initialComparisons = [],
  onUpdateProduct,
  onBack,
  onBackToHome,
  onShowToast,
}) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('results');

  // Search form controls
  const [searchMode, setSearchMode] = useState<OnlinePriceSearchMode>('name');
  const [queryText, setQueryText] = useState('');
  const [brandInput, setBrandInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [categoryInput, setCategoryInput] = useState('');
  const [regionFilter, setRegionFilter] = useState<OnlinePriceRegionFilter>('all');
  const [selectedLocalProductId, setSelectedLocalProductId] = useState<string>('');
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  // Loading & error state
  const [isSearching, setIsSearching] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<OnlinePriceProviderStatus | null>(null);
  const [searchResponse, setSearchResponse] = useState<OnlinePriceSearchResponse | null>(null);

  // Persistent lists synced with backend
  const [history, setHistory] = useState<OnlinePriceSearchQueryRecord[]>(initialHistory);
  const [favourites, setFavourites] = useState<OnlinePriceFavouriteItem[]>(initialFavourites);
  const [savedComparisons, setSavedComparisons] = useState<SavedPriceComparisonRecord[]>(initialComparisons);

  // Filters, sorting, pagination
  const [sortBy, setSortBy] = useState<SortOption>('relevance');
  const [regionResultFilter, setRegionResultFilter] = useState<'all' | 'pakistan' | 'international'>('all');
  const [brandFilter, setBrandFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [exactMatchOnly, setExactMatchOnly] = useState(false);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [pricedOnly, setPricedOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  // Modals (Clear History & Optional Manual Price Update Confirmation)
  const [confirmClearHistoryOpen, setConfirmClearHistoryOpen] = useState(false);
  const [manualPriceDialogOpen, setManualPriceDialogOpen] = useState(false);
  const [proposedNewSalePrice, setProposedNewSalePrice] = useState('');

  useEffect(() => {
    setHistory(initialHistory);
  }, [initialHistory]);

  useEffect(() => {
    setFavourites(initialFavourites);
  }, [initialFavourites]);

  useEffect(() => {
    setSavedComparisons(initialComparisons);
  }, [initialComparisons]);

  useEffect(() => {
    let cancelled = false;
    fetchPriceSearchConfig(activeShopId)
      .then((cfg) => {
        if (cancelled) return;
        if (cfg.providerStatus) setProviderStatus(cfg.providerStatus);
        if (Array.isArray(cfg.history)) setHistory(cfg.history);
        if (Array.isArray(cfg.favourites)) setFavourites(cfg.favourites);
        if (Array.isArray(cfg.savedComparisons)) setSavedComparisons(cfg.savedComparisons);
      })
      .catch(() => {
        // Silent initial load fallback
      });
    return () => {
      cancelled = true;
    };
  }, [activeShopId]);

  // Match local POS product either from explicit selection or searchResponse
  const activeLocalProduct: Product | null = useMemo(() => {
    if (selectedLocalProductId) {
      const found = products.find((p) => p.id === selectedLocalProductId);
      if (found) return found;
    }
    if (searchResponse?.localProductMatch?.id) {
      const found = products.find((p) => p.id === searchResponse.localProductMatch?.id);
      if (found) return found;
    }
    return null;
  }, [products, selectedLocalProductId, searchResponse]);

  const performSearch = async (overrides?: {
    query?: string;
    mode?: OnlinePriceSearchMode;
    barcode?: string;
    itemCode?: string;
    brand?: string;
    model?: string;
    category?: string;
    region?: OnlinePriceRegionFilter;
    localProductId?: string;
    forceRefresh?: boolean;
  }) => {
    const mode = overrides?.mode ?? searchMode;
    const rawQ = (overrides?.query ?? queryText).trim();
    const localId = overrides?.localProductId ?? selectedLocalProductId;

    if (!rawQ && !overrides?.barcode && !overrides?.itemCode && !localId) {
      setErrorMsg('Please enter a product name, barcode, or item code to search online.');
      return;
    }

    setErrorMsg(null);
    setIsSearching(true);
    setCurrentPage(1);

    try {
      const data = await runOnlinePriceSearchApi(
        {
          query: rawQ,
          searchMode: mode,
          barcode: overrides?.barcode ?? (mode === 'barcode' ? rawQ : undefined),
          itemCode: overrides?.itemCode ?? (mode === 'item_code' ? rawQ : undefined),
          brand: (overrides?.brand ?? brandInput).trim() || undefined,
          model: (overrides?.model ?? modelInput).trim() || undefined,
          category: (overrides?.category ?? categoryInput).trim() || undefined,
          region: overrides?.region ?? regionFilter,
          localProductId: localId || undefined,
          forceRefresh: Boolean(overrides?.forceRefresh),
        },
        activeShopId
      );

      setSearchResponse(data);
      if (data.providerStatus) setProviderStatus(data.providerStatus);
      if (Array.isArray(data.history)) setHistory(data.history);
      if (data.localProductMatch?.id && !selectedLocalProductId) {
        setSelectedLocalProductId(data.localProductMatch.id);
      }
      setActiveTab('results');
    } catch (err: any) {
      const msg = err?.message || 'Unable to complete online product price search.';
      setErrorMsg(msg);
      onShowToast?.(msg, 'error');
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    performSearch();
  };

  const handleBarcodeScanned = (scannedCode: string) => {
    const clean = scannedCode.trim();
    if (!clean) return;
    setSearchMode('barcode');
    setQueryText(clean);
    performSearch({
      query: clean,
      mode: 'barcode',
      barcode: clean,
    });
  };

  const handleClearSearch = () => {
    setQueryText('');
    setBrandInput('');
    setModelInput('');
    setCategoryInput('');
    setSelectedLocalProductId('');
    setErrorMsg(null);
    setSearchResponse(null);
    setCurrentPage(1);
  };

  const handleToggleFavourite = async (item: OnlinePriceResultItem) => {
    const existing = favourites.find((f) => f.websiteUrl && f.websiteUrl === item.websiteUrl);
    try {
      if (existing) {
        const updated = await removePriceSearchFavouriteApi(existing.id, activeShopId);
        setFavourites(updated);
        onShowToast?.('Removed from Favourite Products.', 'info');
      } else {
        const updated = await savePriceSearchFavouriteApi(
          {
            title: item.title,
            query: searchResponse?.query || item.title,
            searchMode,
            barcode: item.barcode || searchResponse?.resolvedMeta?.barcode,
            brand: item.brand || brandInput || undefined,
            model: item.model || modelInput || undefined,
            category: item.category || categoryInput || undefined,
            websiteName: item.websiteName,
            websiteUrl: item.websiteUrl,
            imageUrl: item.imageUrl,
            price: item.price,
            currency: item.currency,
            localProductId: activeLocalProduct?.id,
          },
          activeShopId
        );
        setFavourites(updated);
        onShowToast?.('Saved to Favourite Products!', 'success');
      }
    } catch (err: any) {
      onShowToast?.(err?.message || 'Could not update favourites.', 'error');
    }
  };

  const handleSaveComparison = async () => {
    if (!searchResponse || searchResponse.results.length === 0) return;
    try {
      const pkr = searchResponse.comparison.primaryPkrComparison;
      const updated = await savePriceComparisonApi(
        {
          query: searchResponse.query,
          searchedAt: searchResponse.searchedAt,
          localProductId: activeLocalProduct?.id,
          localProductName: activeLocalProduct?.name,
          localSalePrice: activeLocalProduct?.price,
          lowestPkrPrice: pkr?.lowestPrice ?? null,
          averagePkrPrice: pkr?.averagePrice ?? null,
          highestPkrPrice: pkr?.highestPrice ?? null,
          websiteCount: pkr?.websiteCount || searchResponse.results.length,
          results: searchResponse.results.slice(0, 20),
        },
        activeShopId
      );
      setSavedComparisons(updated);
      onShowToast?.('Price comparison snapshot saved!', 'success');
    } catch (err: any) {
      onShowToast?.(err?.message || 'Failed to save comparison.', 'error');
    }
  };

  const handleConfirmClearHistory = async () => {
    try {
      const updated = await clearPriceSearchHistoryApi(activeShopId);
      setHistory(updated);
      setConfirmClearHistoryOpen(false);
      onShowToast?.('Online price search history cleared.', 'info');
    } catch (err: any) {
      onShowToast?.(err?.message || 'Failed to clear history.', 'error');
    }
  };

  const handleConfirmManualSalePriceUpdate = () => {
    if (!activeLocalProduct || !onUpdateProduct) return;
    const numeric = Number(proposedNewSalePrice);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      onShowToast?.('Please enter a valid positive sale price.', 'error');
      return;
    }
    const res = onUpdateProduct({
      ...activeLocalProduct,
      price: Math.round(numeric * 100) / 100,
    });
    if (res.ok) {
      setManualPriceDialogOpen(false);
    }
  };

  // Derive available filter facets from live results
  const availableBrands = useMemo(() => {
    const set = new Set<string>();
    for (const r of searchResponse?.results || []) {
      if (r.brand) set.add(r.brand);
    }
    return Array.from(set).sort();
  }, [searchResponse]);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of searchResponse?.results || []) {
      if (r.category) set.add(r.category);
    }
    return Array.from(set).sort();
  }, [searchResponse]);

  // Apply interactive filters & sorting
  const filteredResults = useMemo(() => {
    const raw = searchResponse?.results || [];
    const filtered = raw.filter((item) => {
      if (regionResultFilter !== 'all' && item.region !== regionResultFilter) return false;
      if (brandFilter !== 'all' && item.brand !== brandFilter) return false;
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
      if (exactMatchOnly && item.matchQuality !== 'exact') return false;
      if (availableOnly && item.availability !== 'in_stock' && item.availability !== 'limited') return false;
      if (pricedOnly && !item.hasVerifiedPrice) return false;
      return true;
    });

    if (sortBy === 'price_asc') {
      return [...filtered].sort((a, b) => {
        if (a.hasVerifiedPrice !== b.hasVerifiedPrice) return a.hasVerifiedPrice ? -1 : 1;
        return (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER);
      });
    }
    if (sortBy === 'price_desc') {
      return [...filtered].sort((a, b) => {
        if (a.hasVerifiedPrice !== b.hasVerifiedPrice) return a.hasVerifiedPrice ? -1 : 1;
        return (b.price ?? -1) - (a.price ?? -1);
      });
    }
    return filtered;
  }, [searchResponse, regionResultFilter, brandFilter, categoryFilter, exactMatchOnly, availableOnly, pricedOnly, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filteredResults.length / RESULTS_PER_PAGE));
  const pagedResults = useMemo(() => {
    const safePage = Math.min(currentPage, totalPages);
    const start = (safePage - 1) * RESULTS_PER_PAGE;
    return filteredResults.slice(start, start + RESULTS_PER_PAGE);
  }, [filteredResults, currentPage, totalPages]);

  const pakistaniPagedResults = useMemo(
    () => pagedResults.filter((r) => r.region === 'pakistan'),
    [pagedResults]
  );
  const internationalPagedResults = useMemo(
    () => pagedResults.filter((r) => r.region === 'international'),
    [pagedResults]
  );

  // Local shop comparison calculations (never auto-mutates POS data)
  const localComparisonMetrics = useMemo(() => {
    if (!activeLocalProduct) return null;
    const pkrStats = searchResponse?.comparison?.primaryPkrComparison || null;
    const salePrice = Number(activeLocalProduct.price) || 0;
    const purchasePrice = canViewCostAndProfit ? Number(activeLocalProduct.costPrice) || 0 : null;
    const onlineLow = pkrStats ? pkrStats.lowestPrice : null;
    const onlineAvg = pkrStats ? pkrStats.averagePrice : null;
    const onlineHigh = pkrStats ? pkrStats.highestPrice : null;

    const diffVsLowest = onlineLow !== null ? Math.round((salePrice - onlineLow) * 100) / 100 : null;
    const diffVsAverage = onlineAvg !== null ? Math.round((salePrice - onlineAvg) * 100) / 100 : null;

    return {
      salePrice,
      purchasePrice,
      onlineLow,
      onlineAvg,
      onlineHigh,
      diffVsLowest,
      diffVsAverage,
      websiteCount: pkrStats?.websiteCount || 0,
    };
  }, [activeLocalProduct, searchResponse, canViewCostAndProfit]);

  const renderResultCard = (item: OnlinePriceResultItem, lowestItemId?: string) => {
    const isLowest = Boolean(lowestItemId && item.id === lowestItemId);
    const isFav = favourites.some((f) => f.websiteUrl && f.websiteUrl === item.websiteUrl);
    const safeLink = sanitizeUiExternalUrl(item.websiteUrl);

    return (
      <article
        key={item.id}
        data-testid="online-price-result-card"
        className={`rounded-2xl bg-white border p-4 flex flex-col justify-between gap-3 transition-shadow hover:shadow-md ${
          isLowest
            ? 'border-emerald-500 ring-1 ring-emerald-500/20'
            : item.matchQuality === 'mismatch'
            ? 'border-amber-300'
            : 'border-slate-200'
        }`}
      >
        <div className="space-y-3">
          {/* Top metadata line: Website + Region + Saved Star */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 truncate">
                <Globe className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="truncate">{item.websiteName}</span>
                <span className="text-slate-300">·</span>
                <span className={item.region === 'pakistan' ? 'text-emerald-700' : 'text-blue-700'}>
                  {item.region === 'pakistan' ? 'Pakistan' : 'International'}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 truncate mt-0.5">{item.sourceLabel}</p>
            </div>

            <button
              type="button"
              onClick={() => handleToggleFavourite(item)}
              className={`min-h-[36px] min-w-[36px] rounded-xl border flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                isFav
                  ? 'bg-amber-50 border-amber-300 text-amber-600'
                  : 'bg-slate-50 border-slate-200 text-slate-400 hover:text-amber-600'
              }`}
              title={isFav ? 'Remove from Favourites' : 'Save to Favourites'}
            >
              {isFav ? <BookmarkCheck className="w-4 h-4" /> : <Bookmark className="w-4 h-4" />}
            </button>
          </div>

          {/* Product thumbnail & title */}
          <div className="flex items-start gap-3">
            <ProductResultThumbnail imageUrl={item.imageUrl} alt={item.title} />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-bold text-slate-900 line-clamp-2 leading-snug">{item.title}</h3>
              <p className="text-xs text-slate-500 mt-1 truncate">
                {[
                  item.brand ? `Brand: ${item.brand}` : '',
                  item.model ? `Model: ${item.model}` : '',
                  item.barcode ? `Barcode: ${item.barcode}` : '',
                  item.packSize || '',
                ]
                  .filter(Boolean)
                  .join(' · ') || item.websiteDomain}
              </p>
            </div>
          </div>

          {/* Verified Price & Availability */}
          <div className="flex items-end justify-between gap-2 pt-2 border-t border-slate-100">
            <div>
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                {item.hasVerifiedPrice ? `Online Price (${item.currency || 'PKR'})` : 'Price Status'}
              </p>
              <p
                className={`text-lg font-black tabular-nums ${
                  item.hasVerifiedPrice
                    ? isLowest
                      ? 'text-emerald-700'
                      : 'text-slate-900'
                    : 'text-slate-500 text-sm'
                }`}
              >
                {item.priceDisplay}
              </p>
              {isLowest && item.hasVerifiedPrice && (
                <p className="text-[11px] font-bold text-emerald-700">Lowest Online Price</p>
              )}
            </div>

            <div className="text-right">
              <p
                className={`text-xs font-bold ${
                  item.availability === 'in_stock'
                    ? 'text-emerald-700'
                    : item.availability === 'out_of_stock'
                    ? 'text-red-600'
                    : item.availability === 'limited'
                    ? 'text-amber-700'
                    : 'text-slate-500'
                }`}
              >
                {item.availabilityLabel}
              </p>
              <p className="text-[11px] text-slate-400 tabular-nums mt-0.5">
                {formatDateTimeShort(item.lastCheckedAt)} {item.cached ? '· Cached' : '· Live'}
              </p>
            </div>
          </div>

          {/* Mismatch or match explanation */}
          {item.mismatchWarning ? (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>{item.mismatchWarning}</span>
            </div>
          ) : (
            <p
              className={`text-xs font-medium ${
                item.matchQuality === 'exact' ? 'text-emerald-700' : 'text-slate-500'
              }`}
            >
              {item.matchReason}
            </p>
          )}
        </div>

        {/* Footer button: Open Original Website */}
        <div className="pt-1">
          {safeLink ? (
            <a
              href={safeLink}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-900 hover:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-2 transition-colors"
            >
              <span>OPEN ORIGINAL WEBSITE</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          ) : (
            <div className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-100 text-slate-400 text-xs font-bold flex items-center justify-center">
              Website Link Unavailable
            </div>
          )}
        </div>
      </article>
    );
  };

  return (
    <div
      data-testid="google-price-search-page"
      className="flex-1 min-h-[100dvh] bg-slate-50 text-slate-900 flex flex-col font-sans pb-20 lg:pb-6"
    >
      <FullScreenPageHeader
        title="Google Online Price Search"
        urduTitle="آن لائن قیمت تلاش کریں"
        subtitle="Compare Pakistani & Global Store Prices With Your Shop Inventory"
        icon={<Search className="w-4 h-4" />}
        storeName={branding?.storeName || 'WAQAS MART'}
        onBack={onBack}
        onBackToHome={onBackToHome}
        actions={
          <button
            type="button"
            onClick={() => setIsScannerOpen(true)}
            className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <ScanBarcode className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Scan Barcode</span>
          </button>
        }
      />

      <div className="max-w-7xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-5 flex-1">
        {/* ============================================================== */}
        {/* 1. SEARCH BAR & MODE SELECTOR HERO                             */}
        {/* ============================================================== */}
        <section className="bg-white rounded-2xl border border-slate-200 shadow-xs p-4 sm:p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg sm:text-xl font-black text-slate-900 flex items-center gap-2">
                <Globe className="w-5 h-5 text-emerald-600" />
                <span>Search Products Online</span>
              </h2>
              <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
                Search by Product Name, Barcode, Brand, Model, or Shop Item Code · پاکستان اور عالمی قیمتیں چیک کریں
              </p>
            </div>

            {/* Search Mode Switcher */}
            <div className="inline-flex p-1 bg-slate-100 rounded-xl border border-slate-200 self-start">
              {(
                [
                  { id: 'name', label: 'Product Name' },
                  { id: 'barcode', label: 'Barcode' },
                  { id: 'item_code', label: 'Item Code / SKU' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSearchMode(m.id)}
                  className={`px-3 py-2 min-h-[38px] rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    searchMode === m.id
                      ? 'bg-white text-emerald-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSearchSubmit} className="space-y-3">
            <div className="flex flex-col md:flex-row gap-2.5">
              <div className="relative flex-1">
                <Search className="w-5 h-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  data-testid="price-search-input"
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  placeholder={
                    searchMode === 'barcode'
                      ? 'Scan or type product barcode (e.g. 8961014200123)...'
                      : searchMode === 'item_code'
                      ? 'Enter shop Item Code / SKU / Product ID...'
                      : 'Enter product name, brand, model, or weight (e.g. Dalda Cooking Oil 5L)...'
                  }
                  className="w-full min-h-[48px] pl-11 pr-10 py-2.5 rounded-xl border border-slate-300 bg-slate-50 focus:bg-white focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 text-sm font-medium text-slate-900 focus:outline-none"
                />
                {queryText && (
                  <button
                    type="button"
                    onClick={() => setQueryText('')}
                    aria-label="Clear input"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap sm:flex-nowrap gap-2">
                <button
                  type="button"
                  onClick={() => setIsScannerOpen(true)}
                  className="min-h-[48px] px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-800 text-xs sm:text-sm font-bold flex items-center justify-center gap-2 cursor-pointer flex-1 sm:flex-initial"
                >
                  <ScanBarcode className="w-4 h-4 text-emerald-700" />
                  <span>Scan</span>
                </button>

                <button
                  type="submit"
                  disabled={isSearching}
                  data-testid="price-search-submit-btn"
                  className="min-h-[48px] px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs sm:text-sm font-extrabold flex items-center justify-center gap-2 cursor-pointer shadow-xs flex-1 sm:flex-initial"
                >
                  <Search className="w-4 h-4" />
                  <span>{isSearching ? 'Searching...' : 'Search Online'}</span>
                </button>

                {searchResponse && (
                  <button
                    type="button"
                    disabled={isSearching}
                    onClick={() => performSearch({ forceRefresh: true })}
                    className="min-h-[48px] px-3.5 py-2.5 rounded-xl bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-800 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    title="Bypass cache & check live prices again"
                  >
                    <RefreshCw className={`w-4 h-4 ${isSearching ? 'animate-spin' : ''}`} />
                    <span className="hidden xl:inline">Live Refresh</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="min-h-[48px] px-3.5 py-2.5 rounded-xl bg-white hover:bg-slate-100 border border-slate-300 text-slate-600 text-xs font-bold cursor-pointer"
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Secondary Controls Row: Link Shop Product + Region + Refine Specs */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <select
                  value={selectedLocalProductId}
                  onChange={(e) => {
                    const pid = e.target.value;
                    setSelectedLocalProductId(pid);
                    const matched = products.find((p) => p.id === pid);
                    if (matched && !queryText.trim()) {
                      setQueryText(matched.name);
                    }
                  }}
                  aria-label="Link shop product for comparison"
                  className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700 max-w-xs"
                >
                  <option value="">Auto-Match Shop Product (Optional)</option>
                  {products.slice(0, 300).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — Rs. {p.price} {p.barcode ? `(${p.barcode})` : ''}
                    </option>
                  ))}
                </select>

                <select
                  value={regionFilter}
                  onChange={(e) => setRegionFilter(e.target.value as OnlinePriceRegionFilter)}
                  aria-label="Store region priority"
                  className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700"
                >
                  <option value="all">Pakistan First + Global</option>
                  <option value="pakistan">Pakistani Websites Only</option>
                  <option value="international">International Websites</option>
                </select>
              </div>

              <button
                type="button"
                onClick={() => setShowAdvancedFields(!showAdvancedFields)}
                className="text-xs font-bold text-emerald-700 hover:text-emerald-800 flex items-center gap-1 cursor-pointer min-h-[36px]"
              >
                <Filter className="w-3.5 h-3.5" />
                <span>{showAdvancedFields ? 'Hide Brand / Model Fields' : 'Add Brand / Model / Category'}</span>
              </button>
            </div>

            {showAdvancedFields && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-slate-100">
                <input
                  type="text"
                  value={brandInput}
                  onChange={(e) => setBrandInput(e.target.value)}
                  placeholder="Brand (e.g. Tapal, Nestle, Samsung)"
                  className="min-h-[40px] px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs font-medium focus:outline-none focus:border-emerald-500"
                />
                <input
                  type="text"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder="Model / Pack Size (e.g. 900g, A54)"
                  className="min-h-[40px] px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs font-medium focus:outline-none focus:border-emerald-500"
                />
                <input
                  type="text"
                  value={categoryInput}
                  onChange={(e) => setCategoryInput(e.target.value)}
                  placeholder="Category (e.g. Cooking Oil, Tea)"
                  className="min-h-[40px] px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs font-medium focus:outline-none focus:border-emerald-500"
                />
              </div>
            )}
          </form>

          {/* Recent Quick Chips (only real recent user searches) */}
          {history.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
              <span className="text-xs font-bold text-slate-500 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" /> Recent:
              </span>
              {history.slice(0, 6).map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => {
                    setSearchMode(h.searchMode);
                    setQueryText(h.query);
                    performSearch({
                      query: h.query,
                      mode: h.searchMode,
                      barcode: h.barcode,
                      itemCode: h.itemCode,
                      region: h.region,
                      localProductId: h.localProductId,
                    });
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-emerald-50 hover:text-emerald-800 border border-slate-200 text-xs font-semibold text-slate-700 cursor-pointer transition-colors"
                >
                  {h.query}
                </button>
              ))}
            </div>
          )}

          {/* Server Configuration Notice if Google/Shopping providers are unconfigured */}
          {providerStatus && !providerStatus.hasLiveShoppingOrSearchProvider && (
            <div
              data-testid="provider-setup-notice"
              className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950 space-y-1.5"
            >
              <div className="flex items-start gap-2 font-bold">
                <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <span>{providerStatus.missingConfigSummary}</span>
              </div>
              <ul className="list-disc pl-6 space-y-0.5 text-amber-900">
                {providerStatus.setupInstructions.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs font-bold text-red-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </section>

        {/* ============================================================== */}
        {/* 2. SECTION TABS                                                */}
        {/* ============================================================== */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {[
            {
              id: 'results' as const,
              label: `Search Results${searchResponse ? ` (${searchResponse.results.length})` : ''}`,
              icon: Search,
            },
            {
              id: 'compare_shop' as const,
              label: 'Compare With My Shop Price',
              icon: Store,
            },
            {
              id: 'favourites' as const,
              label: `Favourites & Saved (${favourites.length + savedComparisons.length})`,
              icon: Bookmark,
            },
            {
              id: 'history' as const,
              label: `Search History (${history.length})`,
              icon: History,
            },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`min-h-[44px] px-4 py-2 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2 whitespace-nowrap cursor-pointer border transition-colors ${
                  active
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* ============================================================== */}
        {/* 3. TAB A: SEARCH RESULTS & COMPARISON TABLE                    */}
        {/* ============================================================== */}
        {activeTab === 'results' && (
          <div className="space-y-5">
            {!searchResponse ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-8 sm:p-12 text-center space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center mx-auto border border-emerald-200">
                  <ShoppingBag className="w-7 h-7" />
                </div>
                <h3 className="text-base sm:text-lg font-black text-slate-900">
                  Ready to Check Real Online Product Prices
                </h3>
                <p className="text-xs sm:text-sm text-slate-500 max-w-xl mx-auto">
                  Enter any product name, scan a barcode with your mobile camera, or choose a shop item above to compare Pakistani store prices (Daraz, PriceOye, Naheed, HumMart, Al-Fatah, Imtiaz) and global listings against your WAQAS POS retail rate.
                </p>
              </div>
            ) : (
              <>
                {/* Notices & Resolved Product Metadata */}
                {searchResponse.resolvedMeta?.productName && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <ProductResultThumbnail
                        imageUrl={searchResponse.resolvedMeta.imageUrl}
                        alt={searchResponse.resolvedMeta.productName}
                      />
                      <div>
                        <p className="text-xs font-bold text-emerald-800 uppercase tracking-wide">
                          Barcode Identified ({searchResponse.resolvedMeta.source})
                        </p>
                        <p className="text-sm font-black text-slate-900">
                          {searchResponse.resolvedMeta.productName}
                        </p>
                        <p className="text-xs text-slate-600">
                          {[
                            searchResponse.resolvedMeta.brand,
                            searchResponse.resolvedMeta.packSize,
                            searchResponse.resolvedMeta.barcode,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {searchResponse.notices.map((note, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-xl bg-blue-50 border border-blue-200 text-xs font-semibold text-blue-900 flex items-center gap-2"
                  >
                    <Info className="w-4 h-4 text-blue-600 shrink-0" />
                    <span>{note}</span>
                  </div>
                ))}

                {searchResponse.warnings.map((warn, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs font-semibold text-amber-900 flex items-center gap-2"
                  >
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>{warn}</span>
                  </div>
                ))}

                {/* Price Comparison Summary KPI Strip */}
                {searchResponse.comparison.currencyComparisons.length > 0 && (
                  <section className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm sm:text-base font-black text-slate-900 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-emerald-600" />
                        <span>Online Price Comparison Summary</span>
                      </h3>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleSaveComparison}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl bg-white hover:bg-slate-100 border border-slate-300 text-xs font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer"
                        >
                          <Save className="w-3.5 h-3.5 text-emerald-700" />
                          <span>Save Comparison</span>
                        </button>
                        {activeLocalProduct && (
                          <button
                            type="button"
                            onClick={() => setActiveTab('compare_shop')}
                            className="min-h-[38px] px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                          >
                            <Store className="w-3.5 h-3.5" />
                            <span>Compare With My Shop Price</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                      {searchResponse.comparison.currencyComparisons.slice(0, 1).map((comp) => (
                        <React.Fragment key={comp.currency}>
                          <div className="bg-white rounded-2xl border border-emerald-200 p-4">
                            <p className="text-xs font-bold text-slate-500">Lowest Online ({comp.currency})</p>
                            <p className="text-2xl font-black text-emerald-700 tabular-nums mt-1">
                              {formatMoney(comp.lowestPrice, comp.currency)}
                            </p>
                            <p className="text-xs text-slate-600 mt-1 truncate">{comp.lowestWebsite}</p>
                          </div>
                          <div className="bg-white rounded-2xl border border-slate-200 p-4">
                            <p className="text-xs font-bold text-slate-500">Average Price ({comp.currency})</p>
                            <p className="text-2xl font-black text-slate-900 tabular-nums mt-1">
                              {comp.averagePrice !== null
                                ? formatMoney(comp.averagePrice, comp.currency)
                                : 'Need 2+ Stores'}
                            </p>
                            <p className="text-xs text-slate-500 mt-1">Excludes mismatched variants</p>
                          </div>
                          <div className="bg-white rounded-2xl border border-slate-200 p-4">
                            <p className="text-xs font-bold text-slate-500">Highest Online ({comp.currency})</p>
                            <p className="text-2xl font-black text-slate-900 tabular-nums mt-1">
                              {formatMoney(comp.highestPrice, comp.currency)}
                            </p>
                            <p className="text-xs text-slate-600 mt-1 truncate">{comp.highestWebsite}</p>
                          </div>
                          <div className="bg-white rounded-2xl border border-slate-200 p-4">
                            <p className="text-xs font-bold text-slate-500">Matching Websites</p>
                            <p className="text-2xl font-black text-blue-700 tabular-nums mt-1">
                              {comp.websiteCount}
                            </p>
                            <p className="text-xs text-slate-500 mt-1">
                              {searchResponse.comparison.pakistaniCount} PK ·{' '}
                              {searchResponse.comparison.internationalCount} International
                            </p>
                          </div>
                        </React.Fragment>
                      ))}
                    </div>
                  </section>
                )}

                {/* Filter & Sort Controls */}
                {searchResponse.results.length > 0 && (
                  <section className="bg-white rounded-2xl border border-slate-200 p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                        <ArrowDownUp className="w-3.5 h-3.5" />
                        <span>Sort:</span>
                      </div>
                      <select
                        value={sortBy}
                        onChange={(e) => {
                          setSortBy(e.target.value as SortOption);
                          setCurrentPage(1);
                        }}
                        className="min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 text-xs font-semibold"
                      >
                        <option value="relevance">Best Match First</option>
                        <option value="price_asc">Lowest Price First</option>
                        <option value="price_desc">Highest Price First</option>
                      </select>

                      <select
                        value={regionResultFilter}
                        onChange={(e) => {
                          setRegionResultFilter(e.target.value as 'all' | 'pakistan' | 'international');
                          setCurrentPage(1);
                        }}
                        className="min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 text-xs font-semibold"
                      >
                        <option value="all">All Websites ({searchResponse.results.length})</option>
                        <option value="pakistan">
                          Pakistani Websites ({searchResponse.comparison.pakistaniCount})
                        </option>
                        <option value="international">
                          International ({searchResponse.comparison.internationalCount})
                        </option>
                      </select>

                      {availableBrands.length > 0 && (
                        <select
                          value={brandFilter}
                          onChange={(e) => {
                            setBrandFilter(e.target.value);
                            setCurrentPage(1);
                          }}
                          className="min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 text-xs font-semibold"
                        >
                          <option value="all">All Brands</option>
                          {availableBrands.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      )}

                      {availableCategories.length > 0 && (
                        <select
                          value={categoryFilter}
                          onChange={(e) => {
                            setCategoryFilter(e.target.value);
                            setCurrentPage(1);
                          }}
                          className="min-h-[38px] px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 text-xs font-semibold"
                        >
                          <option value="all">All Categories</option>
                          {availableCategories.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-700">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={exactMatchOnly}
                          onChange={(e) => {
                            setExactMatchOnly(e.target.checked);
                            setCurrentPage(1);
                          }}
                          className="rounded border-slate-300 text-emerald-600"
                        />
                        <span>Exact Match Only</span>
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={availableOnly}
                          onChange={(e) => {
                            setAvailableOnly(e.target.checked);
                            setCurrentPage(1);
                          }}
                          className="rounded border-slate-300 text-emerald-600"
                        />
                        <span>In Stock Only</span>
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pricedOnly}
                          onChange={(e) => {
                            setPricedOnly(e.target.checked);
                            setCurrentPage(1);
                          }}
                          className="rounded border-slate-300 text-emerald-600"
                        />
                        <span>Verified Price Only</span>
                      </label>
                    </div>
                  </section>
                )}

                {/* Empty Results Message */}
                {filteredResults.length === 0 ? (
                  <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-2">
                    <p className="text-sm font-black text-slate-900">No Matching Online Listings Found</p>
                    <p className="text-xs text-slate-500">
                      Try broadening your product name, adjusting filters, or verifying server search provider configuration.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Pakistani Websites Section */}
                    {pakistaniPagedResults.length > 0 && (
                      <section className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-black text-slate-900">
                            Pakistani Websites (PKR / Rs.)
                          </h3>
                          <span className="text-xs text-slate-500 font-semibold">
                            {pakistaniPagedResults.length} shown on page
                          </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                          {pakistaniPagedResults.map((item) =>
                            renderResultCard(
                              item,
                              searchResponse.comparison.primaryPkrComparison?.lowestItemId
                            )
                          )}
                        </div>
                      </section>
                    )}

                    {/* International Websites Section */}
                    {internationalPagedResults.length > 0 && (
                      <section className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-black text-slate-900">
                            International Websites (Original Store Currency — No Fake FX Conversion)
                          </h3>
                          <span className="text-xs text-slate-500 font-semibold">
                            {internationalPagedResults.length} shown on page
                          </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                          {internationalPagedResults.map((item) => renderResultCard(item))}
                        </div>
                      </section>
                    )}

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-center gap-2 pt-2">
                        <button
                          type="button"
                          disabled={currentPage <= 1}
                          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                          className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-white border border-slate-300 text-xs font-bold disabled:opacity-40 cursor-pointer"
                        >
                          Previous
                        </button>
                        <span className="text-xs font-bold text-slate-600 tabular-nums px-2">
                          Page {currentPage} of {totalPages}
                        </span>
                        <button
                          type="button"
                          disabled={currentPage >= totalPages}
                          onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                          className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-white border border-slate-300 text-xs font-bold disabled:opacity-40 cursor-pointer"
                        >
                          Next
                        </button>
                      </div>
                    )}

                    {/* Side-by-Side Comparison Table */}
                    {filteredResults.filter((r) => r.hasVerifiedPrice).length >= 2 && (
                      <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                          <h3 className="text-sm font-black text-slate-900">
                            Side-by-Side Website Price Comparison Table
                          </h3>
                          <span className="text-xs text-slate-500">
                            Lowest PKR rate highlighted
                          </span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                                <th className="py-2.5 px-3">Website Name</th>
                                <th className="py-2.5 px-3">Product Name</th>
                                <th className="py-2.5 px-3">Price</th>
                                <th className="py-2.5 px-3">Currency</th>
                                <th className="py-2.5 px-3">Availability</th>
                                <th className="py-2.5 px-3">Last Checked</th>
                                <th className="py-2.5 px-3 text-right">Open Website</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {filteredResults.map((row) => {
                                const isLowest =
                                  row.id === searchResponse.comparison.primaryPkrComparison?.lowestItemId;
                                const safeUrl = sanitizeUiExternalUrl(row.websiteUrl);
                                return (
                                  <tr
                                    key={row.id}
                                    className={isLowest ? 'bg-emerald-50/60' : 'hover:bg-slate-50'}
                                  >
                                    <td className="py-2.5 px-3 font-bold text-slate-900 whitespace-nowrap">
                                      {row.websiteName}
                                      {isLowest && (
                                        <span className="ml-1.5 text-[10px] font-black text-emerald-700">
                                          (Lowest)
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2.5 px-3 text-slate-700 max-w-xs truncate">
                                      {row.title}
                                      {row.mismatchWarning && (
                                        <span className="block text-[11px] text-amber-700 font-semibold">
                                          {row.mismatchWarning}
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2.5 px-3 font-black tabular-nums whitespace-nowrap text-slate-900">
                                      {row.priceDisplay}
                                    </td>
                                    <td className="py-2.5 px-3 text-slate-600">{row.currency || '—'}</td>
                                    <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                                      {row.availabilityLabel}
                                    </td>
                                    <td className="py-2.5 px-3 text-slate-500 tabular-nums whitespace-nowrap">
                                      {formatDateTimeShort(row.lastCheckedAt)}
                                    </td>
                                    <td className="py-2.5 px-3 text-right whitespace-nowrap">
                                      {safeUrl ? (
                                        <a
                                          href={safeUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-900 font-bold"
                                        >
                                          <span>Open</span>
                                          <ExternalLink className="w-3 h-3" />
                                        </a>
                                      ) : (
                                        <span className="text-slate-400">N/A</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ============================================================== */}
        {/* 4. TAB B: COMPARE WITH MY SHOP PRICE                           */}
        {/* ============================================================== */}
        {activeTab === 'compare_shop' && (
          <section
            data-testid="compare-with-shop-panel"
            className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <h3 className="text-base sm:text-lg font-black text-slate-900 flex items-center gap-2">
                  <Store className="w-5 h-5 text-emerald-600" />
                  <span>Compare With My Shop Price</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Read-only comparison against your WAQAS POS catalog. Your shop prices & stock are NEVER changed automatically.
                </p>
              </div>

              <select
                value={activeLocalProduct?.id || ''}
                onChange={(e) => setSelectedLocalProductId(e.target.value)}
                className="min-h-[42px] px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 text-xs font-bold text-slate-800 max-w-sm"
              >
                <option value="">Select Local Shop Product...</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — Sale Rs. {p.price} {p.barcode ? `(${p.barcode})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {!activeLocalProduct ? (
              <div className="py-8 text-center text-sm text-slate-500">
                Select a local shop product above or search by a barcode/name matching your inventory to compare prices.
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                    <p className="text-xs font-bold text-slate-500">My Product Name</p>
                    <p className="text-sm font-black text-slate-900 mt-1">{activeLocalProduct.name}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Barcode: {activeLocalProduct.barcode || 'None'} · Stock: {activeLocalProduct.stock}{' '}
                      {activeLocalProduct.unit}
                    </p>
                  </div>

                  {canViewCostAndProfit && (
                    <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                      <p className="text-xs font-bold text-slate-500">My Purchase Price</p>
                      <p className="text-2xl font-black text-slate-900 tabular-nums mt-1">
                        {formatMoney(activeLocalProduct.costPrice, 'PKR')}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">Cost reference only</p>
                    </div>
                  )}

                  <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200">
                    <p className="text-xs font-bold text-emerald-800">My Current Sale Price</p>
                    <p className="text-2xl font-black text-emerald-800 tabular-nums mt-1">
                      {formatMoney(activeLocalProduct.price, 'PKR')}
                    </p>
                    <p className="text-xs text-emerald-700 mt-1">Active POS retail rate</p>
                  </div>

                  <div className="p-4 rounded-2xl bg-blue-50 border border-blue-200">
                    <p className="text-xs font-bold text-blue-800">Online Lowest / Avg / High (PKR)</p>
                    <p className="text-sm font-black text-blue-950 tabular-nums mt-1">
                      Low: {localComparisonMetrics?.onlineLow !== null ? formatMoney(localComparisonMetrics?.onlineLow, 'PKR') : '—'}
                    </p>
                    <p className="text-xs font-semibold text-blue-900 tabular-nums mt-0.5">
                      Avg: {localComparisonMetrics?.onlineAvg !== null ? formatMoney(localComparisonMetrics?.onlineAvg, 'PKR') : '—'} · High:{' '}
                      {localComparisonMetrics?.onlineHigh !== null ? formatMoney(localComparisonMetrics?.onlineHigh, 'PKR') : '—'}
                    </p>
                  </div>
                </div>

                {/* Price Difference Insights */}
                {localComparisonMetrics && localComparisonMetrics.onlineLow !== null && (
                  <div className="p-4 rounded-2xl bg-slate-900 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <p className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                        Price Competitiveness Analysis ({localComparisonMetrics.websiteCount || 0} Pakistani Stores)
                      </p>
                      {localComparisonMetrics.diffVsLowest !== null && (
                        <p className="text-base font-black flex items-center gap-2">
                          {localComparisonMetrics.diffVsLowest <= 0 ? (
                            <>
                              <TrendingDown className="w-5 h-5 text-emerald-400" />
                              <span className="text-emerald-300">
                                Your shop is {formatMoney(Math.abs(localComparisonMetrics.diffVsLowest), 'PKR')} cheaper or equal to the lowest online PKR price!
                              </span>
                            </>
                          ) : (
                            <>
                              <TrendingUp className="w-5 h-5 text-amber-400" />
                              <span className="text-amber-300">
                                Your sale price is {formatMoney(localComparisonMetrics.diffVsLowest, 'PKR')} higher than the lowest online PKR price.
                              </span>
                            </>
                          )}
                        </p>
                      )}
                      {localComparisonMetrics?.diffVsAverage !== null && (
                        <p className="text-xs text-slate-300 tabular-nums">
                          Difference vs Online Average:{' '}
                          {localComparisonMetrics.diffVsAverage > 0 ? '+' : ''}
                          {formatMoney(localComparisonMetrics.diffVsAverage, 'PKR')}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setQueryText(activeLocalProduct.barcode || activeLocalProduct.name);
                          setSearchMode(activeLocalProduct.barcode ? 'barcode' : 'name');
                          performSearch({
                            query: activeLocalProduct.barcode || activeLocalProduct.name,
                            mode: activeLocalProduct.barcode ? 'barcode' : 'name',
                            barcode: activeLocalProduct.barcode,
                            localProductId: activeLocalProduct.id,
                          });
                        }}
                        className="min-h-[42px] px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold cursor-pointer"
                      >
                        Search This Product Online
                      </button>

                      {canEditPrice && onUpdateProduct && (
                        <button
                          type="button"
                          onClick={() => {
                            setProposedNewSalePrice(
                              String(localComparisonMetrics?.onlineLow || activeLocalProduct.price)
                            );
                            setManualPriceDialogOpen(true);
                          }}
                          className="min-h-[42px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                        >
                          <DollarSign className="w-4 h-4" />
                          <span>Manual Update Sale Price</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ============================================================== */}
        {/* 5. TAB C: FAVOURITE PRODUCTS & SAVED COMPARISONS               */}
        {/* ============================================================== */}
        {activeTab === 'favourites' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 space-y-3">
              <h3 className="text-sm sm:text-base font-black text-slate-900">
                Favourite Products ({favourites.length})
              </h3>
              {favourites.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">
                  No favourite products saved yet. Bookmark any search result card to save it here.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {favourites.map((fav) => (
                    <div
                      key={fav.id}
                      className="p-3 rounded-xl border border-slate-200 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-900 truncate">{fav.title}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {fav.websiteName || 'Saved Search'} ·{' '}
                          {fav.price ? formatMoney(fav.price, fav.currency) : 'Price Not Saved'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setQueryText(fav.query);
                            setSearchMode(fav.searchMode);
                            performSearch({
                              query: fav.query,
                              mode: fav.searchMode,
                              barcode: fav.barcode,
                              localProductId: fav.localProductId,
                            });
                          }}
                          className="min-h-[36px] px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-bold cursor-pointer"
                        >
                          Search Again
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const updated = await removePriceSearchFavouriteApi(fav.id, activeShopId);
                            setFavourites(updated);
                          }}
                          className="min-h-[36px] min-w-[36px] rounded-lg bg-red-50 hover:bg-red-100 text-red-600 flex items-center justify-center cursor-pointer"
                          title="Remove Favourite"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 space-y-3">
              <h3 className="text-sm sm:text-base font-black text-slate-900">
                Saved Price Comparisons ({savedComparisons.length})
              </h3>
              {savedComparisons.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">
                  No saved price comparisons yet. Click &ldquo;Save Comparison&rdquo; after running a search.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {savedComparisons.map((comp) => (
                    <div
                      key={comp.id}
                      className="p-3 rounded-xl border border-slate-200 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-900 truncate">{comp.query}</p>
                        <p className="text-xs text-slate-500 tabular-nums">
                          {comp.lowestPkrPrice ? `Low ${formatMoney(comp.lowestPkrPrice, 'PKR')}` : 'No PKR Low'} ·{' '}
                          {comp.websiteCount} websites · {formatDateTimeShort(comp.savedAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setQueryText(comp.query);
                            performSearch({ query: comp.query, localProductId: comp.localProductId });
                          }}
                          className="min-h-[36px] px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-800 text-xs font-bold cursor-pointer"
                        >
                          Re-Check Live
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const updated = await removePriceComparisonApi(comp.id, activeShopId);
                            setSavedComparisons(updated);
                          }}
                          className="min-h-[36px] min-w-[36px] rounded-lg bg-red-50 hover:bg-red-100 text-red-600 flex items-center justify-center cursor-pointer"
                          title="Delete Comparison"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* ============================================================== */}
        {/* 6. TAB D: SEARCH HISTORY                                       */}
        {/* ============================================================== */}
        {activeTab === 'history' && (
          <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm sm:text-base font-black text-slate-900">
                Search History ({history.length})
              </h3>
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmClearHistoryOpen(true)}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear History</span>
                </button>
              )}
            </div>

            {history.length === 0 ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                Your online price search history is empty.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">{item.query}</p>
                      <p className="text-xs text-slate-500 tabular-nums">
                        Mode: {item.searchMode} · {item.resultCount} results ({item.verifiedPricedCount} priced)
                        {item.lowestPkrPrice ? ` · Lowest: ${formatMoney(item.lowestPkrPrice, 'PKR')}` : ''} ·{' '}
                        {formatDateTimeShort(item.searchedAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchMode(item.searchMode);
                        setQueryText(item.query);
                        performSearch({
                          query: item.query,
                          mode: item.searchMode,
                          barcode: item.barcode,
                          itemCode: item.itemCode,
                          region: item.region,
                          localProductId: item.localProductId,
                        });
                      }}
                      className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-emerald-700 text-white text-xs font-bold self-start sm:self-center cursor-pointer"
                    >
                      Search Again
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {/* Mobile Barcode Camera Scanner Modal (auto-triggers search on scan) */}
      <BarcodeScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onBarcodeDetected={handleBarcodeScanned}
        pageContext="price-search"
      />

      {/* Confirm Clear History Dialog */}
      {confirmClearHistoryOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 max-w-sm w-full p-5 space-y-4 shadow-xl">
            <h4 className="text-base font-black text-slate-900">Clear Online Search History?</h4>
            <p className="text-xs text-slate-600">
              This will permanently remove your saved online price search queries for this shop. Your shop products and saved comparisons remain untouched.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmClearHistoryOpen(false)}
                className="min-h-[40px] px-4 py-2 rounded-xl border border-slate-300 text-xs font-bold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmClearHistory}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold cursor-pointer"
              >
                Confirm Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Explicit Manual Confirmation Dialog Before Updating Shop Sale Price */}
      {manualPriceDialogOpen && activeLocalProduct && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 max-w-md w-full p-5 space-y-4 shadow-xl">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-base font-black text-slate-900">Confirm Sale Price Update</h4>
                <p className="text-xs text-slate-600 mt-0.5">
                  Manual confirmation is required before updating <strong>{activeLocalProduct.name}</strong>. Purchase cost and stock will NOT be altered.
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
              <p>
                Current Sale Price: <strong className="tabular-nums">{formatMoney(activeLocalProduct.price, 'PKR')}</strong>
              </p>
              {canViewCostAndProfit && (
                <p>
                  Purchase Cost: <strong className="tabular-nums">{formatMoney(activeLocalProduct.costPrice, 'PKR')}</strong>
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                New Shop Retail Sale Price (Rs.)
              </label>
              <input
                type="number"
                min="1"
                step="0.01"
                value={proposedNewSalePrice}
                onChange={(e) => setProposedNewSalePrice(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-slate-300 text-sm font-bold tabular-nums focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setManualPriceDialogOpen(false)}
                className="min-h-[42px] px-4 py-2 rounded-xl border border-slate-300 text-xs font-bold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmManualSalePriceUpdate}
                className="min-h-[42px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer"
              >
                Confirm Update Price
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
