import {
  OnlinePriceFavouriteItem,
  OnlinePriceProviderStatus,
  OnlinePriceRegionFilter,
  OnlinePriceResultItem,
  OnlinePriceSearchMode,
  OnlinePriceSearchQueryRecord,
  OnlinePriceSearchResponse,
  SavedPriceComparisonRecord,
} from '../types/pos';
import { safeFetchJson } from './apiClient';

function buildHeaders(shopId?: string): Record<string, string> {
  return shopId ? { 'x-shop-id': shopId } : {};
}

export function sanitizeUiExternalUrl(rawUrl?: string | null): string | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface PriceSearchConfigResponse {
  providerStatus: OnlinePriceProviderStatus;
  history: OnlinePriceSearchQueryRecord[];
  favourites: OnlinePriceFavouriteItem[];
  savedComparisons: SavedPriceComparisonRecord[];
}

export async function fetchPriceSearchConfig(shopId?: string): Promise<PriceSearchConfigResponse> {
  const res = await safeFetchJson<{
    success: boolean;
    providerStatus: OnlinePriceProviderStatus;
    history?: OnlinePriceSearchQueryRecord[];
    favourites?: OnlinePriceFavouriteItem[];
    savedComparisons?: SavedPriceComparisonRecord[];
  }>('/api/price-search/config', {
    method: 'GET',
    headers: buildHeaders(shopId),
  });
  return {
    providerStatus: res.data?.providerStatus,
    history: Array.isArray(res.data?.history) ? res.data.history : [],
    favourites: Array.isArray(res.data?.favourites) ? res.data.favourites : [],
    savedComparisons: Array.isArray(res.data?.savedComparisons) ? res.data.savedComparisons : [],
  };
}

export interface ExecutePriceSearchParams {
  query: string;
  searchMode: OnlinePriceSearchMode;
  barcode?: string;
  itemCode?: string;
  brand?: string;
  model?: string;
  category?: string;
  region: OnlinePriceRegionFilter;
  localProductId?: string;
  forceRefresh?: boolean;
}

export async function runOnlinePriceSearchApi(
  params: ExecutePriceSearchParams,
  shopId?: string
): Promise<OnlinePriceSearchResponse & { history?: OnlinePriceSearchQueryRecord[] }> {
  const res = await safeFetchJson<OnlinePriceSearchResponse & { history?: OnlinePriceSearchQueryRecord[] }>(
    '/api/price-search/query',
    {
      method: 'POST',
      headers: buildHeaders(shopId),
      body: JSON.stringify(params),
    }
  );
  return res.data;
}

export async function clearPriceSearchHistoryApi(shopId?: string): Promise<OnlinePriceSearchQueryRecord[]> {
  const res = await safeFetchJson<{ success: boolean; history?: OnlinePriceSearchQueryRecord[] }>(
    '/api/price-search/history',
    {
      method: 'DELETE',
      headers: buildHeaders(shopId),
      body: JSON.stringify({ confirmClear: true }),
    }
  );
  return Array.isArray(res.data?.history) ? res.data.history : [];
}

export async function savePriceSearchFavouriteApi(
  payload: Omit<OnlinePriceFavouriteItem, 'id' | 'savedAt'> & { id?: string },
  shopId?: string
): Promise<OnlinePriceFavouriteItem[]> {
  const res = await safeFetchJson<{ success: boolean; favourites?: OnlinePriceFavouriteItem[] }>(
    '/api/price-search/favourites',
    {
      method: 'POST',
      headers: buildHeaders(shopId),
      body: JSON.stringify(payload),
    }
  );
  return Array.isArray(res.data?.favourites) ? res.data.favourites : [];
}

export async function removePriceSearchFavouriteApi(
  favId: string,
  shopId?: string
): Promise<OnlinePriceFavouriteItem[]> {
  const res = await safeFetchJson<{ success: boolean; favourites?: OnlinePriceFavouriteItem[] }>(
    `/api/price-search/favourites/${encodeURIComponent(favId)}`,
    {
      method: 'DELETE',
      headers: buildHeaders(shopId),
    }
  );
  return Array.isArray(res.data?.favourites) ? res.data.favourites : [];
}

export async function savePriceComparisonApi(
  payload: {
    query: string;
    searchedAt: string;
    localProductId?: string;
    localProductName?: string;
    localSalePrice?: number;
    lowestPkrPrice?: number | null;
    averagePkrPrice?: number | null;
    highestPkrPrice?: number | null;
    websiteCount: number;
    results: OnlinePriceResultItem[];
  },
  shopId?: string
): Promise<SavedPriceComparisonRecord[]> {
  const res = await safeFetchJson<{ success: boolean; savedComparisons?: SavedPriceComparisonRecord[] }>(
    '/api/price-search/comparisons',
    {
      method: 'POST',
      headers: buildHeaders(shopId),
      body: JSON.stringify(payload),
    }
  );
  return Array.isArray(res.data?.savedComparisons) ? res.data.savedComparisons : [];
}

export async function removePriceComparisonApi(
  compId: string,
  shopId?: string
): Promise<SavedPriceComparisonRecord[]> {
  const res = await safeFetchJson<{ success: boolean; savedComparisons?: SavedPriceComparisonRecord[] }>(
    `/api/price-search/comparisons/${encodeURIComponent(compId)}`,
    {
      method: 'DELETE',
      headers: buildHeaders(shopId),
    }
  );
  return Array.isArray(res.data?.savedComparisons) ? res.data.savedComparisons : [];
}
