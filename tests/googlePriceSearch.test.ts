import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GooglePriceSearchPage } from '../src/components/GooglePriceSearchPage.tsx';
import type { Product } from '../src/types/pos.ts';

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

async function jsonReq(
  baseUrl: string,
  urlPath: string,
  options: RequestInit & { headers?: Record<string, string> } = {}
) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  return { status: res.status, ok: res.ok, data, text };
}

async function waitForHealth(baseUrl: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server at ${baseUrl} did not become healthy`);
}

async function runTests() {
  console.log('1. Verifying navigation placement and environment variable hygiene...');
  const homeSource = fs.readFileSync(path.resolve(process.cwd(), 'src/components/HomePage.tsx'), 'utf-8');
  const sidebarSection = homeSource.slice(
    homeSource.indexOf('const sidebarNavItems'),
    homeSource.indexOf('const submenuSections')
  );
  const quickCardsSection = homeSource.slice(
    homeSource.indexOf('const quickActionCards'),
    homeSource.indexOf('const sidebarNavItems')
  );
  // Sales order untouched
  assert.ok(sidebarSection.indexOf('Sale Summary') < sidebarSection.indexOf('New Sale'));
  assert.ok(sidebarSection.indexOf('New Sale') < sidebarSection.indexOf('Old Sale'));
  assert.ok(sidebarSection.indexOf('Old Sale') < sidebarSection.indexOf('New Purchase'));
  assert.ok(sidebarSection.indexOf('New Purchase') < sidebarSection.indexOf('Old Purchase'));
  // GOOGLE ONLINE PRICE SEARCH is at the VERY LAST position
  const lastSidebarIdx = sidebarSection.lastIndexOf('GOOGLE ONLINE PRICE SEARCH');
  assert.ok(lastSidebarIdx > sidebarSection.lastIndexOf('CCTV Cameras'), 'Sidebar must put Google Online Price Search after CCTV Cameras');
  const lastQuickIdx = quickCardsSection.lastIndexOf('GOOGLE ONLINE PRICE SEARCH');
  assert.ok(lastQuickIdx > quickCardsSection.lastIndexOf("id: 'cctv'"), 'Quick cards must put Google Online Price Search last');

  const envExample = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf-8');
  assert.ok(envExample.includes('GOOGLE_CSE_API_KEY'));
  assert.ok(envExample.includes('GOOGLE_CSE_CX'));
  assert.ok(envExample.includes('SERPAPI_API_KEY'));
  assert.ok(!envExample.includes('VITE_GOOGLE_CSE'));
  assert.ok(!envExample.includes('VITE_SERPAPI'));

  console.log('2. Starting local mock upstream provider servers (Google CSE, SerpAPI, OpenFoodFacts)...');
  const providerPort = await getFreePort();
  const providerBase = `http://127.0.0.1:${providerPort}`;
  let liveCseCallCount = 0;

  const mockProviderServer = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', providerBase);
    const p = parsedUrl.pathname;

    if (p.startsWith('/off/8961014200123.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 1,
          product: {
            product_name: 'Tapal Danedar Tea',
            brands: 'Tapal',
            quantity: '900g',
            categories: 'Beverages, Tea',
            image_front_url: 'https://cdn.example.pk/tapal-900g.jpg',
          },
        })
      );
      return;
    }

    if (p === '/cse') {
      liveCseCallCount += 1;
      const gl = parsedUrl.searchParams.get('gl') || 'pk';
      if (gl === 'pk') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [
              {
                title: 'Tapal Danedar Black Tea 900g Pack',
                link: 'https://www.daraz.pk/products/tapal-danedar-900g',
                snippet: 'Buy Tapal Danedar Tea 900g online in Pakistan',
                pagemap: {
                  offer: [{ price: '1650', pricecurrency: 'PKR', availability: 'https://schema.org/InStock' }],
                  product: [{ brand: 'Tapal', gtin13: '8961014200123', image: 'https://daraz.pk/img/tea.jpg' }],
                },
              },
              {
                title: 'Tapal Tea Review & Guide Pakistan (No Price Info)',
                link: 'https://blog.example.pk/tapal-review-only',
                snippet: 'Best tea around Rs 1200 to Rs 2000 review article.',
                // Deliberately NO pagemap.offer or structured price -> MUST NOT guess from snippet!
              },
              {
                title: 'Malicious Javascript Link Attempt',
                link: 'javascript:alert(1)',
                snippet: 'Should be sanitized out',
              },
            ],
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [] }));
      return;
    }

    if (p === '/serpapi') {
      const gl = parsedUrl.searchParams.get('gl') || 'pk';
      if (gl === 'pk') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            shopping_results: [
              {
                title: 'Tapal Danedar Tea 900g Pouch',
                source: 'PriceOye',
                link: 'https://priceoye.pk/grocery/tapal-danedar-900g',
                extracted_price: 1590,
                price: 'Rs. 1,590',
                delivery: 'In stock · Free delivery',
                brand: 'Tapal',
                thumbnail: 'https://priceoye.pk/thumb.jpg',
              },
              {
                title: 'Tapal Danedar Tea 900g',
                source: 'Naheed Supermarket',
                link: 'https://www.naheed.pk/tapal-danedar-900g',
                extracted_price: 1720,
                price: 'Rs. 1,720',
                delivery: 'In stock',
                brand: 'Tapal',
              },
              {
                // Weight mismatch: 450g instead of 900g -> must be flagged mismatch and excluded from exact avg/lowest
                title: 'Tapal Danedar Tea 450g Economy Pack',
                source: 'HumMart',
                link: 'https://hummart.com/tapal-danedar-450g',
                extracted_price: 850,
                price: 'Rs. 850',
                delivery: 'In stock',
                brand: 'Tapal',
              },
            ],
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          shopping_results: [
            {
              title: 'Tapal Danedar Black Tea 900g International Pack',
              source: 'Amazon Global',
              link: 'https://www.amazon.com/dp/B00TAPAL900',
              extracted_price: 8.99,
              price: '$8.99',
              brand: 'Tapal',
            },
          ],
        })
      );
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ status: 0 }));
  });
  await new Promise<void>((resolve) => mockProviderServer.listen(providerPort, '127.0.0.1', () => resolve()));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqas-price-search-test-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const SA_GMAIL = 'test-price-sa@gmail.com';
  const SA_PASS = 'SuperPass!234';
  const saSalt = crypto.randomBytes(16).toString('hex');
  const saHash = 'scrypt:' + crypto.scryptSync(SA_PASS, saSalt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');

  const FAKE_CSE_SECRET = 'SECRET_CSE_KEY_DO_NOT_LEAK_999';
  const FAKE_SERP_SECRET = 'SECRET_SERP_KEY_DO_NOT_LEAK_888';

  let serverProc: ChildProcess | null = null;
  try {
    console.log(`3. Starting isolated POS server on ${baseUrl}...`);
    serverProc = spawn('npx', ['tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        WAQAS_DATA_DIR: dataDir,
        SUPER_ADMIN_EMAIL: SA_GMAIL,
        SUPER_ADMIN_PASSWORD_SALT: saSalt,
        SUPER_ADMIN_PASSWORD_HASH: saHash,
        GOOGLE_CSE_API_KEY: FAKE_CSE_SECRET,
        GOOGLE_CSE_CX: 'test-cx-id',
        SERPAPI_API_KEY: FAKE_SERP_SECRET,
        GOOGLE_CSE_ENDPOINT: `${providerBase}/cse`,
        SERPAPI_ENDPOINT: `${providerBase}/serpapi`,
        OPENFOODFACTS_ENDPOINT: `${providerBase}/off`,
        PRICE_SEARCH_RATE_LIMIT_PER_MIN: '5',
        NODE_ENV: 'production',
      },
      stdio: 'pipe',
    });

    await waitForHealth(baseUrl);

    // Login Super Admin -> create Mart A & Mart B
    const saLogin = await jsonReq(baseUrl, '/api/auth/super-admin/login', {
      method: 'POST',
      body: JSON.stringify({ gmail: SA_GMAIL, password: SA_PASS }),
    });
    assert.equal(saLogin.status, 200);
    const superToken = saLogin.data.token as string;

    const createMartA = await jsonReq(baseUrl, '/api/super-admin/shops', {
      method: 'POST',
      headers: { Authorization: `Bearer ${superToken}` },
      body: JSON.stringify({
        shopName: 'Price Test Mart A',
        ownerName: 'Waqas Owner',
        username: 'price_owner_a',
        password: 'OwnerPass!234',
        phone: '03001112233',
        planType: 'MONTHLY',
        subscriptionDays: 30,
      }),
    });
    assert.equal(createMartA.status, 200);
    const martAId = createMartA.data.shop.id as string;

    const createMartB = await jsonReq(baseUrl, '/api/super-admin/shops', {
      method: 'POST',
      headers: { Authorization: `Bearer ${superToken}` },
      body: JSON.stringify({
        shopName: 'Price Test Mart B',
        ownerName: 'Ali Owner',
        username: 'price_owner_b',
        password: 'OwnerPass!234',
        phone: '03009998877',
        planType: 'MONTHLY',
        subscriptionDays: 30,
      }),
    });
    assert.equal(createMartB.status, 200);
    const martBId = createMartB.data.shop.id as string;

    const ownerALogin = await jsonReq(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ portal: 'shop', identifier: 'price_owner_a', password: 'OwnerPass!234' }),
    });
    assert.equal(ownerALogin.status, 200);
    const ownerAToken = ownerALogin.data.token as string;

    const ownerBLogin = await jsonReq(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ portal: 'shop', identifier: 'price_owner_b', password: 'OwnerPass!234' }),
    });
    assert.equal(ownerBLogin.status, 200);
    const ownerBToken = ownerBLogin.data.token as string;

    // Seed Mart A product & staff
    const sampleProduct: Product = {
      id: 'prod-tapal-900',
      barcode: '8961014200123',
      sku: 'SKU-TEA-900',
      name: 'Tapal Danedar Tea 900g',
      category: 'Beverages',
      price: 1680,
      costPrice: 1420,
      stock: 25,
      unit: 'Pack',
    };

    const syncProdRes = await jsonReq(baseUrl, '/api/store/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        action: 'update_stock',
        sourceDeviceId: 'TEST-PC',
        payload: [sampleProduct],
      }),
    });
    assert.equal(syncProdRes.status, 200);

    const syncStaffRes = await jsonReq(baseUrl, '/api/store/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        action: 'sync_staff',
        sourceDeviceId: 'TEST-PC',
        payload: [
          {
            id: 'staff-no-cost',
            name: 'StaffViewer',
            phone: '03001110001',
            role: 'Clerk',
            salary: 25000,
            joiningDate: '2026-01-01',
            accountStatus: 'active',
            username: 'staff_viewer',
            newPassword: 'StaffPass!123',
            permissions: {
              newSale: true,
              oldSale: false,
              newPurchase: false,
              oldPurchase: false,
              stock: true,
              products: true,
              customers: false,
              suppliers: false,
              expenses: false,
              reports: false,
              printing: true,
              settings: false,
              canEditPrice: false,
              canGiveDiscount: false,
              canDeleteItems: false,
              canAccessReports: false,
              canAccessSettings: false,
              canAccessLedgers: false,
              canViewCostAndProfit: false,
            },
          },
          {
            id: 'staff-denied',
            name: 'RestrictedCashier',
            phone: '03001110002',
            role: 'Cashier',
            salary: 20000,
            joiningDate: '2026-01-01',
            accountStatus: 'active',
            username: 'staff_denied',
            newPassword: 'StaffPass!456',
            permissions: {
              newSale: true,
              oldSale: false,
              newPurchase: false,
              oldPurchase: false,
              stock: false,
              products: false,
              customers: false,
              suppliers: false,
              expenses: false,
              reports: false,
              printing: false,
              settings: false,
              canEditPrice: false,
              canGiveDiscount: false,
              canDeleteItems: false,
              canAccessReports: false,
              canAccessSettings: false,
              canAccessLedgers: false,
              canViewCostAndProfit: false,
            },
          },
        ],
      }),
    });
    assert.equal(syncStaffRes.status, 200);

    console.log('4. Testing auth, RBAC, and zero secret key exposure...');
    const unauthRes = await jsonReq(baseUrl, '/api/price-search/config');
    assert.equal(unauthRes.status, 401);

    const cfgRes = await jsonReq(baseUrl, '/api/price-search/config', {
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
    });
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.data.providerStatus.googleCseConfigured, true);
    assert.equal(cfgRes.data.providerStatus.serpApiConfigured, true);
    assert.ok(!cfgRes.text.includes(FAKE_CSE_SECRET), 'Must never leak Google CSE secret');
    assert.ok(!cfgRes.text.includes(FAKE_SERP_SECRET), 'Must never leak SerpAPI secret');

    const deniedLogin = await jsonReq(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ portal: 'shop', identifier: 'staff_denied', password: 'StaffPass!456' }),
    });
    assert.equal(deniedLogin.status, 200);
    const deniedRes = await jsonReq(baseUrl, '/api/price-search/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deniedLogin.data.token}`, 'x-shop-id': martAId },
      body: JSON.stringify({ query: 'Tapal Danedar Tea 900g', searchMode: 'name', region: 'all' }),
    });
    assert.equal(deniedRes.status, 403);

    console.log('5. Testing Name search, verified vs unpriced listings, variant mismatch, & PKR/USD separation...');
    const nameSearch = await jsonReq(baseUrl, '/api/price-search/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        query: 'Tapal Danedar Tea 900g',
        searchMode: 'name',
        brand: 'Tapal',
        region: 'all',
      }),
    });
    assert.equal(nameSearch.status, 200);
    assert.equal(nameSearch.data.cached, false);
    assert.ok(!nameSearch.text.includes(FAKE_CSE_SECRET));
    assert.ok(!nameSearch.text.includes(FAKE_SERP_SECRET));

    const results = nameSearch.data.results as any[];
    assert.ok(!results.some((r) => String(r.websiteUrl).startsWith('javascript:')), 'Unsafe JS URL must be filtered');

    const blogRow = results.find((r) => r.websiteDomain === 'blog.example.pk');
    assert.ok(blogRow, 'Plain web listing should appear honestly');
    assert.equal(blogRow.hasVerifiedPrice, false);
    assert.equal(blogRow.price, null);
    assert.equal(blogRow.priceDisplay, 'Price Not Available');

    const mismatchRow = results.find((r) => r.websiteDomain === 'hummart.com');
    assert.ok(mismatchRow, '450g listing should appear with mismatch warning');
    assert.equal(mismatchRow.matchQuality, 'mismatch');
    assert.ok(mismatchRow.mismatchWarning);

    const pkrSummary = nameSearch.data.comparison.primaryPkrComparison;
    assert.ok(pkrSummary);
    assert.equal(pkrSummary.lowestPrice, 1590, 'Lowest PKR must be PriceOye Rs 1590, excluding mismatched 450g Rs 850');
    assert.equal(pkrSummary.highestPrice, 1720);
    assert.equal(pkrSummary.comparableCount, 3);
    // Average of 1590, 1650, 1720 = 1653.33
    assert.equal(pkrSummary.averagePrice, 1653.33);

    const usdSummary = nameSearch.data.comparison.currencyComparisons.find((c: any) => c.currency === 'USD');
    assert.ok(usdSummary);
    assert.equal(usdSummary.lowestPrice, 8.99);
    assert.equal(usdSummary.averagePrice, null, 'Only 1 USD store -> do not invent multi-store avg');

    console.log('6. Testing cache hit, forceRefresh, barcode & item_code search, and staff cost redaction...');
    const callsBeforeCacheHit = liveCseCallCount;
    const cachedSearch = await jsonReq(baseUrl, '/api/price-search/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        query: 'Tapal Danedar Tea 900g',
        searchMode: 'name',
        brand: 'Tapal',
        region: 'all',
      }),
    });
    assert.equal(cachedSearch.status, 200);
    assert.equal(cachedSearch.data.cached, true);
    assert.equal(liveCseCallCount, callsBeforeCacheHit, 'Cache hit should not invoke upstream CSE');

    const barcodeSearch = await jsonReq(baseUrl, '/api/price-search/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        query: '8961014200123',
        searchMode: 'barcode',
        region: 'pakistan',
      }),
    });
    assert.equal(barcodeSearch.status, 200);
    assert.equal(barcodeSearch.data.resolvedMeta?.productName, 'Tapal Danedar Tea');
    assert.equal(barcodeSearch.data.localProductMatch?.id, 'prod-tapal-900');
    assert.equal(barcodeSearch.data.localProductMatch?.purchasePrice, 1420);

    // Staff without cost view permission gets redacted purchasePrice
    const viewerLogin = await jsonReq(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ portal: 'shop', identifier: 'staff_viewer', password: 'StaffPass!123' }),
    });
    assert.equal(viewerLogin.status, 200);
    const staffItemCodeSearch = await jsonReq(baseUrl, '/api/price-search/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${viewerLogin.data.token}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        query: 'SKU-TEA-900',
        searchMode: 'item_code',
        region: 'pakistan',
      }),
    });
    assert.equal(staffItemCodeSearch.status, 200);
    assert.equal(staffItemCodeSearch.data.localProductMatch?.id, 'prod-tapal-900');
    assert.equal(staffItemCodeSearch.data.localProductMatch?.salePrice, 1680);
    assert.equal(staffItemCodeSearch.data.localProductMatch?.purchasePrice, null, 'Cost must be redacted for restricted staff');

    console.log('7. Testing POS safety (zero auto-mutation), favourites, comparisons, history & cross-shop isolation...');
    const storeStateAfterSearch = await jsonReq(baseUrl, '/api/store/state', {
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
    });
    assert.equal(storeStateAfterSearch.status, 200);
    const untouchedProduct = storeStateAfterSearch.data.store.products.find((p: Product) => p.id === 'prod-tapal-900');
    assert.equal(untouchedProduct.price, 1680);
    assert.equal(untouchedProduct.costPrice, 1420);
    assert.equal(untouchedProduct.stock, 25);

    const favSaveRes = await jsonReq(baseUrl, '/api/price-search/favourites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        title: 'Tapal Danedar Tea 900g Pouch',
        query: 'Tapal Danedar Tea 900g',
        searchMode: 'name',
        websiteName: 'PriceOye',
        websiteUrl: 'https://priceoye.pk/grocery/tapal-danedar-900g',
        price: 1590,
        currency: 'PKR',
      }),
    });
    assert.equal(favSaveRes.status, 200);
    assert.equal(favSaveRes.data.favourites.length, 1);

    const compSaveRes = await jsonReq(baseUrl, '/api/price-search/comparisons', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        query: 'Tapal Danedar Tea 900g',
        searchedAt: nameSearch.data.searchedAt,
        localProductId: 'prod-tapal-900',
        localProductName: 'Tapal Danedar Tea 900g',
        localSalePrice: 1680,
        lowestPkrPrice: 1590,
        averagePkrPrice: 1653.33,
        highestPkrPrice: 1720,
        websiteCount: 3,
        results: nameSearch.data.results.slice(0, 3),
      }),
    });
    assert.equal(compSaveRes.status, 200);
    assert.equal(compSaveRes.data.savedComparisons.length, 1);

    // Mart B must remain completely isolated
    const martBConfig = await jsonReq(baseUrl, '/api/price-search/config', {
      headers: { Authorization: `Bearer ${ownerBToken}`, 'x-shop-id': martBId },
    });
    assert.equal(martBConfig.status, 200);
    assert.equal(martBConfig.data.history.length, 0);
    assert.equal(martBConfig.data.favourites.length, 0);
    assert.equal(martBConfig.data.savedComparisons.length, 0);

    // Clear history requires confirmation
    const unconfirmedClear = await jsonReq(baseUrl, '/api/price-search/history', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({ confirmClear: false }),
    });
    assert.equal(unconfirmedClear.status, 400);

    const confirmedClear = await jsonReq(baseUrl, '/api/price-search/history', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({ confirmClear: true }),
    });
    assert.equal(confirmedClear.status, 200);
    assert.equal(confirmedClear.data.history.length, 0);

    console.log('8. Testing rate limiting...');
    let saw429 = false;
    for (let i = 0; i < 6; i++) {
      const rlRes = await jsonReq(baseUrl, '/api/price-search/query', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerAToken}`, 'x-shop-id': martAId },
        body: JSON.stringify({
          query: `RateLimitQuery-${i}`,
          searchMode: 'name',
          region: 'pakistan',
        }),
      });
      if (rlRes.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.ok(saw429, 'Should enforce 429 rate limit on burst live queries');

    console.log('9. Testing GooglePriceSearchPage SSR rendering...');
    const html = renderToStaticMarkup(
      React.createElement(GooglePriceSearchPage, {
        products: [sampleProduct],
        activeShopId: martAId,
        canViewCostAndProfit: true,
        canEditPrice: true,
        initialHistory: [],
        initialFavourites: [],
        initialComparisons: [],
        onBack: () => {},
        onBackToHome: () => {},
      })
    );
    assert.ok(html.includes('Google Online Price Search'));
    assert.ok(html.includes('Compare With My Shop Price'));
    assert.ok(html.includes('Search Products Online'));
    assert.ok(html.includes('Back'));
    assert.ok(!html.includes(FAKE_CSE_SECRET));
    assert.ok(!html.includes(FAKE_SERP_SECRET));

    console.log('ALL GOOGLE ONLINE PRICE SEARCH TESTS PASSED SUCCESSFULLY!');
  } finally {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
    }
    mockProviderServer.closeAllConnections?.();
    mockProviderServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
