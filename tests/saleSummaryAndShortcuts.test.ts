import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeSaleSummaryMetrics,
  computeTodaySaleSnapshot,
  deduplicateSalesTransactions,
  parseDateToIso,
  toLocalIsoDate,
} from '../src/utils/saleSummaryHelpers';
import { CartItem, Product, SaleReturn, SaleTransaction } from '../src/types/pos';

function makeCartItem(id: string, product: Product, quantity: number): CartItem {
  return {
    id,
    product,
    quantity,
    unitPrice: product.price,
    discountAmount: 0,
    lineTotal: product.price * quantity,
  };
}

function runTests() {
  console.log('1. Testing date normalization (ISO, DD/MM/YYYY, en-PK locale)...');
  assert.equal(parseDateToIso('2026-11-24T10:15:00.000Z'), '2026-11-24');
  assert.equal(parseDateToIso('24/11/2026'), '2026-11-24');
  const enPkDate = parseDateToIso('24 Nov 2026, 02:30 PM');
  assert.equal(enPkDate, '2026-11-24');

  const today = new Date();
  const todayIso = toLocalIsoDate(today);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayIso = toLocalIsoDate(yesterday);

  const products: Product[] = [
    {
      id: 'p1',
      barcode: '1001',
      sku: 'SKU-1',
      name: 'Basmati Rice 5kg',
      category: 'Grocery',
      price: 1800,
      costPrice: 1500,
      stock: 15,
      unit: 'Bag',
    },
    {
      id: 'p2',
      barcode: '1002',
      sku: 'SKU-2',
      name: 'Cooking Oil 1L',
      category: 'Oil',
      price: 550,
      costPrice: 480,
      stock: 30,
      unit: 'Bottle',
    },
  ];

  const transactions: SaleTransaction[] = [
    // Today Cash sale
    {
      invoiceNumber: 'INV-1001',
      dateTime: `${todayIso}T09:30:00`,
      mode: 'sale',
      items: [makeCartItem('ci-1', { ...products[0], costPrice: 1500 }, 2)],
      subtotal: 3600,
      discount: 100,
      taxAmount: 0,
      grandTotal: 3500,
      paymentMethod: 'cash',
      cashTendered: 4000,
      changeDue: 500,
      customerName: 'Walk-in',
      cashierName: 'Owner',
      status: 'completed',
    },
    // Duplicate invoice number should be ignored by deduplication
    {
      invoiceNumber: 'INV-1001',
      dateTime: `${todayIso}T09:30:00`,
      mode: 'sale',
      items: [makeCartItem('ci-1b', products[0], 2)],
      subtotal: 3600,
      discount: 100,
      taxAmount: 0,
      grandTotal: 3500,
      paymentMethod: 'cash',
      cashierName: 'Owner',
      status: 'completed',
    },
    // Today Digital sale (uses catalog fallback costPrice when item snapshot has 0)
    {
      invoiceNumber: 'INV-1002',
      dateTime: `${todayIso}T11:45:00`,
      mode: 'sale',
      items: [makeCartItem('ci-2', { ...products[1], costPrice: 0 }, 4)],
      subtotal: 2200,
      discount: 0,
      taxAmount: 0,
      grandTotal: 2200,
      paymentMethod: 'digital',
      customerName: 'Sara Ahmed',
      cashierName: 'Owner',
      status: 'completed',
    },
    // Today Credit sale with partial paid
    {
      invoiceNumber: 'INV-1003',
      dateTime: `${todayIso}T14:20:00`,
      mode: 'sale',
      items: [makeCartItem('ci-3', { ...products[1], costPrice: 480 }, 2)],
      subtotal: 1100,
      discount: 0,
      taxAmount: 0,
      grandTotal: 1100,
      paymentMethod: 'credit',
      cashTendered: 400,
      customerName: 'Haji Tariq',
      cashierName: 'Owner',
      status: 'completed',
    },
    // Yesterday cash sale
    {
      invoiceNumber: 'INV-0999',
      dateTime: `${yesterdayIso}T18:00:00`,
      mode: 'sale',
      items: [makeCartItem('ci-4', products[0], 1)],
      subtotal: 1800,
      discount: 0,
      taxAmount: 0,
      grandTotal: 1800,
      paymentMethod: 'cash',
      cashierName: 'Owner',
      status: 'completed',
    },
  ];

  const returns: SaleReturn[] = [
    {
      id: 'ret-1',
      returnNumber: 'RET-1',
      originalInvoiceNumber: 'INV-1001',
      date: todayIso,
      dateTime: `${todayIso}T15:00:00`,
      items: [
        {
          productId: products[1].id,
          productName: products[1].name,
          barcode: products[1].barcode,
          quantity: 1,
          unitPrice: 550,
          total: 550,
          condition: 'damaged',
          reason: 'Damaged seal',
        },
      ],
      totalRefund: 550,
      refundMethod: 'cash',
      reason: 'Damaged seal',
      cashierName: 'Owner',
      createdAt: `${todayIso}T15:00:00`,
    },
  ];

  console.log('2. Testing deduplication & Today 10-KPI metrics + profit calculations...');
  const deduped = deduplicateSalesTransactions(transactions);
  assert.equal(deduped.length, 4);

  const todaySummary = computeSaleSummaryMetrics({
    transactions,
    saleReturns: returns,
    products,
    fromDate: todayIso,
    toDate: todayIso,
    paymentFilter: 'All',
  });

  assert.equal(todaySummary.kpis.totalInvoices, 3);
  assert.equal(todaySummary.kpis.grossSales, 6900); // 3600 + 2200 + 1100
  assert.equal(todaySummary.kpis.totalSales, 6800); // 3500 + 2200 + 1100
  assert.equal(todaySummary.kpis.totalDiscounts, 100);
  assert.equal(todaySummary.kpis.cashSales, 3500);
  assert.equal(todaySummary.kpis.digitalSales, 2200);
  assert.equal(todaySummary.kpis.creditSales, 1100);
  assert.equal(todaySummary.kpis.outstandingCreditDue, 700); // 1100 - 400
  assert.equal(todaySummary.kpis.totalItemsSold, 8); // 2 + 4 + 2
  assert.equal(todaySummary.kpis.salesReturns, 550);
  assert.equal(todaySummary.kpis.netSales, 6250); // 6800 - 550
  assert.equal(todaySummary.kpis.totalCogs, 5880); // 3000 + 1920 + 960
  assert.equal(todaySummary.kpis.actualGrossProfit, 370); // 6250 - 5880
  assert.equal(todaySummary.kpis.hasCompleteCostData, true);

  console.log('3. Testing payment mix & top products chart aggregations...');
  assert.equal(todaySummary.paymentMix.cash, 3500);
  assert.equal(todaySummary.paymentMix.digital, 2200);
  assert.equal(todaySummary.paymentMix.credit, 1100);
  assert.equal(todaySummary.topProducts[0].productId, 'p1');
  assert.equal(todaySummary.topProducts[1].productId, 'p2');
  assert.equal(todaySummary.topProducts[1].quantity, 6);

  console.log('4. Testing multi-day range (Yesterday..Today) & Bottom Summary Strip helper...');
  const twoDaySummary = computeSaleSummaryMetrics({
    transactions,
    saleReturns: returns,
    products,
    fromDate: yesterdayIso,
    toDate: todayIso,
    paymentFilter: 'All',
  });
  assert.equal(twoDaySummary.kpis.totalInvoices, 4);
  assert.equal(twoDaySummary.dailySeries.length, 2);

  const stripSnap = computeTodaySaleSnapshot(transactions, returns, today);
  assert.equal(stripSnap.totalSales, 6800);
  assert.equal(stripSnap.invoicesCount, 3);
  assert.equal(stripSnap.cashSales, 3500);
  assert.equal(stripSnap.creditSales, 1100);

  console.log('5. Verifying UI wiring across New Sale, Old Sale, Sale Summary & App Lock gates...');
  const newSaleSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/NewSalePosPage.tsx'), 'utf8');
  assert.ok(newSaleSrc.includes('new-sale-top-summary-btn'));
  assert.ok(newSaleSrc.includes('new-sale-bottom-summary-strip'));
  assert.ok(newSaleSrc.includes('new-sale-mobile-summary-btn'));
  assert.ok(newSaleSrc.includes('new-sale-mobile-bottom-summary-strip'));

  const oldSaleSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/SalePosPage.tsx'), 'utf8');
  assert.ok(oldSaleSrc.includes('old-sale-top-summary-btn'));
  assert.ok(oldSaleSrc.includes('old-sale-bottom-summary-strip'));
  assert.ok(oldSaleSrc.includes('old-sale-mobile-summary-btn'));
  assert.ok(oldSaleSrc.includes('old-sale-mobile-bottom-summary-strip'));

  const saleSummarySrc = fs.readFileSync(path.join(process.cwd(), 'src/components/SaleSummaryPage.tsx'), 'utf8');
  assert.ok(saleSummarySrc.includes('sale-summary-charts'));
  assert.ok(saleSummarySrc.includes('sale-summary-invoice-modal'));
  assert.ok(saleSummarySrc.includes('sales-section-flow-bar'));
  assert.ok(saleSummarySrc.includes('sales-flow-new-sale-btn'));
  assert.ok(saleSummarySrc.includes('sales-flow-old-sale-btn'));

  const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(appSrc.includes('if (appLockConfig.enabled && isAppLocked)'));
  assert.ok(appSrc.includes('<AppLockScreen'));
  assert.ok(appSrc.includes('<ExitSecurityModal'));
  assert.ok(appSrc.includes('visibilitychange'));
  assert.ok(appSrc.includes("page === 'Sales'"));
  assert.ok(appSrc.includes('handleNavigateBack'));
  assert.ok(appSrc.includes('mobile-nav-sale-btn'));
  assert.ok(appSrc.includes("handleNavigate('Sales')"));

  console.log('6. Verifying Sales Page Order: Sale Summary -> New Sale -> Old Sale -> New Purchase -> Old Purchase...');
  const homeSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/HomePage.tsx'), 'utf8');

  // Quick Action Cards order
  const quickStart = homeSrc.indexOf('const quickActionCards = [');
  const quickEnd = homeSrc.indexOf('const sidebarNavItems = [');
  const quickBlock = homeSrc.slice(quickStart, quickEnd);
  const qSummary = quickBlock.indexOf("id: 'sale_summary'");
  const qNewSale = quickBlock.indexOf("id: 'new_sale'");
  const qOldSale = quickBlock.indexOf("id: 'old_sale'");
  const qNewPurch = quickBlock.indexOf("id: 'new_purchase'");
  const qOldPurch = quickBlock.indexOf("id: 'old_purchase'");
  assert.ok(qSummary !== -1 && qSummary < qNewSale);
  assert.ok(qNewSale < qOldSale);
  assert.ok(qOldSale < qNewPurch);
  assert.ok(qNewPurch < qOldPurch);

  // Left Sidebar order
  const sideStart = homeSrc.indexOf('const sidebarNavItems = [');
  const sideEnd = homeSrc.indexOf('const submenuSections = [');
  const sideBlock = homeSrc.slice(sideStart, sideEnd);
  const sSummary = sideBlock.indexOf("'1. Sale Summary'");
  const sNewSale = sideBlock.indexOf("'2. New Sale'");
  const sOldSale = sideBlock.indexOf("'3. Old Sale'");
  const sNewPurch = sideBlock.indexOf("'4. New Purchase'");
  const sOldPurch = sideBlock.indexOf("'5. Old Purchase'");
  assert.ok(sSummary !== -1 && sSummary < sNewSale);
  assert.ok(sNewSale < sOldSale);
  assert.ok(sOldSale < sNewPurch);
  assert.ok(sNewPurch < sOldPurch);

  // Submenu Section A order
  const secAStart = homeSrc.indexOf("title: 'A. Sales & Returns Management'");
  const secBStart = homeSrc.indexOf("title: 'B. Purchase Management'");
  const secABlock = homeSrc.slice(secAStart, secBStart);
  assert.ok(secABlock.indexOf("label: 'Sale Summary'") < secABlock.indexOf("label: 'New Sale'"));
  assert.ok(secABlock.indexOf("label: 'New Sale'") < secABlock.indexOf("label: 'Old Sale'"));

  // Back buttons & mobile flow bars on New Sale & Old Sale
  assert.ok(newSaleSrc.includes('new-sale-back-btn'));
  assert.ok(newSaleSrc.includes('new-sale-mobile-back-btn'));
  assert.ok(newSaleSrc.includes('new-sale-mobile-flow-bar'));
  assert.ok(newSaleSrc.includes('new-sale-top-old-sale-btn'));

  assert.ok(oldSaleSrc.includes('old-sale-back-btn'));
  assert.ok(oldSaleSrc.includes('old-sale-mobile-back-btn'));
  assert.ok(oldSaleSrc.includes('old-sale-mobile-flow-bar'));
  assert.ok(oldSaleSrc.includes('old-sale-top-new-sale-btn'));

  console.log('ALL Sale Summary, Page Order, KPI, Chart, Back Navigation & POS Shortcut tests PASSED!');
}

runTests();
