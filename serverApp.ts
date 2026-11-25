import express from 'express';
import type { Request, Response, NextFunction, Application } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import net from 'net';
import tls from 'tls';
import http from 'http';
import https from 'https';
import { DEFAULT_STAFF_PERMISSIONS } from './src/types/pos.ts';
import {
  CctvGatewayManager,
  decryptCctvSecret,
  defaultCctvSystemSettings,
  defaultCapabilitiesForCamera,
  defaultPortForType,
  detectMediaBinaries,
  encryptCctvSecret,
  hashCctvPin,
  isScheduleActiveNow,
  isValidHostnameOrIp,
  maskCredentialsInUrl,
  normalizeCctvSystemSettings,
  probeCameraConnection,
  resolveEffectiveCameraTarget,
  sanitizeCameraForClient,
  sanitizeCctvSettingsForClient,
  sanitizeDvrConfigForClient,
  verifyCctvPin,
} from './serverCctvGateway.ts';
import type {
  CctvPtzAction,
  CctvCameraStored,
  CctvSystemStoredSettings,
  DvrNvrStoredConfig,
} from './serverCctvGateway.ts';
import type {
  Product,
  SaleTransaction,
  PurchaseTransaction,
  Customer,
  CustomerLedgerEntry,
  Supplier,
  SaleReturn,
  HeldBill,
  StoreBranding,
  DeviceInfo,
  PairingSession,
  SyncEvent,
  UserProfile,
  ShopAccount,
  SubscriptionPaymentRecord,
  SubscriptionRenewalRecord,
  SubscriptionPriceHistoryEntry,
  SubscriptionLifecycleEvent,
  PaymentStatusType,
  SubscriptionPlanType,
  AuthUser,
  UserRole,
  AuditLogEntry,
  DefaultSubscriptionPricing,
  StockTransaction,
  StockTransactionType,
  PurchaseReturn,
  ExpenseEntry,
  StaffMember,
  StaffModulePermissions,
  SupplierLedgerEntry,
  PrinterSettings,
  CategoryInfo,
  DailyHisabRow,
  ReceiptSettings,
  AppLockStoredConfig,
  AppLockPublicConfig,
  AppLockTimeoutOption,
  AppLockUnlockMethod,
  WebAuthnCredentialRecord,
  CctvCamera,
  CctvCameraType,
  CctvMotionEvent,
  CctvRecordingMode,
  DvrNvrConfig,
  OnlinePriceSearchMode,
  OnlinePriceRegionFilter,
  OnlinePriceSearchQueryRecord,
  OnlinePriceFavouriteItem,
  SavedPriceComparisonRecord,
} from './src/types/pos.ts';
import {
  checkPriceSearchRateLimit,
  executeOnlinePriceSearch,
  findLocalProductMatch,
  getPriceSearchProviderStatus,
  isOnlinePriceSearchCached,
  sanitizeExternalHttpUrl,
} from './serverPriceSearch.ts';
import {
  SCREENSHOT_CATEGORIES,
  INITIAL_SUPPLIERS,
  SEED_CATALOG_PRODUCTS,
} from './src/data/defaultProducts.ts';
import {
  applyPurchaseDeleteAllToState,
  applyPurchaseDeleteToState,
  applyPurchaseSaveToState,
  formatStockAuditTimestamp,
} from './src/utils/purchaseHelpers.ts';
import {
  STOCK_ALREADY_ZERO_MESSAGE,
  buildInsufficientStockMessage,
  findLiveProduct,
  reconcileNegativeStockFromHistory,
  roundStockQty,
  validatePurchaseReturnStock,
  validateSaleItemsStock,
} from './src/utils/stockValidation.ts';
import { APP_VERSION, APP_BUILD_ID, APP_BUILD_DATE, AUTH_POLICY_VERSION } from './src/version.ts';

export const isServerlessRuntime = Boolean(
  process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.WAQAS_SERVERLESS === '1'
);

const SEED_DATA_DIR = path.resolve(process.cwd(), 'data');

function isDirectoryWritable(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probeFile = path.join(dirPath, `.write_probe_${process.pid}_${Date.now()}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    return false;
  }
}

function copySeedDirectoryIfMissing(srcDir: string, destDir: string) {
  if (!fs.existsSync(srcDir)) return;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'backups' || entry.name.startsWith('.write_probe_')) continue;
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copySeedDirectoryIfMissing(srcPath, destPath);
      } else if (entry.isFile() && !fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  } catch (err) {
    console.warn('[Server] Seed directory sync warning:', err);
  }
}

function resolveDataDir(): { dataDir: string; storageMode: 'local-fs' | 'serverless-tmp' } {
  if (process.env.WAQAS_DATA_DIR) {
    const customDir = path.resolve(process.env.WAQAS_DATA_DIR);
    if (isDirectoryWritable(customDir)) {
      return { dataDir: customDir, storageMode: isServerlessRuntime ? 'serverless-tmp' : 'local-fs' };
    }
  }

  if (!isServerlessRuntime && isDirectoryWritable(SEED_DATA_DIR)) {
    return { dataDir: SEED_DATA_DIR, storageMode: 'local-fs' };
  }

  const tmpDataDir = path.join(os.tmpdir(), 'waqas-pos-data');
  fs.mkdirSync(tmpDataDir, { recursive: true });
  copySeedDirectoryIfMissing(SEED_DATA_DIR, tmpDataDir);
  return { dataDir: tmpDataDir, storageMode: 'serverless-tmp' };
}

const resolvedStorage = resolveDataDir();
export const DATA_DIR = resolvedStorage.dataDir;
export const SHOPS_DIR = path.join(DATA_DIR, 'shops');
fs.mkdirSync(SHOPS_DIR, { recursive: true });

const STORE_DB_FILE = path.join(DATA_DIR, 'store_db.json');
const DEVICES_DB_FILE = path.join(DATA_DIR, 'devices_db.json');
const SUBSCRIPTIONS_DB_FILE = path.join(DATA_DIR, 'subscriptions_db.json');
const AUTH_DB_FILE = path.join(DATA_DIR, 'auth_db.json');
const AUDIT_LOGS_FILE = path.join(DATA_DIR, 'audit_logs.json');
const PAIRING_SESSIONS_FILE = path.join(DATA_DIR, 'pairing_sessions.json');
const SUPER_ADMIN_POS_SHOP_ID = 'SHOP-SA-POS';

// -------------------------------------------------------------
// OPTIONAL SHARED KV STORE (Vercel KV / Upstash Redis REST API)
// Enables multi-container persistence on Vercel Serverless Functions
// -------------------------------------------------------------
function getKvConfig(): { url: string; token: string; enabled: boolean } {
  const url = (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ''
  ).replace(/\/+$/, '');
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return { url, token, enabled: Boolean(url && token) };
}

const initialKvCfg = getKvConfig();
const isSharedKvEnabled = initialKvCfg.enabled;

interface KvGetResult<T> {
  ok: boolean;
  found: boolean;
  value: T | null;
}

async function fetchWithTimeoutAndRetry(
  url: string,
  init: RequestInit,
  timeoutMs = 5000,
  retries = 2
): Promise<globalThis.Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < retries) {
        const delayMs = Math.min(1500, 150 * Math.pow(2, attempt) + Math.floor(Math.random() * 80));
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        const delayMs = Math.min(1500, 150 * Math.pow(2, attempt) + Math.floor(Math.random() * 80));
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Network request failed');
}

async function kvGetResult<T>(key: string): Promise<KvGetResult<T>> {
  const kv = getKvConfig();
  if (!kv.enabled) return { ok: false, found: false, value: null };
  try {
    const res = await fetchWithTimeoutAndRetry(`${kv.url}/get/${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${kv.token}` },
    });
    if (!res.ok) return { ok: false, found: false, value: null };
    const body = (await res.json()) as { result?: unknown };
    if (body?.result == null) return { ok: true, found: false, value: null };
    if (typeof body.result === 'string') {
      return { ok: true, found: true, value: JSON.parse(body.result) as T };
    }
    return { ok: true, found: true, value: body.result as T };
  } catch {
    return { ok: false, found: false, value: null };
  }
}

async function kvGetJson<T>(key: string): Promise<T | null> {
  const res = await kvGetResult<T>(key);
  return res.found ? res.value : null;
}

const pendingKvWrites = new Set<Promise<void>>();

export async function flushPendingKvWrites(): Promise<void> {
  if (pendingKvWrites.size === 0) return;
  await Promise.allSettled(Array.from(pendingKvWrites));
}

function trackKvWrite(task: Promise<void>): Promise<void> {
  pendingKvWrites.add(task);
  task.finally(() => {
    pendingKvWrites.delete(task);
  });
  return task;
}

async function kvSetJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const kv = getKvConfig();
  if (!kv.enabled) return;
  const run = (async () => {
    try {
      const serialized = JSON.stringify(value);
      const endpoint = ttlSeconds
        ? `${kv.url}/set/${encodeURIComponent(key)}?EX=${Math.max(1, Math.floor(ttlSeconds))}`
        : `${kv.url}/set/${encodeURIComponent(key)}`;
      await fetchWithTimeoutAndRetry(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kv.token}`,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: serialized,
      });
    } catch {}
  })();
  return trackKvWrite(run);
}

async function kvSetNxJson(key: string, value: unknown): Promise<void> {
  const kv = getKvConfig();
  if (!kv.enabled) return;
  const run = (async () => {
    try {
      const serialized = JSON.stringify(value);
      const res = await fetchWithTimeoutAndRetry(`${kv.url}/set/${encodeURIComponent(key)}?NX=true`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kv.token}`,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: serialized,
      });
      if (!res.ok) {
        await fetchWithTimeoutAndRetry(`${kv.url}/set/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${kv.token}`,
            'Content-Type': 'text/plain; charset=utf-8',
          },
          body: serialized,
        });
      }
    } catch {}
  })();
  return trackKvWrite(run);
}

async function kvDel(key: string): Promise<void> {
  const kv = getKvConfig();
  if (!kv.enabled) return;
  const run = (async () => {
    try {
      await fetchWithTimeoutAndRetry(`${kv.url}/del/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kv.token}` },
      });
    } catch {}
  })();
  return trackKvWrite(run);
}

// -------------------------------------------------------------
// HMAC-SIGNED SESSION TOKENS (Survives across serverless cold/warm containers)
// -------------------------------------------------------------
const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
let sharedKvSessionSecret: string | null = null;

function getExplicitEnvSessionSecret(): string {
  return (
    process.env.SESSION_SECRET ||
    process.env.WAQAS_SESSION_SECRET ||
    process.env.AUTH_SECRET ||
    ''
  ).trim();
}

function hasConfiguredSessionSecret(): boolean {
  return Boolean(getExplicitEnvSessionSecret() || (isSharedKvEnabled && sharedKvSessionSecret));
}

function getSessionSigningSecret(): string {
  return (
    getExplicitEnvSessionSecret() ||
    sharedKvSessionSecret ||
    EPHEMERAL_SESSION_SECRET
  );
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64').toString('utf8');
}

function createSignedSessionToken(prefix: 'SA' | 'SO' | 'STF', session: Omit<AuthSessionData, 'token'>): string {
  const payloadObj = {
    jti: crypto.randomBytes(12).toString('hex'),
    uid: session.userId,
    role: session.role,
    shopId: session.shopId,
    staffId: session.staffId,
    email: session.email,
    gmail: session.gmail,
    username: session.username,
    fullName: session.fullName,
    iat: session.createdAt,
    exp: session.expiresAt,
    pv: session.policyVersion || AUTH_POLICY_VERSION,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payloadObj));
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', getSessionSigningSecret()).update(`${prefix}.${payloadB64}`).digest()
  );
  return `${prefix}.${payloadB64}.${sig}`;
}

function verifySignedSessionToken(token: string): (AuthSessionData & { jti?: string }) | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [prefix, payloadB64, sigB64] = parts;
  if (prefix !== 'SA' && prefix !== 'SO' && prefix !== 'STF') return null;

  try {
    const expectedSig = base64UrlEncode(
      crypto.createHmac('sha256', getSessionSigningSecret()).update(`${prefix}.${payloadB64}`).digest()
    );
    const a = Buffer.from(sigB64);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }
    const parsed = JSON.parse(base64UrlDecode(payloadB64));
    if (!parsed || !parsed.uid || !parsed.role) return null;
    if (parsed.pv !== AUTH_POLICY_VERSION) return null;
    if (!parsed.exp || parsed.exp <= Date.now()) return null;

    if (parsed.jti && authDb.revokedTokens?.[parsed.jti]) {
      return null;
    }
    const revokedBefore = authDb.revokedBefore?.[parsed.uid] || 0;
    if (parsed.iat && parsed.iat < revokedBefore) {
      return null;
    }
    if (parsed.shopId) {
      const shopRevokedBefore = authDb.revokedBefore?.[`shop:${parsed.shopId}`] || 0;
      if (parsed.iat && parsed.iat < shopRevokedBefore) {
        return null;
      }
    }

    return {
      token,
      jti: parsed.jti,
      userId: parsed.uid,
      email: parsed.email,
      gmail: parsed.gmail,
      username: parsed.username,
      fullName: parsed.fullName,
      role: parsed.role,
      shopId: parsed.shopId,
      staffId: parsed.staffId,
      createdAt: parsed.iat || Date.now(),
      expiresAt: parsed.exp,
      policyVersion: parsed.pv,
    };
  } catch {
    return null;
  }
}

function revokeTokenInDb(token: string, fallbackExp?: number) {
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const parsed = JSON.parse(base64UrlDecode(parts[1]));
      if (parsed?.jti) {
        authDb.revokedTokens = authDb.revokedTokens || {};
        authDb.revokedTokens[parsed.jti] = parsed.exp || fallbackExp || Date.now() + 30 * 24 * 60 * 60 * 1000;
      }
    } catch {}
  }
}

export interface StoredSuperAdmin {
  id: string;
  gmail: string;
  googleSub?: string;
  mobile?: string;
  fullName: string;
  status: 'active';
  verifiedGmail: boolean;
  verifiedMobile?: boolean;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
  lastLoginAt?: string;
}

export interface PendingOAuthState {
  purpose: 'login' | 'provision';
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingGoogleAssertion {
  gmail: string;
  googleSub: string;
  fullName: string;
  purpose: 'login' | 'provision';
  createdAt: number;
  expiresAt: number;
  used: boolean;
  passwordRetries: number;
}

export interface PendingOtpSession {
  purpose: 'setup' | 'recovery';
  gmail?: string;
  mobile?: string;
  fullName?: string;
  passwordSaltTemp?: string;
  passwordHashTemp?: string;
  emailOtpHash?: string;
  smsOtpHash?: string;
  channel?: 'gmail' | 'mobile';
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

export interface StoredUser {
  id: string;
  email?: string;
  username?: string;
  secondaryEmails?: string[];
  fullName: string;
  phone?: string;
  whatsapp?: string;
  role: UserRole;
  shopId?: string;
  passwordHash: string;
  passwordSalt: string;
  mustChangePasswordOnFirstLogin?: boolean;
  createdAt: string;
}

export interface AuthSessionData {
  token: string;
  userId: string;
  email?: string;
  gmail?: string;
  username?: string;
  fullName?: string;
  role: UserRole;
  shopId?: string;
  staffId?: string;
  permissions?: StaffModulePermissions;
  createdAt: number;
  expiresAt: number;
  ip?: string;
  policyVersion?: string;
}

export interface AuthDb {
  superAdmin: StoredSuperAdmin | null;
  superAdminSetupLocked?: boolean;
  users: StoredUser[];
  sessions: Record<string, AuthSessionData>;
  revokedTokens?: Record<string, number>;
  revokedBefore?: Record<string, number>;
  pendingOtps: Record<string, PendingOtpSession>;
  failedAttempts: Record<string, { count: number; lastAttempt: number }>;
}

function normalizeMobile(input: string): string {
  const digits = String(input || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('0092') && digits.length >= 12) {
    return '0' + digits.slice(4);
  }
  if (digits.startsWith('92') && digits.length === 12) {
    return '0' + digits.slice(2);
  }
  if (digits.length === 10 && digits.startsWith('3')) {
    return '0' + digits;
  }
  return digits;
}

function hashPassword(password: string, salt: string): string {
  return 'scrypt:' + crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function verifyPasswordRecord(password: string, salt: string, storedHash: string): boolean {
  if (!password || !salt || !storedHash) return false;
  if (storedHash.startsWith('scrypt:')) {
    const expectedHex = storedHash.slice(7);
    const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(derived, expectedBuf);
  }
  const calc100k = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  if (calc100k === storedHash) return true;
  const calc1k = crypto.pbkdf2Sync(password, salt, 1000, 32, 'sha256').toString('hex');
  return calc1k === storedHash;
}

function verifyPassword(password: string, user: StoredUser): boolean {
  if (!user || !user.passwordSalt || !user.passwordHash) return false;
  const ok = verifyPasswordRecord(password, user.passwordSalt, user.passwordHash);
  if (ok && !user.passwordHash.startsWith('scrypt:')) {
    user.passwordHash = hashPassword(password, user.passwordSalt);
    persistAuthDb();
  }
  return ok;
}

function loadInitialAuditLogs(): AuditLogEntry[] {
  if (fs.existsSync(AUDIT_LOGS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(AUDIT_LOGS_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        return parsed.map((entry: any) => ({
          ...entry,
          actorRole: entry.actorRole === 'MASTER_ADMIN' ? 'SUPER_ADMIN' : entry.actorRole,
        }));
      }
    } catch (e) {
      console.warn('Failed to parse audit_logs.json, initializing', e);
    }
  }
  const initialLogs: AuditLogEntry[] = [
    {
      id: `AUD-${Date.now()}-001`,
      timestamp: new Date().toISOString(),
      action: 'SYSTEM_INITIALIZED',
      actorEmail: 'system@waqaspos',
      actorRole: 'SUPER_ADMIN',
      details: 'WAQAS POS SOFTWARE centralized multi-shop authentication initialized.',
    },
  ];
  try {
    fs.writeFileSync(AUDIT_LOGS_FILE, JSON.stringify(initialLogs, null, 2));
  } catch (err) {
    console.error('Error saving audit_logs.json', err);
  }
  return initialLogs;
}

let auditLogs: AuditLogEntry[] = loadInitialAuditLogs();

function persistAuditLogs() {
  const sliced = auditLogs.slice(0, 500);
  try {
    const tmpFile = `${AUDIT_LOGS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(sliced, null, 2));
    fs.renameSync(tmpFile, AUDIT_LOGS_FILE);
  } catch (e) {
    console.error('Error persisting audit_logs.json', e);
  }
  if (isSharedKvEnabled) {
    kvSetJson('waqas:audit_logs', sliced).catch(() => {});
  }
}

function recordAuditLog(
  action: string,
  actorEmail: string,
  actorRole: UserRole,
  details: string,
  shopId?: string,
  ipAddress?: string
) {
  const entry: AuditLogEntry = {
    id: `AUD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    timestamp: new Date().toISOString(),
    action,
    actorEmail,
    actorRole,
    details,
    shopId,
    ipAddress,
  };
  auditLogs.unshift(entry);
  persistAuditLogs();
}

const hasEnvSuperAdminOverride = Boolean(
  process.env.SUPER_ADMIN_PASSWORD_SALT && process.env.SUPER_ADMIN_PASSWORD_HASH
);
const FIXED_SUPER_ADMIN_EMAIL = String(process.env.SUPER_ADMIN_EMAIL || 'muhammedsaad255251@gmail.com')
  .trim()
  .toLowerCase();
const FIXED_SUPER_ADMIN_NAME = String(process.env.SUPER_ADMIN_NAME || 'Muhammad Waqas').trim();
const FIXED_SUPER_ADMIN_SALT =
  process.env.SUPER_ADMIN_PASSWORD_SALT || 'b14561a263ef0e8ff0ea689fd55dac48';
const FIXED_SUPER_ADMIN_HASH =
  process.env.SUPER_ADMIN_PASSWORD_HASH ||
  'scrypt:3d8886d2b0130d72bcc7df325617b5f9b65148ed0e5823b8f5e041da8d63e77856a89d05a586f61508df19c110e92f378cb109ca541d0f87b3be8487a4593dfb';

function createFixedSuperAdminRecord(): StoredSuperAdmin {
  return {
    id: 'SUPER-ADMIN-01',
    gmail: FIXED_SUPER_ADMIN_EMAIL,
    fullName: FIXED_SUPER_ADMIN_NAME,
    status: 'active',
    verifiedGmail: true,
    passwordSalt: FIXED_SUPER_ADMIN_SALT,
    passwordHash: FIXED_SUPER_ADMIN_HASH,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function normalizeLoadedAuthDb(raw: any): AuthDb {
  const users: StoredUser[] = Array.isArray(raw?.users)
    ? raw.users
        .filter((u: any) => u && u.role !== 'MASTER_ADMIN')
        .map((u: any) => {
          if (u.id === 'USR-SHOP-001' && !u.username) {
            return { ...u, username: 'waqasmart' };
          }
          return u;
        })
    : [];
  const sessions: Record<string, AuthSessionData> = {};
  if (raw?.sessions && typeof raw.sessions === 'object') {
    for (const [tok, sess] of Object.entries<any>(raw.sessions)) {
      if (sess && sess.role && sess.role !== 'MASTER_ADMIN' && sess.policyVersion === AUTH_POLICY_VERSION) {
        sessions[tok] = sess;
      }
    }
  }
  const existingSa: StoredSuperAdmin | null =
    !hasEnvSuperAdminOverride &&
    raw?.superAdmin &&
    typeof raw.superAdmin.gmail === 'string' &&
    raw.superAdmin.gmail.trim().toLowerCase() === FIXED_SUPER_ADMIN_EMAIL &&
    raw.superAdmin.passwordHash &&
    raw.superAdmin.passwordSalt
      ? {
          ...raw.superAdmin,
          gmail: FIXED_SUPER_ADMIN_EMAIL,
          status: 'active',
          verifiedGmail: true,
        }
      : null;

  return {
    superAdmin: existingSa || createFixedSuperAdminRecord(),
    superAdminSetupLocked: true,
    users,
    sessions,
    revokedTokens: raw?.revokedTokens && typeof raw.revokedTokens === 'object' ? raw.revokedTokens : {},
    revokedBefore: raw?.revokedBefore && typeof raw.revokedBefore === 'object' ? raw.revokedBefore : {},
    pendingOtps: {},
    failedAttempts: raw?.failedAttempts && typeof raw.failedAttempts === 'object' ? raw.failedAttempts : {},
  };
}

function loadInitialAuthDb(): AuthDb {
  if (fs.existsSync(AUTH_DB_FILE)) {
    try {
      const raw: any = JSON.parse(fs.readFileSync(AUTH_DB_FILE, 'utf-8'));
      const loaded = normalizeLoadedAuthDb(raw);
      try {
        fs.writeFileSync(AUTH_DB_FILE, JSON.stringify(loaded, null, 2));
      } catch {}
      return loaded;
    } catch (e) {
      console.warn('Failed to parse auth_db.json, initializing', e);
    }
  }

  const shopOwnerSalt = crypto.randomBytes(16).toString('hex');
  const shopOwnerHash = hashPassword('ShopOwner@123', shopOwnerSalt);

  const initialAuth: AuthDb = {
    superAdmin: createFixedSuperAdminRecord(),
    superAdminSetupLocked: true,
    users: [
      {
        id: 'USR-SHOP-001',
        email: 'waqasmart.pos@gmail.com',
        username: 'waqasmart',
        secondaryEmails: [],
        fullName: 'Muhammad Waqas',
        phone: '03429634133',
        whatsapp: '03228570782',
        role: 'SHOP_OWNER',
        shopId: 'SHOP-WM-001',
        passwordSalt: shopOwnerSalt,
        passwordHash: shopOwnerHash,
        mustChangePasswordOnFirstLogin: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    sessions: {},
    revokedTokens: {},
    revokedBefore: {},
    pendingOtps: {},
    failedAttempts: {},
  };

  try {
    fs.writeFileSync(AUTH_DB_FILE, JSON.stringify(initialAuth, null, 2));
  } catch (err) {
    console.error('Error creating default auth_db.json', err);
  }

  return initialAuth;
}

let authDb: AuthDb = loadInitialAuthDb();

function pruneExpiredAuthState() {
  const now = Date.now();
  if (authDb.sessions && typeof authDb.sessions === 'object') {
    for (const [tok, sess] of Object.entries(authDb.sessions)) {
      if (!sess || sess.expiresAt <= now || sess.policyVersion !== AUTH_POLICY_VERSION) {
        delete authDb.sessions[tok];
      }
    }
  }
  if (authDb.revokedTokens && typeof authDb.revokedTokens === 'object') {
    for (const [jti, exp] of Object.entries(authDb.revokedTokens)) {
      if (typeof exp !== 'number' || exp <= now) {
        delete authDb.revokedTokens[jti];
      }
    }
  }
  if (authDb.failedAttempts && typeof authDb.failedAttempts === 'object') {
    for (const [key, rec] of Object.entries(authDb.failedAttempts)) {
      if (rec && rec.lastAttempt < now - 60 * 60 * 1000) {
        delete authDb.failedAttempts[key];
      }
    }
  }
}

function persistAuthDb() {
  pruneExpiredAuthState();
  try {
    const tmpFile = `${AUTH_DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(authDb, null, 2));
    fs.renameSync(tmpFile, AUTH_DB_FILE);
  } catch (e) {
    console.error('Error persisting auth_db.json', e);
  }
  if (isSharedKvEnabled) {
    kvSetJson('waqas:auth_db', authDb).catch(() => {});
  }
}

interface SubscriptionsData {
  shops: ShopAccount[];
  payments: SubscriptionPaymentRecord[];
  renewals: SubscriptionRenewalRecord[];
  defaultPricing?: DefaultSubscriptionPricing;
  pricingHistory?: SubscriptionPriceHistoryEntry[];
  subscriptionHistory?: SubscriptionLifecycleEvent[];
}

const INITIAL_DEFAULT_PRICING: DefaultSubscriptionPricing = {
  oneDay: 200,
  sevenDays: 1000,
  hourlyRate: 50,
  lifetime: 25000,
  oneMonth: 1500,
  threeMonths: 4000,
  sixMonths: 7500,
  twelveMonths: 14000,
  previousPrices: {},
  lastUpdated: '2026-01-01T00:00:00.000Z',
  updatedBy: 'System Default',
};

function normalizeDefaultPricing(raw?: Partial<DefaultSubscriptionPricing>): DefaultSubscriptionPricing {
  return {
    oneDay: typeof raw?.oneDay === 'number' && Number.isFinite(raw.oneDay) && raw.oneDay >= 0 ? raw.oneDay : INITIAL_DEFAULT_PRICING.oneDay,
    sevenDays: typeof raw?.sevenDays === 'number' && Number.isFinite(raw.sevenDays) && raw.sevenDays >= 0 ? raw.sevenDays : INITIAL_DEFAULT_PRICING.sevenDays,
    hourlyRate: typeof raw?.hourlyRate === 'number' && Number.isFinite(raw.hourlyRate) && raw.hourlyRate >= 0 ? raw.hourlyRate : INITIAL_DEFAULT_PRICING.hourlyRate,
    lifetime: typeof raw?.lifetime === 'number' && Number.isFinite(raw.lifetime) && raw.lifetime >= 0 ? raw.lifetime : INITIAL_DEFAULT_PRICING.lifetime,
    oneMonth: typeof raw?.oneMonth === 'number' && Number.isFinite(raw.oneMonth) && raw.oneMonth >= 0 ? raw.oneMonth : INITIAL_DEFAULT_PRICING.oneMonth,
    threeMonths: typeof raw?.threeMonths === 'number' && Number.isFinite(raw.threeMonths) && raw.threeMonths >= 0 ? raw.threeMonths : INITIAL_DEFAULT_PRICING.threeMonths,
    sixMonths: typeof raw?.sixMonths === 'number' && Number.isFinite(raw.sixMonths) && raw.sixMonths >= 0 ? raw.sixMonths : INITIAL_DEFAULT_PRICING.sixMonths,
    twelveMonths: typeof raw?.twelveMonths === 'number' && Number.isFinite(raw.twelveMonths) && raw.twelveMonths >= 0 ? raw.twelveMonths : INITIAL_DEFAULT_PRICING.twelveMonths,
    previousPrices: raw?.previousPrices && typeof raw.previousPrices === 'object' ? { ...raw.previousPrices } : {},
    lastUpdated: raw?.lastUpdated || INITIAL_DEFAULT_PRICING.lastUpdated,
    updatedBy: raw?.updatedBy || INITIAL_DEFAULT_PRICING.updatedBy,
  };
}

function normalizeSubscriptionsData(raw: any): SubscriptionsData {
  const shops: ShopAccount[] = Array.isArray(raw?.shops)
    ? raw.shops.map((s: ShopAccount) => {
        const isLife = Boolean(s.isLifetime || s.plan === 'lifetime' || s.expiryDate === 'LIFETIME');
        const rem = typeof s.remainingBalance === 'number' ? Math.max(0, s.remainingBalance) : 0;
        const paid = typeof s.totalPaid === 'number' ? Math.max(0, s.totalPaid) : 0;
        const derivedPayStatus: PaymentStatusType =
          s.paymentStatus || (rem <= 0 ? 'Paid' : paid > 0 ? 'Partially Paid' : 'Unpaid');
        return {
          ...s,
          isLifetime: isLife,
          expiryDate: isLife ? 'LIFETIME' : s.expiryDate,
          expiryAt: isLife ? null : s.expiryAt,
          paymentStatus: derivedPayStatus,
        };
      })
    : [];
  return {
    shops,
    payments: Array.isArray(raw?.payments) ? raw.payments : [],
    renewals: Array.isArray(raw?.renewals) ? raw.renewals : [],
    defaultPricing: normalizeDefaultPricing(raw?.defaultPricing),
    pricingHistory: Array.isArray(raw?.pricingHistory) ? raw.pricingHistory : [],
    subscriptionHistory: Array.isArray(raw?.subscriptionHistory) ? raw.subscriptionHistory : [],
  };
}

function loadInitialSubscriptions(): SubscriptionsData {
  if (fs.existsSync(SUBSCRIPTIONS_DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_DB_FILE, 'utf-8'));
      return normalizeSubscriptionsData(parsed);
    } catch (e) {
      console.warn('Failed to parse subscriptions_db.json, using defaults', e);
    }
  }

  const defaultSubs: SubscriptionsData = {
    shops: [
      {
        id: 'SHOP-WM-001',
        shopName: 'WAQAS MART (Main Branch)',
        ownerName: 'Muhammad Waqas',
        email: 'waqasmart.pos@gmail.com',
        phone: '03429634133',
        whatsapp: '03228570782',
        address: 'Main Commercial Market, Pakistan',
        status: 'active',
        plan: '12_months',
        startDate: '2026-01-01',
        expiryDate: '2027-01-01',
        activationAt: '2026-01-01T00:00:00.000Z',
        expiryAt: '2027-01-01T23:59:59.999Z',
        isLifetime: false,
        agreedPrice: 14000,
        discount: 0,
        finalPrice: 14000,
        paymentStatus: 'Paid',
        lastPaymentDate: '2026-01-01',
        pricing: {
          oneDay: 200,
          sevenDays: 1000,
          hourlyRate: 50,
          lifetime: 25000,
          oneMonth: 1500,
          threeMonths: 4000,
          sixMonths: 7500,
          twelveMonths: 14000,
          customPricePerMonth: 1500,
          lastUpdated: '2026-10-24',
        },
        initialPayment: 14000,
        remainingBalance: 0,
        totalPaid: 14000,
        totalIncome: 14000,
        renewalsCount: 1,
        mustChangePasswordOnFirstLogin: false,
        createdAt: '2026-01-01',
      },
    ],
    payments: [
      {
        id: 'PAY-1001',
        receiptNumber: 'RCP-9821',
        shopId: 'SHOP-WM-001',
        shopName: 'WAQAS MART (Main Branch)',
        ownerName: 'Muhammad Waqas',
        ownerEmail: 'waqasmart.pos@gmail.com',
        plan: '12_months',
        durationLabel: '12 Months (1 Year)',
        totalAmount: 14000,
        discount: 0,
        finalAmount: 14000,
        amountPaid: 14000,
        remainingBalance: 0,
        paymentMethod: 'Bank Transfer',
        paymentDate: '2026-01-01',
        transactionReference: 'TRX-PKR-00192',
        confirmedBy: 'Super Admin',
        status: 'Paid',
        createdAt: '2026-01-01T10:00:00Z',
      },
    ],
    renewals: [
      {
        id: 'REN-1001',
        shopId: 'SHOP-WM-001',
        shopName: 'WAQAS MART (Main Branch)',
        plan: '12_months',
        durationDays: 365,
        durationLabel: '12 Months (1 Year)',
        previousExpiry: '2026-01-01',
        newExpiry: '2027-01-01',
        paymentReceiptNumber: 'RCP-9821',
        agreedPrice: 14000,
        discount: 0,
        finalAmount: 14000,
        amountPaid: 14000,
        remainingBalance: 0,
        amount: 14000,
        renewedAt: '2026-01-01',
        confirmedBy: 'Super Admin',
      },
    ],
    defaultPricing: { ...INITIAL_DEFAULT_PRICING },
    pricingHistory: [],
    subscriptionHistory: [],
  };

  try {
    fs.writeFileSync(SUBSCRIPTIONS_DB_FILE, JSON.stringify(defaultSubs, null, 2));
  } catch (err) {
    console.error('Error creating default subscriptions_db.json', err);
  }

  return defaultSubs;
}

let subscriptionsDb: SubscriptionsData = loadInitialSubscriptions();

function persistSubscriptions() {
  try {
    const tmpFile = `${SUBSCRIPTIONS_DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(subscriptionsDb, null, 2));
    fs.renameSync(tmpFile, SUBSCRIPTIONS_DB_FILE);
  } catch (e) {
    console.error('Error persisting subscriptions_db.json', e);
  }
  if (isSharedKvEnabled) {
    kvSetJson('waqas:subscriptions_db', subscriptionsDb).catch(() => {});
  }
}

export interface StoreData {
  products: Product[];
  transactions: SaleTransaction[];
  purchases: PurchaseTransaction[];
  customers: Customer[];
  customerLedgers: CustomerLedgerEntry[];
  saleReturns: SaleReturn[];
  suppliers: Supplier[];
  heldBills: HeldBill[];
  branding: StoreBranding;
  userProfile: UserProfile;
  martOwner?: any;
  stockHistory?: StockTransaction[];
  purchaseReturns?: PurchaseReturn[];
  supplierLedgers?: SupplierLedgerEntry[];
  expenses?: ExpenseEntry[];
  staffList?: StaffMember[];
  printerSettings?: PrinterSettings;
  categories?: CategoryInfo[];
  dailyHisab?: Record<string, Record<string, Partial<DailyHisabRow>>>;
  receiptSettings?: ReceiptSettings;
  appLock?: AppLockStoredConfig;
  cctvCameras?: CctvCameraStored[];
  dvrConfig?: DvrNvrStoredConfig;
  cctvGroups?: string[];
  cctvMotionEvents?: CctvMotionEvent[];
  cctvSettings?: CctvSystemStoredSettings;
  priceSearchHistory?: OnlinePriceSearchQueryRecord[];
  priceSearchFavourites?: OnlinePriceFavouriteItem[];
  priceSearchComparisons?: SavedPriceComparisonRecord[];
  syncVersion?: number;
  lastUpdated?: string;
}

function normalizeStaffPermissions(raw?: Partial<StaffModulePermissions>): StaffModulePermissions {
  const r = raw || {};
  const hasSettings = typeof r.settings === 'boolean' ? r.settings : Boolean(r.canAccessSettings);
  return {
    newSale: typeof r.newSale === 'boolean' ? r.newSale : DEFAULT_STAFF_PERMISSIONS.newSale,
    oldSale: typeof r.oldSale === 'boolean' ? r.oldSale : DEFAULT_STAFF_PERMISSIONS.oldSale,
    newPurchase: typeof r.newPurchase === 'boolean' ? r.newPurchase : DEFAULT_STAFF_PERMISSIONS.newPurchase,
    oldPurchase: typeof r.oldPurchase === 'boolean' ? r.oldPurchase : DEFAULT_STAFF_PERMISSIONS.oldPurchase,
    stock: typeof r.stock === 'boolean' ? r.stock : DEFAULT_STAFF_PERMISSIONS.stock,
    products: typeof r.products === 'boolean' ? r.products : DEFAULT_STAFF_PERMISSIONS.products,
    customers: typeof r.customers === 'boolean' ? r.customers : DEFAULT_STAFF_PERMISSIONS.customers,
    suppliers: typeof r.suppliers === 'boolean' ? r.suppliers : DEFAULT_STAFF_PERMISSIONS.suppliers,
    expenses: typeof r.expenses === 'boolean' ? r.expenses : DEFAULT_STAFF_PERMISSIONS.expenses,
    reports: typeof r.reports === 'boolean' ? r.reports : Boolean(r.canAccessReports),
    printing: typeof r.printing === 'boolean' ? r.printing : DEFAULT_STAFF_PERMISSIONS.printing,
    settings: hasSettings,
    canEditPrice: Boolean(r.canEditPrice),
    canGiveDiscount: Boolean(r.canGiveDiscount),
    canDeleteItems: Boolean(r.canDeleteItems),
    canAccessReports: typeof r.reports === 'boolean' ? r.reports : Boolean(r.canAccessReports),
    canAccessSettings: hasSettings,
    canAccessLedgers: typeof r.canAccessLedgers === 'boolean' ? r.canAccessLedgers : Boolean(r.customers || r.suppliers),
    canViewCostAndProfit: Boolean(r.canViewCostAndProfit),
    canViewCctv: typeof r.canViewCctv === 'boolean' ? r.canViewCctv : hasSettings,
    canManageCctv: typeof r.canManageCctv === 'boolean' ? r.canManageCctv : hasSettings,
  };
}

function normalizeStoreData(raw: Partial<StoreData>, fallbackShopName = 'WAQAS MART'): StoreData {
  const staffNormalized: StaffMember[] = Array.isArray(raw.staffList)
    ? raw.staffList.map((st: any) => ({
        ...st,
        permissions: normalizeStaffPermissions(st?.permissions),
      }))
    : [];

  return {
    products: Array.isArray(raw.products) ? raw.products : [],
    transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
    purchases: Array.isArray(raw.purchases) ? raw.purchases : [],
    customers: Array.isArray(raw.customers) ? raw.customers : [],
    customerLedgers: Array.isArray(raw.customerLedgers) ? raw.customerLedgers : [],
    saleReturns: Array.isArray(raw.saleReturns) ? raw.saleReturns : [],
    suppliers: Array.isArray(raw.suppliers) && raw.suppliers.length > 0 ? raw.suppliers : INITIAL_SUPPLIERS,
    heldBills: Array.isArray(raw.heldBills) ? raw.heldBills : [],
    stockHistory: Array.isArray(raw.stockHistory) ? raw.stockHistory : [],
    purchaseReturns: Array.isArray(raw.purchaseReturns) ? raw.purchaseReturns : [],
    supplierLedgers: Array.isArray(raw.supplierLedgers) ? raw.supplierLedgers : [],
    expenses: Array.isArray(raw.expenses) ? raw.expenses : [],
    staffList: staffNormalized,
    printerSettings: raw.printerSettings,
    categories: Array.isArray(raw.categories) && raw.categories.length > 0 ? raw.categories : SCREENSHOT_CATEGORIES,
    dailyHisab: raw.dailyHisab && typeof raw.dailyHisab === 'object' ? raw.dailyHisab : {},
    receiptSettings: raw.receiptSettings,
    martOwner: raw.martOwner,
    appLock: normalizeAppLockConfig(raw.appLock),
    cctvCameras: Array.isArray(raw.cctvCameras) ? raw.cctvCameras : [],
    dvrConfig: raw.dvrConfig && typeof raw.dvrConfig === 'object' ? raw.dvrConfig : undefined,
    cctvGroups: Array.isArray(raw.cctvGroups) ? raw.cctvGroups.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim()) : [],
    cctvMotionEvents: Array.isArray(raw.cctvMotionEvents) ? raw.cctvMotionEvents.slice(0, 500) : [],
    cctvSettings: normalizeCctvSystemSettings(raw.cctvSettings, raw.cctvSettings),
    priceSearchHistory: Array.isArray(raw.priceSearchHistory) ? raw.priceSearchHistory.slice(0, 100) : [],
    priceSearchFavourites: Array.isArray(raw.priceSearchFavourites) ? raw.priceSearchFavourites.slice(0, 200) : [],
    priceSearchComparisons: Array.isArray(raw.priceSearchComparisons) ? raw.priceSearchComparisons.slice(0, 100) : [],
    syncVersion: typeof raw.syncVersion === 'number' ? raw.syncVersion : 1,
    lastUpdated: raw.lastUpdated || new Date().toISOString(),
    branding: raw.branding || {
      storeName: fallbackShopName,
      primaryName: fallbackShopName.split(' ')[0] || 'WAQAS',
      accentName: fallbackShopName.split(' ').slice(1).join(' ') || 'MART',
      subtitle: 'Supermarket Management',
      primaryColor: '#00a859',
      sidebarPromoTitle: 'Small Steps Big Dreams',
      sidebarPromoBadge: fallbackShopName,
      bottomBannerTitle: 'Fresh Products Everyday',
      bottomBannerSubtitle: 'Best Quality • Lowest Prices',
      terminalDeviceId: 'WM-001',
    },
    userProfile: raw.userProfile || {
      id: 'USR-SHOP-OWNER',
      displayName: 'Shop Owner',
      email: '',
      phone: '',
      role: 'Shop Owner',
      createdAt: new Date().toLocaleDateString('en-GB'),
    },
  };
}

const VALID_APP_LOCK_TIMEOUTS: AppLockTimeoutOption[] = ['immediate', '30s', '1m', '5m', '10m', '15m'];
const VALID_APP_LOCK_METHODS: AppLockUnlockMethod[] = ['fingerprint', 'pin', 'password'];

function normalizeAppLockConfig(raw?: Partial<AppLockStoredConfig> | null): AppLockStoredConfig {
  const r = raw && typeof raw === 'object' ? raw : {};
  const autoLockTimeout: AppLockTimeoutOption = VALID_APP_LOCK_TIMEOUTS.includes(r.autoLockTimeout as AppLockTimeoutOption)
    ? (r.autoLockTimeout as AppLockTimeoutOption)
    : '1m';
  const defaultUnlockMethod: AppLockUnlockMethod = VALID_APP_LOCK_METHODS.includes(
    r.defaultUnlockMethod as AppLockUnlockMethod
  )
    ? (r.defaultUnlockMethod as AppLockUnlockMethod)
    : 'pin';
  return {
    enabled: Boolean(r.enabled),
    pinSalt: typeof r.pinSalt === 'string' ? r.pinSalt : undefined,
    pinHash: typeof r.pinHash === 'string' ? r.pinHash : undefined,
    pinLength: typeof r.pinLength === 'number' && r.pinLength >= 4 && r.pinLength <= 12 ? r.pinLength : 4,
    passwordSalt: typeof r.passwordSalt === 'string' ? r.passwordSalt : undefined,
    passwordHash: typeof r.passwordHash === 'string' ? r.passwordHash : undefined,
    defaultUnlockMethod,
    autoLockTimeout,
    requireAuthOnExit: typeof r.requireAuthOnExit === 'boolean' ? r.requireAuthOnExit : true,
    requireAuthOnReopen: typeof r.requireAuthOnReopen === 'boolean' ? r.requireAuthOnReopen : true,
    webauthnCredentials: Array.isArray(r.webauthnCredentials)
      ? r.webauthnCredentials.filter((c) => c && typeof c.id === 'string' && typeof c.rawIdBase64Url === 'string')
      : [],
    failedAttempts: typeof r.failedAttempts === 'number' && r.failedAttempts >= 0 ? r.failedAttempts : 0,
    lastFailedAt: typeof r.lastFailedAt === 'string' ? r.lastFailedAt : undefined,
    lockedOutUntil: typeof r.lockedOutUntil === 'string' ? r.lockedOutUntil : undefined,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
  };
}

function toPublicAppLockConfig(raw?: Partial<AppLockStoredConfig> | null): AppLockPublicConfig {
  const cfg = normalizeAppLockConfig(raw);
  return {
    enabled: cfg.enabled,
    hasPin: Boolean(cfg.pinHash && cfg.pinSalt),
    pinLength: cfg.pinLength || 4,
    hasPassword: Boolean(cfg.passwordHash && cfg.passwordSalt),
    defaultUnlockMethod: cfg.defaultUnlockMethod,
    autoLockTimeout: cfg.autoLockTimeout,
    requireAuthOnExit: cfg.requireAuthOnExit,
    requireAuthOnReopen: cfg.requireAuthOnReopen,
    webauthnCredentials: (cfg.webauthnCredentials || []).map((c) => ({
      id: c.id,
      rawIdBase64Url: c.rawIdBase64Url,
      deviceLabel: c.deviceLabel,
      authenticatorType: c.authenticatorType,
      transports: c.transports,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    })),
    failedAttempts: cfg.failedAttempts || 0,
    lastFailedAt: cfg.lastFailedAt,
    lockedOutUntil: cfg.lockedOutUntil,
    updatedAt: cfg.updatedAt,
  };
}

function getShopStoreFile(shopId: string): string {
  const cleanId = (shopId || 'SHOP-WM-001').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(SHOPS_DIR, `${cleanId}.json`);
}

const MAX_SHOP_STORE_CACHE = 50;
const shopStoreCache = new Map<string, StoreData>();

function setCachedShopStore(shopId: string, data: StoreData) {
  if (shopStoreCache.has(shopId)) {
    shopStoreCache.delete(shopId);
  }
  shopStoreCache.set(shopId, data);
  while (shopStoreCache.size > MAX_SHOP_STORE_CACHE) {
    const oldestKey = shopStoreCache.keys().next().value;
    if (!oldestKey) break;
    shopStoreCache.delete(oldestKey);
  }
}

function getShopStore(shopId: string): StoreData {
  const targetId = shopId || 'SHOP-WM-001';
  const cached = shopStoreCache.get(targetId);
  if (cached) {
    // Refresh LRU order
    shopStoreCache.delete(targetId);
    shopStoreCache.set(targetId, cached);
    return cached;
  }

  const shopMeta = subscriptionsDb.shops.find((s) => s.id === targetId);
  const shopName =
    shopMeta?.shopName ||
    (targetId === SUPER_ADMIN_POS_SHOP_ID
      ? 'MY POS APP'
      : targetId === 'SHOP-WM-001'
      ? 'WAQAS MART'
      : 'NEW MART');
  const file = getShopStoreFile(targetId);

  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const normalized = normalizeStoreData(parsed, shopName);
      setCachedShopStore(targetId, normalized);
      return normalized;
    } catch (e) {
      console.warn(`Failed to parse shop store for ${targetId}, using fallback`, e);
    }
  }

  if (targetId === 'SHOP-WM-001' && fs.existsSync(STORE_DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(STORE_DB_FILE, 'utf-8'));
      const normalized = normalizeStoreData(parsed, shopName);
      setCachedShopStore(targetId, normalized);
      fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
      return normalized;
    } catch {}
  }

  const fresh = normalizeStoreData({}, shopName);
  if (targetId === SUPER_ADMIN_POS_SHOP_ID) {
    fresh.userProfile = {
      id: authDb.superAdmin?.id || 'SUPER_ADMIN_ROOT',
      displayName: authDb.superAdmin?.fullName || 'Muhammad Saad (Super Admin)',
      email: authDb.superAdmin?.gmail || '',
      phone: authDb.superAdmin?.mobile || '03228570782',
      role: 'SUPER_ADMIN',
      createdAt: new Date().toLocaleDateString('en-GB'),
    };
    fresh.martOwner = {
      martName: 'MY POS APP',
      badge: 'SUPER ADMIN POS',
      ownerName: authDb.superAdmin?.fullName || 'Muhammad Saad',
      designation: 'Super Admin Personal POS',
      mobileNumber: authDb.superAdmin?.mobile || '03228570782',
      whatsappNumber: authDb.superAdmin?.mobile || '03228570782',
      address: 'Super Admin Personal Terminal',
      photoUrl: '/5c454cea45cc8c39a24b57a83fbbc5cf_0.webp',
    };
  } else if (shopMeta) {
    fresh.userProfile = {
      id: `USR-${targetId}`,
      displayName: shopMeta.ownerName || shopName,
      email: shopMeta.email || '',
      phone: shopMeta.phone || '',
      role: 'Shop Owner',
      createdAt: shopMeta.createdAt || new Date().toLocaleDateString('en-GB'),
    };
  }
  setCachedShopStore(targetId, fresh);
  try {
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2));
    if (targetId === 'SHOP-WM-001') {
      fs.writeFileSync(STORE_DB_FILE, JSON.stringify(fresh, null, 2));
    }
  } catch {}
  return fresh;
}

function persistShopStore(shopId: string, bumpVersion = true): StoreData {
  const targetId = shopId || 'SHOP-WM-001';
  const store = getShopStore(targetId);
  if (bumpVersion) {
    store.syncVersion = (Number(store.syncVersion) || 0) + 1;
    store.lastUpdated = new Date().toISOString();
  }
  const serialized = JSON.stringify(store, null, 2);
  try {
    const shopFile = getShopStoreFile(targetId);
    const tmpShopFile = `${shopFile}.tmp`;
    fs.writeFileSync(tmpShopFile, serialized);
    fs.renameSync(tmpShopFile, shopFile);
    if (targetId === 'SHOP-WM-001') {
      const tmpStoreFile = `${STORE_DB_FILE}.tmp`;
      fs.writeFileSync(tmpStoreFile, serialized);
      fs.renameSync(tmpStoreFile, STORE_DB_FILE);
    }
  } catch (err) {
    console.error(`Error saving shop store data for ${targetId}:`, err);
  }
  if (isSharedKvEnabled) {
    kvSetJson(`waqas:shop:${targetId}`, store).catch(() => {});
  }
  return store;
}

function setShopStore(shopId: string, data: StoreData, bumpVersion = true): StoreData {
  const targetId = shopId || 'SHOP-WM-001';
  const shopMeta = subscriptionsDb.shops.find((s) => s.id === targetId);
  const fallbackName = targetId === SUPER_ADMIN_POS_SHOP_ID ? 'MY POS APP' : shopMeta?.shopName || 'WAQAS MART';
  const normalized = normalizeStoreData(data, fallbackName);
  setCachedShopStore(targetId, normalized);
  return persistShopStore(targetId, bumpVersion);
}

function sanitizeStoreForClient(store: StoreData, role: UserRole, permissions?: StaffModulePermissions): StoreData {
  const cloned: StoreData = {
    ...store,
    appLock: undefined,
    cctvCameras: (store.cctvCameras || []).map((cam) => sanitizeCameraForClient(cam, DATA_DIR)),
    dvrConfig: sanitizeDvrConfigForClient(store.dvrConfig),
    cctvSettings: sanitizeCctvSettingsForClient(store.cctvSettings),
    staffList: (store.staffList || []).map((st: any) => ({
      ...st,
      passwordHash: undefined,
      passwordSalt: undefined,
    })),
  };

  if (role === 'STAFF' && !permissions?.canViewCostAndProfit) {
    cloned.products = (store.products || []).map((p) => ({ ...p, costPrice: 0 }));
    cloned.transactions = (store.transactions || []).map((tx) => ({
      ...tx,
      items: (tx.items || []).map((it) => ({
        ...it,
        product: it.product ? { ...it.product, costPrice: 0 } : it.product,
      })),
    }));
    if (!permissions?.newPurchase && !permissions?.oldPurchase && !permissions?.reports) {
      cloned.purchases = [];
      cloned.purchaseReturns = [];
    }
    if (!permissions?.expenses && !permissions?.reports) {
      cloned.expenses = [];
    }
  }

  return cloned;
}

function loadInitialDevices(): DeviceInfo[] {
  if (fs.existsSync(DEVICES_DB_FILE)) {
    try {
      const content = fs.readFileSync(DEVICES_DB_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed.map((d: any) => ({
          ...d,
          shopId: d.shopId || 'SHOP-WM-001',
        }));
      }
    } catch (e) {
      console.warn('Failed to parse devices_db.json, initializing', e);
    }
  }

  const initialDevices: DeviceInfo[] = [
    {
      deviceId: 'DEV-PRIMARY-TERMINAL',
      sessionToken: 'TOKEN-PRIMARY-TERMINAL-ROOT',
      shopId: 'SHOP-WM-001',
      deviceName: 'Main Store Windows Terminal',
      deviceType: 'Windows PC',
      browser: 'Chrome / Desktop',
      os: 'Windows 11 / 10',
      isCurrentDevice: false,
      firstRegistered: new Date().toLocaleDateString('en-GB'),
      lastActive: new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
      status: 'active',
      connectionState: 'online',
    },
  ];

  try {
    fs.writeFileSync(DEVICES_DB_FILE, JSON.stringify(initialDevices, null, 2));
  } catch (err) {
    console.error('Error saving default devices', err);
  }

  return initialDevices;
}

getShopStore('SHOP-WM-001');
let registeredDevices: DeviceInfo[] = loadInitialDevices();
const pairingSessions = new Map<string, PairingSession>();
const removedDeviceIds = new Set<string>();

function loadPairingSessionsFromDisk() {
  if (!fs.existsSync(PAIRING_SESSIONS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(PAIRING_SESSIONS_FILE, 'utf-8'));
    if (Array.isArray(raw)) {
      const now = Date.now();
      for (const s of raw) {
        if (s && s.pairingToken && (s.expiresAt > now || s.status === 'approved')) {
          pairingSessions.set(s.pairingToken, s);
        }
      }
    }
  } catch {}
}

function persistPairingSessions() {
  try {
    const now = Date.now();
    const list = Array.from(pairingSessions.values()).filter(
      (s) => s.expiresAt > now - 60000 || s.status === 'approved'
    );
    const tmpFile = `${PAIRING_SESSIONS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2));
    fs.renameSync(tmpFile, PAIRING_SESSIONS_FILE);
  } catch {}
}

loadPairingSessionsFromDisk();

async function savePairingSessionShared(session: PairingSession): Promise<void> {
  pairingSessions.set(session.pairingToken, session);
  persistPairingSessions();
  if (isSharedKvEnabled) {
    await Promise.all([
      kvSetJson(`waqas:pairing:${session.pairingToken}`, session, 360),
      kvSetJson(`waqas:pairing_code:${session.manualCode.toUpperCase()}`, session.pairingToken, 360),
    ]);
  }
}

async function deletePairingSessionShared(session: PairingSession): Promise<void> {
  pairingSessions.delete(session.pairingToken);
  persistPairingSessions();
  if (isSharedKvEnabled) {
    await Promise.all([
      kvDel(`waqas:pairing:${session.pairingToken}`),
      kvDel(`waqas:pairing_code:${session.manualCode.toUpperCase()}`),
    ]);
  }
}

async function findPairingSessionShared(tokenOrCode: string): Promise<PairingSession | undefined> {
  const clean = tokenOrCode.trim();
  if (!clean) return undefined;

  loadPairingSessionsFromDisk();

  let session = pairingSessions.get(clean);
  if (!session) {
    for (const s of pairingSessions.values()) {
      if (s.manualCode.toUpperCase() === clean.toUpperCase()) {
        session = s;
        break;
      }
    }
  }

  if (!session && isSharedKvEnabled) {
    const direct = await kvGetJson<PairingSession>(`waqas:pairing:${clean}`);
    if (direct) {
      pairingSessions.set(direct.pairingToken, direct);
      return direct;
    }
    const mappedToken = await kvGetJson<string>(`waqas:pairing_code:${clean.toUpperCase()}`);
    if (mappedToken) {
      const byCode = await kvGetJson<PairingSession>(`waqas:pairing:${mappedToken}`);
      if (byCode) {
        pairingSessions.set(byCode.pairingToken, byCode);
        return byCode;
      }
    }
  } else if (session && isSharedKvEnabled) {
    const fresh = await kvGetJson<PairingSession>(`waqas:pairing:${session.pairingToken}`);
    if (fresh) {
      pairingSessions.set(fresh.pairingToken, fresh);
      return fresh;
    }
  }

  return session;
}

function verifyDeviceAccess(
  deviceId?: string,
  sessionToken?: string
): { allowed: boolean; statusCode: number; error?: string; message?: string; device?: DeviceInfo } {
  if (!deviceId) {
    return { allowed: true, statusCode: 200 };
  }
  if (removedDeviceIds.has(deviceId)) {
    return {
      allowed: false,
      statusCode: 403,
      error: 'DEVICE_REMOVED',
      message: 'This device was removed by the administrator. Re-pair via QR code to reconnect.',
    };
  }
  const dev = registeredDevices.find((d) => d.deviceId === deviceId);
  if (!dev) {
    if (sessionToken) {
      return {
        allowed: false,
        statusCode: 403,
        error: 'DEVICE_UNKNOWN',
        message: 'Device session is no longer registered. Please pair again.',
      };
    }
    return { allowed: true, statusCode: 200 };
  }
  if (dev.status === 'revoked') {
    return {
      allowed: false,
      statusCode: 403,
      error: 'DEVICE_REVOKED',
      message: 'Device access has been revoked by administrator.',
      device: dev,
    };
  }
  if (dev.sessionToken && sessionToken && dev.sessionToken !== sessionToken) {
    return {
      allowed: false,
      statusCode: 403,
      error: 'INVALID_DEVICE_TOKEN',
      message: 'Invalid or expired device authorization token.',
      device: dev,
    };
  }
  return { allowed: true, statusCode: 200, device: dev };
}

function recordShopStockTx(
  shopData: StoreData,
  product: Product,
  previousStock: number,
  quantityChange: number,
  newStock: number,
  transactionType: StockTransactionType,
  invoiceNumber: string,
  userName?: string,
  notes?: string
) {
  const entry: StockTransaction = {
    id: `STK-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    productId: product.id,
    productName: product.name,
    barcode: product.barcode,
    previousStock,
    quantityChange,
    newStock,
    transactionType,
    invoiceNumber,
    dateTime: new Date().toLocaleString('en-PK', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }),
    userName,
    notes,
  };
  shopData.stockHistory = [entry, ...(shopData.stockHistory || [])].slice(0, 5000);
}

function persistDevices() {
  try {
    const tmpFile = `${DEVICES_DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(registeredDevices, null, 2));
    fs.renameSync(tmpFile, DEVICES_DB_FILE);
  } catch (e) {
    console.error('Error persisting devices_db.json', e);
  }
  if (isSharedKvEnabled) {
    kvSetJson('waqas:devices_db', {
      devices: registeredDevices,
      removed: Array.from(removedDeviceIds),
    }).catch(() => {});
  }
}

let lastKvHydrationAt = 0;
let inFlightKvHydration: Promise<void> | null = null;

async function ensureSharedKvSessionSecret(): Promise<void> {
  if (!isSharedKvEnabled || getExplicitEnvSessionSecret()) return;
  if (sharedKvSessionSecret) return;

  const existing = await kvGetResult<string>('waqas:session_secret');
  if (existing.ok && existing.found && typeof existing.value === 'string' && existing.value.length >= 32) {
    sharedKvSessionSecret = existing.value;
    return;
  }
  if (existing.ok && !existing.found) {
    const generated = crypto.randomBytes(32).toString('hex');
    await kvSetNxJson('waqas:session_secret', generated);
    const confirmed = await kvGetResult<string>('waqas:session_secret');
    if (confirmed.ok && confirmed.found && typeof confirmed.value === 'string' && confirmed.value.length >= 32) {
      sharedKvSessionSecret = confirmed.value;
    } else {
      sharedKvSessionSecret = generated;
    }
  }
}

async function hydrateSharedKvIfConfigured(force = false): Promise<void> {
  if (!isSharedKvEnabled) return;
  const now = Date.now();
  if (!force && now - lastKvHydrationAt < 1500) return;
  if (inFlightKvHydration) {
    await inFlightKvHydration;
    if (!force) return;
  }

  inFlightKvHydration = (async () => {
    lastKvHydrationAt = Date.now();
    try {
      await ensureSharedKvSessionSecret();
      const [kvAuthRes, kvSubsRes, kvDevsRes] = await Promise.all([
        kvGetResult<AuthDb>('waqas:auth_db'),
        kvGetResult<SubscriptionsData>('waqas:subscriptions_db'),
        kvGetResult<{ devices?: DeviceInfo[]; removed?: string[] }>('waqas:devices_db'),
      ]);

      if (kvAuthRes.ok && kvAuthRes.found && kvAuthRes.value) {
        authDb = normalizeLoadedAuthDb(kvAuthRes.value);
      } else if (kvAuthRes.ok && !kvAuthRes.found) {
        await kvSetJson('waqas:auth_db', authDb);
      }

      if (kvSubsRes.ok && kvSubsRes.found && kvSubsRes.value && Array.isArray(kvSubsRes.value.shops)) {
        subscriptionsDb = kvSubsRes.value;
      } else if (kvSubsRes.ok && !kvSubsRes.found) {
        await kvSetJson('waqas:subscriptions_db', subscriptionsDb);
      }

      if (kvDevsRes.ok && kvDevsRes.found && kvDevsRes.value && Array.isArray(kvDevsRes.value.devices)) {
        registeredDevices = kvDevsRes.value.devices;
        removedDeviceIds.clear();
        for (const rId of kvDevsRes.value.removed || []) removedDeviceIds.add(rId);
      } else if (kvDevsRes.ok && !kvDevsRes.found) {
        await kvSetJson('waqas:devices_db', {
          devices: registeredDevices,
          removed: Array.from(removedDeviceIds),
        });
      }
    } catch {}
  })();

  try {
    await inFlightKvHydration;
  } finally {
    inFlightKvHydration = null;
  }
}

async function ensureShopStoreHydratedFromKv(shopId: string): Promise<StoreData> {
  if (isSharedKvEnabled) {
    const kvStore = await kvGetJson<StoreData>(`waqas:shop:${shopId}`);
    if (kvStore) {
      const shopMeta = subscriptionsDb.shops.find((s) => s.id === shopId);
      const fallbackName =
        shopId === SUPER_ADMIN_POS_SHOP_ID ? 'MY POS APP' : shopMeta?.shopName || 'WAQAS MART';
      const normalized = normalizeStoreData(kvStore, fallbackName);
      setCachedShopStore(shopId, normalized);
      return normalized;
    }
  }
  return getShopStore(shopId);
}

function pruneOldSafetyBackups(maxToKeep = 10) {
  try {
    const backupsDir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(backupsDir)) return;
    const dirs = fs
      .readdirSync(backupsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('safety_'))
      .map((d) => {
        const full = path.join(backupsDir, d.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {}
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of dirs.slice(maxToKeep)) {
      try {
        fs.rmSync(stale.full, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

interface SseClient {
  id: string;
  res: Response;
  deviceId: string;
  shopId: string;
  role: UserRole;
  canViewCostAndProfit: boolean;
  ip: string;
  connectedAt: number;
}
const sseClients = new Map<string, SseClient>();

function sanitizeSseEventForClient(event: SyncEvent, client: SseClient): SyncEvent {
  if (client.role !== 'STAFF' || client.canViewCostAndProfit) {
    return event;
  }
  const p = event.payload;
  if (!p) return event;

  if (event.type === 'store:sync' && typeof p === 'object') {
    return {
      ...event,
      payload: sanitizeStoreForClient(p as StoreData, 'STAFF', { ...DEFAULT_STAFF_PERMISSIONS, canViewCostAndProfit: false }),
    };
  }
  if (Array.isArray(p) && event.type === 'stock:updated') {
    return {
      ...event,
      payload: p.map((item: any) => ({ ...item, costPrice: 0 })),
    };
  }
  if (typeof p === 'object' && Array.isArray(p.updatedProducts)) {
    return {
      ...event,
      payload: {
        ...p,
        updatedProducts: p.updatedProducts.map((item: any) => ({ ...item, costPrice: 0 })),
      },
    };
  }
  return event;
}

function broadcastSyncEventToShop(shopId: string, event: SyncEvent) {
  const targetShopId = shopId || 'SHOP-WM-001';
  sseClients.forEach((client) => {
    if (client.shopId !== targetShopId) return;
    if (client.res.writableEnded || client.res.destroyed || client.res.writableLength > 512 * 1024) {
      try {
        client.res.end();
      } catch {}
      sseClients.delete(client.id);
      return;
    }
    try {
      const safeEvent = sanitizeSseEventForClient(event, client);
      client.res.write(`data: ${JSON.stringify(safeEvent)}\n\n`);
    } catch {
      sseClients.delete(client.id);
    }
  });
}

function disconnectShopClients(
  shopId: string,
  eventType: 'device:revoked' | 'auth:shop_restricted' = 'device:revoked',
  message?: string
) {
  for (const [cid, client] of sseClients.entries()) {
    if (client.shopId === shopId) {
      try {
        client.res.write(
          `data: ${JSON.stringify({
            type: eventType,
            timestamp: Date.now(),
            payload: { shopId, message },
          })}\n\n`
        );
        client.res.end();
      } catch {}
      sseClients.delete(cid);
    }
  }
}

export function closeAllSseClients() {
  sseClients.forEach((client) => {
    try {
      if (!client.res.writableEnded && !client.res.destroyed) {
        client.res.end();
      }
    } catch {}
  });
  sseClients.clear();
}

let activeCctvGateway: CctvGatewayManager | null = null;
export function shutdownCctvGateway() {
  if (activeCctvGateway) {
    try {
      activeCctvGateway.shutdownAll();
    } catch {}
    activeCctvGateway = null;
  }
}

let maintenanceStarted = false;
let maintenanceCleanupTimer: NodeJS.Timeout | null = null;
let maintenancePingTimer: NodeJS.Timeout | null = null;

export function stopBackgroundMaintenanceTimers() {
  maintenanceStarted = false;
  if (maintenanceCleanupTimer) {
    clearInterval(maintenanceCleanupTimer);
    maintenanceCleanupTimer = null;
  }
  if (maintenancePingTimer) {
    clearInterval(maintenancePingTimer);
    maintenancePingTimer = null;
  }
}

export function startBackgroundMaintenanceTimers() {
  if (maintenanceStarted || isServerlessRuntime) return;
  maintenanceStarted = true;

  maintenanceCleanupTimer = setInterval(() => {
    const now = Date.now();
    let pairingChanged = false;
    for (const [token, session] of pairingSessions.entries()) {
      if (session.expiresAt <= now) {
        session.status = 'expired';
        pairingSessions.delete(token);
        pairingChanged = true;
      }
    }
    if (pairingChanged) persistPairingSessions();

    let authDirty = false;
    for (const [k, otp] of Object.entries(authDb.pendingOtps || {})) {
      if (otp.expiresAt <= now) {
        delete authDb.pendingOtps[k];
        authDirty = true;
      }
    }
    for (const [tok, sess] of Object.entries(authDb.sessions || {})) {
      if (!sess || sess.expiresAt <= now || sess.policyVersion !== AUTH_POLICY_VERSION) {
        delete authDb.sessions[tok];
        authDirty = true;
      }
    }
    if (authDb.revokedTokens) {
      for (const [jti, exp] of Object.entries(authDb.revokedTokens)) {
        if (typeof exp === 'number' && exp <= now) {
          delete authDb.revokedTokens[jti];
          authDirty = true;
        }
      }
    }
    if (authDb.failedAttempts) {
      for (const [key, rec] of Object.entries(authDb.failedAttempts)) {
        if (!rec || now - rec.lastAttempt > 24 * 60 * 60 * 1000) {
          delete authDb.failedAttempts[key];
          authDirty = true;
        }
      }
    }
    if (authDirty) persistAuthDb();

    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    if (rssMb > 420) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        event: 'HIGH_MEMORY_RSS',
        rssMb,
        cachedShops: shopStoreCache.size,
        sseClients: sseClients.size,
      }));
      if (shopStoreCache.size > 10) {
        const keep = Math.min(10, shopStoreCache.size);
        while (shopStoreCache.size > keep) {
          const oldest = shopStoreCache.keys().next().value;
          if (!oldest) break;
          shopStoreCache.delete(oldest);
        }
      }
    }
  }, 60 * 1000);
  maintenanceCleanupTimer.unref?.();

  maintenancePingTimer = setInterval(() => {
    const ping = JSON.stringify({
      type: 'ping',
      timestamp: Date.now(),
    });
    sseClients.forEach((client) => {
      if (client.res.writableEnded || client.res.destroyed || client.res.writableLength > 512 * 1024) {
        try {
          client.res.end();
        } catch {}
        sseClients.delete(client.id);
        return;
      }
      try {
        client.res.write(`data: ${ping}\n\n`);
      } catch {
        sseClients.delete(client.id);
      }
    });
  }, 20 * 1000);
  maintenancePingTimer.unref?.();
}

let cachedApp: Application | null = null;

export function getRuntimeInfo() {
  const mem = process.memoryUsage();
  return {
    serverless: isServerlessRuntime,
    storageMode: isSharedKvEnabled ? 'vercel-kv' : resolvedStorage.storageMode,
    sharedAcrossInstances: isSharedKvEnabled || !isServerlessRuntime,
    hasSessionSecret: hasConfiguredSessionSecret(),
    dataDir: DATA_DIR,
    uptimeSec: Math.round(process.uptime()),
    memoryMb: {
      rss: Math.round(mem.rss / (1024 * 1024)),
      heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
    },
  };
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function isSignedTokenShape(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && (parts[0] === 'SA' || parts[0] === 'SO' || parts[0] === 'STF');
}

function extractSessionTokenFromReq(req: Request): string {
  const candidates: string[] = [];
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    candidates.push(authHeader.substring(7).trim());
  }
  const headerTok = req.headers['x-session-token'];
  if (typeof headerTok === 'string') {
    candidates.push(headerTok.trim());
  } else if (Array.isArray(headerTok) && headerTok[0]) {
    candidates.push(String(headerTok[0]).trim());
  }
  if (req.query?.token && typeof req.query.token === 'string') {
    candidates.push(req.query.token.trim());
  }
  if (req.body && typeof req.body === 'object' && req.body.sessionToken) {
    candidates.push(String(req.body.sessionToken).trim());
  }

  for (const raw of candidates) {
    if (raw && raw !== 'null' && raw !== 'undefined') {
      return raw;
    }
  }
  return '';
}

export function createApiApp(): Application {
  if (cachedApp) return cachedApp;

  const app = express();
  app.set('trust proxy', 1);

  // 1. CORS & Preflight Handling (No wildcard '*' on authenticated requests)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-device-id, x-device-token, x-session-token, x-shop-id'
    );
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  // Guard pre-parsed request body (Vercel Node.js runtime sometimes parses req.body before Express)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (
      req.body !== undefined &&
      (req.readableEnded || (req as any)._readableState?.ended || (req as any).complete)
    ) {
      (req as any)._body = true;
    }
    next();
  });

  app.use(express.json({ limit: '25mb' }));

  // Hydrate shared KV state on serverless invocations when configured
  if (isSharedKvEnabled) {
    app.use('/api', async (req: Request, _res: Response, next: NextFunction) => {
      if (req.path === '/health' || req.path === '/ping') return next();
      try {
        await hydrateSharedKvIfConfigured();
        next();
      } catch (err) {
        next(err);
      }
    });
  }

  // Health & ping routes
  app.get('/api/health', asyncHandler(async (_req: Request, res: Response) => {
    if (isSharedKvEnabled && !sharedKvSessionSecret) {
      await ensureSharedKvSessionSecret();
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
      status: 'healthy',
      app: 'WAQAS POS SOFTWARE',
      version: APP_VERSION,
      buildId: APP_BUILD_ID,
      buildDate: APP_BUILD_DATE,
      serverTime: new Date().toISOString(),
      devicesConnected: registeredDevices.length,
      runtime: getRuntimeInfo(),
    });
  }));

  app.get('/api/ping', (_req: Request, res: Response) => {
    res.json({ pong: true, time: Date.now(), serverless: isServerlessRuntime });
  });

  app.get(['/download', '/download-app', '/api/download', '/waqas-mart-pos.zip'], (_req: Request, res: Response) => {
    return res.status(404).json({
      success: false,
      error: 'ZIP_DOWNLOAD_REMOVED',
      message: 'Offline ZIP package download has been removed in this version.',
    });
  });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api') && !req.path.includes('/events') && !req.path.includes('/ping')) {
      console.log(`[API] ${req.method} ${req.path}`);
    }
    next();
  });

  // -------------------------------------------------------------
  // 1. CENTRALIZED AUTHENTICATION (SUPER ADMIN, SHOP OWNER, STAFF)
  // -------------------------------------------------------------
  function getSessionFromToken(token: string): AuthSessionData | null {
    if (!token) return null;

    const storedSession = authDb.sessions[token];
    if (storedSession) {
      if (storedSession.expiresAt <= Date.now() || storedSession.policyVersion !== AUTH_POLICY_VERSION) {
        delete authDb.sessions[token];
        persistAuthDb();
        return null;
      }
      return storedSession;
    }

    // Fallback: verify HMAC-signed stateless token (for multi-instance Vercel serverless compatibility)
    const verified = verifySignedSessionToken(token);
    if (verified) {
      return verified;
    }
    return null;
  }

  function getSessionFromReq(req: Request): AuthSessionData | null {
    return getSessionFromToken(extractSessionTokenFromReq(req));
  }

  async function getSessionFromReqAsync(req: Request): Promise<{
    session: AuthSessionData | null;
    token: string;
    ephemeralContainerMismatch: boolean;
  }> {
    const token = extractSessionTokenFromReq(req);
    if (!token) {
      return { session: null, token: '', ephemeralContainerMismatch: false };
    }

    let session = getSessionFromToken(token);
    if (!session && isSharedKvEnabled) {
      await hydrateSharedKvIfConfigured(true);
      session = getSessionFromToken(token);
    }

    const ephemeralContainerMismatch = Boolean(
      !session &&
        isSignedTokenShape(token) &&
        isServerlessRuntime &&
        !hasConfiguredSessionSecret() &&
        !isSharedKvEnabled
    );

    return { session, token, ephemeralContainerMismatch };
  }

  function resolveShopExpiryMs(shop: ShopAccount): number | null {
    if (shop.isLifetime || shop.plan === 'lifetime' || shop.expiryDate === 'LIFETIME') {
      return null;
    }
    if (shop.expiryAt) {
      const ts = Date.parse(shop.expiryAt);
      if (!Number.isNaN(ts)) return ts;
    }
    if (shop.expiryDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(shop.expiryDate)) {
        const ts = Date.parse(`${shop.expiryDate}T23:59:59.999Z`);
        if (!Number.isNaN(ts)) return ts;
      }
      const ts = Date.parse(shop.expiryDate);
      if (!Number.isNaN(ts)) return ts;
    }
    return null;
  }

  function recordSubscriptionLifecycle(event: Omit<SubscriptionLifecycleEvent, 'id' | 'timestamp'>) {
    subscriptionsDb.subscriptionHistory = subscriptionsDb.subscriptionHistory || [];
    subscriptionsDb.subscriptionHistory.unshift({
      id: `SUBHIST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      ...event,
    });
    if (subscriptionsDb.subscriptionHistory.length > 2000) {
      subscriptionsDb.subscriptionHistory = subscriptionsDb.subscriptionHistory.slice(0, 2000);
    }
  }

  function checkAndAutoExpireSubscriptions() {
    const nowMs = Date.now();
    let updated = false;
    let authRevokedUpdated = false;

    subscriptionsDb.shops.forEach((shop) => {
      if (shop.status === 'blocked' || shop.status === 'suspended' || shop.status === 'inactive') {
        return;
      }
      if (shop.isLifetime || shop.plan === 'lifetime' || shop.expiryDate === 'LIFETIME') {
        if (!shop.isLifetime || shop.expiryDate !== 'LIFETIME' || shop.expiryAt !== null) {
          shop.isLifetime = true;
          shop.expiryDate = 'LIFETIME';
          shop.expiryAt = null;
          updated = true;
        }
        if (shop.status === 'expired' || shop.status === 'expiring_soon') {
          shop.status = 'active';
          updated = true;
        }
        return;
      }

      const expMs = resolveShopExpiryMs(shop);
      if (expMs === null) return;

      if (nowMs >= expMs) {
        if (shop.status !== 'expired') {
          shop.status = 'expired';
          updated = true;
          const expLabel = shop.expiryAt ? new Date(expMs).toISOString() : shop.expiryDate;
          recordSubscriptionLifecycle({
            shopId: shop.id,
            shopName: shop.shopName,
            eventType: 'EXPIRED',
            plan: shop.plan,
            expiryAt: shop.expiryAt || new Date(expMs).toISOString(),
            notes: `Automatically locked on expiry (${expLabel}). All POS business data preserved safely.`,
            actor: 'system',
          });
          recordAuditLog(
            'SUBSCRIPTION_EXPIRED',
            'system',
            'SUPER_ADMIN',
            `Shop ${shop.shopName} (${shop.id}) expired at ${expLabel}`,
            shop.id
          );
          // Immediately terminate active sessions & SSE streams for expired account without deleting any shop data
          for (const token of Object.keys(authDb.sessions)) {
            if (authDb.sessions[token].shopId === shop.id) {
              revokeTokenInDb(token, authDb.sessions[token].expiresAt);
              delete authDb.sessions[token];
              authRevokedUpdated = true;
            }
          }
          authDb.revokedBefore = authDb.revokedBefore || {};
          authDb.revokedBefore[`shop:${shop.id}`] = nowMs;
          authRevokedUpdated = true;
          disconnectShopClients(
            shop.id,
            'auth:shop_restricted',
            `Subscription expired at ${new Date(expMs).toLocaleString('en-PK')}. Contact Master Admin (03228570782) to renew.`
          );
        }
      } else {
        const remainingMs = expMs - nowMs;
        const soonThresholdMs =
          shop.plan === 'hourly'
            ? 60 * 60 * 1000
            : shop.plan === '1_day'
            ? 6 * 60 * 60 * 1000
            : shop.plan === '7_days'
            ? 2 * 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
        if (remainingMs <= soonThresholdMs && shop.status === 'active') {
          shop.status = 'expiring_soon';
          updated = true;
        } else if (remainingMs > soonThresholdMs && shop.status === 'expiring_soon') {
          shop.status = 'active';
          updated = true;
        }
      }
    });

    if (updated) {
      persistSubscriptions();
    }
    if (authRevokedUpdated) {
      persistAuthDb();
    }
  }

  checkAndAutoExpireSubscriptions();

  function sanitizeAuthUser(session: AuthSessionData): AuthUser {
    if (session.role === 'SUPER_ADMIN' && authDb.superAdmin) {
      return {
        id: authDb.superAdmin.id,
        gmail: authDb.superAdmin.gmail,
        email: authDb.superAdmin.gmail,
        mobile: authDb.superAdmin.mobile,
        phone: authDb.superAdmin.mobile,
        fullName: authDb.superAdmin.fullName,
        role: 'SUPER_ADMIN',
        verifiedGmail: authDb.superAdmin.verifiedGmail,
        verifiedMobile: authDb.superAdmin.verifiedMobile,
        createdAt: authDb.superAdmin.createdAt,
      };
    }
    const shopMeta = session.shopId ? subscriptionsDb.shops.find((s) => s.id === session.shopId) : undefined;
    if (session.role === 'STAFF' && session.shopId && session.staffId) {
      const store = getShopStore(session.shopId);
      const staff = (store.staffList || []).find((s) => s.id === session.staffId);
      return {
        id: session.userId,
        username: staff?.username || session.username,
        fullName: staff?.name || session.fullName || 'Staff Member',
        phone: staff?.phone,
        role: 'STAFF',
        shopId: session.shopId,
        shopName: shopMeta?.shopName,
        staffId: session.staffId,
        permissions: normalizeStaffPermissions(staff?.permissions || session.permissions),
        createdAt: staff?.createdAt || new Date().toISOString(),
      };
    }
    const owner = authDb.users.find((u) => u.id === session.userId);
    return {
      id: owner?.id || session.userId,
      email: owner?.email || session.email,
      username: owner?.username || session.username,
      fullName: owner?.fullName || shopMeta?.ownerName || 'Shop Owner',
      phone: owner?.phone || shopMeta?.phone,
      whatsapp: owner?.whatsapp || shopMeta?.whatsapp,
      role: session.role,
      shopId: session.shopId,
      shopName: shopMeta?.shopName,
      mustChangePasswordOnFirstLogin: owner?.mustChangePasswordOnFirstLogin,
      createdAt: owner?.createdAt || new Date().toISOString(),
    };
  }

  interface ResolvedActor {
    ok: boolean;
    statusCode: number;
    error?: string;
    message?: string;
    role: UserRole;
    shopId: string;
    actorEmail: string;
    staffId?: string;
    permissions?: StaffModulePermissions;
    device?: DeviceInfo;
    session?: AuthSessionData;
  }

  async function resolveShopActorAsync(req: Request): Promise<ResolvedActor> {
    checkAndAutoExpireSubscriptions();
    const { session, ephemeralContainerMismatch } = await getSessionFromReqAsync(req);
    const deviceId =
      (req.headers['x-device-id'] as string) ||
      (req.query.deviceId as string) ||
      (req.body?.sourceDeviceId as string) ||
      '';
    const deviceToken =
      (req.headers['x-device-token'] as string) ||
      (req.query.deviceToken as string) ||
      '';

    if (deviceId) {
      let devCheck = verifyDeviceAccess(deviceId, deviceToken || undefined);
      if (
        !devCheck.allowed &&
        isSharedKvEnabled &&
        (devCheck.error === 'DEVICE_UNKNOWN' || devCheck.error === 'INVALID_DEVICE_TOKEN')
      ) {
        await hydrateSharedKvIfConfigured(true);
        devCheck = verifyDeviceAccess(deviceId, deviceToken || undefined);
      }
      if (!devCheck.allowed) {
        const isSuperAdminSession = session?.role === 'SUPER_ADMIN';
        const isStaleTokenWithActiveSession =
          Boolean(session) &&
          (devCheck.error === 'DEVICE_UNKNOWN' || devCheck.error === 'INVALID_DEVICE_TOKEN');
        if (!isSuperAdminSession && !isStaleTokenWithActiveSession) {
          return {
            ok: false,
            statusCode: devCheck.statusCode,
            error: devCheck.error,
            message: devCheck.message,
            role: 'STAFF',
            shopId: '',
            actorEmail: deviceId,
          };
        }
      }
    }

    if (session) {
      if (session.role === 'SUPER_ADMIN') {
        if (!authDb.superAdmin) {
          return {
            ok: false,
            statusCode: 401,
            error: 'SUPER_ADMIN_NOT_CONFIGURED',
            message: 'Super Admin session is invalid.',
            role: 'SUPER_ADMIN',
            shopId: '',
            actorEmail: 'unknown',
          };
        }
        const requestedShopId =
          (req.query.shopId as string) ||
          (req.headers['x-shop-id'] as string) ||
          (req.body?.shopId as string) ||
          SUPER_ADMIN_POS_SHOP_ID;
        return {
          ok: true,
          statusCode: 200,
          role: 'SUPER_ADMIN',
          shopId: requestedShopId,
          actorEmail: authDb.superAdmin.gmail,
          session,
        };
      }

      checkAndAutoExpireSubscriptions();
      const shopId = session.shopId || '';
      let shop = subscriptionsDb.shops.find((s) => s.id === shopId);
      if (!shop && isSharedKvEnabled) {
        await hydrateSharedKvIfConfigured(true);
        checkAndAutoExpireSubscriptions();
        shop = subscriptionsDb.shops.find((s) => s.id === shopId);
      }
      if (!shop) {
        return {
          ok: false,
          statusCode: 403,
          error: 'SHOP_NOT_FOUND',
          message: 'Shop account no longer exists.',
          role: session.role,
          shopId,
          actorEmail: session.username || session.email || session.userId,
        };
      }

      if (shop.status === 'inactive' || shop.status === 'suspended' || shop.status === 'blocked' || shop.status === 'expired') {
        return {
          ok: false,
          statusCode: 403,
          error: 'SHOP_ACCOUNT_RESTRICTED',
          message:
            shop.status === 'expired'
              ? `Subscription Expired for "${shop.shopName}". Contact Master Admin (03228570782) to renew.`
              : `Shop "${shop.shopName}" is ${shop.status.toUpperCase()}. Contact Muhammad Waqas (03228570782).`,
          role: session.role,
          shopId,
          actorEmail: session.username || session.email || session.userId,
        };
      }

      const explicitShop = (req.query.shopId as string) || (req.headers['x-shop-id'] as string);
      if (explicitShop && explicitShop !== shopId) {
        return {
          ok: false,
          statusCode: 403,
          error: 'CROSS_SHOP_ACCESS_DENIED',
          message: 'Access to another shop database is prohibited.',
          role: session.role,
          shopId,
          actorEmail: session.username || session.email || session.userId,
        };
      }

      let livePermissions = session.permissions;
      if (session.role === 'STAFF' && session.staffId) {
        const shopStore = await ensureShopStoreHydratedFromKv(shopId);
        const staff = (shopStore.staffList || []).find((st) => st.id === session.staffId);
        if (!staff || staff.accountStatus !== 'active') {
          return {
            ok: false,
            statusCode: 403,
            error: 'STAFF_ACCOUNT_RESTRICTED',
            message: 'Staff account is inactive or suspended.',
            role: 'STAFF',
            shopId,
            actorEmail: session.username || session.userId,
          };
        }
        livePermissions = normalizeStaffPermissions(staff.permissions);
      }

      const dev = deviceId ? registeredDevices.find((d) => d.deviceId === deviceId) : undefined;
      return {
        ok: true,
        statusCode: 200,
        role: session.role,
        shopId,
        actorEmail: session.username || session.email || session.userId,
        staffId: session.staffId,
        permissions: livePermissions,
        device: dev,
        session,
      };
    }

    if (deviceId && deviceToken) {
      let dev = registeredDevices.find((d) => d.deviceId === deviceId && d.sessionToken === deviceToken);
      if (!dev && isSharedKvEnabled) {
        await hydrateSharedKvIfConfigured(true);
        dev = registeredDevices.find((d) => d.deviceId === deviceId && d.sessionToken === deviceToken);
      }
      if (dev && dev.status === 'active') {
        checkAndAutoExpireSubscriptions();
        const shopId = dev.shopId || 'SHOP-WM-001';
        const shop = subscriptionsDb.shops.find((s) => s.id === shopId);
        if (shop && (shop.status === 'inactive' || shop.status === 'suspended' || shop.status === 'blocked' || shop.status === 'expired')) {
          return {
            ok: false,
            statusCode: 403,
            error: 'SHOP_ACCOUNT_RESTRICTED',
            message:
              shop.status === 'expired'
                ? `Subscription Expired for "${shop.shopName}". Terminal access locked.`
                : `Shop "${shop.shopName}" is ${shop.status.toUpperCase()}. Terminal access locked.`,
            role: 'SHOP_OWNER',
            shopId,
            actorEmail: dev.deviceId,
          };
        }
        const explicitShop = (req.query.shopId as string) || (req.headers['x-shop-id'] as string);
        if (explicitShop && explicitShop !== shopId) {
          return {
            ok: false,
            statusCode: 403,
            error: 'CROSS_SHOP_ACCESS_DENIED',
            message: 'Terminal cannot access another shop database.',
            role: 'SHOP_OWNER',
            shopId,
            actorEmail: dev.deviceId,
          };
        }
        return {
          ok: true,
          statusCode: 200,
          role: 'SHOP_OWNER',
          shopId,
          actorEmail: dev.deviceId,
          device: dev,
        };
      }
    }

    if (ephemeralContainerMismatch) {
      console.warn('[Auth] Session token rejected on serverless instance without shared SESSION_SECRET or KV store.');
      return {
        ok: false,
        statusCode: 401,
        error: 'SERVERLESS_SESSION_SECRET_MISSING',
        message:
          'Session verification failed across Vercel serverless instances because SESSION_SECRET (or Vercel KV) is not configured in Vercel Environment Variables. Add SESSION_SECRET in Vercel Project Settings and redeploy.',
        role: 'STAFF',
        shopId: '',
        actorEmail: 'anonymous',
      };
    }

    return {
      ok: false,
      statusCode: 401,
      error: 'AUTH_REQUIRED',
      message: 'Authentication required. Please log in with your Super Admin, Shop Owner, or Staff credentials.',
      role: 'STAFF',
      shopId: '',
      actorEmail: 'anonymous',
    };
  }

  function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
    getSessionFromReqAsync(req)
      .then(({ session, ephemeralContainerMismatch }) => {
        if (!session) {
          if (ephemeralContainerMismatch) {
            console.warn('[Auth] Super Admin session rejected on serverless instance without shared SESSION_SECRET or KV store.');
            return res.status(401).json({
              success: false,
              error: 'SERVERLESS_SESSION_SECRET_MISSING',
              message:
                'Super Admin session failed across Vercel serverless instances because SESSION_SECRET (or Vercel KV) is not configured in Vercel Environment Variables. Add SESSION_SECRET in Vercel Project Settings and redeploy.',
            });
          }
          return res.status(401).json({ success: false, error: 'AUTH_REQUIRED', message: 'Super Admin authentication required.' });
        }
        if (session.role !== 'SUPER_ADMIN' || !authDb.superAdmin) {
          return res.status(403).json({ success: false, error: 'SUPER_ADMIN_ONLY', message: 'Access restricted to Primary Super Admin.' });
        }
        (req as any).superAdminSession = session;
        next();
      })
      .catch(next);
  }

  function checkRateLimit(key: string): { blocked: boolean; retrySeconds?: number } {
    const rec = authDb.failedAttempts[key];
    if (!rec) return { blocked: false };
    const elapsed = Date.now() - rec.lastAttempt;
    if (elapsed > 15 * 60 * 1000) {
      delete authDb.failedAttempts[key];
      return { blocked: false };
    }
    if (rec.count >= 10) {
      return { blocked: true, retrySeconds: Math.ceil((15 * 60 * 1000 - elapsed) / 1000) };
    }
    return { blocked: false };
  }

  function recordFailedAttempt(key: string) {
    const prev = authDb.failedAttempts[key];
    const withinWindow = prev && Date.now() - prev.lastAttempt < 15 * 60 * 1000;
    authDb.failedAttempts[key] = {
      count: withinWindow ? prev.count + 1 : 1,
      lastAttempt: Date.now(),
    };
    persistAuthDb();
  }

  function clearFailedAttempt(key: string) {
    if (authDb.failedAttempts[key]) {
      delete authDb.failedAttempts[key];
      persistAuthDb();
    }
  }

  app.get('/api/auth/bootstrap-status', (_req: Request, res: Response) => {
    return res.json({
      success: true,
      superAdminConfigured: true,
      superAdminSetupLocked: true,
      registrationDisabled: true,
      googleOAuthEnabled: false,
    });
  });

  app.post('/api/auth/google/verify-id-token', (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'GOOGLE_OAUTH_DISABLED',
      message: 'Google OAuth sign-in is disabled. Use the fixed Super Admin Gmail and password.',
    });
  });

  app.get('/api/auth/google/url', (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'GOOGLE_OAUTH_DISABLED',
      message: 'Google OAuth sign-in is disabled. Use the fixed Super Admin Gmail and password.',
    });
  });

  app.get(['/api/auth/google/callback', '/api/auth/google/callback/'], (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'GOOGLE_OAUTH_DISABLED',
      message: 'Google OAuth callback is disabled.',
    });
  });

  app.post('/api/auth/super-admin/validate-provision-token', (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'SUPER_ADMIN_REGISTRATION_DISABLED',
      message: 'Super Admin registration and provisioning are permanently disabled.',
    });
  });

  app.post('/api/auth/super-admin/provision', (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'SUPER_ADMIN_REGISTRATION_DISABLED',
      message: 'Super Admin registration and provisioning are permanently disabled.',
    });
  });

  app.post('/api/auth/super-admin/send-setup-otp', (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'PUBLIC_REGISTRATION_DISABLED',
      message: 'Public Super Admin registration is permanently disabled.',
    });
  });

  app.post('/api/auth/super-admin/complete-setup', (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'PUBLIC_REGISTRATION_DISABLED',
      message: 'Public Super Admin registration is permanently disabled.',
    });
  });

  app.post('/api/auth/super-admin/recover/request', (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'OTP_RECOVERY_DISABLED',
      message: 'OTP recovery is disabled.',
    });
  });

  app.post('/api/auth/super-admin/recover/verify', (_req: Request, res: Response) => {
    return res.status(403).json({
      success: false,
      error: 'OTP_RECOVERY_DISABLED',
      message: 'OTP recovery is disabled.',
    });
  });

  // Fixed Super Admin Login
  app.post('/api/auth/super-admin/login', asyncHandler(async (req: Request, res: Response) => {
    let sa = authDb.superAdmin;
    if (!sa) {
      return res.status(500).json({
        success: false,
        error: 'SUPER_ADMIN_NOT_CONFIGURED',
        message: 'Super Admin account is unavailable on the server.',
      });
    }

    const rateKey = `super_admin:${req.ip || 'local'}`;
    const limitCheck = checkRateLimit(rateKey);
    if (limitCheck.blocked) {
      return res.status(429).json({
        success: false,
        error: 'TOO_MANY_ATTEMPTS',
        message: `Too many failed login attempts. Try again in ${limitCheck.retrySeconds} seconds.`,
      });
    }

    const { gmail, email, password } = req.body || {};
    const cleanGmail = String(gmail || email || '').trim().toLowerCase();
    const cleanPassword = String(password || '').trim();

    if (!cleanGmail || !cleanPassword) {
      return res.status(400).json({
        success: false,
        error: 'CREDENTIALS_REQUIRED',
        message: 'Super Admin Gmail and Password are required.',
      });
    }

    if (cleanGmail !== FIXED_SUPER_ADMIN_EMAIL || cleanGmail !== sa.gmail.trim().toLowerCase()) {
      recordFailedAttempt(rateKey);
      recordAuditLog(
        'SUPER_ADMIN_WRONG_GMAIL',
        cleanGmail,
        'SUPER_ADMIN',
        `Rejected unauthorized Gmail "${cleanGmail}" at Super Admin login`,
        undefined,
        req.ip
      );
      return res.status(403).json({
        success: false,
        error: 'UNAUTHORIZED_GMAIL',
        message: 'Access denied. Only the registered Super Admin Gmail is authorized.',
      });
    }

    let passwordMatches = verifyPasswordRecord(cleanPassword, sa.passwordSalt, sa.passwordHash);
    if (!passwordMatches && isSharedKvEnabled) {
      await hydrateSharedKvIfConfigured(true);
      sa = authDb.superAdmin;
      if (sa) {
        passwordMatches = verifyPasswordRecord(cleanPassword, sa.passwordSalt, sa.passwordHash);
      }
    }

    if (!passwordMatches || !sa) {
      recordFailedAttempt(rateKey);
      recordAuditLog(
        'SUPER_ADMIN_LOGIN_FAILED',
        sa?.gmail || cleanGmail,
        'SUPER_ADMIN',
        `Invalid Super Admin password attempt from ${req.ip || 'unknown'}`,
        undefined,
        req.ip
      );
      return res.status(401).json({
        success: false,
        error: 'INVALID_SUPER_ADMIN_PASSWORD',
        message: 'Incorrect Super Admin password.',
      });
    }

    if (isSharedKvEnabled && !sharedKvSessionSecret) {
      await ensureSharedKvSessionSecret();
    }

    clearFailedAttempt(rateKey);
    sa.lastLoginAt = new Date().toISOString();

    const now = Date.now();
    const baseSess = {
      userId: sa.id,
      email: sa.gmail,
      gmail: sa.gmail,
      fullName: sa.fullName,
      role: 'SUPER_ADMIN' as UserRole,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      ip: req.ip,
      policyVersion: AUTH_POLICY_VERSION,
    };
    const token = createSignedSessionToken('SA', baseSess);
    const sess: AuthSessionData = { ...baseSess, token };
    authDb.sessions[token] = sess;
    persistAuthDb();

    recordAuditLog(
      'SUPER_ADMIN_LOGIN_SUCCESS',
      sa.gmail,
      'SUPER_ADMIN',
      'Super Admin authenticated via fixed Gmail + password credentials',
      undefined,
      req.ip
    );

    return res.json({
      success: true,
      token,
      expiresAt: new Date(sess.expiresAt).toISOString(),
      policyVersion: AUTH_POLICY_VERSION,
      user: sanitizeAuthUser(sess),
    });
  }));

  // Mart Login Endpoint
  app.post('/api/auth/login', asyncHandler(async (req: Request, res: Response) => {
    checkAndAutoExpireSubscriptions();
    const { portal = 'shop', identifier, password } = req.body || {};
    const cleanIdent = String(identifier || '').trim();
    const cleanPassword = String(password || '').trim();

    if (portal === 'super_admin') {
      return res.status(400).json({
        success: false,
        error: 'USE_SUPER_ADMIN_LOGIN',
        message: 'Super Admin must sign in through the Super Admin Login portal using authorized Gmail and Password.',
      });
    }

    if (!cleanIdent || !cleanPassword) {
      return res.status(400).json({
        success: false,
        error: 'CREDENTIALS_REQUIRED',
        message: 'Shop ID / Shop Username and Shop Password are required.',
      });
    }

    const rateKey = `${portal}:${cleanIdent.toLowerCase()}`;
    const limitCheck = checkRateLimit(rateKey);
    if (limitCheck.blocked) {
      return res.status(429).json({
        success: false,
        error: 'TOO_MANY_ATTEMPTS',
        message: `Too many failed attempts. Try again in ${limitCheck.retrySeconds} seconds.`,
      });
    }

    const lowerIdent = cleanIdent.toLowerCase();
    const normPhoneIdent = normalizeMobile(cleanIdent);

    const findOwnerAndShop = () => {
      const foundOwner = authDb.users.find(
        (u) =>
          u.role === 'SHOP_OWNER' &&
          (u.shopId?.trim().toLowerCase() === lowerIdent ||
            u.username?.trim().toLowerCase() === lowerIdent ||
            u.email?.trim().toLowerCase() === lowerIdent ||
            (normPhoneIdent && normalizeMobile(u.phone || '') === normPhoneIdent))
      );
      const foundShop = subscriptionsDb.shops.find(
        (s) =>
          s.id.trim().toLowerCase() === lowerIdent ||
          (s.ownerUsername && s.ownerUsername.trim().toLowerCase() === lowerIdent) ||
          (s.email && s.email.trim().toLowerCase() === lowerIdent)
      );
      return { foundOwner, foundShop };
    };

    let { foundOwner: ownerUser, foundShop: matchedShop } = findOwnerAndShop();
    if (!ownerUser && !matchedShop && isSharedKvEnabled) {
      await hydrateSharedKvIfConfigured(true);
      ({ foundOwner: ownerUser, foundShop: matchedShop } = findOwnerAndShop());
    }

    if (!ownerUser && matchedShop) {
      ownerUser = authDb.users.find((u) => u.role === 'SHOP_OWNER' && u.shopId === matchedShop.id);
      if (!ownerUser) {
        recordFailedAttempt(rateKey);
        return res.status(403).json({
          success: false,
          error: 'OWNER_LOGIN_NOT_CONFIGURED',
          shopId: matchedShop.id,
          shopName: matchedShop.shopName,
          message: `Mart "${matchedShop.shopName}" (${matchedShop.id}) does not have an owner password set yet. Ask Super Admin to open Mart Accounts and set/reset the owner password.`,
        });
      }
    }

    if (ownerUser) {
      let shop = subscriptionsDb.shops.find((s) => s.id === ownerUser!.shopId);
      if (!shop) {
        return res.status(404).json({
          success: false,
          error: 'SHOP_NOT_FOUND',
          message: 'Associated mart account was not found in database.',
        });
      }

      let ownerPasswordOk = verifyPassword(cleanPassword, ownerUser);
      if (!ownerPasswordOk && isSharedKvEnabled) {
        await hydrateSharedKvIfConfigured(true);
        const refreshed = findOwnerAndShop();
        if (refreshed.foundOwner) {
          ownerUser = refreshed.foundOwner;
          shop = subscriptionsDb.shops.find((s) => s.id === ownerUser!.shopId) || shop;
          ownerPasswordOk = verifyPassword(cleanPassword, ownerUser);
        }
      }

      if (!ownerPasswordOk) {
        recordFailedAttempt(rateKey);
        recordAuditLog(
          'SHOP_LOGIN_FAILED',
          cleanIdent,
          'SHOP_OWNER',
          `Invalid password for Shop Owner "${cleanIdent}" (${shop.id})`,
          shop.id,
          req.ip
        );
        return res.status(401).json({
          success: false,
          error: 'INVALID_PASSWORD',
          message: 'Incorrect Shop Password. Please check your password and try again.',
        });
      }

      checkAndAutoExpireSubscriptions();
      shop = subscriptionsDb.shops.find((s) => s.id === shop!.id) || shop;
      if (shop.status === 'inactive' || shop.status === 'suspended' || shop.status === 'blocked' || shop.status === 'expired') {
        return res.status(403).json({
          success: false,
          error: 'SHOP_ACCOUNT_RESTRICTED',
          status: shop.status,
          shopName: shop.shopName,
          plan: shop.plan,
          expiryDate: shop.expiryDate,
          expiryAt: shop.expiryAt || null,
          whatsapp: '03228570782',
          message:
            shop.status === 'expired'
              ? `Subscription Expired for "${shop.shopName}". Contact Super Admin (03228570782) to renew.`
              : `This mart account ("${shop.shopName}") is currently ${shop.status.toUpperCase()}. Contact Super Admin (03228570782) to restore access.`,
        });
      }

      if (isSharedKvEnabled && !sharedKvSessionSecret) {
        await ensureSharedKvSessionSecret();
      }

      clearFailedAttempt(rateKey);
      const now = Date.now();
      const baseSess = {
        userId: ownerUser.id,
        email: ownerUser.email,
        username: ownerUser.username,
        fullName: ownerUser.fullName,
        role: 'SHOP_OWNER' as UserRole,
        shopId: shop.id,
        createdAt: now,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000,
        ip: req.ip,
        policyVersion: AUTH_POLICY_VERSION,
      };
      const token = createSignedSessionToken('SO', baseSess);
      const sess: AuthSessionData = { ...baseSess, token };
      authDb.sessions[token] = sess;
      persistAuthDb();

      recordAuditLog(
        'SHOP_OWNER_LOGIN',
        ownerUser.username || ownerUser.email || ownerUser.id,
        'SHOP_OWNER',
        `Shop Owner signed into ${shop.shopName} (${shop.id})`,
        shop.id,
        req.ip
      );

      return res.json({
        success: true,
        token,
        expiresAt: new Date(sess.expiresAt).toISOString(),
        policyVersion: AUTH_POLICY_VERSION,
        user: sanitizeAuthUser(sess),
        shop: { ...shop, ownerUsername: ownerUser.username || shop.ownerUsername },
      });
    }

    for (const shop of subscriptionsDb.shops) {
      const shopStore = await ensureShopStoreHydratedFromKv(shop.id);
      const staff = (shopStore.staffList || []).find(
        (st) =>
          st.username &&
          st.username.trim().toLowerCase() === lowerIdent &&
          (st as any).passwordHash &&
          (st as any).passwordSalt
      ) as (StaffMember & { passwordSalt?: string }) | undefined;

      if (staff) {
        if (!verifyPasswordRecord(cleanPassword, staff.passwordSalt || '', staff.passwordHash || '')) {
          recordFailedAttempt(rateKey);
          return res.status(401).json({
            success: false,
            error: 'INVALID_PASSWORD',
            message: 'Incorrect Staff Password. Please verify your password and try again.',
          });
        }
        if (staff.accountStatus !== 'active') {
          return res.status(403).json({
            success: false,
            error: 'STAFF_ACCOUNT_RESTRICTED',
            message: `Staff account "${staff.name}" is ${staff.accountStatus}. Contact your Shop Owner.`,
          });
        }
        checkAndAutoExpireSubscriptions();
        if (shop.status === 'inactive' || shop.status === 'suspended' || shop.status === 'blocked' || shop.status === 'expired') {
          return res.status(403).json({
            success: false,
            error: 'SHOP_ACCOUNT_RESTRICTED',
            status: shop.status,
            shopName: shop.shopName,
            plan: shop.plan,
            expiryDate: shop.expiryDate,
            expiryAt: shop.expiryAt || null,
            whatsapp: '03228570782',
            message:
              shop.status === 'expired'
                ? `Subscription Expired for "${shop.shopName}". Contact Super Admin (03228570782) to renew.`
                : `This mart account ("${shop.shopName}") is currently ${shop.status.toUpperCase()}. Contact Super Admin (03228570782).`,
          });
        }

        if (isSharedKvEnabled && !sharedKvSessionSecret) {
          await ensureSharedKvSessionSecret();
        }

        clearFailedAttempt(rateKey);
        const now = Date.now();
        const perms = normalizeStaffPermissions(staff.permissions);
        const baseSess = {
          userId: staff.id,
          username: staff.username,
          fullName: staff.name,
          role: 'STAFF' as UserRole,
          shopId: shop.id,
          staffId: staff.id,
          permissions: perms,
          createdAt: now,
          expiresAt: now + 14 * 24 * 60 * 60 * 1000,
          ip: req.ip,
          policyVersion: AUTH_POLICY_VERSION,
        };
        const token = createSignedSessionToken('STF', baseSess);
        const sess: AuthSessionData = { ...baseSess, token };
        authDb.sessions[token] = sess;
        persistAuthDb();

        recordAuditLog(
          'STAFF_LOGIN',
          staff.username,
          'STAFF',
          `Staff "${staff.name}" (${staff.role}) signed into ${shop.shopName}`,
          shop.id,
          req.ip
        );

        return res.json({
          success: true,
          token,
          expiresAt: new Date(sess.expiresAt).toISOString(),
          policyVersion: AUTH_POLICY_VERSION,
          user: sanitizeAuthUser(sess),
          shop,
        });
      }
    }

    recordFailedAttempt(rateKey);
    return res.status(401).json({
      success: false,
      error: 'ACCOUNT_NOT_FOUND',
      message: 'No Mart or Staff account found matching that Shop ID or Shop Username.',
    });
  }));

  app.get('/api/auth/me', asyncHandler(async (req: Request, res: Response) => {
    const { session, ephemeralContainerMismatch } = await getSessionFromReqAsync(req);
    if (!session) {
      if (ephemeralContainerMismatch) {
        return res.status(401).json({
          success: false,
          error: 'SERVERLESS_SESSION_SECRET_MISSING',
          message:
            'Session could not be verified across Vercel serverless instances because SESSION_SECRET (or Vercel KV) is missing.',
        });
      }
      return res.status(401).json({ success: false, error: 'SESSION_INVALID', message: 'Not authenticated.' });
    }
    if (session.role === 'SUPER_ADMIN') {
      if (!authDb.superAdmin) {
        return res.status(401).json({ success: false, message: 'Super Admin not configured.' });
      }
      return res.json({
        success: true,
        policyVersion: AUTH_POLICY_VERSION,
        user: sanitizeAuthUser(session),
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
    }

    checkAndAutoExpireSubscriptions();
    let shop = subscriptionsDb.shops.find((s) => s.id === session.shopId);
    if (!shop && isSharedKvEnabled) {
      await hydrateSharedKvIfConfigured(true);
      shop = subscriptionsDb.shops.find((s) => s.id === session.shopId);
    }
    if (!shop || shop.status === 'inactive' || shop.status === 'suspended' || shop.status === 'blocked' || shop.status === 'expired') {
      return res.status(403).json({
        success: false,
        error: 'SHOP_ACCOUNT_RESTRICTED',
        status: shop?.status || 'inactive',
        shopName: shop?.shopName,
        plan: shop?.plan,
        expiryDate: shop?.expiryDate,
        expiryAt: shop?.expiryAt || null,
        whatsapp: '03228570782',
        message: shop
          ? shop.status === 'expired'
            ? `Subscription Expired for "${shop.shopName}". Contact Super Admin (03228570782) to renew.`
            : `Shop "${shop.shopName}" is ${shop.status.toUpperCase()}. Contact Super Admin (03228570782).`
          : 'Shop account removed.',
      });
    }

    if (session.role === 'STAFF' && session.staffId) {
      const store = await ensureShopStoreHydratedFromKv(shop.id);
      const staff = (store.staffList || []).find((st) => st.id === session.staffId);
      if (!staff || staff.accountStatus !== 'active') {
        return res.status(403).json({ success: false, error: 'STAFF_ACCOUNT_RESTRICTED', message: 'Staff account is inactive.' });
      }
    }

    return res.json({
      success: true,
      policyVersion: AUTH_POLICY_VERSION,
      user: sanitizeAuthUser(session),
      shop,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }));

  app.post('/api/auth/logout', asyncHandler(async (req: Request, res: Response) => {
    const token = extractSessionTokenFromReq(req);
    if (token) {
      if (isSharedKvEnabled) {
        await hydrateSharedKvIfConfigured(true);
      }
      if (authDb.sessions[token]) {
        delete authDb.sessions[token];
      }
      const verified = verifySignedSessionToken(token);
      if (verified?.jti) {
        authDb.revokedTokens = authDb.revokedTokens || {};
        authDb.revokedTokens[verified.jti] = verified.expiresAt;
      }
      persistAuthDb();
    }
    return res.json({ success: true, message: 'Signed out cleanly.' });
  }));

  app.post('/api/auth/change-password', asyncHandler(async (req: Request, res: Response) => {
    const { session } = await getSessionFromReqAsync(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    const { currentPassword, newPassword } = req.body || {};
    const cleanCurr = String(currentPassword || '').trim();
    const cleanNew = String(newPassword || '').trim();
    if (!cleanCurr || !cleanNew || cleanNew.length < 6) {
      return res.status(400).json({ success: false, message: 'Current password and new password (min 6 chars) are required.' });
    }

    if (session.role === 'SUPER_ADMIN' && authDb.superAdmin) {
      if (cleanNew.length < 8) {
        return res.status(400).json({ success: false, message: 'Super Admin password must be at least 8 characters.' });
      }
      if (!verifyPasswordRecord(cleanCurr, authDb.superAdmin.passwordSalt, authDb.superAdmin.passwordHash)) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      authDb.superAdmin.passwordSalt = salt;
      authDb.superAdmin.passwordHash = hashPassword(cleanNew, salt);
      persistAuthDb();
      recordAuditLog('SUPER_ADMIN_PASSWORD_CHANGED', authDb.superAdmin.gmail, 'SUPER_ADMIN', 'Super Admin changed password.', undefined, req.ip);
      return res.json({ success: true, message: 'Super Admin password updated.' });
    }

    const user = authDb.users.find((u) => u.id === session.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }
    if (!verifyPassword(cleanCurr, user)) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    user.passwordSalt = salt;
    user.passwordHash = hashPassword(cleanNew, salt);
    user.mustChangePasswordOnFirstLogin = false;
    persistAuthDb();

    recordAuditLog('PASSWORD_CHANGED', user.username || user.email || user.id, session.role, 'Account password updated.', user.shopId, req.ip);
    return res.json({ success: true, message: 'Password updated successfully.' });
  }));

  // -------------------------------------------------------------
  // 2. DEVICE PAIRING & QR CODE MANAGEMENT (PER-SHOP SCOPED)
  // -------------------------------------------------------------
  app.post('/api/devices/pairing-session', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const pairingToken = crypto.randomBytes(16).toString('hex');
    const manualCode = `WM-${Math.floor(1000 + Math.random() * 9000)}`;
    const createdAt = Date.now();
    const expiresAt = createdAt + 5 * 60 * 1000;

    const session: PairingSession = {
      pairingToken,
      manualCode,
      shopId: actor.shopId,
      createdAt,
      expiresAt,
      status: 'pending_scan',
    };

    await savePairingSessionShared(session);

    return res.json({
      success: true,
      pairingToken,
      manualCode,
      shopId: actor.shopId,
      expiresAt,
      storeName: shopStore.branding.storeName || 'WAQAS MART',
      subtitle: shopStore.branding.subtitle || 'Supermarket Management',
    });
  }));

  app.get('/api/devices/pairing-status/:token', async (req: Request, res: Response) => {
    const { token } = req.params;
    const session = await findPairingSessionShared(token);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'PAIRING_SESSION_NOT_FOUND',
        message: 'Pairing session not found or expired.',
      });
    }

    if (Date.now() > session.expiresAt && session.status !== 'approved') {
      session.status = 'expired';
      await savePairingSessionShared(session);
      return res.json({ success: true, session });
    }

    let authPayload = null;
    if (session.status === 'approved' && session.approvedDeviceId) {
      const targetShopId = session.shopId || 'SHOP-WM-001';
      let approvedDev = registeredDevices.find((d) => d.deviceId === session.approvedDeviceId);
      if (!approvedDev && isSharedKvEnabled) {
        await hydrateSharedKvIfConfigured(true);
        approvedDev = registeredDevices.find((d) => d.deviceId === session.approvedDeviceId);
      }
      const shopStore = await ensureShopStoreHydratedFromKv(targetShopId);
      const shop = subscriptionsDb.shops.find((s) => s.id === targetShopId);
      authPayload = {
        sessionToken: approvedDev?.sessionToken,
        device: approvedDev,
        shopId: targetShopId,
        shop,
        user: shopStore.userProfile,
        storeState: sanitizeStoreForClient(shopStore, 'SHOP_OWNER'),
      };
    }

    return res.json({
      success: true,
      session,
      auth: authPayload,
    });
  });

  app.post('/api/devices/pair', async (req: Request, res: Response) => {
    const { tokenOrCode, device } = req.body || {};
    const cleanTokenOrCode = typeof tokenOrCode === 'string' ? tokenOrCode.trim() : '';
    if (!cleanTokenOrCode || !device?.deviceId) {
      return res.status(400).json({ success: false, message: 'Invalid pairing request payload.' });
    }

    const session = await findPairingSessionShared(cleanTokenOrCode);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Invalid or expired QR code.' });
    }
    if (Date.now() > session.expiresAt) {
      session.status = 'expired';
      await savePairingSessionShared(session);
      return res.status(410).json({ success: false, message: 'This QR pairing code has expired.' });
    }
    if (session.status === 'rejected') {
      return res.status(403).json({ success: false, message: 'Pairing was rejected by the shop owner.' });
    }
    if (session.status === 'approved' || session.status === 'cancelled' || session.status === 'expired') {
      return res.status(409).json({
        success: false,
        error: 'PAIRING_CODE_ALREADY_USED',
        message: 'This QR pairing code has already been used or closed. Generate a new QR code from the owner device.',
      });
    }
    if (
      session.status === 'pending_approval' &&
      session.candidateDevice?.deviceId &&
      session.candidateDevice.deviceId !== device.deviceId
    ) {
      return res.status(409).json({
        success: false,
        error: 'PAIRING_SESSION_LOCKED',
        message: 'This QR code is already pending approval for another device.',
      });
    }

    session.candidateDevice = {
      deviceId: device.deviceId,
      deviceName: device.deviceName || 'New Terminal',
      deviceType: device.deviceType || 'Android Mobile',
      browser: device.browser || 'Browser',
      os: device.os || 'OS',
    };
    session.status = 'pending_approval';
    await savePairingSessionShared(session);

    const targetShopId = session.shopId || 'SHOP-WM-001';
    recordAuditLog(
      'DEVICE_PAIR_REQUEST',
      device.deviceId,
      'STAFF',
      `Device pairing requested by "${session.candidateDevice.deviceName}" (${session.candidateDevice.deviceType})`,
      targetShopId,
      req.ip
    );

    broadcastSyncEventToShop(targetShopId, {
      type: 'device:pairing_request',
      timestamp: Date.now(),
      payload: {
        pairingToken: session.pairingToken,
        candidateDevice: session.candidateDevice,
      },
    });

    return res.json({
      success: true,
      message: 'Pairing request submitted. Waiting for shop owner approval.',
      session,
    });
  });

  app.post('/api/devices/approve-pairing', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }

    const { pairingToken, approve } = req.body || {};
    const session = pairingToken ? await findPairingSessionShared(String(pairingToken)) : undefined;
    if (!session) {
      return res.status(404).json({ success: false, message: 'Pairing session not found.' });
    }

    const sessionShopId = session.shopId || 'SHOP-WM-001';
    if (actor.role !== 'SUPER_ADMIN' && actor.shopId !== sessionShopId) {
      return res.status(403).json({ success: false, message: 'Cannot approve pairing session belonging to another shop.' });
    }
    if (session.status === 'approved') {
      return res.status(409).json({ success: false, message: 'This pairing code has already been approved and consumed.' });
    }

    if (!approve) {
      session.status = 'rejected';
      await savePairingSessionShared(session);
      recordAuditLog(
        'DEVICE_PAIR_REJECTED',
        actor.actorEmail,
        actor.role,
        `Rejected pairing request for ${session.candidateDevice?.deviceName || session.pairingToken}`,
        sessionShopId,
        req.ip
      );
      broadcastSyncEventToShop(sessionShopId, {
        type: 'device:updated',
        timestamp: Date.now(),
        payload: { pairingToken, status: 'rejected' },
      });
      return res.json({ success: true, message: 'Device pairing rejected.' });
    }

    if (!session.candidateDevice) {
      return res.status(400).json({ success: false, message: 'No candidate device scanned this code.' });
    }

    const sessionToken = `ST-${crypto.randomBytes(16).toString('hex')}`;
    const newDev: DeviceInfo = {
      deviceId: session.candidateDevice.deviceId,
      sessionToken,
      shopId: sessionShopId,
      deviceName: session.candidateDevice.deviceName,
      deviceType: session.candidateDevice.deviceType,
      browser: session.candidateDevice.browser,
      os: session.candidateDevice.os,
      isCurrentDevice: false,
      firstRegistered: new Date().toLocaleDateString('en-GB'),
      lastActive: new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
      status: 'active',
      connectionState: 'online',
      ipAddress: req.ip,
    };

    removedDeviceIds.delete(newDev.deviceId);
    registeredDevices = registeredDevices.filter((d) => d.deviceId !== newDev.deviceId);
    registeredDevices.push(newDev);
    persistDevices();

    session.status = 'approved';
    session.approvedDeviceId = newDev.deviceId;
    await savePairingSessionShared(session);

    recordAuditLog(
      'DEVICE_PAIR_APPROVED',
      actor.actorEmail,
      actor.role,
      `Approved device "${newDev.deviceName}" (${newDev.deviceId})`,
      sessionShopId,
      req.ip
    );

    const shopDevices = registeredDevices.filter((d) => d.shopId === sessionShopId).map((d) => ({ ...d, sessionToken: undefined }));
    broadcastSyncEventToShop(sessionShopId, {
      type: 'device:approved',
      timestamp: Date.now(),
      payload: { pairingToken, device: { ...newDev, sessionToken: undefined } },
    });
    broadcastSyncEventToShop(sessionShopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: shopDevices,
    });

    return res.json({
      success: true,
      message: 'Device successfully authorized!',
      device: newDev,
    });
  }));

  app.post('/api/devices/register-primary', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }

    const dev = req.body?.device;
    if (!dev?.deviceId) {
      return res.status(400).json({ success: false, message: 'Device ID is required.' });
    }
    if (removedDeviceIds.has(dev.deviceId)) {
      return res.status(403).json({
        success: false,
        error: 'DEVICE_REMOVED',
        message: 'This device was removed by administrator. Re-pair via QR code.',
      });
    }

    const existing = registeredDevices.find((d) => d.deviceId === dev.deviceId);
    if (existing) {
      if (existing.status === 'revoked') {
        return res.status(403).json({
          success: false,
          error: 'DEVICE_REVOKED',
          message: 'This device is revoked.',
        });
      }
      if (!existing.sessionToken) {
        existing.sessionToken = `ST-${crypto.randomBytes(16).toString('hex')}`;
      }
      existing.shopId = actor.shopId;
      existing.lastActive = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
      existing.connectionState = 'online';
      persistDevices();
      return res.json({ success: true, device: existing, sessionToken: existing.sessionToken });
    }

    const sessionToken = `ST-${crypto.randomBytes(16).toString('hex')}`;
    const primaryDev: DeviceInfo = {
      deviceId: dev.deviceId,
      sessionToken,
      shopId: actor.shopId,
      deviceName: dev.deviceName || 'Primary Terminal',
      deviceType: dev.deviceType || 'Web Browser',
      browser: dev.browser || 'Browser',
      os: dev.os || 'OS',
      isCurrentDevice: false,
      firstRegistered: new Date().toLocaleDateString('en-GB'),
      lastActive: new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
      status: 'active',
      connectionState: 'online',
      ipAddress: req.ip,
    };
    registeredDevices.push(primaryDev);
    persistDevices();
    recordAuditLog(
      'PRIMARY_DEVICE_REGISTERED',
      actor.actorEmail,
      actor.role,
      `Registered terminal "${primaryDev.deviceName}" (${primaryDev.deviceId})`,
      actor.shopId,
      req.ip
    );
    broadcastSyncEventToShop(actor.shopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: registeredDevices.filter((d) => d.shopId === actor.shopId).map((d) => ({ ...d, sessionToken: undefined })),
    });
    return res.json({ success: true, device: primaryDev, sessionToken });
  }));

  app.post('/api/devices/cancel-pairing', asyncHandler(async (req: Request, res: Response) => {
    const { pairingToken } = req.body || {};
    if (pairingToken) {
      const s = await findPairingSessionShared(String(pairingToken));
      if (s) {
        s.status = 'cancelled';
        await deletePairingSessionShared(s);
      }
    }
    return res.json({ success: true, message: 'Pairing cancelled.' });
  }));

  // -------------------------------------------------------------
  // 3. DEVICE MANAGEMENT ENDPOINTS (SHOP-SCOPED OR SUPER ADMIN)
  // -------------------------------------------------------------
  app.get('/api/devices', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const visible = registeredDevices.filter((d) => (d.shopId || 'SHOP-WM-001') === actor.shopId);

    const list = visible.map((d) => {
      const hasLiveSse = Array.from(sseClients.values()).some((c) => c.deviceId === d.deviceId);
      const sId = d.shopId || 'SHOP-WM-001';
      const shop = subscriptionsDb.shops.find((s) => s.id === sId);
      return {
        ...d,
        shopName: sId === SUPER_ADMIN_POS_SHOP_ID ? 'SUPER ADMIN · MY POS APP' : shop?.shopName || 'WAQAS MART',
        sessionToken: undefined,
        connectionState: hasLiveSse ? ('online' as const) : ('offline' as const),
      };
    });
    return res.json({ success: true, devices: list });
  }));

  app.post('/api/devices/:id/rename', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const { id } = req.params;
    const { name } = req.body || {};
    const target = registeredDevices.find((d) => d.deviceId === id);
    if (!target) {
      return res.status(404).json({ success: false, message: 'Device not found.' });
    }
    if (actor.role !== 'SUPER_ADMIN' && (target.shopId || 'SHOP-WM-001') !== actor.shopId) {
      return res.status(403).json({ success: false, message: 'Cannot rename device belonging to another shop.' });
    }
    target.deviceName = name || target.deviceName;
    persistDevices();
    const targetShopId = target.shopId || 'SHOP-WM-001';
    recordAuditLog('DEVICE_RENAMED', actor.actorEmail, actor.role, `Renamed device ${id} to "${target.deviceName}"`, targetShopId, req.ip);

    broadcastSyncEventToShop(targetShopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: registeredDevices.filter((d) => d.shopId === targetShopId).map((d) => ({ ...d, sessionToken: undefined })),
    });

    return res.json({ success: true, device: { ...target, sessionToken: undefined } });
  }));

  app.post('/api/devices/:id/revoke', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const { id } = req.params;
    const target = registeredDevices.find((d) => d.deviceId === id);
    if (!target) {
      return res.status(404).json({ success: false, message: 'Device not found.' });
    }
    if (actor.role !== 'SUPER_ADMIN' && (target.shopId || 'SHOP-WM-001') !== actor.shopId) {
      return res.status(403).json({ success: false, message: 'Cannot revoke device belonging to another shop.' });
    }

    target.status = 'revoked';
    target.connectionState = 'offline';
    persistDevices();

    const targetShopId = target.shopId || 'SHOP-WM-001';
    recordAuditLog('DEVICE_REVOKED', actor.actorEmail, actor.role, `Revoked access for device "${target.deviceName}" (${id})`, targetShopId, req.ip);

    broadcastSyncEventToShop(targetShopId, {
      type: 'device:revoked',
      sourceDeviceId: id,
      timestamp: Date.now(),
      payload: { deviceId: id },
    });

    for (const [cid, client] of sseClients.entries()) {
      if (client.deviceId === id) {
        try { client.res.end(); } catch {}
        sseClients.delete(cid);
      }
    }

    broadcastSyncEventToShop(targetShopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: registeredDevices.filter((d) => d.shopId === targetShopId).map((d) => ({ ...d, sessionToken: undefined })),
    });

    return res.json({ success: true, message: 'Device access revoked successfully.' });
  }));

  app.post('/api/devices/:id/restore', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const { id } = req.params;
    const target = registeredDevices.find((d) => d.deviceId === id);
    if (!target) {
      return res.status(404).json({ success: false, message: 'Device not found.' });
    }
    if (actor.role !== 'SUPER_ADMIN' && (target.shopId || 'SHOP-WM-001') !== actor.shopId) {
      return res.status(403).json({ success: false, message: 'Cannot restore device belonging to another shop.' });
    }
    target.status = 'active';
    removedDeviceIds.delete(id);
    persistDevices();
    const targetShopId = target.shopId || 'SHOP-WM-001';
    recordAuditLog('DEVICE_RESTORED', actor.actorEmail, actor.role, `Restored access for device "${target.deviceName}" (${id})`, targetShopId, req.ip);
    broadcastSyncEventToShop(targetShopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: registeredDevices.filter((d) => d.shopId === targetShopId).map((d) => ({ ...d, sessionToken: undefined })),
    });
    return res.json({ success: true, message: 'Device access restored.', device: { ...target, sessionToken: undefined } });
  }));

  app.get('/api/devices/check-status', asyncHandler(async (req: Request, res: Response) => {
    const deviceId =
      (req.headers['x-device-id'] as string) ||
      (req.query.deviceId as string) ||
      '';
    const deviceToken =
      (req.headers['x-device-token'] as string) ||
      (req.query.deviceToken as string) ||
      '';

    if (!deviceId || !deviceToken) {
      return res.status(401).json({
        success: false,
        allowed: false,
        error: 'AUTH_REQUIRED',
        message: 'Device credentials missing. Please scan a new QR code.',
      });
    }

    let devCheck = verifyDeviceAccess(deviceId, deviceToken);
    if (
      !devCheck.allowed &&
      isSharedKvEnabled &&
      (devCheck.error === 'DEVICE_UNKNOWN' || devCheck.error === 'INVALID_DEVICE_TOKEN')
    ) {
      await hydrateSharedKvIfConfigured(true);
      devCheck = verifyDeviceAccess(deviceId, deviceToken);
    }
    if (!devCheck.allowed || !devCheck.device) {
      return res.status(devCheck.statusCode || 403).json({
        success: false,
        allowed: false,
        error: devCheck.error || 'DEVICE_REVOKED',
        message: devCheck.message || 'Device access is still restricted.',
      });
    }

    checkAndAutoExpireSubscriptions();
    const shopId = devCheck.device.shopId || 'SHOP-WM-001';
    const shop = subscriptionsDb.shops.find((s) => s.id === shopId);
    if (shop && (shop.status === 'inactive' || shop.status === 'suspended' || shop.status === 'blocked' || shop.status === 'expired')) {
      return res.status(403).json({
        success: false,
        allowed: false,
        error: 'SHOP_ACCOUNT_RESTRICTED',
        status: shop.status,
        shopName: shop.shopName,
        expiryDate: shop.expiryDate,
        expiryAt: shop.expiryAt || null,
        message:
          shop.status === 'expired'
            ? `Subscription Expired for "${shop.shopName}". Terminal access locked.`
            : `Shop "${shop.shopName}" is ${shop.status.toUpperCase()}. Terminal access locked.`,
      });
    }

    return res.json({
      success: true,
      allowed: true,
      device: { ...devCheck.device, sessionToken: undefined },
    });
  }));

  app.delete('/api/devices/:id', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const { id } = req.params;
    const target = registeredDevices.find((d) => d.deviceId === id);
    if (!target) {
      return res.status(404).json({ success: false, message: 'Device not found.' });
    }
    if (actor.role !== 'SUPER_ADMIN' && (target.shopId || 'SHOP-WM-001') !== actor.shopId) {
      return res.status(403).json({ success: false, message: 'Cannot remove device belonging to another shop.' });
    }

    const targetShopId = target.shopId || 'SHOP-WM-001';
    registeredDevices = registeredDevices.filter((d) => d.deviceId !== id);
    removedDeviceIds.add(id);
    persistDevices();

    recordAuditLog('DEVICE_REMOVED', actor.actorEmail, actor.role, `Permanently removed device "${target.deviceName}" (${id})`, targetShopId, req.ip);

    broadcastSyncEventToShop(targetShopId, {
      type: 'device:revoked',
      timestamp: Date.now(),
      payload: { deviceId: id },
    });

    for (const [cid, client] of sseClients.entries()) {
      if (client.deviceId === id) {
        try { client.res.end(); } catch {}
        sseClients.delete(cid);
      }
    }

    broadcastSyncEventToShop(targetShopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: registeredDevices.filter((d) => d.shopId === targetShopId).map((d) => ({ ...d, sessionToken: undefined })),
    });

    return res.json({ success: true, message: 'Device removed.' });
  }));

  // -------------------------------------------------------------
  // 4. REAL-TIME SERVER-SENT EVENTS (SSE) STREAM (PER-SHOP SCOPED)
  // -------------------------------------------------------------
  app.get('/api/sync/events', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const deviceId = (req.query.deviceId as string) || (req.headers['x-device-id'] as string) || 'UNKNOWN-DEV';
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    if (actor.device) {
      actor.device.lastActive = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
      actor.device.connectionState = 'online';
    }

    // On Vercel Serverless Functions, close gracefully after sending initial ping
    // so client switches cleanly to adaptive polling instead of hitting 504 timeout.
    if (isServerlessRuntime) {
      res.write('retry: 10000\n');
      res.write(
        `data: ${JSON.stringify({
          type: 'ping',
          mode: 'serverless',
          timestamp: Date.now(),
          shopId: actor.shopId,
          syncVersion: shopStore.syncVersion || 1,
          message: 'Connected to WAQAS POS Serverless Sync',
        })}\n\n`
      );
      return res.end();
    }

    try {
      req.socket?.setKeepAlive?.(true, 30000);
      req.socket?.setTimeout?.(0);
    } catch {}

    // Close excess stale SSE connections for the same device so reconnect loops never leak sockets
    if (deviceId && deviceId !== 'UNKNOWN-DEV') {
      const sameDeviceClients = Array.from(sseClients.values())
        .filter((c) => c.shopId === actor.shopId && c.deviceId === deviceId)
        .sort((a, b) => a.connectedAt - b.connectedAt);
      while (sameDeviceClients.length >= 2) {
        const oldest = sameDeviceClients.shift();
        if (oldest) {
          sseClients.delete(oldest.id);
          try {
            oldest.res.end();
          } catch {}
        }
      }
    }

    const clientId = `CLIENT-${crypto.randomBytes(8).toString('hex')}`;
    const client: SseClient = {
      id: clientId,
      res,
      deviceId,
      shopId: actor.shopId,
      role: actor.role,
      canViewCostAndProfit: actor.role !== 'STAFF' || Boolean(actor.permissions?.canViewCostAndProfit),
      ip: req.ip || '',
      connectedAt: Date.now(),
    };

    sseClients.set(clientId, client);

    res.write(
      `data: ${JSON.stringify({
        type: 'ping',
        timestamp: Date.now(),
        shopId: actor.shopId,
        syncVersion: shopStore.syncVersion || 1,
        message: 'Connected to WAQAS POS Live Sync Engine',
      })}\n\n`
    );

    const shopDevices = registeredDevices.filter((d) => d.shopId === actor.shopId).map((d) => ({ ...d, sessionToken: undefined }));
    broadcastSyncEventToShop(actor.shopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: shopDevices,
    });

    let cleanedUp = false;
    const cleanupSseClient = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (!sseClients.delete(clientId)) return;
      const remaining = registeredDevices.filter((d) => d.shopId === actor.shopId).map((d) => ({ ...d, sessionToken: undefined }));
      broadcastSyncEventToShop(actor.shopId, {
        type: 'device:updated',
        timestamp: Date.now(),
        payload: remaining,
      });
    };

    req.on('close', cleanupSseClient);
    res.on('close', cleanupSseClient);
    res.on('error', cleanupSseClient);
  }));

  // -------------------------------------------------------------
  // 5. AUTHORITATIVE PER-SHOP STORE STATE & ATOMIC MUTATIONS
  // -------------------------------------------------------------
  app.get('/api/store/state', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const safeStore = sanitizeStoreForClient(shopStore, actor.role, actor.permissions);
    return res.json({
      success: true,
      shopId: actor.shopId,
      syncVersion: shopStore.syncVersion || 1,
      store: safeStore,
    });
  }));

  function canStaffPerformMutation(action: string, perms?: StaffModulePermissions): boolean {
    if (!perms) return false;
    switch (action) {
      case 'create_sale':
      case 'update_held_bills':
      case 'delete_held_bill':
      case 'delete_all_held_bills':
        return perms.newSale || perms.oldSale;
      case 'process_return':
        return perms.newSale || perms.oldSale || perms.customers;
      case 'create_purchase':
      case 'update_purchase':
      case 'delete_purchase':
      case 'delete_all_purchases':
      case 'sync_purchase_returns':
      case 'create_purchase_return':
        return perms.newPurchase || perms.oldPurchase;
      case 'update_stock':
      case 'reconcile_negative_stock':
      case 'sync_stock_history':
      case 'sync_categories':
        return perms.stock || perms.products;
      case 'update_customer_ledger':
        return perms.customers || perms.canAccessLedgers;
      case 'sync_supplier_ledgers':
        return perms.suppliers || perms.canAccessLedgers;
      case 'sync_expenses':
        return perms.expenses;
      case 'sync_daily_hisab':
        return perms.reports || perms.canAccessReports;
      case 'sync_printer_settings':
      case 'sync_receipt_settings':
        return perms.printing || perms.settings;
      case 'sync_staff':
      case 'update_branding':
        return perms.settings || perms.canAccessSettings;
      case 'sync_full':
        return true;
      case 'reset_all_zero':
      case 'load_seed_catalog':
        return false;
      default:
        return false;
    }
  }

  app.post('/api/store/sync', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({
        success: false,
        error: actor.error,
        message: actor.message,
      });
    }

    const { action, payload, sourceDeviceId, baseSyncVersion } = req.body || {};
    if (actor.role === 'STAFF' && !canStaffPerformMutation(action, actor.permissions)) {
      return res.status(403).json({
        success: false,
        error: 'PERMISSION_DENIED',
        message: `Your staff account does not have permission for "${action}".`,
      });
    }

    if (actor.device) {
      actor.device.lastActive = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
      actor.device.connectionState = 'online';
    }

    const targetShopId = actor.shopId;
    const shopStore = await ensureShopStoreHydratedFromKv(targetShopId);

    switch (action) {
      case 'create_sale': {
        const tx: SaleTransaction = payload;
        if (!tx || !tx.invoiceNumber) {
          return res.status(400).json({ success: false, message: 'Invalid transaction payload.' });
        }

        const exists = shopStore.transactions.some((t) => t.invoiceNumber === tx.invoiceNumber);
        if (!exists) {
          if (tx.mode === 'sale') {
            const stockCheck = validateSaleItemsStock(shopStore.products, tx.items || []);
            if (!stockCheck.ok) {
              return res.status(400).json({
                success: false,
                error: stockCheck.code,
                message: stockCheck.message,
              });
            }
          }

          const enrichedTx: SaleTransaction = {
            ...tx,
            items: (tx.items || []).map((it) => {
              const srvProd = findLiveProduct(shopStore.products, {
                productId: it.product?.id,
                barcode: it.product?.barcode,
              });
              return srvProd ? { ...it, product: { ...it.product, costPrice: srvProd.costPrice } } : it;
            }),
          };

          shopStore.transactions.unshift(enrichedTx);

          if (tx.mode === 'sale') {
            (tx.items || []).forEach((item) => {
              const product = findLiveProduct(shopStore.products, {
                productId: item.product?.id,
                barcode: item.product?.barcode,
              });
              if (product) {
                const reqQty = Number(item.quantity) || 0;
                const prevStock = roundStockQty(Number(product.stock) || 0);
                const nextStock = roundStockQty(prevStock - reqQty);
                product.stock = nextStock;
                recordShopStockTx(
                  shopStore,
                  product,
                  prevStock,
                  -reqQty,
                  nextStock,
                  'Sale',
                  tx.invoiceNumber,
                  tx.cashierName || actor.actorEmail
                );
              }
            });
          }

          if (tx.paymentMethod === 'credit' && (tx.customerId || tx.customerName)) {
            const advancePaid = Number(tx.cashTendered) || 0;
            const unpaidCredit = Math.max(0, (Number(tx.grandTotal) || 0) - advancePaid);
            const alreadyRecorded = shopStore.customerLedgers.some(
              (l) => l.invoiceNumber === tx.invoiceNumber && l.credit > 0
            );
            if (unpaidCredit > 0 && !alreadyRecorded) {
              const entry: CustomerLedgerEntry = {
                id: `LED-SALE-${tx.invoiceNumber}`,
                customerId: tx.customerId || 'CUST-GENERAL',
                date: tx.dateTime,
                details: `Sales Invoice #${tx.invoiceNumber}`,
                invoiceNumber: tx.invoiceNumber,
                credit: unpaidCredit,
                debit: 0,
                runningBalance: 0,
                paymentMethod: 'Credit / Pay Later',
                createdAt: new Date().toISOString(),
              };
              shopStore.customerLedgers.push(entry);
            }
          }

          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'sale:completed',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: {
              transaction: sanitizeStoreForClient(shopStore, actor.role, actor.permissions).transactions[0],
              updatedProducts: shopStore.products,
              customerLedgers: shopStore.customerLedgers,
              stockHistory: shopStore.stockHistory,
              syncVersion: shopStore.syncVersion,
            },
          });
        }

        const safeStore = sanitizeStoreForClient(shopStore, actor.role, actor.permissions);
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: safeStore });
      }

      case 'create_purchase': {
        const purchase: PurchaseTransaction = payload;
        if (!purchase) {
          return res.status(400).json({ success: false, message: 'Invalid purchase payload.' });
        }

        const reconciled = applyPurchaseSaveToState({
          purchase,
          isEdit: false,
          products: shopStore.products,
          suppliers: shopStore.suppliers,
          purchases: shopStore.purchases,
          userName: purchase.userName || actor.actorEmail,
          timestampStr: formatStockAuditTimestamp(),
        });

        if (reconciled.stockError) {
          return res.status(400).json({
            success: false,
            error: reconciled.stockError.code,
            message: reconciled.stockError.message,
          });
        }

        if (!reconciled.duplicateBlocked) {
          shopStore.products = reconciled.products;
          shopStore.suppliers = reconciled.suppliers;
          shopStore.purchases = reconciled.purchases;
          shopStore.stockHistory = [...reconciled.stockEntries, ...(shopStore.stockHistory || [])].slice(0, 5000);

          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'purchase:added',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: {
              purchase,
              updatedProducts: shopStore.products,
              suppliers: shopStore.suppliers,
              stockHistory: shopStore.stockHistory,
              syncVersion: shopStore.syncVersion,
            },
          });
        }

        const safeStore = sanitizeStoreForClient(shopStore, actor.role, actor.permissions);
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: safeStore });
      }

      case 'update_purchase': {
        const purchase: PurchaseTransaction = payload;
        if (!purchase || !purchase.id) {
          return res.status(400).json({ success: false, message: 'Invalid purchase update payload.' });
        }

        const existingPurchase = shopStore.purchases.find(
          (p) => p.id === purchase.id || p.purchaseInvoiceNo === purchase.purchaseInvoiceNo
        );
        if (
          existingPurchase &&
          typeof baseSyncVersion === 'number' &&
          existingPurchase.updatedAt &&
          purchase.updatedAt &&
          existingPurchase.updatedAt > purchase.updatedAt
        ) {
          return res.status(409).json({
            success: false,
            error: 'CONFLICT',
            message: `Purchase #${purchase.purchaseInvoiceNo} was updated more recently on another device.`,
            serverVersion: shopStore.syncVersion,
            store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions),
          });
        }

        const reconciled = applyPurchaseSaveToState({
          purchase,
          isEdit: Boolean(existingPurchase),
          products: shopStore.products,
          suppliers: shopStore.suppliers,
          purchases: shopStore.purchases,
          userName: purchase.editBy || purchase.userName || actor.actorEmail,
          timestampStr: formatStockAuditTimestamp(),
        });

        if (reconciled.stockError) {
          return res.status(400).json({
            success: false,
            error: reconciled.stockError.code,
            message: reconciled.stockError.message,
          });
        }

        if (!reconciled.duplicateBlocked) {
          shopStore.products = reconciled.products;
          shopStore.suppliers = reconciled.suppliers;
          shopStore.purchases = reconciled.purchases;
          shopStore.stockHistory = [...reconciled.stockEntries, ...(shopStore.stockHistory || [])].slice(0, 5000);
        }

        persistShopStore(targetShopId);

        broadcastSyncEventToShop(targetShopId, {
          type: 'purchase:updated',
          sourceDeviceId,
          timestamp: Date.now(),
          payload: {
            purchase,
            updatedProducts: shopStore.products,
            suppliers: shopStore.suppliers,
            stockHistory: shopStore.stockHistory,
            syncVersion: shopStore.syncVersion,
          },
        });

        const safeStore = sanitizeStoreForClient(shopStore, actor.role, actor.permissions);
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: safeStore });
      }

      case 'delete_purchase': {
        const { purchaseId } = payload || {};
        if (!purchaseId) {
          return res.status(400).json({ success: false, message: 'purchaseId is required.' });
        }

        const reversed = applyPurchaseDeleteToState({
          purchaseId,
          products: shopStore.products,
          suppliers: shopStore.suppliers,
          purchases: shopStore.purchases,
          userName: actor.actorEmail,
          timestampStr: formatStockAuditTimestamp(),
        });

        if (reversed.stockError) {
          return res.status(400).json({
            success: false,
            error: reversed.stockError.code,
            message: reversed.stockError.message,
          });
        }

        if (reversed.deletedPurchase) {
          shopStore.products = reversed.products;
          shopStore.suppliers = reversed.suppliers;
          shopStore.purchases = reversed.purchases;
          shopStore.stockHistory = [...reversed.stockEntries, ...(shopStore.stockHistory || [])].slice(0, 5000);
          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'purchase:deleted',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: {
              purchaseId: reversed.deletedPurchase.id,
              updatedProducts: shopStore.products,
              suppliers: shopStore.suppliers,
              stockHistory: shopStore.stockHistory,
              syncVersion: shopStore.syncVersion,
            },
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'process_return': {
        const ret: SaleReturn = payload;
        if (!ret) {
          return res.status(400).json({ success: false, message: 'Invalid return payload.' });
        }

        const exists = shopStore.saleReturns.some((r) => r.returnNumber === ret.returnNumber);
        if (!exists) {
          shopStore.saleReturns.unshift(ret);

          ret.items.forEach((item) => {
            if (item.condition === 'resaleable') {
              const product = shopStore.products.find((p) => p.id === item.productId);
              if (product) {
                const prevStock = Number(product.stock) || 0;
                const nextStock = prevStock + item.quantity;
                product.stock = nextStock;
                recordShopStockTx(
                  shopStore,
                  product,
                  prevStock,
                  item.quantity,
                  nextStock,
                  'Sale Return',
                  ret.returnNumber,
                  ret.cashierName || actor.actorEmail
                );
              }
            }
          });

          if (ret.refundMethod === 'credit' && ret.customerId) {
            const entry: CustomerLedgerEntry = {
              id: `LED-RET-${ret.returnNumber}`,
              customerId: ret.customerId,
              date: ret.dateTime,
              details: `Sale Return #${ret.returnNumber}`,
              invoiceNumber: ret.originalInvoiceNumber,
              credit: 0,
              debit: ret.totalRefund,
              runningBalance: 0,
              paymentMethod: 'Credit Adjustment',
              createdAt: new Date().toISOString(),
            };
            if (!shopStore.customerLedgers.some((l) => l.id === entry.id)) {
              shopStore.customerLedgers.push(entry);
            }
          }

          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'return:processed',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: {
              saleReturn: ret,
              updatedProducts: shopStore.products,
              customerLedgers: shopStore.customerLedgers,
              stockHistory: shopStore.stockHistory,
              syncVersion: shopStore.syncVersion,
            },
          });
        }

        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'create_purchase_return': {
        const ret: PurchaseReturn = payload;
        if (!ret || !ret.returnNumber) {
          return res.status(400).json({ success: false, message: 'Invalid purchase return payload.' });
        }
        shopStore.purchaseReturns = shopStore.purchaseReturns || [];
        const exists = shopStore.purchaseReturns.some((r) => r.returnNumber === ret.returnNumber);
        if (!exists) {
          const stockCheck = validatePurchaseReturnStock(shopStore.products, ret.items || []);
          if (!stockCheck.ok) {
            return res.status(400).json({
              success: false,
              error: stockCheck.code,
              message: stockCheck.message,
            });
          }

          shopStore.purchaseReturns.unshift(ret);
          (ret.items || []).forEach((item) => {
            const product = findLiveProduct(shopStore.products, {
              productId: item.productId,
              barcode: item.barcode,
            });
            if (product) {
              const reqQty = Number(item.quantity) || 0;
              const prevStock = roundStockQty(Number(product.stock) || 0);
              const nextStock = roundStockQty(prevStock - reqQty);
              product.stock = nextStock;
              recordShopStockTx(
                shopStore,
                product,
                prevStock,
                -reqQty,
                nextStock,
                'Purchase Return',
                ret.returnNumber,
                actor.actorEmail
              );
            }
          });
          if (ret.refundType === 'reduce_payable' && ret.supplierId) {
            const supplier = shopStore.suppliers.find((s) => s.id === ret.supplierId);
            if (supplier) {
              supplier.payableBalance = Math.max(0, (Number(supplier.payableBalance) || 0) - ret.totalRefund);
            }
          }
          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'purchase_return:processed',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: {
              purchaseReturn: ret,
              updatedProducts: shopStore.products,
              suppliers: shopStore.suppliers,
              stockHistory: shopStore.stockHistory,
              syncVersion: shopStore.syncVersion,
            },
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_staff': {
        if (Array.isArray(payload)) {
          const existingMap = new Map<string, any>();
          for (const st of shopStore.staffList || []) {
            existingMap.set(st.id, st);
          }

          const updatedStaff: StaffMember[] = payload.map((rawSt: any) => {
            const prev = existingMap.get(rawSt.id);
            let passwordSalt = prev?.passwordSalt;
            let passwordHash = prev?.passwordHash;
            const plainNewPass = typeof rawSt.newPassword === 'string' ? rawSt.newPassword.trim() : '';
            if (plainNewPass.length >= 4) {
              passwordSalt = crypto.randomBytes(16).toString('hex');
              passwordHash = hashPassword(plainNewPass, passwordSalt);
            }
            const cleanStaff: any = {
              ...rawSt,
              permissions: normalizeStaffPermissions(rawSt.permissions),
            };
            delete cleanStaff.newPassword;
            if (passwordSalt) cleanStaff.passwordSalt = passwordSalt;
            if (passwordHash) cleanStaff.passwordHash = passwordHash;
            return cleanStaff;
          });

          shopStore.staffList = updatedStaff;
          persistShopStore(targetShopId);

          const safeStaff = updatedStaff.map((st: any) => ({
            ...st,
            passwordHash: undefined,
            passwordSalt: undefined,
          }));
          broadcastSyncEventToShop(targetShopId, {
            type: 'staff:updated',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: safeStaff,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_expenses': {
        if (Array.isArray(payload)) {
          shopStore.expenses = payload;
          persistShopStore(targetShopId);
          broadcastSyncEventToShop(targetShopId, {
            type: 'expenses:updated',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore.expenses,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_supplier_ledgers': {
        const { suppliers: supList, ledgerEntries } = payload || {};
        if (Array.isArray(supList)) shopStore.suppliers = supList;
        if (Array.isArray(ledgerEntries)) shopStore.supplierLedgers = ledgerEntries;
        persistShopStore(targetShopId);
        broadcastSyncEventToShop(targetShopId, {
          type: 'supplier:ledger_updated',
          sourceDeviceId,
          timestamp: Date.now(),
          payload: {
            suppliers: shopStore.suppliers,
            supplierLedgers: shopStore.supplierLedgers,
          },
        });
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_printer_settings': {
        if (payload) {
          shopStore.printerSettings = payload;
          persistShopStore(targetShopId);
          broadcastSyncEventToShop(targetShopId, {
            type: 'printer:updated',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore.printerSettings,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_receipt_settings': {
        if (payload) {
          shopStore.receiptSettings = payload;
          persistShopStore(targetShopId);
          broadcastSyncEventToShop(targetShopId, {
            type: 'receipt:updated',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore.receiptSettings,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_categories': {
        if (Array.isArray(payload)) {
          shopStore.categories = payload;
          persistShopStore(targetShopId);
          broadcastSyncEventToShop(targetShopId, {
            type: 'categories:updated',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore.categories,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_daily_hisab': {
        if (payload && typeof payload === 'object') {
          if (
            typeof baseSyncVersion === 'number' &&
            baseSyncVersion > 0 &&
            (shopStore.syncVersion || 1) > baseSyncVersion &&
            req.body?.enforceConflictCheck === true
          ) {
            return res.status(409).json({
              success: false,
              error: 'CONFLICT',
              message: 'Daily Hisab was modified by another device while offline.',
              serverVersion: shopStore.syncVersion,
              store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions),
            });
          }
          shopStore.dailyHisab = payload;
          persistShopStore(targetShopId);
          broadcastSyncEventToShop(targetShopId, {
            type: 'daily_hisab:updated',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore.dailyHisab,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_stock_history': {
        if (Array.isArray(payload)) {
          shopStore.stockHistory = payload;
          persistShopStore(targetShopId);
          broadcastSyncEventToShop(targetShopId, {
            type: 'store:sync',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'update_stock': {
        const updatedProducts: Product[] = payload;
        if (Array.isArray(updatedProducts)) {
          if (
            typeof baseSyncVersion === 'number' &&
            baseSyncVersion > 0 &&
            (shopStore.syncVersion || 1) > baseSyncVersion &&
            req.body?.enforceConflictCheck === true
          ) {
            return res.status(409).json({
              success: false,
              error: 'CONFLICT',
              message: 'Product catalog changed on server while offline. Review server state before retrying.',
              serverVersion: shopStore.syncVersion,
              store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions),
            });
          }
          const existingById = new Map(shopStore.products.map((p) => [p.id, p]));
          const seenBarcodes = new Set<string>();
          for (const p of updatedProducts) {
            const prev = existingById.get(p.id);
            const nextStk = roundStockQty(Number(p.stock) || 0);
            if (!prev && nextStk < 0) {
              return res.status(400).json({
                success: false,
                error: 'STOCK_ALREADY_ZERO',
                message: STOCK_ALREADY_ZERO_MESSAGE,
              });
            }
            if (prev) {
              const prevStk = roundStockQty(Number(prev.stock) || 0);
              if (nextStk < 0 && nextStk < prevStk) {
                if (prevStk <= 0) {
                  return res.status(400).json({
                    success: false,
                    error: 'STOCK_ALREADY_ZERO',
                    message: STOCK_ALREADY_ZERO_MESSAGE,
                  });
                }
                return res.status(400).json({
                  success: false,
                  error: 'INSUFFICIENT_STOCK',
                  message: buildInsufficientStockMessage(prevStk),
                });
              }
            }

            const b = (p.barcode || '').trim().toLowerCase();
            if (b) {
              if (seenBarcodes.has(b)) {
                return res.status(400).json({
                  success: false,
                  error: 'DUPLICATE_BARCODE',
                  message: `Duplicate barcode "${p.barcode}" is not allowed on product "${p.name}".`,
                });
              }
              seenBarcodes.add(b);
            }
          }

          if (actor.role === 'STAFF' && !actor.permissions?.canViewCostAndProfit) {
            const costById = new Map(shopStore.products.map((p) => [p.id, p.costPrice]));
            shopStore.products = updatedProducts.map((p) => ({
              ...p,
              costPrice: costById.get(p.id) ?? p.costPrice,
            }));
          } else {
            shopStore.products = updatedProducts;
          }

          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'stock:updated',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore.products,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'update_customer_ledger': {
        const { customers, ledgerEntries } = payload || {};
        if (Array.isArray(customers)) shopStore.customers = customers;
        if (Array.isArray(ledgerEntries)) shopStore.customerLedgers = ledgerEntries;
        persistShopStore(targetShopId);

        broadcastSyncEventToShop(targetShopId, {
          type: 'customer:ledger_updated',
          sourceDeviceId,
          timestamp: Date.now(),
          payload: {
            customers: shopStore.customers,
            customerLedgers: shopStore.customerLedgers,
          },
        });
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'update_branding': {
        const branding: StoreBranding = payload;
        if (branding) {
          shopStore.branding = branding;
          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'store:sync',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'update_held_bills': {
        const heldBills: HeldBill[] = payload;
        if (Array.isArray(heldBills)) {
          shopStore.heldBills = heldBills;
          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'store:sync',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore,
          });
        }
        return res.json({ success: true, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'delete_held_bill': {
        const { billId } = payload || {};
        if (billId) {
          shopStore.heldBills = (shopStore.heldBills || []).filter((b) => b.id !== billId);
          persistShopStore(targetShopId);

          broadcastSyncEventToShop(targetShopId, {
            type: 'store:sync',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore,
          });
        }
        return res.json({ success: true, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_purchase_returns': {
        if (Array.isArray(payload)) {
          shopStore.purchaseReturns = payload;
          persistShopStore(targetShopId);
          broadcastSyncEventToShop(targetShopId, {
            type: 'store:sync',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore,
          });
        }
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'delete_all_purchases': {
        const resDelete = applyPurchaseDeleteAllToState({
          products: shopStore.products,
          suppliers: shopStore.suppliers,
          purchases: shopStore.purchases,
          userName: actor.actorEmail,
          timestampStr: formatStockAuditTimestamp(),
        });
        if (!resDelete.ok || resDelete.stockError) {
          return res.status(400).json({
            success: false,
            error: resDelete.stockError?.code || 'INSUFFICIENT_STOCK',
            message: resDelete.stockError?.message || STOCK_ALREADY_ZERO_MESSAGE,
          });
        }
        shopStore.products = resDelete.products;
        shopStore.suppliers = resDelete.suppliers;
        shopStore.purchases = [];
        if (resDelete.stockEntries.length > 0) {
          shopStore.stockHistory = [...resDelete.stockEntries, ...(shopStore.stockHistory || [])].slice(0, 5000);
        }
        persistShopStore(targetShopId);
        broadcastSyncEventToShop(targetShopId, {
          type: 'store:sync',
          sourceDeviceId,
          timestamp: Date.now(),
          payload: shopStore,
        });
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'reconcile_negative_stock': {
        const rec = reconcileNegativeStockFromHistory({
          products: shopStore.products,
          purchases: shopStore.purchases,
          transactions: shopStore.transactions,
          saleReturns: shopStore.saleReturns,
          purchaseReturns: shopStore.purchaseReturns,
          actor: actor.actorEmail,
          timestampStr: formatStockAuditTimestamp(),
        });
        if (rec.reconciledCount > 0) {
          shopStore.products = rec.products;
          if (rec.stockEntries.length > 0) {
            shopStore.stockHistory = [...rec.stockEntries, ...(shopStore.stockHistory || [])].slice(0, 5000);
          }
          recordAuditLog(
            'NEGATIVE_STOCK_RECONCILED',
            actor.actorEmail,
            actor.role,
            `Reconciled ${rec.reconciledCount} negative stock product(s) to 0.`,
            targetShopId,
            req.ip
          );
          persistShopStore(targetShopId);
          broadcastSyncEventToShop(targetShopId, {
            type: 'store:sync',
            sourceDeviceId,
            timestamp: Date.now(),
            payload: shopStore,
          });
        }
        return res.json({
          success: true,
          reconciledCount: rec.reconciledCount,
          syncVersion: shopStore.syncVersion,
          store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions),
        });
      }

      case 'delete_all_held_bills': {
        shopStore.heldBills = [];
        persistShopStore(targetShopId);
        broadcastSyncEventToShop(targetShopId, {
          type: 'store:sync',
          sourceDeviceId,
          timestamp: Date.now(),
          payload: shopStore,
        });
        return res.json({ success: true, syncVersion: shopStore.syncVersion, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'sync_full': {
        const { transactions, purchases, saleReturns, products, customers, customerLedgers } = payload || {};
        if (Array.isArray(transactions)) {
          transactions.forEach((tx) => {
            if (!shopStore.transactions.some((t) => t.invoiceNumber === tx.invoiceNumber)) {
              shopStore.transactions.push(tx);
            }
          });
        }
        if (Array.isArray(purchases)) {
          purchases.forEach((p) => {
            if (!shopStore.purchases.some((x) => x.purchaseInvoiceNo === p.purchaseInvoiceNo)) {
              shopStore.purchases.push(p);
            }
          });
        }
        if (Array.isArray(saleReturns)) {
          saleReturns.forEach((r) => {
            if (!shopStore.saleReturns.some((x) => x.returnNumber === r.returnNumber)) {
              shopStore.saleReturns.push(r);
            }
          });
        }
        if (Array.isArray(products) && products.length > 0 && shopStore.products.length === 0) {
          shopStore.products = products;
        }
        if (Array.isArray(customers) && customers.length > 0 && shopStore.customers.length === 0) {
          shopStore.customers = customers;
        }
        if (Array.isArray(customerLedgers)) {
          customerLedgers.forEach((l) => {
            if (!shopStore.customerLedgers.some((x) => x.id === l.id)) {
              shopStore.customerLedgers.push(l);
            }
          });
        }

        persistShopStore(targetShopId);
        broadcastSyncEventToShop(targetShopId, {
          type: 'store:sync',
          sourceDeviceId,
          timestamp: Date.now(),
          payload: shopStore,
        });
        return res.json({ success: true, store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'reset_all_zero': {
        shopStore.products = [];
        shopStore.transactions = [];
        shopStore.purchases = [];
        shopStore.customers = [];
        shopStore.customerLedgers = [];
        shopStore.saleReturns = [];
        shopStore.heldBills = [];
        persistShopStore(targetShopId);

        broadcastSyncEventToShop(targetShopId, {
          type: 'store:sync',
          sourceDeviceId,
          timestamp: Date.now(),
          payload: shopStore,
        });

        return res.json({ success: true, message: 'All store data reset to clean zero state.', store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      case 'load_seed_catalog': {
        shopStore.products = SEED_CATALOG_PRODUCTS;
        persistShopStore(targetShopId);

        broadcastSyncEventToShop(targetShopId, {
          type: 'store:sync',
          sourceDeviceId,
          timestamp: Date.now(),
          payload: shopStore,
        });

        return res.json({ success: true, message: 'Reference 15 picture products loaded.', store: sanitizeStoreForClient(shopStore, actor.role, actor.permissions) });
      }

      default:
        return res.status(400).json({ success: false, message: `Unknown action: ${action}` });
    }
  }));

  // -------------------------------------------------------------
  // 6. SUPER ADMIN CONSOLE, MULTI-SHOP, SUBSCRIPTIONS & BACKUP API
  // -------------------------------------------------------------
  function buildSuperAdminOverviewPayload() {
    checkAndAutoExpireSubscriptions();
    const defaultPricing = normalizeDefaultPricing(subscriptionsDb.defaultPricing);
    const totalIncome = subscriptionsDb.payments.reduce((sum, p) => sum + (p.finalAmount || 0), 0);
    const amountReceived = subscriptionsDb.payments.reduce((sum, p) => sum + (p.amountPaid || 0), 0);
    const outstandingBalance = subscriptionsDb.shops.reduce((sum, s) => sum + (s.remainingBalance || 0), 0);
    const currentYearMonth = new Date().toISOString().slice(0, 7);
    const thisMonthIncome = subscriptionsDb.payments
      .filter((p) => (p.paymentDate || '').startsWith(currentYearMonth))
      .reduce((sum, p) => sum + (p.amountPaid || 0), 0);
    const currentYear = new Date().getFullYear().toString();
    const thisYearIncome = subscriptionsDb.payments
      .filter((p) => (p.paymentDate || '').startsWith(currentYear))
      .reduce((sum, p) => sum + (p.amountPaid || 0), 0);

    const onlineDeviceIds = new Set(Array.from(sseClients.values()).map((c) => c.deviceId));
    const enrichedDevices = registeredDevices.map((d) => {
      const sId = d.shopId || 'SHOP-WM-001';
      const shop = subscriptionsDb.shops.find((s) => s.id === sId);
      return {
        ...d,
        shopId: sId,
        shopName: sId === SUPER_ADMIN_POS_SHOP_ID ? 'SUPER ADMIN · MY POS APP' : shop?.shopName || 'WAQAS MART',
        sessionToken: undefined,
        connectionState: onlineDeviceIds.has(d.deviceId) ? ('online' as const) : ('offline' as const),
      };
    });

    const enrichedShops = subscriptionsDb.shops.map((s) => {
      const ownerUser = authDb.users.find((u) => u.shopId === s.id && u.role === 'SHOP_OWNER');
      const shopDevs = enrichedDevices.filter((d) => d.shopId === s.id);
      const fallbackUsername = s.ownerUsername || (s.email && s.email.includes('@') ? s.email.split('@')[0] : s.email) || '';
      const isLife = Boolean(s.isLifetime || s.plan === 'lifetime' || s.expiryDate === 'LIFETIME');
      const remBal = typeof s.remainingBalance === 'number' ? Math.max(0, s.remainingBalance) : 0;
      const totPaid = typeof s.totalPaid === 'number' ? Math.max(0, s.totalPaid) : 0;
      const derivedPayStatus: PaymentStatusType =
        s.paymentStatus || (remBal <= 0 ? 'Paid' : totPaid > 0 ? 'Partially Paid' : 'Unpaid');
      return {
        ...s,
        isLifetime: isLife,
        expiryDate: isLife ? 'LIFETIME' : s.expiryDate,
        expiryAt: isLife ? null : s.expiryAt,
        paymentStatus: derivedPayStatus,
        ownerUsername: ownerUser?.username || fallbackUsername,
        hasOwnerLogin: Boolean(ownerUser && ownerUser.passwordHash && ownerUser.passwordSalt),
        deviceCount: shopDevs.filter((d) => d.status === 'active').length,
        onlineDeviceCount: shopDevs.filter((d) => d.connectionState === 'online').length,
      };
    });

    const activeDevices = enrichedDevices.filter((d) => d.status === 'active');
    const onlineDevicesCount = activeDevices.filter((d) => d.connectionState === 'online').length;
    const lifetimeShopsCount = enrichedShops.filter((s) => s.isLifetime || s.plan === 'lifetime').length;
    const hourlyShopsCount = enrichedShops.filter((s) => s.plan === 'hourly').length;

    return {
      metrics: {
        totalIncome,
        amountReceived,
        outstandingBalance,
        thisMonthIncome,
        thisYearIncome,
        totalRenewals: subscriptionsDb.renewals.length,
        totalShops: subscriptionsDb.shops.length,
        activeShops: subscriptionsDb.shops.filter((s) => s.status === 'active' || s.status === 'expiring_soon').length,
        inactiveShops: subscriptionsDb.shops.filter((s) => s.status === 'inactive').length,
        expiringSoon: subscriptionsDb.shops.filter((s) => s.status === 'expiring_soon').length,
        expiredShops: subscriptionsDb.shops.filter((s) => s.status === 'expired').length,
        suspendedShops: subscriptionsDb.shops.filter((s) => s.status === 'suspended').length,
        blockedShops: subscriptionsDb.shops.filter((s) => s.status === 'blocked').length,
        lifetimeShops: lifetimeShopsCount,
        hourlyShops: hourlyShopsCount,
        totalOwners: authDb.users.filter((u) => u.role === 'SHOP_OWNER').length,
        totalDevices: registeredDevices.length,
        onlineDevices: onlineDevicesCount,
        offlineDevices: Math.max(0, activeDevices.length - onlineDevicesCount),
        revokedDevices: registeredDevices.filter((d) => d.status === 'revoked').length,
      },
      defaultPricing,
      pricingHistory: (subscriptionsDb.pricingHistory || []).slice(0, 200),
      subscriptionHistory: (subscriptionsDb.subscriptionHistory || []).slice(0, 400),
      shops: enrichedShops,
      payments: subscriptionsDb.payments,
      renewals: subscriptionsDb.renewals,
      devices: enrichedDevices,
      auditLogs: auditLogs.slice(0, 300),
      superAdmin: authDb.superAdmin
        ? {
            id: authDb.superAdmin.id,
            gmail: authDb.superAdmin.gmail,
            mobile: authDb.superAdmin.mobile,
            fullName: authDb.superAdmin.fullName,
            verifiedGmail: authDb.superAdmin.verifiedGmail,
            verifiedMobile: authDb.superAdmin.verifiedMobile,
            createdAt: authDb.superAdmin.createdAt,
            lastLoginAt: authDb.superAdmin.lastLoginAt,
          }
        : null,
    };
  }

  function roundMoney(v: number): number {
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  function parseNonNegativeInput(val: unknown, fallback = 0): { ok: boolean; value: number } {
    if (val === undefined || val === null || val === '') {
      return { ok: true, value: roundMoney(fallback) };
    }
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, value: 0 };
    }
    return { ok: true, value: roundMoney(n) };
  }

  function getPlanDefaultBasePrice(plan: SubscriptionPlanType, hoursCount: number, pricing: DefaultSubscriptionPricing): number {
    switch (plan) {
      case '1_day':
        return pricing.oneDay;
      case '7_days':
        return pricing.sevenDays;
      case 'hourly':
        return roundMoney(hoursCount * pricing.hourlyRate);
      case 'lifetime':
        return pricing.lifetime;
      case '1_month':
        return pricing.oneMonth;
      case '3_months':
        return pricing.threeMonths;
      case '6_months':
        return pricing.sixMonths;
      case '12_months':
        return pricing.twelveMonths;
      default:
        return pricing.oneMonth;
    }
  }

  function formatDurationLabel(plan: SubscriptionPlanType, hoursCount?: number, customDays?: number): string {
    switch (plan) {
      case '1_day':
        return '1 Day (24 Hours)';
      case '7_days':
        return '7 Days (168 Hours)';
      case 'hourly': {
        const hrs = hoursCount || 1;
        return `Hourly (${hrs} Hour${hrs === 1 ? '' : 's'})`;
      }
      case 'lifetime':
        return 'Lifetime — No Expiry';
      case '1_month':
        return '1 Month (30 Days)';
      case '3_months':
        return '3 Months (90 Days)';
      case '6_months':
        return '6 Months (180 Days)';
      case '12_months':
        return '12 Months (1 Year)';
      default:
        return customDays ? `Custom (${customDays} Days)` : 'Custom Subscription';
    }
  }

  function computeSubscriptionTimingAndBilling(params: {
    plan: SubscriptionPlanType;
    hoursCount?: unknown;
    additionalDays?: unknown;
    additionalHours?: unknown;
    agreedPrice?: unknown;
    discount?: unknown;
    amountPaid?: unknown;
    baseMs?: number;
    manualExpiryAt?: string;
    manualStartDate?: string;
  }) {
    const defaultPricing = normalizeDefaultPricing(subscriptionsDb.defaultPricing);
    const plan = params.plan;
    const validPlans: SubscriptionPlanType[] = [
      '1_day',
      '7_days',
      'hourly',
      'lifetime',
      '1_month',
      '3_months',
      '6_months',
      '12_months',
      'custom',
    ];
    if (!validPlans.includes(plan)) {
      return { ok: false as const, message: `Unsupported subscription plan "${plan}".` };
    }

    let hoursNum = 0;
    if (plan === 'hourly') {
      const h = Number(params.hoursCount);
      if (!Number.isFinite(h) || h <= 0 || h > 87600) {
        return { ok: false as const, message: 'Please enter a valid positive number of hours for an Hourly subscription.' };
      }
      hoursNum = Math.round(h * 100) / 100;
    }

    const defaultPrice = getPlanDefaultBasePrice(plan, hoursNum, defaultPricing);
    const parsedAgreed = parseNonNegativeInput(params.agreedPrice, defaultPrice);
    if (!parsedAgreed.ok) {
      return { ok: false as const, message: 'Subscription price cannot be negative or invalid.' };
    }
    const agreedPrice = parsedAgreed.value;

    const parsedDiscount = parseNonNegativeInput(params.discount, 0);
    if (!parsedDiscount.ok) {
      return { ok: false as const, message: 'Discount cannot be negative or invalid.' };
    }
    const discount = parsedDiscount.value;
    if (discount > agreedPrice) {
      return { ok: false as const, message: 'Discount cannot exceed the original subscription price.' };
    }

    const finalAmount = roundMoney(Math.max(0, agreedPrice - discount));
    const parsedPaid = parseNonNegativeInput(params.amountPaid, 0);
    if (!parsedPaid.ok) {
      return { ok: false as const, message: 'Amount Paid cannot be negative or invalid.' };
    }
    const amountPaid = parsedPaid.value;
    if (amountPaid > finalAmount) {
      return {
        ok: false as const,
        message: `Amount Paid (PKR ${amountPaid.toLocaleString()}) cannot exceed Final Payable Amount (PKR ${finalAmount.toLocaleString()}).`,
      };
    }

    const remainingBalance = roundMoney(Math.max(0, finalAmount - amountPaid));
    const paymentStatus: PaymentStatusType =
      finalAmount === 0 || remainingBalance === 0 ? 'Paid' : amountPaid > 0 ? 'Partially Paid' : 'Unpaid';

    const activationMs =
      params.baseMs ??
      (params.manualStartDate ? Date.parse(params.manualStartDate) || Date.now() : Date.now());
    const activationAt = new Date(activationMs).toISOString();
    const startDate = params.manualStartDate && /^\d{4}-\d{2}-\d{2}$/.test(params.manualStartDate)
      ? params.manualStartDate
      : activationAt.split('T')[0];

    const isLifetime = plan === 'lifetime';
    let expiryAt: string | null = null;
    let expiryDate = 'LIFETIME';
    let durationDays = 0;

    if (!isLifetime) {
      if (params.manualExpiryAt) {
        const rawExp = String(params.manualExpiryAt).trim();
        const expMs = /^\d{4}-\d{2}-\d{2}$/.test(rawExp)
          ? Date.parse(`${rawExp}T23:59:59.999Z`)
          : Date.parse(rawExp);
        if (Number.isNaN(expMs)) {
          return { ok: false as const, message: 'Invalid custom expiry date/time provided.' };
        }
        expiryAt = new Date(expMs).toISOString();
        expiryDate = expiryAt.split('T')[0];
        durationDays = Math.max(1, Math.ceil((expMs - activationMs) / (24 * 60 * 60 * 1000)));
      } else {
        let durationMs = 0;
        const addHrs = Number(params.additionalHours);
        const addDays = Number(params.additionalDays);
        if (plan === 'hourly') {
          durationMs = Math.round(hoursNum * 60 * 60 * 1000);
          durationDays = Number((hoursNum / 24).toFixed(2));
        } else if (Number.isFinite(addHrs) && addHrs > 0) {
          durationMs = Math.round(addHrs * 60 * 60 * 1000);
          durationDays = Number((addHrs / 24).toFixed(2));
        } else if (Number.isFinite(addDays) && addDays > 0) {
          durationDays = addDays;
          durationMs = Math.round(addDays * 24 * 60 * 60 * 1000);
        } else if (plan === '1_day') {
          durationDays = 1;
          durationMs = 24 * 60 * 60 * 1000;
        } else if (plan === '7_days') {
          durationDays = 7;
          durationMs = 7 * 24 * 60 * 60 * 1000;
        } else if (plan === '1_month') {
          durationDays = 30;
          durationMs = 30 * 24 * 60 * 60 * 1000;
        } else if (plan === '3_months') {
          durationDays = 90;
          durationMs = 90 * 24 * 60 * 60 * 1000;
        } else if (plan === '6_months') {
          durationDays = 180;
          durationMs = 180 * 24 * 60 * 60 * 1000;
        } else if (plan === '12_months') {
          durationDays = 365;
          durationMs = 365 * 24 * 60 * 60 * 1000;
        } else {
          durationDays = 30;
          durationMs = 30 * 24 * 60 * 60 * 1000;
        }
        expiryAt = new Date(activationMs + durationMs).toISOString();
        expiryDate = expiryAt.split('T')[0];
      }
    }

    return {
      ok: true as const,
      defaultPricing,
      plan,
      hoursCount: plan === 'hourly' ? hoursNum : undefined,
      hourlyRateApplied: plan === 'hourly' ? defaultPricing.hourlyRate : undefined,
      isLifetime,
      agreedPrice,
      discount,
      finalAmount,
      amountPaid,
      remainingBalance,
      paymentStatus,
      activationAt,
      startDate,
      expiryAt,
      expiryDate,
      durationDays,
      durationLabel: formatDurationLabel(plan, hoursNum, durationDays),
    };
  }

  app.get('/api/super-admin/overview', requireSuperAdmin, (_req: Request, res: Response) => {
    return res.json({ success: true, ...buildSuperAdminOverviewPayload() });
  });

  app.get('/api/subscriptions/overview', requireSuperAdmin, (_req: Request, res: Response) => {
    return res.json({ success: true, ...buildSuperAdminOverviewPayload() });
  });

  app.get('/api/super-admin/pricing', requireSuperAdmin, (_req: Request, res: Response) => {
    return res.json({
      success: true,
      defaultPricing: normalizeDefaultPricing(subscriptionsDb.defaultPricing),
      pricingHistory: subscriptionsDb.pricingHistory || [],
    });
  });

  app.get('/api/subscriptions/pricing', requireSuperAdmin, (_req: Request, res: Response) => {
    return res.json({
      success: true,
      defaultPricing: normalizeDefaultPricing(subscriptionsDb.defaultPricing),
      pricingHistory: subscriptionsDb.pricingHistory || [],
    });
  });

  function handleUpdateSubscriptionPricing(req: Request, res: Response) {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const current = normalizeDefaultPricing(subscriptionsDb.defaultPricing);
    const body = req.body || {};

    const editableFields: Array<{
      key: 'oneDay' | 'sevenDays' | 'hourlyRate' | 'lifetime' | 'oneMonth' | 'threeMonths' | 'sixMonths' | 'twelveMonths';
      label: string;
    }> = [
      { key: 'oneDay', label: '1 Day (24 Hours)' },
      { key: 'sevenDays', label: '7 Days' },
      { key: 'hourlyRate', label: 'Hourly Rate (Per Hour)' },
      { key: 'lifetime', label: 'Lifetime Plan' },
      { key: 'oneMonth', label: '1 Month' },
      { key: 'threeMonths', label: '3 Months' },
      { key: 'sixMonths', label: '6 Months' },
      { key: 'twelveMonths', label: '12 Months' },
    ];

    const updated = {
      ...current,
      previousPrices: { ...(current.previousPrices || {}) },
    };
    const changes: SubscriptionPriceHistoryEntry[] = [];
    const nowIso = new Date().toISOString();
    const actorLabel = saSession?.email || saSession?.fullName || 'Super Admin';

    for (const f of editableFields) {
      if (body[f.key] === undefined) continue;
      const num = Number(body[f.key]);
      if (!Number.isFinite(num) || num < 0) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_PRICE',
          message: `Price for "${f.label}" must be a valid non-negative number.`,
        });
      }
      const rounded = roundMoney(num);
      const prevVal = current[f.key];
      if (rounded !== prevVal) {
        updated.previousPrices[f.key] = prevVal;
        updated[f.key] = rounded;
        changes.push({
          id: `PH-${Date.now()}-${f.key}-${Math.random().toString(36).slice(2, 5)}`,
          planKey: f.key,
          planLabel: f.label,
          previousPrice: prevVal,
          newPrice: rounded,
          changedBy: actorLabel,
          changedAt: nowIso,
        });
      }
    }

    if (changes.length > 0) {
      updated.lastUpdated = nowIso;
      updated.updatedBy = actorLabel;
      subscriptionsDb.defaultPricing = updated;
      subscriptionsDb.pricingHistory = [...changes, ...(subscriptionsDb.pricingHistory || [])].slice(0, 500);
      persistSubscriptions();

      const summary = changes
        .map((c) => `${c.planLabel}: PKR ${c.previousPrice} -> PKR ${c.newPrice}`)
        .join('; ');
      recordAuditLog(
        'SUBSCRIPTION_PRICE_UPDATED',
        actorLabel,
        'SUPER_ADMIN',
        `Updated default subscription pricing (${summary}). Existing Mart accounts preserved unchanged.`,
        undefined,
        req.ip
      );
    }

    return res.json({
      success: true,
      defaultPricing: updated,
      pricingHistory: subscriptionsDb.pricingHistory || [],
      changesCount: changes.length,
    });
  }

  app.put('/api/super-admin/pricing', requireSuperAdmin, handleUpdateSubscriptionPricing);
  app.put('/api/subscriptions/pricing', requireSuperAdmin, handleUpdateSubscriptionPricing);

  app.get('/api/super-admin/shops', requireSuperAdmin, (_req: Request, res: Response) => {
    return res.json({ success: true, shops: buildSuperAdminOverviewPayload().shops });
  });

  app.get('/api/subscriptions/shops', requireSuperAdmin, (_req: Request, res: Response) => {
    return res.json({ success: true, shops: buildSuperAdminOverviewPayload().shops });
  });

  function handleCreateShop(req: Request, res: Response) {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const {
      shopName,
      ownerName,
      username,
      password,
      confirmPassword,
      email,
      phone,
      mobile,
      whatsapp,
      address,
      plan = '1_day',
      hoursCount,
      agreedPrice,
      discount = 0,
      amountPaid,
      status = 'active',
      startDate,
      expiryDate,
      expiryAt: manualExpiryAt,
      pricing,
      initialPayment,
      paymentMethod = 'Cash',
      transactionReference,
      notes,
    } = req.body || {};

    const cleanShopName = String(shopName || '').trim();
    const cleanOwnerName = String(ownerName || cleanShopName).trim();
    const cleanPhone = String(mobile || phone || '').trim();
    const rawUsername = String(username || '').trim().toLowerCase();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(password || '').trim();
    const cleanConfirm = confirmPassword !== undefined ? String(confirmPassword).trim() : cleanPass;

    if (!cleanShopName || !cleanOwnerName || (!rawUsername && !cleanEmail) || !cleanPass) {
      return res.status(400).json({
        success: false,
        error: 'REQUIRED_FIELDS_MISSING',
        message: 'Mart Name, Mart Owner Name, Shop Username, and Shop Password are required.',
      });
    }
    if (rawUsername && !/^[a-z0-9_.-]+$/.test(rawUsername)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_SHOP_USERNAME',
        message: 'Shop Username may only contain letters, numbers, dots (.), underscores (_), or hyphens (-), with no spaces.',
      });
    }
    if (rawUsername && rawUsername.length < 3) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_SHOP_USERNAME',
        message: 'Shop Username must be at least 3 characters long.',
      });
    }
    if (cleanPass.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'WEAK_PASSWORD',
        message: 'Shop Password must be at least 6 characters long.',
      });
    }
    if (cleanPass !== cleanConfirm) {
      return res.status(400).json({
        success: false,
        error: 'PASSWORD_MISMATCH',
        message: 'Shop Password and Confirm Password do not match.',
      });
    }

    const effectiveUsername = rawUsername || cleanEmail.split('@')[0].replace(/[^a-z0-9_.-]/g, '');
    if (!effectiveUsername || effectiveUsername.length < 3) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_SHOP_USERNAME',
        message: 'Please enter a valid Shop Username (minimum 3 characters, no spaces).',
      });
    }
    const effectiveEmail = cleanEmail || `${effectiveUsername}@shop.local`;

    const dupUser = authDb.users.find(
      (u) =>
        u.username?.trim().toLowerCase() === effectiveUsername ||
        (cleanEmail && u.email?.trim().toLowerCase() === cleanEmail)
    );
    const dupShop = subscriptionsDb.shops.find(
      (s) =>
        (s.ownerUsername && s.ownerUsername.trim().toLowerCase() === effectiveUsername) ||
        (cleanEmail && s.email?.trim().toLowerCase() === cleanEmail)
    );
    if (dupUser || dupShop) {
      return res.status(409).json({
        success: false,
        error: 'DUPLICATE_USERNAME',
        message: `Shop Username "${effectiveUsername}" is already taken by another Mart. Please choose a different username.`,
      });
    }

    const calc = computeSubscriptionTimingAndBilling({
      plan: plan as SubscriptionPlanType,
      hoursCount,
      agreedPrice: agreedPrice !== undefined ? agreedPrice : pricing?.customAgreedPrice,
      discount,
      amountPaid: amountPaid !== undefined ? amountPaid : initialPayment,
      manualExpiryAt: manualExpiryAt || expiryDate,
      manualStartDate: startDate,
    });
    if (!calc.ok) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_SUBSCRIPTION_VALUES',
        message: calc.message,
      });
    }

    let uniqueShopId = `SHOP-WM-${100 + subscriptionsDb.shops.length + Math.floor(Math.random() * 900)}`;
    while (
      subscriptionsDb.shops.some((s) => s.id.toLowerCase() === uniqueShopId.toLowerCase()) ||
      authDb.users.some((u) => (u.shopId || '').toLowerCase() === uniqueShopId.toLowerCase())
    ) {
      uniqueShopId = `SHOP-WM-${100 + subscriptionsDb.shops.length + Math.floor(Math.random() * 9000)}`;
    }

    const dp = calc.defaultPricing;
    const nowIso = new Date().toISOString();
    const todayDate = nowIso.split('T')[0];

    const newShop: ShopAccount = {
      id: uniqueShopId,
      shopName: cleanShopName,
      ownerName: cleanOwnerName,
      ownerUsername: effectiveUsername,
      hasOwnerLogin: true,
      email: effectiveEmail,
      phone: cleanPhone,
      whatsapp: String(whatsapp || cleanPhone).trim(),
      address: String(address || '').trim(),
      status: status === 'inactive' || status === 'suspended' ? status : 'active',
      plan: calc.plan,
      startDate: calc.startDate,
      expiryDate: calc.expiryDate,
      activationAt: calc.activationAt,
      expiryAt: calc.expiryAt,
      isLifetime: calc.isLifetime,
      hoursCount: calc.hoursCount,
      hourlyRateApplied: calc.hourlyRateApplied,
      agreedPrice: calc.agreedPrice,
      discount: calc.discount,
      finalPrice: calc.finalAmount,
      paymentStatus: calc.paymentStatus,
      lastPaymentDate: calc.amountPaid > 0 ? todayDate : undefined,
      pricing: {
        oneDay: Number(pricing?.oneDay) || dp.oneDay,
        sevenDays: Number(pricing?.sevenDays) || dp.sevenDays,
        hourlyRate: Number(pricing?.hourlyRate) || dp.hourlyRate,
        lifetime: Number(pricing?.lifetime) || dp.lifetime,
        oneMonth: Number(pricing?.oneMonth) || dp.oneMonth,
        threeMonths: Number(pricing?.threeMonths) || dp.threeMonths,
        sixMonths: Number(pricing?.sixMonths) || dp.sixMonths,
        twelveMonths: Number(pricing?.twelveMonths) || dp.twelveMonths,
        customPricePerMonth: Number(pricing?.customPricePerMonth) || dp.oneMonth,
        lastUpdated: todayDate,
      },
      initialPayment: calc.amountPaid,
      remainingBalance: calc.remainingBalance,
      totalPaid: calc.amountPaid,
      totalIncome: calc.finalAmount,
      renewalsCount: 0,
      mustChangePasswordOnFirstLogin: false,
      createdAt: nowIso,
    };

    const salt = crypto.randomBytes(16).toString('hex');
    const newOwnerUser: StoredUser = {
      id: `USR-${uniqueShopId}`,
      username: effectiveUsername,
      email: effectiveEmail,
      fullName: cleanOwnerName,
      phone: cleanPhone,
      whatsapp: String(whatsapp || cleanPhone).trim(),
      role: 'SHOP_OWNER',
      shopId: uniqueShopId,
      passwordSalt: salt,
      passwordHash: hashPassword(cleanPass, salt),
      mustChangePasswordOnFirstLogin: false,
      createdAt: nowIso,
    };

    subscriptionsDb.shops.unshift(newShop);
    authDb.users.push(newOwnerUser);

    let createdPayment: SubscriptionPaymentRecord | undefined;
    if (calc.finalAmount > 0 || calc.amountPaid > 0) {
      const receiptNumber = `RCP-${crypto.randomInt(1000, 9999)}`;
      createdPayment = {
        id: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        receiptNumber,
        shopId: uniqueShopId,
        shopName: cleanShopName,
        ownerName: cleanOwnerName,
        ownerEmail: effectiveEmail,
        plan: newShop.plan,
        durationLabel: calc.durationLabel,
        hoursCount: calc.hoursCount,
        hourlyRateApplied: calc.hourlyRateApplied,
        paymentMode: 'subscription_charge',
        totalAmount: calc.agreedPrice,
        discount: calc.discount,
        finalAmount: calc.finalAmount,
        amountPaid: calc.amountPaid,
        remainingBalance: calc.remainingBalance,
        paymentMethod: paymentMethod as any,
        paymentDate: todayDate,
        transactionReference: transactionReference ? String(transactionReference).trim() : undefined,
        confirmedBy: saSession?.fullName || 'Super Admin',
        notes: notes ? String(notes).trim() : 'Initial Mart subscription',
        status: calc.paymentStatus,
        createdAt: nowIso,
      };
      subscriptionsDb.payments.unshift(createdPayment);
    }

    const actorEmail = saSession?.email || saSession?.fullName || 'superadmin';
    recordSubscriptionLifecycle({
      shopId: uniqueShopId,
      shopName: cleanShopName,
      eventType: 'CREATED',
      plan: calc.plan,
      durationLabel: calc.durationLabel,
      agreedPrice: calc.agreedPrice,
      discount: calc.discount,
      finalAmount: calc.finalAmount,
      amountPaid: calc.amountPaid,
      remainingBalance: calc.remainingBalance,
      expiryAt: calc.expiryAt,
      notes: notes ? String(notes).trim() : `Account created with ${calc.durationLabel}`,
      actor: actorEmail,
    });

    persistAuthDb();
    persistSubscriptions();

    const newStore = getShopStore(uniqueShopId);
    newStore.branding.storeName = cleanShopName;
    newStore.branding.primaryName = cleanShopName.split(' ')[0] || cleanShopName;
    newStore.branding.accentName = cleanShopName.split(' ').slice(1).join(' ') || 'POS';
    newStore.branding.sidebarPromoBadge = cleanShopName;
    newStore.userProfile = {
      id: newOwnerUser.id,
      displayName: cleanOwnerName,
      email: effectiveEmail,
      phone: cleanPhone,
      role: 'Shop Owner',
      createdAt: new Date().toLocaleDateString('en-GB'),
    };
    persistShopStore(uniqueShopId, false);

    recordAuditLog(
      'SHOP_CREATED',
      actorEmail,
      'SUPER_ADMIN',
      `Created mart "${cleanShopName}" (${uniqueShopId}) · Plan: ${calc.durationLabel} · Final: PKR ${calc.finalAmount} · Paid: PKR ${calc.amountPaid} · Status: ${calc.paymentStatus}`,
      uniqueShopId,
      req.ip
    );

    return res.json({
      success: true,
      shopId: uniqueShopId,
      shop: { ...newShop, ownerUsername: effectiveUsername, hasOwnerLogin: true },
      payment: createdPayment,
      ownerUsername: effectiveUsername,
    });
  }

  app.post('/api/super-admin/shops', requireSuperAdmin, handleCreateShop);
  app.post('/api/subscriptions/shops', requireSuperAdmin, handleCreateShop);

  app.put('/api/super-admin/shops/:id', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const shop = subscriptionsDb.shops.find((s) => s.id === id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found.' });
    }

    const { shopName, ownerName, ownerUsername, phone, whatsapp, email, address, status, plan, expiryDate, expiryAt, pricing } = req.body || {};
    const ownerUser = authDb.users.find((u) => u.shopId === id && u.role === 'SHOP_OWNER');

    if (ownerUsername !== undefined) {
      const cleanNewUsername = String(ownerUsername || '').trim().toLowerCase();
      if (!cleanNewUsername || cleanNewUsername.length < 3 || !/^[a-z0-9_.-]+$/.test(cleanNewUsername)) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_SHOP_USERNAME',
          message: 'Shop Username must be at least 3 characters (letters, numbers, ., _, - with no spaces).',
        });
      }
      const dupUsername = authDb.users.find(
        (u) => u.id !== ownerUser?.id && u.username?.trim().toLowerCase() === cleanNewUsername
      );
      const dupShop = subscriptionsDb.shops.find(
        (s) => s.id !== shop.id && s.ownerUsername?.trim().toLowerCase() === cleanNewUsername
      );
      if (dupUsername || dupShop) {
        return res.status(409).json({
          success: false,
          error: 'DUPLICATE_USERNAME',
          message: 'That Shop Username is already in use by another mart.',
        });
      }
      if (ownerUser) ownerUser.username = cleanNewUsername;
      shop.ownerUsername = cleanNewUsername;
    }

    if (shopName) shop.shopName = String(shopName).trim();
    if (ownerName) shop.ownerName = String(ownerName).trim();
    if (phone !== undefined) shop.phone = String(phone).trim();
    if (whatsapp !== undefined) shop.whatsapp = String(whatsapp).trim();
    if (email !== undefined) shop.email = String(email).trim().toLowerCase();
    if (address !== undefined) shop.address = String(address).trim();
    if (status) shop.status = status;
    if (plan) {
      shop.plan = plan;
      if (plan === 'lifetime') {
        shop.isLifetime = true;
        shop.expiryDate = 'LIFETIME';
        shop.expiryAt = null;
      } else {
        shop.isLifetime = false;
      }
    }
    if (expiryAt !== undefined && !shop.isLifetime) {
      if (expiryAt === null) {
        shop.expiryAt = null;
      } else {
        const ms = Date.parse(String(expiryAt));
        if (!Number.isNaN(ms)) {
          shop.expiryAt = new Date(ms).toISOString();
          shop.expiryDate = shop.expiryAt.split('T')[0];
        }
      }
    } else if (expiryDate && !shop.isLifetime) {
      shop.expiryDate = expiryDate;
      if (/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
        shop.expiryAt = `${expiryDate}T23:59:59.999Z`;
      }
    }
    if (pricing) {
      shop.pricing = { ...shop.pricing, ...pricing, lastUpdated: new Date().toISOString().split('T')[0] };
    }

    if (ownerUser) {
      if (ownerName) ownerUser.fullName = shop.ownerName;
      if (phone !== undefined) ownerUser.phone = shop.phone;
      if (whatsapp !== undefined) ownerUser.whatsapp = shop.whatsapp;
      if (email) ownerUser.email = shop.email;
      persistAuthDb();
    }

    if (shop.status === 'inactive' || shop.status === 'suspended' || shop.status === 'blocked') {
      for (const token of Object.keys(authDb.sessions)) {
        if (authDb.sessions[token].shopId === shop.id) {
          revokeTokenInDb(token, authDb.sessions[token].expiresAt);
          delete authDb.sessions[token];
        }
      }
      authDb.revokedBefore = authDb.revokedBefore || {};
      authDb.revokedBefore[`shop:${shop.id}`] = Date.now();
      if (ownerUser) {
        authDb.revokedBefore[ownerUser.id] = Date.now();
      }
      persistAuthDb();
      disconnectShopClients(shop.id, 'auth:shop_restricted', `Shop status changed to ${shop.status}`);
    }

    persistSubscriptions();
    recordAuditLog(
      'SHOP_UPDATED',
      saSession?.email || 'superadmin',
      'SUPER_ADMIN',
      `Updated shop "${shop.shopName}" (${shop.id})`,
      shop.id,
      req.ip
    );
    return res.json({ success: true, shop: { ...shop, ownerUsername: ownerUser?.username } });
  });

  app.put('/api/subscriptions/shops/:id', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const shop = subscriptionsDb.shops.find((s) => s.id === id);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
    const { status, pricing, expiryDate, plan } = req.body || {};
    const prevStatus = shop.status;
    if (status) shop.status = status;
    if (pricing) shop.pricing = { ...shop.pricing, ...pricing, lastUpdated: new Date().toISOString().split('T')[0] };
    if (expiryDate) shop.expiryDate = expiryDate;
    if (plan) shop.plan = plan;
    persistSubscriptions();
    if (shop.status === 'inactive' || shop.status === 'suspended' || shop.status === 'blocked') {
      for (const token of Object.keys(authDb.sessions)) {
        if (authDb.sessions[token].shopId === shop.id) {
          revokeTokenInDb(token, authDb.sessions[token].expiresAt);
          delete authDb.sessions[token];
        }
      }
      authDb.revokedBefore = authDb.revokedBefore || {};
      authDb.revokedBefore[`shop:${shop.id}`] = Date.now();
      persistAuthDb();
      disconnectShopClients(shop.id, 'auth:shop_restricted', `Shop status changed to ${shop.status}`);
    }
    recordAuditLog('SHOP_STATUS_UPDATED', saSession?.email || 'superadmin', 'SUPER_ADMIN', `Updated ${shop.shopName} (${shop.id}): ${prevStatus} -> ${shop.status}`, shop.id, req.ip);
    return res.json({ success: true, shop });
  });

  app.post('/api/super-admin/shops/:id/status', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const shop = subscriptionsDb.shops.find((s) => s.id === id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found.' });
    }

    const { status, notes } = req.body || {};
    const allowedStatuses = ['active', 'inactive', 'suspended', 'blocked', 'expired', 'expiring_soon'];
    const newStatus = allowedStatuses.includes(status) ? status : shop.status === 'active' ? 'suspended' : 'active';
    const prevStatus = shop.status;
    shop.status = newStatus;

    const actorEmail = saSession?.email || saSession?.fullName || 'superadmin';
    if (newStatus === 'suspended' || newStatus === 'blocked' || newStatus === 'inactive') {
      recordSubscriptionLifecycle({
        shopId: shop.id,
        shopName: shop.shopName,
        eventType: 'SUSPENDED',
        plan: shop.plan,
        expiryAt: shop.expiryAt,
        notes: notes ? String(notes).trim() : `Status changed from ${prevStatus} to ${newStatus}`,
        actor: actorEmail,
      });
    } else if (newStatus === 'active' && (prevStatus === 'suspended' || prevStatus === 'blocked' || prevStatus === 'inactive' || prevStatus === 'expired')) {
      recordSubscriptionLifecycle({
        shopId: shop.id,
        shopName: shop.shopName,
        eventType: 'REACTIVATED',
        plan: shop.plan,
        expiryAt: shop.expiryAt,
        notes: notes ? String(notes).trim() : `Reactivated from ${prevStatus} to active`,
        actor: actorEmail,
      });
    }
    persistSubscriptions();

    if (newStatus === 'inactive' || newStatus === 'suspended' || newStatus === 'blocked' || newStatus === 'expired') {
      for (const token of Object.keys(authDb.sessions)) {
        if (authDb.sessions[token].shopId === shop.id) {
          revokeTokenInDb(token, authDb.sessions[token].expiresAt);
          delete authDb.sessions[token];
        }
      }
      authDb.revokedBefore = authDb.revokedBefore || {};
      authDb.revokedBefore[`shop:${shop.id}`] = Date.now();
      persistAuthDb();
      disconnectShopClients(shop.id, 'auth:shop_restricted', `Shop access ${newStatus}`);
    }

    recordAuditLog(
      'SHOP_STATUS_CHANGED',
      actorEmail,
      'SUPER_ADMIN',
      `Shop "${shop.shopName}" (${shop.id}) status changed: ${prevStatus} -> ${newStatus}`,
      shop.id,
      req.ip
    );
    return res.json({ success: true, status: newStatus, shop });
  });

  app.post('/api/super-admin/shops/:id/reset-password', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const shop = subscriptionsDb.shops.find((s) => s.id === id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found.' });
    }

    const { password, confirmPassword, username: requestedUsername, mustChangeOnNextLogin = false } = req.body || {};
    const cleanPass = String(password || '').trim();
    if (!cleanPass || cleanPass.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }
    if (confirmPassword !== undefined && cleanPass !== String(confirmPassword).trim()) {
      return res.status(400).json({ success: false, message: 'Password and Confirm Password do not match.' });
    }

    let shopUser = authDb.users.find((u) => u.shopId === id && u.role === 'SHOP_OWNER');
    const salt = crypto.randomBytes(16).toString('hex');

    if (!shopUser) {
      const candidateUsername = String(
        requestedUsername ||
          shop.ownerUsername ||
          (shop.email && shop.email.includes('@') ? shop.email.split('@')[0] : '') ||
          shop.id.toLowerCase()
      )
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, '');

      if (!candidateUsername || candidateUsername.length < 3) {
        return res.status(400).json({ success: false, message: 'A valid Shop Username (min 3 chars) is required.' });
      }
      const dupUsername = authDb.users.find((u) => u.username?.trim().toLowerCase() === candidateUsername);
      if (dupUsername) {
        return res.status(409).json({
          success: false,
          message: `Username "${candidateUsername}" is already used by another account. Provide a different Shop Username.`,
        });
      }

      shopUser = {
        id: `USR-${shop.id}`,
        username: candidateUsername,
        email: shop.email || `${candidateUsername}@shop.local`,
        fullName: shop.ownerName || shop.shopName,
        phone: shop.phone || '',
        whatsapp: shop.whatsapp || shop.phone || '',
        role: 'SHOP_OWNER',
        shopId: shop.id,
        passwordSalt: salt,
        passwordHash: hashPassword(cleanPass, salt),
        mustChangePasswordOnFirstLogin: Boolean(mustChangeOnNextLogin),
        createdAt: shop.createdAt || new Date().toISOString(),
      };
      authDb.users.push(shopUser);
      shop.ownerUsername = candidateUsername;
      persistSubscriptions();
    } else {
      if (requestedUsername !== undefined && String(requestedUsername).trim()) {
        const cleanU = String(requestedUsername).trim().toLowerCase();
        if (!/^[a-z0-9_.-]+$/.test(cleanU) || cleanU.length < 3) {
          return res.status(400).json({
            success: false,
            message: 'Shop Username must be at least 3 characters (letters, numbers, ., _, - with no spaces).',
          });
        }
        const dupU = authDb.users.find((u) => u.id !== shopUser!.id && u.username?.trim().toLowerCase() === cleanU);
        if (dupU) {
          return res.status(409).json({ success: false, message: `Shop Username "${cleanU}" is already taken.` });
        }
        shopUser.username = cleanU;
        shop.ownerUsername = cleanU;
        persistSubscriptions();
      }
      shopUser.passwordSalt = salt;
      shopUser.passwordHash = hashPassword(cleanPass, salt);
      shopUser.mustChangePasswordOnFirstLogin = Boolean(mustChangeOnNextLogin);
    }

    for (const token of Object.keys(authDb.sessions)) {
      if (authDb.sessions[token].userId === shopUser.id) {
        revokeTokenInDb(token, authDb.sessions[token].expiresAt);
        delete authDb.sessions[token];
      }
    }
    authDb.revokedBefore = authDb.revokedBefore || {};
    authDb.revokedBefore[shopUser.id] = Date.now();
    persistAuthDb();

    recordAuditLog(
      'SHOP_PASSWORD_RESET',
      saSession?.email || 'superadmin',
      'SUPER_ADMIN',
      `Super Admin set/reset password for Shop Owner "${shopUser.username}" of ${id}`,
      id,
      req.ip
    );
    return res.json({
      success: true,
      shopId: shop.id,
      ownerUsername: shopUser.username,
      message: `Shop Owner login updated successfully (${shop.id} / ${shopUser.username}).`,
    });
  });

  app.delete('/api/super-admin/shops/:id', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    if (id === 'SHOP-WM-001' && req.body?.allowPrimaryDelete !== true) {
      return res.status(400).json({ success: false, message: 'Primary branch SHOP-WM-001 cannot be deleted directly.' });
    }
    const shop = subscriptionsDb.shops.find((s) => s.id === id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found.' });
    }
    const confirmText = String(req.body?.confirmText || '').trim();
    if (confirmText !== shop.id && confirmText.toLowerCase() !== shop.shopName.toLowerCase()) {
      return res.status(400).json({
        success: false,
        message: `Confirmation failed. Type "${shop.id}" or "${shop.shopName}" to delete this shop.`,
      });
    }

    const archiveDir = path.join(DATA_DIR, 'backups', 'deleted_shops');
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      const shopFile = getShopStoreFile(id);
      if (fs.existsSync(shopFile)) {
        fs.copyFileSync(shopFile, path.join(archiveDir, `${id}_${Date.now()}.json`));
        fs.unlinkSync(shopFile);
      }
    } catch {}
    shopStoreCache.delete(id);

    subscriptionsDb.shops = subscriptionsDb.shops.filter((s) => s.id !== id);
    persistSubscriptions();

    authDb.users = authDb.users.filter((u) => u.shopId !== id);
    for (const token of Object.keys(authDb.sessions)) {
      if (authDb.sessions[token].shopId === id) {
        revokeTokenInDb(token, authDb.sessions[token].expiresAt);
        delete authDb.sessions[token];
      }
    }
    authDb.revokedBefore = authDb.revokedBefore || {};
    authDb.revokedBefore[`shop:${id}`] = Date.now();
    persistAuthDb();

    disconnectShopClients(id, 'device:revoked', 'Shop account deleted by Super Admin');
    registeredDevices = registeredDevices.filter((d) => d.shopId !== id);
    persistDevices();

    recordAuditLog(
      'SHOP_DELETED',
      saSession?.email || 'superadmin',
      'SUPER_ADMIN',
      `Deleted shop "${shop.shopName}" (${id}) with archive backup`,
      id,
      req.ip
    );
    return res.json({ success: true, message: `Shop "${shop.shopName}" deleted cleanly.` });
  });

  function handleRecordPayment(req: Request, res: Response) {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const {
      shopId,
      plan,
      durationLabel,
      totalAmount,
      discount = 0,
      amountPaid,
      paymentMethod = 'Cash',
      paymentDate,
      transactionReference,
      notes,
      paymentMode = 'subscription_charge',
    } = req.body || {};

    const shop = subscriptionsDb.shops.find((s) => s.id === shopId);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found.' });
    }

    const parsedTotal = parseNonNegativeInput(totalAmount, 0);
    const parsedDisc = parseNonNegativeInput(discount, 0);
    const parsedPaid = parseNonNegativeInput(amountPaid, 0);
    if (!parsedTotal.ok || !parsedDisc.ok || !parsedPaid.ok) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PAYMENT_AMOUNT',
        message: 'Total Amount, Discount, and Amount Paid must be valid non-negative numbers.',
      });
    }

    const total = parsedTotal.value;
    const disc = parsedDisc.value;
    if (disc > total) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_DISCOUNT',
        message: 'Discount cannot exceed Total Fee.',
      });
    }
    const finalAmt = roundMoney(Math.max(0, total - disc));
    const paid = parsedPaid.value;
    if (paid > finalAmt && paymentMode !== 'balance_settlement') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PAYMENT_AMOUNT',
        message: 'Amount Paid cannot exceed Final Payable Amount.',
      });
    }
    if (paymentMode === 'balance_settlement' && paid + disc > (shop.remainingBalance || 0) + 0.01 && total <= (shop.remainingBalance || 0) + 0.01) {
      // If explicitly settling existing balance, disallow exceeding remaining balance unless a new charge was specified
      return res.status(400).json({
        success: false,
        error: 'INVALID_PAYMENT_AMOUNT',
        message: `Settlement payment + discount cannot exceed remaining balance (PKR ${(shop.remainingBalance || 0).toLocaleString()}).`,
      });
    }

    const receiptNumber = `RCP-${crypto.randomInt(1000, 9999)}`;
    const nowIso = new Date().toISOString();
    const payDateStr = paymentDate || nowIso.split('T')[0];

    let shopNewRemaining = 0;
    let recordRemaining = 0;

    if (paymentMode === 'balance_settlement') {
      const prevDue = Math.max(0, shop.remainingBalance || 0);
      shopNewRemaining = roundMoney(Math.max(0, prevDue - disc - paid));
      recordRemaining = shopNewRemaining;
      shop.discount = roundMoney((shop.discount || 0) + disc);
      shop.totalPaid = roundMoney((shop.totalPaid || 0) + paid);
      shop.remainingBalance = shopNewRemaining;
    } else {
      const cycleDue = roundMoney(Math.max(0, finalAmt - paid));
      recordRemaining = cycleDue;
      shop.agreedPrice = total;
      shop.discount = roundMoney((shop.discount || 0) + disc);
      shop.finalPrice = finalAmt;
      shop.totalIncome = roundMoney((shop.totalIncome || 0) + finalAmt);
      shop.totalPaid = roundMoney((shop.totalPaid || 0) + paid);
      shop.remainingBalance = roundMoney((shop.remainingBalance || 0) + cycleDue);
      shopNewRemaining = shop.remainingBalance;
    }

    const recordStatus: PaymentStatusType =
      recordRemaining === 0 ? 'Paid' : paid > 0 ? 'Partially Paid' : 'Unpaid';
    shop.paymentStatus =
      shop.remainingBalance <= 0 ? 'Paid' : (shop.totalPaid || 0) > 0 ? 'Partially Paid' : 'Unpaid';
    if (paid > 0) {
      shop.lastPaymentDate = payDateStr;
    }

    const paymentRecord: SubscriptionPaymentRecord = {
      id: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      receiptNumber,
      shopId: shop.id,
      shopName: shop.shopName,
      ownerName: shop.ownerName,
      ownerEmail: shop.email,
      plan: plan || shop.plan,
      durationLabel:
        durationLabel ||
        (paymentMode === 'balance_settlement' ? 'Remaining Balance Settlement' : formatDurationLabel(plan || shop.plan, shop.hoursCount)),
      paymentMode: paymentMode as any,
      totalAmount: total,
      discount: disc,
      finalAmount: finalAmt,
      amountPaid: paid,
      remainingBalance: recordRemaining,
      paymentMethod,
      paymentDate: payDateStr,
      transactionReference: transactionReference || undefined,
      confirmedBy: saSession?.fullName || 'Super Admin',
      notes: notes || undefined,
      status: recordStatus,
      createdAt: nowIso,
    };

    subscriptionsDb.payments.unshift(paymentRecord);
    const actorEmail = saSession?.email || saSession?.fullName || 'superadmin';
    recordSubscriptionLifecycle({
      shopId: shop.id,
      shopName: shop.shopName,
      eventType: disc > 0 && paid === 0 ? 'DISCOUNT_APPLIED' : 'PAYMENT',
      plan: paymentRecord.plan,
      durationLabel: paymentRecord.durationLabel,
      agreedPrice: total,
      discount: disc,
      finalAmount: finalAmt,
      amountPaid: paid,
      remainingBalance: shop.remainingBalance,
      expiryAt: shop.expiryAt,
      notes: notes || `Receipt ${receiptNumber} (${paymentMethod})`,
      actor: actorEmail,
    });
    persistSubscriptions();

    recordAuditLog(
      'PAYMENT_RECORDED',
      actorEmail,
      'SUPER_ADMIN',
      `Recorded PKR ${paid.toLocaleString()} (Disc: PKR ${disc}, Due Left: PKR ${shopNewRemaining}) for ${shop.shopName} (${shop.id}) via ${paymentMethod} — Receipt: ${receiptNumber}`,
      shop.id,
      req.ip
    );

    return res.json({ success: true, payment: paymentRecord, shop });
  }

  app.post('/api/super-admin/payments', requireSuperAdmin, handleRecordPayment);
  app.post('/api/subscriptions/payments', requireSuperAdmin, handleRecordPayment);

  function handleUpdatePayment(req: Request, res: Response) {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const payment = subscriptionsDb.payments.find((p) => p.id === id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found.' });
    }
    const shop = subscriptionsDb.shops.find((s) => s.id === payment.shopId);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Associated Mart account not found.' });
    }

    const { totalAmount, discount, amountPaid, paymentMethod, paymentDate, transactionReference, notes } = req.body || {};
    const parsedTotal = parseNonNegativeInput(totalAmount, payment.totalAmount);
    const parsedDisc = parseNonNegativeInput(discount, payment.discount || 0);
    const parsedPaid = parseNonNegativeInput(amountPaid, payment.amountPaid);

    if (!parsedTotal.ok || !parsedDisc.ok || !parsedPaid.ok) {
      return res.status(400).json({ success: false, message: 'Amounts must be valid non-negative numbers.' });
    }
    if (parsedDisc.value > parsedTotal.value) {
      return res.status(400).json({ success: false, message: 'Discount cannot exceed Total Amount.' });
    }
    const newFinal = roundMoney(Math.max(0, parsedTotal.value - parsedDisc.value));
    if (parsedPaid.value > newFinal) {
      return res.status(400).json({ success: false, message: 'Amount Paid cannot exceed Final Payable Amount.' });
    }

    const oldFinal = payment.finalAmount || 0;
    const oldPaid = payment.amountPaid || 0;
    const oldDisc = payment.discount || 0;

    payment.totalAmount = parsedTotal.value;
    payment.discount = parsedDisc.value;
    payment.finalAmount = newFinal;
    payment.amountPaid = parsedPaid.value;
    payment.remainingBalance = roundMoney(Math.max(0, newFinal - parsedPaid.value));
    payment.status =
      payment.remainingBalance === 0 ? 'Paid' : payment.amountPaid > 0 ? 'Partially Paid' : 'Unpaid';
    if (paymentMethod) payment.paymentMethod = paymentMethod;
    if (paymentDate) payment.paymentDate = paymentDate;
    if (transactionReference !== undefined) payment.transactionReference = transactionReference || undefined;
    if (notes !== undefined) payment.notes = notes || undefined;
    const actorEmail = saSession?.email || saSession?.fullName || 'superadmin';
    payment.updatedAt = new Date().toISOString();
    payment.updatedBy = actorEmail;

    // Adjust shop ledger aggregates cleanly
    const deltaPaid = roundMoney(payment.amountPaid - oldPaid);
    const deltaFinal = roundMoney(payment.finalAmount - oldFinal);
    const deltaDisc = roundMoney(payment.discount - oldDisc);

    shop.totalPaid = roundMoney(Math.max(0, (shop.totalPaid || 0) + deltaPaid));
    shop.discount = roundMoney(Math.max(0, (shop.discount || 0) + deltaDisc));
    if (payment.paymentMode === 'balance_settlement') {
      shop.remainingBalance = roundMoney(Math.max(0, (shop.remainingBalance || 0) - deltaPaid - deltaDisc));
    } else {
      shop.totalIncome = roundMoney(Math.max(0, (shop.totalIncome || 0) + deltaFinal));
      shop.remainingBalance = roundMoney(Math.max(0, (shop.remainingBalance || 0) + deltaFinal - deltaPaid));
    }
    shop.paymentStatus =
      shop.remainingBalance <= 0 ? 'Paid' : (shop.totalPaid || 0) > 0 ? 'Partially Paid' : 'Unpaid';
    if (payment.amountPaid > 0) {
      shop.lastPaymentDate = payment.paymentDate;
    }

    recordSubscriptionLifecycle({
      shopId: shop.id,
      shopName: shop.shopName,
      eventType: 'PAYMENT_UPDATED',
      plan: payment.plan,
      durationLabel: payment.durationLabel,
      agreedPrice: payment.totalAmount,
      discount: payment.discount,
      finalAmount: payment.finalAmount,
      amountPaid: payment.amountPaid,
      remainingBalance: shop.remainingBalance,
      expiryAt: shop.expiryAt,
      notes: `Updated receipt ${payment.receiptNumber}: Paid PKR ${oldPaid} -> PKR ${payment.amountPaid}`,
      actor: actorEmail,
    });

    persistSubscriptions();
    recordAuditLog(
      'PAYMENT_UPDATED',
      actorEmail,
      'SUPER_ADMIN',
      `Updated payment receipt ${payment.receiptNumber} for ${shop.shopName} (${shop.id}): Paid PKR ${oldPaid} -> PKR ${payment.amountPaid}, Due: PKR ${shop.remainingBalance}`,
      shop.id,
      req.ip
    );

    return res.json({ success: true, payment, shop });
  }

  app.put('/api/super-admin/payments/:id', requireSuperAdmin, handleUpdatePayment);
  app.put('/api/subscriptions/payments/:id', requireSuperAdmin, handleUpdatePayment);

  function handleRenewSubscription(req: Request, res: Response) {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const {
      shopId,
      plan,
      hoursCount,
      additionalDays,
      additionalHours,
      agreedPrice,
      discount = 0,
      amountPaid,
      amount,
      manualExpiryAt,
      startMode = 'extend_current',
      paymentMethod = 'Cash',
      transactionReference,
      notes,
    } = req.body || {};

    const shop = subscriptionsDb.shops.find((s) => s.id === shopId);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    const targetPlan: SubscriptionPlanType = plan || shop.plan || '1_day';
    const prevPlan = shop.plan;
    const prevExpiry = shop.expiryDate;
    const prevExpiryAt = shop.expiryAt || null;

    const nowMs = Date.now();
    const currentExpMs = resolveShopExpiryMs(shop);
    const baseMs =
      startMode === 'now' || targetPlan === 'lifetime'
        ? nowMs
        : currentExpMs && currentExpMs > nowMs
        ? currentExpMs
        : nowMs;

    const resolvedPaid = amountPaid !== undefined ? amountPaid : amount;
    const calc = computeSubscriptionTimingAndBilling({
      plan: targetPlan,
      hoursCount,
      additionalDays,
      additionalHours,
      agreedPrice,
      discount,
      amountPaid: resolvedPaid,
      baseMs,
      manualExpiryAt,
    });
    if (!calc.ok) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_RENEWAL_INPUT',
        message: calc.message,
      });
    }

    shop.plan = calc.plan;
    shop.isLifetime = calc.isLifetime;
    shop.hoursCount = calc.hoursCount;
    shop.hourlyRateApplied = calc.hourlyRateApplied;
    shop.agreedPrice = calc.agreedPrice;
    shop.discount = roundMoney((shop.discount || 0) + calc.discount);
    shop.finalPrice = calc.finalAmount;
    shop.activationAt = calc.activationAt;
    shop.startDate = calc.startDate;
    shop.expiryAt = calc.expiryAt;
    shop.expiryDate = calc.expiryDate;
    shop.status = 'active';
    shop.renewalsCount = (shop.renewalsCount || 0) + 1;
    shop.totalIncome = roundMoney((shop.totalIncome || 0) + calc.finalAmount);
    shop.totalPaid = roundMoney((shop.totalPaid || 0) + calc.amountPaid);
    shop.remainingBalance = roundMoney((shop.remainingBalance || 0) + calc.remainingBalance);
    shop.paymentStatus =
      shop.remainingBalance <= 0 ? 'Paid' : shop.totalPaid > 0 ? 'Partially Paid' : 'Unpaid';

    const nowIso = new Date().toISOString();
    const todayDate = nowIso.split('T')[0];
    if (calc.amountPaid > 0) {
      shop.lastPaymentDate = todayDate;
    }

    const receiptNumber = `RCP-${crypto.randomInt(1000, 9999)}`;
    const actorEmail = saSession?.email || saSession?.fullName || 'superadmin';
    const actorName = saSession?.fullName || 'Super Admin';

    const renewalRecord: SubscriptionRenewalRecord = {
      id: `REN-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      shopId: shop.id,
      shopName: shop.shopName,
      plan: calc.plan,
      previousPlan: prevPlan,
      durationDays: calc.durationDays,
      durationLabel: calc.durationLabel,
      hoursCount: calc.hoursCount,
      hourlyRateApplied: calc.hourlyRateApplied,
      isLifetime: calc.isLifetime,
      previousExpiry: prevExpiry,
      newExpiry: calc.expiryDate,
      previousExpiryAt: prevExpiryAt,
      newExpiryAt: calc.expiryAt,
      paymentReceiptNumber: receiptNumber,
      agreedPrice: calc.agreedPrice,
      discount: calc.discount,
      finalAmount: calc.finalAmount,
      amountPaid: calc.amountPaid,
      remainingBalance: calc.remainingBalance,
      amount: calc.amountPaid,
      notes: notes ? String(notes).trim() : undefined,
      renewedAt: nowIso,
      confirmedBy: actorName,
    };
    subscriptionsDb.renewals.unshift(renewalRecord);

    let createdPayment: SubscriptionPaymentRecord | undefined;
    if (calc.finalAmount > 0 || calc.amountPaid > 0) {
      createdPayment = {
        id: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        receiptNumber,
        shopId: shop.id,
        shopName: shop.shopName,
        ownerName: shop.ownerName,
        ownerEmail: shop.email,
        plan: calc.plan,
        durationLabel: `${calc.durationLabel} Renewal`,
        hoursCount: calc.hoursCount,
        hourlyRateApplied: calc.hourlyRateApplied,
        paymentMode: 'renewal',
        totalAmount: calc.agreedPrice,
        discount: calc.discount,
        finalAmount: calc.finalAmount,
        amountPaid: calc.amountPaid,
        remainingBalance: calc.remainingBalance,
        paymentMethod: (paymentMethod as any) || 'Cash',
        paymentDate: todayDate,
        transactionReference: transactionReference ? String(transactionReference).trim() : undefined,
        confirmedBy: actorName,
        notes: notes ? String(notes).trim() : 'Subscription renewal',
        status: calc.paymentStatus,
        createdAt: nowIso,
      };
      subscriptionsDb.payments.unshift(createdPayment);
    }

    recordSubscriptionLifecycle({
      shopId: shop.id,
      shopName: shop.shopName,
      eventType: prevPlan !== calc.plan ? 'PLAN_CHANGED' : 'RENEWED',
      plan: calc.plan,
      durationLabel: calc.durationLabel,
      agreedPrice: calc.agreedPrice,
      discount: calc.discount,
      finalAmount: calc.finalAmount,
      amountPaid: calc.amountPaid,
      remainingBalance: shop.remainingBalance,
      expiryAt: calc.expiryAt,
      notes: notes
        ? String(notes).trim()
        : `Renewed (${prevPlan} -> ${calc.plan}) · Expiry: ${calc.isLifetime ? 'LIFETIME — NO EXPIRY' : calc.expiryAt}`,
      actor: actorEmail,
    });

    persistSubscriptions();
    recordAuditLog(
      'SUBSCRIPTION_RENEWED',
      actorEmail,
      'SUPER_ADMIN',
      `Renewed ${shop.shopName} (${shop.id}): ${calc.durationLabel} · Final PKR ${calc.finalAmount} · Paid PKR ${calc.amountPaid} · New Expiry: ${calc.isLifetime ? 'LIFETIME' : calc.expiryAt}`,
      shop.id,
      req.ip
    );
    return res.json({ success: true, shop, renewal: renewalRecord, payment: createdPayment, receiptNumber });
  }

  app.post('/api/super-admin/shops/:id/extend-subscription', requireSuperAdmin, (req: Request, res: Response) => {
    req.body = { ...req.body, shopId: req.params.id };
    return handleRenewSubscription(req, res);
  });
  app.post('/api/subscriptions/renew', requireSuperAdmin, handleRenewSubscription);

  app.post('/api/super-admin/shops/:id/extend-expiry', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const shop = subscriptionsDb.shops.find((s) => s.id === id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found.' });
    }
    if (shop.isLifetime || shop.plan === 'lifetime') {
      return res.status(400).json({ success: false, message: 'Lifetime subscriptions do not expire and need no expiry extension.' });
    }

    const { addHours = 0, addDays = 0, manualExpiryAt, notes } = req.body || {};
    const hrs = Number(addHours) || 0;
    const days = Number(addDays) || 0;
    if (!manualExpiryAt && hrs <= 0 && days <= 0) {
      return res.status(400).json({ success: false, message: 'Specify positive hours/days or a custom expiry timestamp.' });
    }

    const nowMs = Date.now();
    const curMs = resolveShopExpiryMs(shop) || nowMs;
    const baseMs = Math.max(nowMs, curMs);
    let newExpMs = baseMs;
    if (manualExpiryAt) {
      const parsed = Date.parse(String(manualExpiryAt));
      if (Number.isNaN(parsed)) {
        return res.status(400).json({ success: false, message: 'Invalid custom expiry date/time.' });
      }
      newExpMs = parsed;
    } else {
      newExpMs = baseMs + Math.round((hrs * 60 * 60 * 1000) + (days * 24 * 60 * 60 * 1000));
    }

    const newExpIso = new Date(newExpMs).toISOString();
    shop.expiryAt = newExpIso;
    shop.expiryDate = newExpIso.split('T')[0];
    if (newExpMs > nowMs && (shop.status === 'expired' || shop.status === 'expiring_soon')) {
      shop.status = 'active';
    }

    const actorEmail = saSession?.email || saSession?.fullName || 'superadmin';
    recordSubscriptionLifecycle({
      shopId: shop.id,
      shopName: shop.shopName,
      eventType: 'EXTENDED',
      plan: shop.plan,
      expiryAt: newExpIso,
      notes: notes ? String(notes).trim() : `Expiry extended to ${newExpIso}`,
      actor: actorEmail,
    });
    persistSubscriptions();
    recordAuditLog(
      'SUBSCRIPTION_EXTENDED',
      actorEmail,
      'SUPER_ADMIN',
      `Extended expiry for ${shop.shopName} (${shop.id}) to ${newExpIso}`,
      shop.id,
      req.ip
    );
    return res.json({ success: true, shop });
  });

  app.get('/api/super-admin/devices', requireSuperAdmin, (_req: Request, res: Response) => {
    return res.json({ success: true, devices: buildSuperAdminOverviewPayload().devices });
  });

  app.post('/api/super-admin/devices/:id/revoke', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const target = registeredDevices.find((d) => d.deviceId === id);
    if (!target) return res.status(404).json({ success: false, message: 'Device not found.' });
    target.status = 'revoked';
    target.connectionState = 'offline';
    persistDevices();
    const targetShopId = target.shopId || 'SHOP-WM-001';
    recordAuditLog('DEVICE_REVOKED', saSession?.email || 'superadmin', 'SUPER_ADMIN', `Super Admin revoked device "${target.deviceName}" (${id})`, targetShopId, req.ip);
    broadcastSyncEventToShop(targetShopId, { type: 'device:revoked', sourceDeviceId: id, timestamp: Date.now(), payload: { deviceId: id } });
    for (const [cid, client] of sseClients.entries()) {
      if (client.deviceId === id) {
        try { client.res.end(); } catch {}
        sseClients.delete(cid);
      }
    }
    broadcastSyncEventToShop(targetShopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: registeredDevices.filter((d) => d.shopId === targetShopId).map((d) => ({ ...d, sessionToken: undefined })),
    });
    return res.json({ success: true, message: 'Device revoked.' });
  });

  app.post('/api/super-admin/devices/:id/restore', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const target = registeredDevices.find((d) => d.deviceId === id);
    if (!target) return res.status(404).json({ success: false, message: 'Device not found.' });
    target.status = 'active';
    removedDeviceIds.delete(id);
    persistDevices();
    const targetShopId = target.shopId || 'SHOP-WM-001';
    recordAuditLog('DEVICE_RESTORED', saSession?.email || 'superadmin', 'SUPER_ADMIN', `Super Admin restored device "${target.deviceName}" (${id})`, targetShopId, req.ip);
    broadcastSyncEventToShop(targetShopId, {
      type: 'device:updated',
      timestamp: Date.now(),
      payload: registeredDevices.filter((d) => d.shopId === targetShopId).map((d) => ({ ...d, sessionToken: undefined })),
    });
    return res.json({ success: true, message: 'Device restored.' });
  });

  app.delete('/api/super-admin/devices/:id', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const { id } = req.params;
    const target = registeredDevices.find((d) => d.deviceId === id);
    if (!target) return res.status(404).json({ success: false, message: 'Device not found.' });
    const targetShopId = target.shopId || 'SHOP-WM-001';
    registeredDevices = registeredDevices.filter((d) => d.deviceId !== id);
    removedDeviceIds.add(id);
    persistDevices();
    recordAuditLog('DEVICE_REMOVED', saSession?.email || 'superadmin', 'SUPER_ADMIN', `Super Admin removed device "${target.deviceName}" (${id})`, targetShopId, req.ip);
    broadcastSyncEventToShop(targetShopId, { type: 'device:revoked', timestamp: Date.now(), payload: { deviceId: id } });
    for (const [cid, client] of sseClients.entries()) {
      if (client.deviceId === id) {
        try { client.res.end(); } catch {}
        sseClients.delete(cid);
      }
    }
    return res.json({ success: true, message: 'Device removed.' });
  });

  app.get('/api/super-admin/audit-logs', requireSuperAdmin, (_req: Request, res: Response) => {
    return res.json({ success: true, logs: auditLogs });
  });

  app.post('/api/super-admin/sessions/revoke-others', requireSuperAdmin, (req: Request, res: Response) => {
    const currentTok = extractSessionTokenFromReq(req);
    const currentSess = (req as any).superAdminSession as AuthSessionData;
    let revoked = 0;
    for (const [tok, sess] of Object.entries(authDb.sessions)) {
      if (sess.role === 'SUPER_ADMIN' && tok !== currentTok) {
        delete authDb.sessions[tok];
        revoked += 1;
      }
    }
    authDb.revokedBefore = authDb.revokedBefore || {};
    authDb.revokedBefore[currentSess.userId] = currentSess.createdAt;
    persistAuthDb();

    recordAuditLog(
      'SUPER_ADMIN_SESSIONS_REVOKED',
      currentSess?.email || 'superadmin',
      'SUPER_ADMIN',
      `Revoked ${revoked} other active Super Admin session(s).`,
      undefined,
      req.ip
    );
    return res.json({ success: true, message: `Terminated ${revoked} other Super Admin session(s).` });
  });

  app.get('/api/settings/mart-owner', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopId = actor.shopId;
    const shopStore = await ensureShopStoreHydratedFromKv(shopId);
    const isSuperAdminPos = shopId === SUPER_ADMIN_POS_SHOP_ID;
    return res.json({
      success: true,
      martOwner: shopStore.martOwner || {
        martName: shopStore.branding.storeName || (isSuperAdminPos ? 'MY POS APP' : 'WAQAS MART'),
        badge: isSuperAdminPos ? 'SUPER ADMIN POS' : 'MART OWNER',
        ownerName: shopStore.userProfile.displayName || (isSuperAdminPos ? 'Muhammad Saad' : 'Shop Owner'),
        designation: isSuperAdminPos ? 'Super Admin Personal POS' : 'Proprietor & Manager',
        mobileNumber: shopStore.userProfile.phone || '03228570782',
        whatsappNumber: shopStore.userProfile.phone || '03228570782',
        address: isSuperAdminPos ? 'Super Admin Personal Terminal' : 'Commercial Market, Pakistan',
        photoUrl: isSuperAdminPos
          ? '/5c454cea45cc8c39a24b57a83fbbc5cf_0.webp'
          : '/assets/aistudio/female_owner_portrait.svg',
      },
      softwareOwner: {
        name: 'Muhammad Waqas',
        designation: 'WAQAS POS SOFTWARE',
        whatsapp: '03228570782',
        mobile: '03429634133',
        photoUrl: '/5c454cea45cc8c39a24b57a83fbbc5cf_0.webp',
        isPermanentlyLocked: true,
      },
    });
  }));

  app.post('/api/settings/mart-owner', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const { martName, ownerName, designation, mobileNumber, whatsappNumber, address, photoUrl } = req.body || {};
    shopStore.martOwner = {
      martName: martName || shopStore.branding.storeName || 'WAQAS MART',
      badge: 'MART OWNER',
      ownerName: ownerName || shopStore.userProfile.displayName || 'Shop Owner',
      designation: designation || 'Proprietor & Manager',
      mobileNumber: mobileNumber || '03228570782',
      whatsappNumber: whatsappNumber || mobileNumber || '03228570782',
      address: address || '',
      photoUrl: photoUrl || '/assets/aistudio/female_owner_portrait.svg',
    };
    persistShopStore(actor.shopId);
    broadcastSyncEventToShop(actor.shopId, {
      type: 'store:sync',
      timestamp: Date.now(),
      payload: shopStore,
    });
    return res.json({ success: true, martOwner: shopStore.martOwner });
  }));

  app.get('/api/super-admin/backup/export', requireSuperAdmin, (_req: Request, res: Response) => {
    const allShopData: Record<string, any> = {};
    if (fs.existsSync(SHOPS_DIR)) {
      const files = fs.readdirSync(SHOPS_DIR);
      for (const f of files) {
        if (f.endsWith('.json')) {
          const sId = f.replace('.json', '');
          try {
            allShopData[sId] = JSON.parse(fs.readFileSync(path.join(SHOPS_DIR, f), 'utf-8'));
          } catch {}
        }
      }
    }
    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      version: '3.0-multishop',
      superAdmin: authDb.superAdmin
        ? { id: authDb.superAdmin.id, gmail: authDb.superAdmin.gmail, mobile: authDb.superAdmin.mobile, fullName: authDb.superAdmin.fullName }
        : null,
      shops: subscriptionsDb.shops,
      shopDatabases: allShopData,
      payments: subscriptionsDb.payments,
      renewals: subscriptionsDb.renewals,
      defaultPricing: normalizeDefaultPricing(subscriptionsDb.defaultPricing),
      pricingHistory: subscriptionsDb.pricingHistory || [],
      subscriptionHistory: subscriptionsDb.subscriptionHistory || [],
      auditLogs,
      devices: registeredDevices.map((d) => ({ ...d, sessionToken: undefined })),
    });
  });

  app.post('/api/super-admin/backup/import', requireSuperAdmin, (req: Request, res: Response) => {
    const saSession = (req as any).superAdminSession as AuthSessionData;
    const restoredData = req.body?.restoredData || req.body?.data || req.body;
    if (!restoredData || typeof restoredData !== 'object') {
      return res.status(400).json({ success: false, message: 'Invalid backup payload.' });
    }

    const safetyDir = path.join(DATA_DIR, 'backups', `safety_before_restore_${Date.now()}`);
    try {
      fs.mkdirSync(safetyDir, { recursive: true });
      if (fs.existsSync(AUTH_DB_FILE)) fs.copyFileSync(AUTH_DB_FILE, path.join(safetyDir, 'auth_db.json'));
      if (fs.existsSync(STORE_DB_FILE)) fs.copyFileSync(STORE_DB_FILE, path.join(safetyDir, 'store_db.json'));
      if (fs.existsSync(SUBSCRIPTIONS_DB_FILE)) fs.copyFileSync(SUBSCRIPTIONS_DB_FILE, path.join(safetyDir, 'subscriptions_db.json'));
      pruneOldSafetyBackups(10);
    } catch {}

    if (Array.isArray(restoredData.shops)) {
      subscriptionsDb.shops = restoredData.shops;
    }
    if (Array.isArray(restoredData.payments)) {
      subscriptionsDb.payments = restoredData.payments;
    }
    if (Array.isArray(restoredData.renewals)) {
      subscriptionsDb.renewals = restoredData.renewals;
    }
    if (restoredData.defaultPricing) {
      subscriptionsDb.defaultPricing = normalizeDefaultPricing(restoredData.defaultPricing);
    }
    if (Array.isArray(restoredData.pricingHistory)) {
      subscriptionsDb.pricingHistory = restoredData.pricingHistory;
    }
    if (Array.isArray(restoredData.subscriptionHistory)) {
      subscriptionsDb.subscriptionHistory = restoredData.subscriptionHistory;
    }
    subscriptionsDb = normalizeSubscriptionsData(subscriptionsDb);
    persistSubscriptions();

    if (restoredData.shopDatabases && typeof restoredData.shopDatabases === 'object') {
      for (const [sId, sData] of Object.entries(restoredData.shopDatabases)) {
        setShopStore(sId, sData as StoreData);
        broadcastSyncEventToShop(sId, {
          type: 'store:sync',
          timestamp: Date.now(),
          payload: getShopStore(sId),
        });
      }
    }

    recordAuditLog('SYSTEM_BACKUP_RESTORED', saSession?.email || 'superadmin', 'SUPER_ADMIN', 'Super Admin restored multi-shop system backup.', undefined, req.ip);
    return res.json({ success: true, message: 'System backup restored across shops.' });
  });

  app.get('/api/shop/backup/export', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !actor.permissions?.settings) {
      return res.status(403).json({ success: false, message: 'Backup export requires Settings permission.' });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const shopMeta = subscriptionsDb.shops.find((s) => s.id === actor.shopId);
    return res.json({
      success: true,
      backup: {
        softwareName: 'WAQAS POS SOFTWARE',
        exportedAt: new Date().toISOString(),
        shopId: actor.shopId,
        martName: shopMeta?.shopName || shopStore.branding.storeName,
        storeDb: {
          ...shopStore,
          appLock: undefined,
          cctvCameras: (shopStore.cctvCameras || []).map((cam) => sanitizeCameraForClient(cam, DATA_DIR)),
          dvrConfig: sanitizeDvrConfigForClient(shopStore.dvrConfig),
          cctvSettings: sanitizeCctvSettingsForClient(shopStore.cctvSettings),
        },
      },
    });
  }));

  app.post('/api/shop/backup/import', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !actor.permissions?.settings) {
      return res.status(403).json({ success: false, message: 'Backup restore requires Settings permission.' });
    }

    const restoredData = req.body?.restoredData || req.body?.data || req.body;
    if (!restoredData || typeof restoredData !== 'object') {
      return res.status(400).json({ success: false, message: 'Invalid backup payload.' });
    }

    const shopId = actor.shopId;
    const current = await ensureShopStoreHydratedFromKv(shopId);
    const safetyDir = path.join(DATA_DIR, 'backups', `safety_shop_${shopId}_${Date.now()}`);
    try {
      fs.mkdirSync(safetyDir, { recursive: true });
      const f = getShopStoreFile(shopId);
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(safetyDir, `${shopId}.json`));
      pruneOldSafetyBackups(10);
    } catch {}

    const sourceStore = restoredData.storeDb || restoredData.store || restoredData;
    const updated = setShopStore(shopId, {
      ...current,
      products: Array.isArray(sourceStore.products) ? sourceStore.products : current.products,
      transactions: Array.isArray(sourceStore.transactions) ? sourceStore.transactions : current.transactions,
      purchases: Array.isArray(sourceStore.purchases) ? sourceStore.purchases : current.purchases,
      customers: Array.isArray(sourceStore.customers) ? sourceStore.customers : current.customers,
      customerLedgers: Array.isArray(sourceStore.customerLedgerEntries)
        ? sourceStore.customerLedgerEntries
        : Array.isArray(sourceStore.customerLedgers)
        ? sourceStore.customerLedgers
        : current.customerLedgers,
      suppliers: Array.isArray(sourceStore.suppliers) ? sourceStore.suppliers : current.suppliers,
      supplierLedgers: Array.isArray(sourceStore.supplierLedgers) ? sourceStore.supplierLedgers : current.supplierLedgers,
      saleReturns: Array.isArray(sourceStore.saleReturns) ? sourceStore.saleReturns : current.saleReturns,
      purchaseReturns: Array.isArray(sourceStore.purchaseReturns) ? sourceStore.purchaseReturns : current.purchaseReturns,
      expenses: Array.isArray(sourceStore.expenses) ? sourceStore.expenses : current.expenses,
      staffList: Array.isArray(sourceStore.staffList) ? sourceStore.staffList : current.staffList,
      stockHistory: Array.isArray(sourceStore.stockHistory) ? sourceStore.stockHistory : current.stockHistory,
      dailyHisab: sourceStore.dailyHisab || current.dailyHisab,
      categories: Array.isArray(sourceStore.categories) ? sourceStore.categories : current.categories,
      branding: sourceStore.branding || current.branding,
      priceSearchHistory: Array.isArray(sourceStore.priceSearchHistory)
        ? sourceStore.priceSearchHistory
        : current.priceSearchHistory,
      priceSearchFavourites: Array.isArray(sourceStore.priceSearchFavourites)
        ? sourceStore.priceSearchFavourites
        : current.priceSearchFavourites,
      priceSearchComparisons: Array.isArray(sourceStore.priceSearchComparisons)
        ? sourceStore.priceSearchComparisons
        : current.priceSearchComparisons,
    });

    recordAuditLog('SHOP_BACKUP_RESTORED', actor.actorEmail, actor.role, `Restored backup for shop ${shopId}`, shopId, req.ip);

    broadcastSyncEventToShop(shopId, {
      type: 'store:sync',
      timestamp: Date.now(),
      payload: updated,
    });

    return res.json({ success: true, message: 'Shop backup restored & synchronized.', store: updated });
  }));

  app.get('/api/security/overview', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopId = actor.shopId;
    const shopDevs = registeredDevices.filter((d) => (d.shopId || 'SHOP-WM-001') === shopId);
    const shopStore = await ensureShopStoreHydratedFromKv(shopId);
    const shopSseCount = Array.from(sseClients.values()).filter((c) => c.shopId === shopId).length;
    const shopAudit = auditLogs.filter((l) => !l.shopId || l.shopId === shopId).slice(0, 60);

    return res.json({
      success: true,
      deviceAuthorized: true,
      activeDevicesCount: shopDevs.filter((d) => d.status === 'active').length,
      revokedDevicesCount: shopDevs.filter((d) => d.status === 'revoked').length,
      connectedSseClients: shopSseCount,
      syncVersion: shopStore.syncVersion || 1,
      auditLogs: shopAudit,
      appLock: toPublicAppLockConfig(shopStore.appLock),
    });
  }));

  // -------------------------------------------------------------
  // APP LOCK, REAL WEBAUTHN BIOMETRIC & EXIT SECURITY ENDPOINTS
  // -------------------------------------------------------------
  interface AppLockChallengeEntry {
    challenge: string;
    shopId: string;
    type: 'register' | 'auth';
    rpId: string;
    origin: string;
    userId: string;
    createdAt: number;
  }
  const appLockChallenges = new Map<string, AppLockChallengeEntry>();

  const pruneAppLockChallenges = () => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of appLockChallenges.entries()) {
      if (v.createdAt < cutoff) appLockChallenges.delete(k);
    }
  };

  const resolveRpContextFromReq = (req: Request): { rpId: string; expectedOrigin: string } => {
    const rawOrigin = String(req.headers.origin || '').trim();
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    if (rawOrigin) {
      try {
        const u = new URL(rawOrigin);
        return { rpId: u.hostname, expectedOrigin: u.origin };
      } catch {}
    }
    const hostname = rawHost.split(':')[0] || 'localhost';
    return { rpId: hostname, expectedOrigin: `${proto}://${rawHost}` };
  };

  const base64UrlToBuffer = (b64u: string): Buffer => {
    const norm = String(b64u || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (norm.length % 4)) % 4;
    return Buffer.from(norm + '='.repeat(pad), 'base64');
  };

  const isAppLockOwnerOrSuperAdmin = (actor: ResolvedActor): boolean =>
    actor.role === 'SHOP_OWNER' || actor.role === 'SUPER_ADMIN';

  const hasAnyConfiguredAppLockMethod = (cfg: AppLockStoredConfig): boolean =>
    Boolean((cfg.pinHash && cfg.pinSalt) || (cfg.passwordHash && cfg.passwordSalt) || (cfg.webauthnCredentials?.length || 0) > 0);

  const checkAppLockCooldown = (cfg: AppLockStoredConfig): { blocked: boolean; retryAfterSec: number } => {
    if (!cfg.lockedOutUntil) return { blocked: false, retryAfterSec: 0 };
    const untilMs = Date.parse(cfg.lockedOutUntil);
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return { blocked: false, retryAfterSec: 0 };
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((untilMs - Date.now()) / 1000)) };
  };

  const recordAppLockFailure = (shopId: string, cfg: AppLockStoredConfig, actor: ResolvedActor, reason: string) => {
    const nextFails = (cfg.failedAttempts || 0) + 1;
    cfg.failedAttempts = nextFails;
    cfg.lastFailedAt = new Date().toISOString();
    if (nextFails >= 5) {
      cfg.lockedOutUntil = new Date(Date.now() + 30 * 1000).toISOString();
    }
    cfg.updatedAt = new Date().toISOString();
    const targetStore = getShopStore(shopId);
    targetStore.appLock = cfg;
    persistShopStore(shopId, false);
    recordAuditLog('APP_LOCK_FAILED_ATTEMPT', actor.actorEmail, actor.role, `${reason} (Attempt #${nextFails})`, shopId);
  };

  const clearAppLockFailures = (cfg: AppLockStoredConfig) => {
    cfg.failedAttempts = 0;
    cfg.lockedOutUntil = undefined;
  };

  const verifyOwnerOrSuperAdminAccountPassword = (actor: ResolvedActor, accountPassword: string): boolean => {
    if (!accountPassword) return false;
    if (actor.role === 'SUPER_ADMIN' && authDb.superAdmin) {
      return verifyPasswordRecord(accountPassword, authDb.superAdmin.passwordSalt, authDb.superAdmin.passwordHash);
    }
    const shopOwners = authDb.users.filter((u) => u.shopId === actor.shopId && u.role === 'SHOP_OWNER');
    return shopOwners.some((owner) => verifyPassword(accountPassword, owner));
  };

  const verifyAssertionSignatureWithSpki = (
    spkiBase64: string,
    signedBytes: Buffer,
    signatureBuf: Buffer
  ): boolean => {
    try {
      const spkiDer = Buffer.from(spkiBase64, 'base64');
      const keyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
      const keyType = keyObj.asymmetricKeyType;
      if (keyType === 'ec') {
        if (crypto.verify('sha256', signedBytes, keyObj, signatureBuf)) return true;
        if (crypto.verify('sha256', signedBytes, { key: keyObj, dsaEncoding: 'ieee-p1363' }, signatureBuf)) return true;
        return false;
      }
      if (keyType === 'rsa' || keyType === 'rsa-pss') {
        return crypto.verify('sha256', signedBytes, keyObj, signatureBuf);
      }
      if (keyType === 'ed25519') {
        return crypto.verify(null, signedBytes, keyObj, signatureBuf);
      }
      return crypto.verify('sha256', signedBytes, keyObj, signatureBuf);
    } catch {
      return false;
    }
  };

  app.get('/api/app-lock/status', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    shopStore.appLock = normalizeAppLockConfig(shopStore.appLock);
    return res.json({
      success: true,
      shopId: actor.shopId,
      canConfigure: isAppLockOwnerOrSuperAdmin(actor),
      config: toPublicAppLockConfig(shopStore.appLock),
    });
  }));

  app.post('/api/app-lock/settings', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!isAppLockOwnerOrSuperAdmin(actor)) {
      return res.status(403).json({
        success: false,
        message: 'Only authorized Mart Owner or Super Admin can modify App Lock settings.',
      });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);
    const body = req.body || {};

    if (typeof body.enabled === 'boolean') {
      if (body.enabled && !hasAnyConfiguredAppLockMethod(cfg)) {
        return res.status(400).json({
          success: false,
          message: 'Please set a PIN, Password, or Fingerprint before enabling App Lock.',
        });
      }
      cfg.enabled = body.enabled;
    }
    if (VALID_APP_LOCK_TIMEOUTS.includes(body.autoLockTimeout)) {
      cfg.autoLockTimeout = body.autoLockTimeout;
    }
    if (VALID_APP_LOCK_METHODS.includes(body.defaultUnlockMethod)) {
      cfg.defaultUnlockMethod = body.defaultUnlockMethod;
    }
    if (typeof body.requireAuthOnExit === 'boolean') {
      cfg.requireAuthOnExit = body.requireAuthOnExit;
    }
    if (typeof body.requireAuthOnReopen === 'boolean') {
      cfg.requireAuthOnReopen = body.requireAuthOnReopen;
    }
    if (body.resetFailedAttempts === true) {
      clearAppLockFailures(cfg);
    }

    cfg.updatedAt = new Date().toISOString();
    shopStore.appLock = cfg;
    persistShopStore(actor.shopId, false);
    recordAuditLog(
      'APP_LOCK_SETTINGS_UPDATED',
      actor.actorEmail,
      actor.role,
      `App Lock ${cfg.enabled ? 'enabled' : 'disabled'} · timeout=${cfg.autoLockTimeout} · exitAuth=${cfg.requireAuthOnExit}`,
      actor.shopId,
      req.ip
    );

    return res.json({ success: true, config: toPublicAppLockConfig(cfg) });
  }));

  app.post('/api/app-lock/pin', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!isAppLockOwnerOrSuperAdmin(actor)) {
      return res.status(403).json({ success: false, message: 'Only Mart Owner or Super Admin can configure App Lock PIN.' });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);
    const { currentPin, pin, confirmPin, remove } = req.body || {};

    if (cfg.pinHash && cfg.pinSalt) {
      if (!currentPin || !verifyPasswordRecord(String(currentPin), cfg.pinSalt, cfg.pinHash)) {
        return res.status(401).json({ success: false, message: 'Current PIN is incorrect.' });
      }
    }

    if (remove === true) {
      cfg.pinHash = undefined;
      cfg.pinSalt = undefined;
      cfg.pinLength = 4;
      if (cfg.enabled && !hasAnyConfiguredAppLockMethod(cfg)) {
        cfg.enabled = false;
      }
      if (cfg.defaultUnlockMethod === 'pin') {
        cfg.defaultUnlockMethod = cfg.webauthnCredentials.length > 0 ? 'fingerprint' : 'password';
      }
      cfg.updatedAt = new Date().toISOString();
      shopStore.appLock = cfg;
      persistShopStore(actor.shopId, false);
      recordAuditLog('APP_LOCK_PIN_REMOVED', actor.actorEmail, actor.role, 'App Lock PIN removed.', actor.shopId, req.ip);
      return res.json({ success: true, message: 'App Lock PIN removed.', config: toPublicAppLockConfig(cfg) });
    }

    const pinStr = String(pin || '').trim();
    const confirmStr = String(confirmPin || '').trim();
    if (!/^\d{4,12}$/.test(pinStr)) {
      return res.status(400).json({ success: false, message: 'PIN must be 4 to 12 digits (numbers only).' });
    }
    if (pinStr !== confirmStr) {
      return res.status(400).json({ success: false, message: 'PIN and Confirm PIN do not match.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    cfg.pinSalt = salt;
    cfg.pinHash = hashPassword(pinStr, salt);
    cfg.pinLength = pinStr.length;
    clearAppLockFailures(cfg);
    cfg.updatedAt = new Date().toISOString();
    shopStore.appLock = cfg;
    persistShopStore(actor.shopId, false);
    recordAuditLog('APP_LOCK_PIN_UPDATED', actor.actorEmail, actor.role, `App Lock ${pinStr.length}-digit PIN configured.`, actor.shopId, req.ip);

    return res.json({ success: true, message: 'App Lock PIN saved securely.', config: toPublicAppLockConfig(cfg) });
  }));

  app.post('/api/app-lock/password', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!isAppLockOwnerOrSuperAdmin(actor)) {
      return res.status(403).json({ success: false, message: 'Only Mart Owner or Super Admin can configure App Lock Password.' });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);
    const { currentPassword, password, confirmPassword, remove } = req.body || {};

    if (cfg.passwordHash && cfg.passwordSalt) {
      if (!currentPassword || !verifyPasswordRecord(String(currentPassword), cfg.passwordSalt, cfg.passwordHash)) {
        return res.status(401).json({ success: false, message: 'Current App Lock Password is incorrect.' });
      }
    }

    if (remove === true) {
      cfg.passwordHash = undefined;
      cfg.passwordSalt = undefined;
      if (cfg.enabled && !hasAnyConfiguredAppLockMethod(cfg)) {
        cfg.enabled = false;
      }
      if (cfg.defaultUnlockMethod === 'password') {
        cfg.defaultUnlockMethod = cfg.webauthnCredentials.length > 0 ? 'fingerprint' : 'pin';
      }
      cfg.updatedAt = new Date().toISOString();
      shopStore.appLock = cfg;
      persistShopStore(actor.shopId, false);
      recordAuditLog('APP_LOCK_PASSWORD_REMOVED', actor.actorEmail, actor.role, 'App Lock Password removed.', actor.shopId, req.ip);
      return res.json({ success: true, message: 'App Lock Password removed.', config: toPublicAppLockConfig(cfg) });
    }

    const pwdStr = String(password || '');
    const confirmStr = String(confirmPassword || '');
    if (pwdStr.length < 4) {
      return res.status(400).json({ success: false, message: 'App Lock Password must be at least 4 characters.' });
    }
    if (pwdStr !== confirmStr) {
      return res.status(400).json({ success: false, message: 'Password and Confirm Password do not match.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    cfg.passwordSalt = salt;
    cfg.passwordHash = hashPassword(pwdStr, salt);
    clearAppLockFailures(cfg);
    cfg.updatedAt = new Date().toISOString();
    shopStore.appLock = cfg;
    persistShopStore(actor.shopId, false);
    recordAuditLog('APP_LOCK_PASSWORD_UPDATED', actor.actorEmail, actor.role, 'App Lock Password updated.', actor.shopId, req.ip);

    return res.json({ success: true, message: 'App Lock Password saved securely.', config: toPublicAppLockConfig(cfg) });
  }));

  app.post('/api/app-lock/webauthn/register-options', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!isAppLockOwnerOrSuperAdmin(actor)) {
      return res.status(403).json({ success: false, message: 'Only Mart Owner or Super Admin can register biometric authenticators.' });
    }
    pruneAppLockChallenges();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);
    const { rpId, expectedOrigin } = resolveRpContextFromReq(req);
    const challengeId = `WCH-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const challenge = base64UrlEncode(crypto.randomBytes(32));
    const userIdBytes = base64UrlEncode(Buffer.from(`${actor.shopId}:${actor.actorEmail}`, 'utf8'));

    appLockChallenges.set(challengeId, {
      challenge,
      shopId: actor.shopId,
      type: 'register',
      rpId,
      origin: expectedOrigin,
      userId: actor.actorEmail,
      createdAt: Date.now(),
    });

    return res.json({
      success: true,
      challengeId,
      options: {
        challenge,
        rp: { name: 'WAQAS POS SOFTWARE', id: rpId },
        user: {
          id: userIdBytes,
          name: actor.actorEmail,
          displayName: shopStore.branding?.storeName || 'WAQAS POS Owner',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required',
        },
        excludeCredentials: (cfg.webauthnCredentials || []).map((c) => ({
          id: c.rawIdBase64Url,
          type: 'public-key',
          transports: c.transports || ['internal'],
        })),
      },
    });
  }));

  app.post('/api/app-lock/webauthn/register-verify', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!isAppLockOwnerOrSuperAdmin(actor)) {
      return res.status(403).json({ success: false, message: 'Only Mart Owner or Super Admin can register biometric authenticators.' });
    }
    const { challengeId, credential, deviceLabel, authenticatorType } = req.body || {};
    const entry = appLockChallenges.get(String(challengeId || ''));
    if (!entry || entry.type !== 'register' || entry.shopId !== actor.shopId) {
      return res.status(400).json({ success: false, message: 'Biometric registration session expired. Please try again.' });
    }
    appLockChallenges.delete(String(challengeId));

    if (!credential?.id || !credential?.rawId || !credential?.response?.clientDataJSON) {
      return res.status(400).json({ success: false, message: 'Invalid WebAuthn credential payload from browser.' });
    }

    let clientData: any;
    try {
      clientData = JSON.parse(base64UrlToBuffer(credential.response.clientDataJSON).toString('utf8'));
    } catch {
      return res.status(400).json({ success: false, message: 'Malformed WebAuthn clientDataJSON.' });
    }

    if (clientData.type !== 'webauthn.create' || clientData.challenge !== entry.challenge) {
      return res.status(400).json({ success: false, message: 'Biometric registration challenge verification failed.' });
    }

    if (credential.response.authenticatorData) {
      const authDataBuf = base64UrlToBuffer(credential.response.authenticatorData);
      if (authDataBuf.length >= 37) {
        const rpIdHash = authDataBuf.subarray(0, 32);
        const expectedRpHash = crypto.createHash('sha256').update(entry.rpId).digest();
        if (!crypto.timingSafeEqual(rpIdHash, expectedRpHash)) {
          return res.status(400).json({ success: false, message: 'WebAuthn RP ID verification mismatch.' });
        }
        const flags = authDataBuf[32];
        if ((flags & 0x01) === 0 || (flags & 0x04) === 0) {
          return res.status(400).json({ success: false, message: 'User verification (biometric/device unlock) was not confirmed.' });
        }
      }
    }

    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);

    const record: WebAuthnCredentialRecord = {
      id: String(credential.id),
      rawIdBase64Url: String(credential.rawId),
      publicKeySpkiBase64:
        typeof credential.response.publicKeySpkiBase64 === 'string' && credential.response.publicKeySpkiBase64.length > 0
          ? credential.response.publicKeySpkiBase64
          : undefined,
      alg: typeof credential.response.publicKeyAlgorithm === 'number' ? credential.response.publicKeyAlgorithm : -7,
      counter: 0,
      deviceLabel: String(deviceLabel || 'Device Biometric Sensor').trim().slice(0, 80),
      authenticatorType: String(authenticatorType || 'Platform Fingerprint / Biometric').trim().slice(0, 80),
      transports: Array.isArray(credential.response.transports) ? credential.response.transports : ['internal'],
      createdAt: new Date().toISOString(),
    };

    cfg.webauthnCredentials = [
      ...(cfg.webauthnCredentials || []).filter((c) => c.id !== record.id),
      record,
    ];
    cfg.updatedAt = new Date().toISOString();
    shopStore.appLock = cfg;
    persistShopStore(actor.shopId, false);
    recordAuditLog(
      'APP_LOCK_BIOMETRIC_REGISTERED',
      actor.actorEmail,
      actor.role,
      `Registered biometric authenticator: ${record.deviceLabel}`,
      actor.shopId,
      req.ip
    );

    return res.json({
      success: true,
      message: 'Fingerprint / Biometric authenticator registered successfully.',
      config: toPublicAppLockConfig(cfg),
    });
  }));

  app.delete('/api/app-lock/webauthn/:credId', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!isAppLockOwnerOrSuperAdmin(actor)) {
      return res.status(403).json({ success: false, message: 'Only Mart Owner or Super Admin can remove biometric authenticators.' });
    }
    const credId = decodeURIComponent(String(req.params.credId || ''));
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);
    cfg.webauthnCredentials = (cfg.webauthnCredentials || []).filter((c) => c.id !== credId);
    if (cfg.enabled && !hasAnyConfiguredAppLockMethod(cfg)) {
      cfg.enabled = false;
    }
    if (cfg.defaultUnlockMethod === 'fingerprint' && cfg.webauthnCredentials.length === 0) {
      cfg.defaultUnlockMethod = cfg.pinHash ? 'pin' : 'password';
    }
    cfg.updatedAt = new Date().toISOString();
    shopStore.appLock = cfg;
    persistShopStore(actor.shopId, false);
    recordAuditLog('APP_LOCK_BIOMETRIC_REMOVED', actor.actorEmail, actor.role, 'Removed registered biometric authenticator.', actor.shopId, req.ip);
    return res.json({ success: true, config: toPublicAppLockConfig(cfg) });
  }));

  app.post('/api/app-lock/webauthn/auth-options', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    pruneAppLockChallenges();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);
    if (!cfg.webauthnCredentials || cfg.webauthnCredentials.length === 0) {
      return res.status(400).json({ success: false, message: 'No registered Fingerprint / Biometric device found for this shop.' });
    }

    const { rpId, expectedOrigin } = resolveRpContextFromReq(req);
    const challengeId = `WAUTH-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const challenge = base64UrlEncode(crypto.randomBytes(32));

    appLockChallenges.set(challengeId, {
      challenge,
      shopId: actor.shopId,
      type: 'auth',
      rpId,
      origin: expectedOrigin,
      userId: actor.actorEmail,
      createdAt: Date.now(),
    });

    return res.json({
      success: true,
      challengeId,
      options: {
        challenge,
        rpId,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: cfg.webauthnCredentials.map((c) => ({
          id: c.rawIdBase64Url,
          type: 'public-key',
          transports: c.transports || ['internal'],
        })),
      },
    });
  }));

  app.post('/api/app-lock/webauthn/auth-verify', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);
    const cooldown = checkAppLockCooldown(cfg);
    if (cooldown.blocked) {
      return res.status(429).json({
        success: false,
        message: `Too many failed attempts. Please wait ${cooldown.retryAfterSec}s before trying again.`,
        config: toPublicAppLockConfig(cfg),
      });
    }

    const { challengeId, credential, context } = req.body || {};
    const entry = appLockChallenges.get(String(challengeId || ''));
    if (!entry || entry.type !== 'auth' || entry.shopId !== actor.shopId) {
      return res.status(400).json({ success: false, message: 'Biometric authentication challenge expired. Try again.' });
    }
    appLockChallenges.delete(String(challengeId));

    const matchedCred = (cfg.webauthnCredentials || []).find(
      (c) => c.id === credential?.id || c.rawIdBase64Url === credential?.rawId
    );
    if (!matchedCred) {
      recordAppLockFailure(actor.shopId, cfg, actor, 'Unrecognized WebAuthn credential');
      return res.status(401).json({
        success: false,
        message: 'Fingerprint credential does not match any registered device.',
        config: toPublicAppLockConfig(cfg),
      });
    }

    const resp = credential?.response || {};
    if (!resp.clientDataJSON || !resp.authenticatorData || !resp.signature) {
      recordAppLockFailure(actor.shopId, cfg, actor, 'Incomplete WebAuthn assertion');
      return res.status(400).json({ success: false, message: 'Incomplete biometric assertion response.' });
    }

    let clientData: any;
    try {
      clientData = JSON.parse(base64UrlToBuffer(resp.clientDataJSON).toString('utf8'));
    } catch {
      return res.status(400).json({ success: false, message: 'Malformed biometric clientDataJSON.' });
    }
    if (clientData.type !== 'webauthn.get' || clientData.challenge !== entry.challenge) {
      recordAppLockFailure(actor.shopId, cfg, actor, 'WebAuthn challenge mismatch');
      return res.status(401).json({
        success: false,
        message: 'Biometric challenge verification failed.',
        config: toPublicAppLockConfig(cfg),
      });
    }

    const authDataBuf = base64UrlToBuffer(resp.authenticatorData);
    const expectedRpHash = crypto.createHash('sha256').update(entry.rpId).digest();
    if (authDataBuf.length < 37 || !crypto.timingSafeEqual(authDataBuf.subarray(0, 32), expectedRpHash)) {
      recordAppLockFailure(actor.shopId, cfg, actor, 'WebAuthn RP ID hash mismatch');
      return res.status(401).json({
        success: false,
        message: 'Security origin verification failed.',
        config: toPublicAppLockConfig(cfg),
      });
    }

    const flags = authDataBuf[32];
    if ((flags & 0x01) === 0 || (flags & 0x04) === 0) {
      recordAppLockFailure(actor.shopId, cfg, actor, 'WebAuthn user verification bit absent');
      return res.status(401).json({
        success: false,
        message: 'Device biometric verification (fingerprint/face) was not completed.',
        config: toPublicAppLockConfig(cfg),
      });
    }

    if (matchedCred.publicKeySpkiBase64) {
      const clientDataRaw = base64UrlToBuffer(resp.clientDataJSON);
      const clientDataHash = crypto.createHash('sha256').update(clientDataRaw).digest();
      const signedData = Buffer.concat([authDataBuf, clientDataHash]);
      const sigBuf = base64UrlToBuffer(resp.signature);
      if (!verifyAssertionSignatureWithSpki(matchedCred.publicKeySpkiBase64, signedData, sigBuf)) {
        recordAppLockFailure(actor.shopId, cfg, actor, 'WebAuthn cryptographic signature verification failed');
        return res.status(401).json({
          success: false,
          message: 'Biometric cryptographic signature could not be verified.',
          config: toPublicAppLockConfig(cfg),
        });
      }
    }

    const signCount = authDataBuf.readUInt32BE(33);
    matchedCred.counter = Math.max(matchedCred.counter || 0, signCount);
    matchedCred.lastUsedAt = new Date().toISOString();
    clearAppLockFailures(cfg);
    cfg.updatedAt = new Date().toISOString();
    shopStore.appLock = cfg;
    persistShopStore(actor.shopId, false);
    recordAuditLog(
      context === 'exit' ? 'APP_LOCK_EXIT_CONFIRMED' : 'APP_LOCK_UNLOCKED',
      actor.actorEmail,
      actor.role,
      `Verified via Biometric (${matchedCred.deviceLabel})`,
      actor.shopId,
      req.ip
    );

    return res.json({ success: true, method: 'fingerprint', config: toPublicAppLockConfig(cfg) });
  }));

  app.post('/api/app-lock/verify', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);

    const cooldown = checkAppLockCooldown(cfg);
    if (cooldown.blocked) {
      return res.status(429).json({
        success: false,
        message: `Too many failed attempts. Please wait ${cooldown.retryAfterSec}s before trying again.`,
        config: toPublicAppLockConfig(cfg),
      });
    }

    const { method, secret, context } = req.body || {};
    const secretStr = String(secret || '');
    if (!secretStr) {
      return res.status(400).json({ success: false, message: 'Please enter your PIN or Password.' });
    }

    let ok = false;
    if (method === 'pin') {
      ok = Boolean(cfg.pinHash && cfg.pinSalt && verifyPasswordRecord(secretStr.trim(), cfg.pinSalt, cfg.pinHash));
    } else if (method === 'password') {
      ok = Boolean(cfg.passwordHash && cfg.passwordSalt && verifyPasswordRecord(secretStr, cfg.passwordSalt, cfg.passwordHash));
    } else {
      return res.status(400).json({ success: false, message: 'Unsupported unlock method.' });
    }

    if (!ok) {
      recordAppLockFailure(
        actor.shopId,
        cfg,
        actor,
        `Incorrect ${method === 'pin' ? 'PIN' : 'App Lock Password'} on ${context === 'exit' ? 'Exit Confirmation' : 'App Unlock'}`
      );
      return res.status(401).json({
        success: false,
        message: method === 'pin' ? 'Incorrect PIN. Please check and try again.' : 'Incorrect Password. Please check and try again.',
        config: toPublicAppLockConfig(cfg),
      });
    }

    clearAppLockFailures(cfg);
    cfg.updatedAt = new Date().toISOString();
    shopStore.appLock = cfg;
    persistShopStore(actor.shopId, false);
    recordAuditLog(
      context === 'exit' ? 'APP_LOCK_EXIT_CONFIRMED' : 'APP_LOCK_UNLOCKED',
      actor.actorEmail,
      actor.role,
      `Verified via ${method === 'pin' ? 'PIN' : 'Password'}`,
      actor.shopId,
      req.ip
    );

    return res.json({ success: true, method, config: toPublicAppLockConfig(cfg) });
  }));

  app.post('/api/app-lock/recover', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!isAppLockOwnerOrSuperAdmin(actor)) {
      return res.status(403).json({
        success: false,
        message: 'Only authorized Mart Owner or Super Admin can reset forgotten App Lock credentials.',
      });
    }

    const { accountPassword, newPin, confirmNewPin, disableAppLock } = req.body || {};
    if (!verifyOwnerOrSuperAdminAccountPassword(actor, String(accountPassword || ''))) {
      return res.status(401).json({
        success: false,
        message: 'Account Login Password verification failed. Recovery denied.',
      });
    }

    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cfg = normalizeAppLockConfig(shopStore.appLock);

    if (disableAppLock === true) {
      cfg.enabled = false;
      clearAppLockFailures(cfg);
    } else if (newPin) {
      const pinStr = String(newPin).trim();
      if (!/^\d{4,12}$/.test(pinStr)) {
        return res.status(400).json({ success: false, message: 'New PIN must be 4 to 12 digits.' });
      }
      if (pinStr !== String(confirmNewPin || '').trim()) {
        return res.status(400).json({ success: false, message: 'New PIN and Confirm PIN do not match.' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      cfg.pinSalt = salt;
      cfg.pinHash = hashPassword(pinStr, salt);
      cfg.pinLength = pinStr.length;
      cfg.defaultUnlockMethod = 'pin';
      clearAppLockFailures(cfg);
    } else {
      return res.status(400).json({ success: false, message: 'Provide a new PIN or select disable App Lock.' });
    }

    cfg.updatedAt = new Date().toISOString();
    shopStore.appLock = cfg;
    persistShopStore(actor.shopId, false);
    recordAuditLog(
      'APP_LOCK_RECOVERED',
      actor.actorEmail,
      actor.role,
      disableAppLock ? 'App Lock disabled after owner account password verification.' : 'App Lock PIN reset after owner account password verification.',
      actor.shopId,
      req.ip
    );

    return res.json({
      success: true,
      message: disableAppLock ? 'App Lock disabled safely.' : 'New App Lock PIN set successfully.',
      config: toPublicAppLockConfig(cfg),
    });
  }));

  // -------------------------------------------------------------
  // CCTV CAMERA, DVR/NVR, STREAM GATEWAY, PTZ & RECORDING ROUTES
  // -------------------------------------------------------------
  if (activeCctvGateway) {
    try {
      activeCctvGateway.shutdownAll();
    } catch {}
  }
  const cctvGateway = new CctvGatewayManager(DATA_DIR);
  activeCctvGateway = cctvGateway;

  const canAccessCctv = (actor: ResolvedActor): boolean => {
    if (actor.role === 'SUPER_ADMIN' || actor.role === 'SHOP_OWNER') return true;
    return Boolean(
      actor.permissions?.canViewCctv ||
        actor.permissions?.canManageCctv ||
        actor.permissions?.settings ||
        actor.permissions?.canAccessSettings
    );
  };

  const canManageCctv = (actor: ResolvedActor, shopStore?: StoreData): boolean => {
    if (actor.role === 'SUPER_ADMIN' || actor.role === 'SHOP_OWNER') return true;
    if (shopStore?.cctvSettings?.security?.staffViewOnly) return false;
    return Boolean(
      actor.permissions?.canManageCctv ||
        actor.permissions?.settings ||
        actor.permissions?.canAccessSettings
    );
  };

  const deriveCctvGroups = (shopStore: StoreData): string[] => {
    const set = new Set<string>(['Main Shop', 'Cash Counter 01', 'Main Entrance', 'Warehouse']);
    if (Array.isArray(shopStore.cctvGroups)) {
      shopStore.cctvGroups.forEach((g) => {
        if (g?.trim()) set.add(g.trim());
      });
    }
    (shopStore.cctvCameras || []).forEach((c) => {
      if (c.group?.trim()) set.add(c.group.trim());
      else if (c.location?.trim()) set.add(c.location.trim());
    });
    return Array.from(set);
  };

  const createCctvStreamToken = (params: { shopId: string; cameraId: string; actorEmail: string; role: UserRole }) => {
    const payloadObj = {
      t: 'cctv_stream',
      shopId: params.shopId,
      cameraId: params.cameraId,
      actorEmail: params.actorEmail,
      role: params.role,
      exp: Date.now() + 2 * 60 * 60 * 1000,
    };
    const b64 = base64UrlEncode(JSON.stringify(payloadObj));
    const sig = base64UrlEncode(
      crypto.createHmac('sha256', getSessionSigningSecret()).update(`CCTV.${b64}`).digest()
    );
    return `${b64}.${sig}`;
  };

  const verifyCctvStreamToken = (
    token: string,
    expectedCameraId?: string
  ): { ok: boolean; shopId?: string; cameraId?: string; actorEmail?: string; role?: UserRole } => {
    if (!token || !token.includes('.')) return { ok: false };
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return { ok: false };
    const expectedSig = base64UrlEncode(
      crypto.createHmac('sha256', getSessionSigningSecret()).update(`CCTV.${b64}`).digest()
    );
    try {
      const a = Buffer.from(sig, 'utf8');
      const b = Buffer.from(expectedSig, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
      const parsed = JSON.parse(base64UrlDecode(b64));
      if (parsed?.t !== 'cctv_stream' || !parsed?.shopId || !parsed?.exp || Date.now() > Number(parsed.exp)) {
        return { ok: false };
      }
      if (expectedCameraId && parsed.cameraId !== expectedCameraId) return { ok: false };
      return {
        ok: true,
        shopId: String(parsed.shopId),
        cameraId: String(parsed.cameraId),
        actorEmail: String(parsed.actorEmail || ''),
        role: parsed.role as UserRole,
      };
    } catch {
      return { ok: false };
    }
  };

  async function resolveCctvMediaAccess(
    req: Request,
    cameraId?: string
  ): Promise<{ ok: boolean; statusCode: number; shopId: string; message?: string }> {
    const st = String(req.query.st || '').trim();
    if (st) {
      const verified = verifyCctvStreamToken(st, cameraId);
      if (verified.ok && verified.shopId) {
        return { ok: true, statusCode: 200, shopId: verified.shopId };
      }
      return { ok: false, statusCode: 401, shopId: '', message: 'Stream session token expired or invalid.' };
    }
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return { ok: false, statusCode: actor.statusCode, shopId: '', message: actor.message };
    }
    if (!canAccessCctv(actor)) {
      return {
        ok: false,
        statusCode: 403,
        shopId: '',
        message: 'You do not have permission to view CCTV cameras.',
      };
    }
    return { ok: true, statusCode: 200, shopId: actor.shopId };
  }

  function resolveStoredCameraCredentials(cam: CctvCameraStored, shopStore: StoreData) {
    const rawPassword = cam.passwordEncrypted ? decryptCctvSecret(cam.passwordEncrypted, DATA_DIR) : '';
    const rawStreamUrl = cam.streamUrlEncrypted
      ? decryptCctvSecret(cam.streamUrlEncrypted, DATA_DIR)
      : (cam as any).streamUrl || '';
    const dvrPass = shopStore.dvrConfig?.passwordEncrypted
      ? decryptCctvSecret(shopStore.dvrConfig.passwordEncrypted, DATA_DIR)
      : '';
    return { rawPassword, rawStreamUrl, dvrPass };
  }

  app.get('/api/cctv/overview', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({
        success: false,
        error: 'CCTV_ACCESS_DENIED',
        message: 'Authorized CCTV permission is required to view cameras.',
      });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const activeRecIds = cctvGateway.getActiveRecordingCameraIds(actor.shopId);
    const rawCams = Array.isArray(shopStore.cctvCameras) ? shopStore.cctvCameras : [];
    const cameras = rawCams.map((c) => sanitizeCameraForClient(c, DATA_DIR, activeRecIds));
    const nameMap = new Map<string, string>(cameras.map((c) => [c.id, c.name]));
    const safeSettings = sanitizeCctvSettingsForClient(shopStore.cctvSettings);
    return res.json({
      success: true,
      cameras,
      dvrConfig: sanitizeDvrConfigForClient(shopStore.dvrConfig),
      gateway: cctvGateway.getGatewayStatus(),
      recordings: cctvGateway.listRecordings(actor.shopId, undefined, nameMap),
      groups: deriveCctvGroups(shopStore),
      settings: safeSettings,
      storage: cctvGateway.getStorageMetrics(actor.shopId, safeSettings, nameMap),
      motionEvents: Array.isArray(shopStore.cctvMotionEvents) ? shopStore.cctvMotionEvents : [],
      permissions: {
        canView: canAccessCctv(actor),
        canManage: canManageCctv(actor, shopStore),
      },
    });
  }));

  app.post('/api/cctv/test-connection', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const body = req.body || {};
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const existingCam = body.cameraId
      ? (shopStore.cctvCameras || []).find((c) => c.id === String(body.cameraId))
      : undefined;

    const existingCreds = existingCam
      ? resolveStoredCameraCredentials(existingCam, shopStore)
      : { rawPassword: '', rawStreamUrl: '', dvrPass: shopStore.dvrConfig?.passwordEncrypted ? decryptCctvSecret(shopStore.dvrConfig.passwordEncrypted, DATA_DIR) : '' };

    const useExistingPwd = body.keepExistingPassword !== false && !body.password;
    const useExistingUrl = body.keepExistingStreamUrl !== false && !body.streamUrl;

    const result = await probeCameraConnection({
      cameraType: (body.cameraType || existingCam?.cameraType || 'rtsp') as CctvCameraType,
      ipAddress: body.ipAddress !== undefined ? String(body.ipAddress) : existingCam?.ipAddress,
      port: body.port !== undefined && body.port !== '' ? Number(body.port) : existingCam?.port,
      username: body.username !== undefined ? String(body.username) : existingCam?.username,
      password: body.password ? String(body.password) : useExistingPwd ? existingCreds.rawPassword : '',
      streamUrl: body.streamUrl ? String(body.streamUrl) : useExistingUrl ? existingCreds.rawStreamUrl : '',
      channelNumber: Number(body.channelNumber || existingCam?.channelNumber || 1),
      supportsPtz: body.supportsPtz !== undefined ? Boolean(body.supportsPtz) : existingCam?.supportsPtz,
      supportsAudio: body.supportsAudio !== undefined ? Boolean(body.supportsAudio) : existingCam?.supportsAudio,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: existingCreds.dvrPass,
    });

    return res.json({ success: result.ok, result });
  }));

  app.post('/api/cctv/cameras', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canManageCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }

    const body = req.body || {};
    const name = String(body.name || '').trim();
    const location = String(body.location || 'Main Shop').trim() || 'Main Shop';
    if (!name) {
      return res.status(400).json({ success: false, message: 'Camera name is required.' });
    }

    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const dvrPass = shopStore.dvrConfig?.passwordEncrypted
      ? decryptCctvSecret(shopStore.dvrConfig.passwordEncrypted, DATA_DIR)
      : '';
    const cameraType = (body.cameraType || 'rtsp') as CctvCameraType;
    const channelNumber = Math.max(1, Number(body.channelNumber) || (shopStore.cctvCameras?.length || 0) + 1);
    const rawIp = String(body.ipAddress || '').trim();
    const rawPort = body.port !== undefined && body.port !== '' ? Number(body.port) : defaultPortForType(cameraType);
    const rawUser = String(body.username || '').trim();
    const rawPassword = String(body.password || '');
    const rawStreamUrl = String(body.streamUrl || '').trim();
    const group = String(body.group || location).trim() || location;
    const model = body.model ? String(body.model).trim() : undefined;

    const validation = resolveEffectiveCameraTarget({
      cameraType,
      ipAddress: rawIp,
      port: rawPort,
      username: rawUser,
      password: rawPassword,
      streamUrl: rawStreamUrl,
      channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: dvrPass,
    });

    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        error: validation.errorCode,
        message: validation.message || 'Invalid camera target.',
      });
    }

    const runProbe = body.testOnSave !== false;
    const probe = runProbe
      ? await probeCameraConnection({
          cameraType,
          ipAddress: rawIp,
          port: rawPort,
          username: rawUser,
          password: rawPassword,
          streamUrl: rawStreamUrl,
          channelNumber,
          supportsPtz: Boolean(body.supportsPtz),
          supportsAudio: Boolean(body.supportsAudio),
          dvrConfig: shopStore.dvrConfig,
          dvrPassword: dvrPass,
        })
      : null;

    const nowIso = new Date().toISOString();
    const { ffmpegAvailable } = detectMediaBinaries();
    const camId = `cam-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const recMode = ['manual', 'continuous', 'motion', 'scheduled'].includes(String(body.recordingMode))
      ? (body.recordingMode as CctvRecordingMode)
      : 'manual';
    const storedCam: CctvCameraStored = {
      id: camId,
      name,
      model,
      group,
      channelNumber,
      cameraType,
      ipAddress: rawIp || validation.host,
      port: rawPort,
      username: rawUser,
      hasPassword: Boolean(rawPassword),
      passwordEncrypted: rawPassword ? encryptCctvSecret(rawPassword, DATA_DIR) : undefined,
      streamUrlEncrypted: rawStreamUrl ? encryptCctvSecret(rawStreamUrl, DATA_DIR) : undefined,
      streamUrlMasked: rawStreamUrl ? maskCredentialsInUrl(rawStreamUrl) : undefined,
      onvifPath: body.onvifPath ? String(body.onvifPath).trim() : undefined,
      status: probe ? probe.status : 'offline',
      errorCode: probe ? probe.errorCode : undefined,
      lastError: probe && !probe.ok ? probe.message : undefined,
      latencyMs: probe?.latencyMs,
      location,
      description: body.description ? String(body.description).trim() : undefined,
      resolution: probe?.resolution || String(body.resolution || '1080p FHD'),
      codec: probe?.codec,
      supportsPtz: Boolean(body.supportsPtz),
      supportsAudio: Boolean(body.supportsAudio || probe?.capabilities.audio),
      supportsRecording: ffmpegAvailable && cameraType !== 'webrtc',
      recordingMode: recMode,
      schedule: body.schedule,
      motionDetectionEnabled: Boolean(body.motionDetectionEnabled),
      motionSensitivity: typeof body.motionSensitivity === 'number' ? Math.max(1, Math.min(100, body.motionSensitivity)) : 60,
      capabilities:
        probe?.capabilities ||
        defaultCapabilitiesForCamera(
          { cameraType, supportsPtz: Boolean(body.supportsPtz), supportsAudio: Boolean(body.supportsAudio) },
          ffmpegAvailable
        ),
      lastPing: new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
      lastCheckedAt: nowIso,
      lastConnectedAt: probe?.ok ? nowIso : undefined,
      updatedAt: nowIso,
    };

    const currentCams = Array.isArray(shopStore.cctvCameras) ? shopStore.cctvCameras : [];
    shopStore.cctvCameras = [...currentCams, storedCam];
    if (group && !(shopStore.cctvGroups || []).includes(group)) {
      shopStore.cctvGroups = [...(shopStore.cctvGroups || []), group];
    }
    persistShopStore(actor.shopId, true);

    const safeCam = sanitizeCameraForClient(storedCam, DATA_DIR);
    recordAuditLog('CCTV_CAMERA_ADDED', actor.actorEmail, actor.role, `Added camera "${name}" (${location})`, actor.shopId, req.ip);

    return res.json({ success: true, camera: safeCam, testResult: probe });
  }));

  app.put('/api/cctv/cameras/:cameraId', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const currentCams = Array.isArray(shopStore.cctvCameras) ? shopStore.cctvCameras : [];
    const idx = currentCams.findIndex((c) => c.id === cameraId);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: 'Camera not found.' });
    }

    const existing = currentCams[idx];
    const existingCreds = resolveStoredCameraCredentials(existing, shopStore);
    const body = req.body || {};

    const name = String(body.name ?? existing.name).trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Camera name is required.' });
    }
    const cameraType = (body.cameraType ?? existing.cameraType ?? 'rtsp') as CctvCameraType;
    const channelNumber = Math.max(1, Number(body.channelNumber ?? existing.channelNumber ?? 1));
    const rawIp = body.ipAddress !== undefined ? String(body.ipAddress).trim() : (existing.ipAddress || '');
    const rawPort = body.port !== undefined && body.port !== '' ? Number(body.port) : (existing.port || defaultPortForType(cameraType));
    const rawUser = body.username !== undefined ? String(body.username).trim() : (existing.username || '');
    const nextLocation = String(body.location ?? existing.location ?? 'Main Shop').trim() || 'Main Shop';
    const nextGroup = String(body.group ?? existing.group ?? nextLocation).trim() || nextLocation;
    const nextModel = body.model !== undefined ? (String(body.model).trim() || undefined) : existing.model;

    const nextPassword =
      body.password !== undefined && String(body.password) !== ''
        ? String(body.password)
        : body.keepExistingPassword === false
        ? ''
        : existingCreds.rawPassword;

    const nextStreamUrl =
      body.streamUrl !== undefined && String(body.streamUrl) !== ''
        ? String(body.streamUrl).trim()
        : body.keepExistingStreamUrl === false
        ? ''
        : existingCreds.rawStreamUrl;

    const validation = resolveEffectiveCameraTarget({
      cameraType,
      ipAddress: rawIp,
      port: rawPort,
      username: rawUser,
      password: nextPassword,
      streamUrl: nextStreamUrl,
      channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: existingCreds.dvrPass,
    });

    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        error: validation.errorCode,
        message: validation.message || 'Invalid camera configuration.',
      });
    }

    // Stop any old active worker when config changes so fresh stream URL takes effect immediately
    cctvGateway.stopCameraWorkers(actor.shopId, cameraId);

    const runProbe = body.testOnSave !== false;
    const probe = runProbe
      ? await probeCameraConnection({
          cameraType,
          ipAddress: rawIp,
          port: rawPort,
          username: rawUser,
          password: nextPassword,
          streamUrl: nextStreamUrl,
          channelNumber,
          supportsPtz: body.supportsPtz !== undefined ? Boolean(body.supportsPtz) : existing.supportsPtz,
          supportsAudio: body.supportsAudio !== undefined ? Boolean(body.supportsAudio) : existing.supportsAudio,
          dvrConfig: shopStore.dvrConfig,
          dvrPassword: existingCreds.dvrPass,
        })
      : null;

    const nowIso = new Date().toISOString();
    const { ffmpegAvailable } = detectMediaBinaries();
    const updatedStored: CctvCameraStored = {
      ...existing,
      name,
      model: nextModel,
      group: nextGroup,
      channelNumber,
      cameraType,
      ipAddress: rawIp || validation.host,
      port: rawPort,
      username: rawUser,
      hasPassword: Boolean(nextPassword),
      passwordEncrypted: nextPassword ? encryptCctvSecret(nextPassword, DATA_DIR) : undefined,
      streamUrlEncrypted: nextStreamUrl ? encryptCctvSecret(nextStreamUrl, DATA_DIR) : undefined,
      streamUrlMasked: nextStreamUrl ? maskCredentialsInUrl(nextStreamUrl) : undefined,
      onvifPath: body.onvifPath !== undefined ? String(body.onvifPath).trim() : existing.onvifPath,
      location: nextLocation,
      description: body.description !== undefined ? String(body.description).trim() : existing.description,
      resolution: probe?.resolution || String(body.resolution ?? existing.resolution ?? '1080p FHD'),
      codec: probe?.codec ?? existing.codec,
      supportsPtz: body.supportsPtz !== undefined ? Boolean(body.supportsPtz) : existing.supportsPtz,
      supportsAudio: body.supportsAudio !== undefined ? Boolean(body.supportsAudio) : existing.supportsAudio,
      supportsRecording: ffmpegAvailable && cameraType !== 'webrtc',
      recordingMode: ['manual', 'continuous', 'motion', 'scheduled'].includes(String(body.recordingMode))
        ? (body.recordingMode as CctvRecordingMode)
        : existing.recordingMode || 'manual',
      schedule: body.schedule !== undefined ? body.schedule : existing.schedule,
      motionDetectionEnabled:
        body.motionDetectionEnabled !== undefined ? Boolean(body.motionDetectionEnabled) : existing.motionDetectionEnabled,
      motionSensitivity:
        body.motionSensitivity !== undefined
          ? Math.max(1, Math.min(100, Number(body.motionSensitivity)))
          : existing.motionSensitivity,
      status: probe ? probe.status : existing.status,
      errorCode: probe ? probe.errorCode : existing.errorCode,
      lastError: probe ? (probe.ok ? undefined : probe.message) : existing.lastError,
      latencyMs: probe?.latencyMs ?? existing.latencyMs,
      capabilities:
        probe?.capabilities ||
        defaultCapabilitiesForCamera(
          {
            cameraType,
            supportsPtz: body.supportsPtz !== undefined ? Boolean(body.supportsPtz) : existing.supportsPtz,
            supportsAudio: body.supportsAudio !== undefined ? Boolean(body.supportsAudio) : existing.supportsAudio,
          },
          ffmpegAvailable
        ),
      lastPing: new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
      lastCheckedAt: nowIso,
      lastConnectedAt: probe?.ok ? nowIso : existing.lastConnectedAt,
      updatedAt: nowIso,
    };

    const nextList = [...currentCams];
    nextList[idx] = updatedStored;
    shopStore.cctvCameras = nextList;
    if (nextGroup && !(shopStore.cctvGroups || []).includes(nextGroup)) {
      shopStore.cctvGroups = [...(shopStore.cctvGroups || []), nextGroup];
    }
    persistShopStore(actor.shopId, true);

    recordAuditLog('CCTV_CAMERA_UPDATED', actor.actorEmail, actor.role, `Updated camera "${name}"`, actor.shopId, req.ip);

    return res.json({
      success: true,
      camera: sanitizeCameraForClient(updatedStored, DATA_DIR, cctvGateway.getActiveRecordingCameraIds(actor.shopId)),
      testResult: probe,
    });
  }));

  app.delete('/api/cctv/cameras/:cameraId', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const currentCams = Array.isArray(shopStore.cctvCameras) ? shopStore.cctvCameras : [];
    const target = currentCams.find((c) => c.id === cameraId);
    if (!target) {
      return res.status(404).json({ success: false, message: 'Camera not found.' });
    }

    cctvGateway.stopCameraWorkers(actor.shopId, cameraId);
    shopStore.cctvCameras = currentCams.filter((c) => c.id !== cameraId);
    persistShopStore(actor.shopId, true);

    recordAuditLog('CCTV_CAMERA_DELETED', actor.actorEmail, actor.role, `Deleted camera "${target.name}"`, actor.shopId, req.ip);
    return res.json({ success: true, deletedId: cameraId });
  }));

  app.post('/api/cctv/cameras/:cameraId/refresh', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }

    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cams = Array.isArray(shopStore.cctvCameras) ? shopStore.cctvCameras : [];
    const idx = cams.findIndex((c) => c.id === cameraId);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: 'Camera not found.' });
    }

    const cam = cams[idx];
    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const probe = await probeCameraConnection({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      supportsPtz: cam.supportsPtz,
      supportsAudio: cam.supportsAudio,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });

    const nowIso = new Date().toISOString();
    const updated: CctvCameraStored = {
      ...cam,
      status: probe.status,
      errorCode: probe.errorCode,
      lastError: probe.ok ? undefined : probe.message,
      latencyMs: probe.latencyMs,
      resolution: probe.resolution || cam.resolution,
      codec: probe.codec || cam.codec,
      capabilities: probe.capabilities,
      lastPing: new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
      lastCheckedAt: nowIso,
      lastConnectedAt: probe.ok ? nowIso : cam.lastConnectedAt,
    };
    cams[idx] = updated;
    shopStore.cctvCameras = cams;
    persistShopStore(actor.shopId, false);

    return res.json({
      success: probe.ok,
      camera: sanitizeCameraForClient(updated, DATA_DIR, cctvGateway.getActiveRecordingCameraIds(actor.shopId)),
      result: probe,
    });
  }));

  app.post('/api/cctv/refresh-all', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }

    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cams = Array.isArray(shopStore.cctvCameras) ? shopStore.cctvCameras : [];
    const nowIso = new Date().toISOString();

    const updatedCams = await Promise.all(
      cams.map(async (cam) => {
        const creds = resolveStoredCameraCredentials(cam, shopStore);
        const probe = await probeCameraConnection({
          cameraType: cam.cameraType,
          ipAddress: cam.ipAddress,
          port: cam.port,
          username: cam.username,
          password: creds.rawPassword,
          streamUrl: creds.rawStreamUrl,
          channelNumber: cam.channelNumber,
          supportsPtz: cam.supportsPtz,
          supportsAudio: cam.supportsAudio,
          dvrConfig: shopStore.dvrConfig,
          dvrPassword: creds.dvrPass,
        });
        return {
          ...cam,
          status: probe.status,
          errorCode: probe.errorCode,
          lastError: probe.ok ? undefined : probe.message,
          latencyMs: probe.latencyMs,
          resolution: probe.resolution || cam.resolution,
          codec: probe.codec || cam.codec,
          capabilities: probe.capabilities,
          lastPing: new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }),
          lastCheckedAt: nowIso,
          lastConnectedAt: probe.ok ? nowIso : cam.lastConnectedAt,
        } as CctvCameraStored;
      })
    );

    shopStore.cctvCameras = updatedCams;
    persistShopStore(actor.shopId, false);

    const activeRecIds = cctvGateway.getActiveRecordingCameraIds(actor.shopId);
    return res.json({
      success: true,
      cameras: updatedCams.map((c) => sanitizeCameraForClient(c, DATA_DIR, activeRecIds)),
    });
  }));

  app.put('/api/cctv/dvr', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }

    const body = req.body || {};
    const dvrIp = String(body.dvrIp || '').trim();
    const port = Number(body.port) || 554;
    const username = String(body.username || 'admin').trim();
    const brand = (body.brand || 'Hikvision') as DvrNvrConfig['brand'];
    const channelCount = Math.max(1, Math.min(64, Number(body.channelCount) || 8));

    const targetValidation = resolveEffectiveCameraTarget({
      cameraType: 'dvr',
      ipAddress: dvrIp,
      port,
      username,
    });
    if (!targetValidation.ok) {
      return res.status(400).json({
        success: false,
        error: targetValidation.errorCode,
        message: targetValidation.message,
      });
    }

    const prevEncrypted = shopStore.dvrConfig?.passwordEncrypted;
    const rawPass = body.password ? String(body.password) : prevEncrypted ? decryptCctvSecret(prevEncrypted, DATA_DIR) : '';

    const probe = await probeCameraConnection({
      cameraType: 'dvr',
      ipAddress: dvrIp,
      port,
      username,
      password: rawPass,
      channelNumber: 1,
      dvrConfig: { brand, dvrIp, port, username, channelCount, connected: false },
      dvrPassword: rawPass,
    });

    const nextDvr: DvrNvrStoredConfig = {
      brand,
      dvrIp,
      port,
      username,
      channelCount,
      connected: probe.ok,
      passwordEncrypted: rawPass ? encryptCctvSecret(rawPass, DATA_DIR) : undefined,
      lastCheckedAt: new Date().toISOString(),
      lastError: probe.ok ? undefined : probe.message,
    };

    shopStore.dvrConfig = nextDvr;
    persistShopStore(actor.shopId, true);

    return res.json({
      success: true,
      dvrConfig: sanitizeDvrConfigForClient(nextDvr),
      testResult: probe,
    });
  }));

  app.post('/api/cctv/cameras/:cameraId/stream-session', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }

    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) {
      return res.status(404).json({ success: false, message: 'Camera not found.' });
    }

    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });

    if (!target.ok || !target.effectiveUrl) {
      return res.status(400).json({
        success: false,
        error: target.errorCode || 'INVALID_IP_OR_URL',
        message: target.message || 'Invalid camera stream configuration.',
      });
    }

    const probe = await probeCameraConnection({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      supportsPtz: cam.supportsPtz,
      supportsAudio: cam.supportsAudio,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });

    const nowIso = new Date().toISOString();
    cam.status = probe.status;
    cam.errorCode = probe.errorCode;
    cam.lastError = probe.ok ? undefined : probe.message;
    cam.latencyMs = probe.latencyMs;
    if (probe.resolution) cam.resolution = probe.resolution;
    if (probe.codec) cam.codec = probe.codec;
    cam.capabilities = probe.capabilities;
    cam.lastCheckedAt = nowIso;
    if (probe.ok) cam.lastConnectedAt = nowIso;
    cam.lastPing = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
    persistShopStore(actor.shopId, false);

    if (!probe.ok) {
      return res.status(502).json({
        success: false,
        error: probe.errorCode,
        message: probe.message,
        camera: sanitizeCameraForClient(cam, DATA_DIR, cctvGateway.getActiveRecordingCameraIds(actor.shopId)),
      });
    }

    const streamToken = createCctvStreamToken({
      shopId: actor.shopId,
      cameraId: cam.id,
      actorEmail: actor.actorEmail,
      role: actor.role,
    });

    const protocol = probe.capabilities.playbackProtocol;
    let streamPath = `/api/cctv/gateway/${encodeURIComponent(cam.id)}/stream.m3u8?st=${encodeURIComponent(streamToken)}`;
    if (protocol === 'mjpeg' || protocol === 'mp4' || protocol === 'snapshot-poll') {
      streamPath = `/api/cctv/gateway/${encodeURIComponent(cam.id)}/proxy?st=${encodeURIComponent(streamToken)}`;
    } else if (protocol === 'webrtc') {
      streamPath = `/api/cctv/gateway/${encodeURIComponent(cam.id)}/whep?st=${encodeURIComponent(streamToken)}`;
    }

    return res.json({
      success: true,
      protocol,
      streamPath,
      snapshotPath: `/api/cctv/cameras/${encodeURIComponent(cam.id)}/snapshot?st=${encodeURIComponent(streamToken)}`,
      capabilities: probe.capabilities,
      camera: sanitizeCameraForClient(cam, DATA_DIR, cctvGateway.getActiveRecordingCameraIds(actor.shopId)),
    });
  }));

  app.get('/api/cctv/gateway/:cameraId/stream.m3u8', asyncHandler(async (req: Request, res: Response) => {
    const cameraId = String(req.params.cameraId || '').trim();
    const access = await resolveCctvMediaAccess(req, cameraId);
    if (!access.ok) {
      return res.status(access.statusCode).json({ success: false, message: access.message });
    }

    const shopStore = await ensureShopStoreHydratedFromKv(access.shopId);
    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) {
      return res.status(404).json({ success: false, message: 'Camera not found.' });
    }

    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });
    if (!target.ok || !target.effectiveUrl) {
      return res.status(400).json({ success: false, message: target.message || 'Invalid stream configuration.' });
    }

    const stToken = String(req.query.st || '');

    // If external HLS (.m3u8), proxy & rewrite segment paths safely so credentials never reach the client
    if ((target.protocol === 'http:' || target.protocol === 'https:') && target.effectiveUrl.toLowerCase().includes('.m3u8')) {
      try {
        const parsed = new URL(target.effectiveUrl);
        const clean = new URL(parsed.toString());
        clean.username = '';
        clean.password = '';
        const headers: Record<string, string> = {};
        if (target.username || target.password) {
          headers['Authorization'] = `Basic ${Buffer.from(`${target.username || ''}:${target.password || ''}`).toString('base64')}`;
        }
        const upstream = await fetch(clean.toString(), { headers, signal: AbortSignal.timeout(10000) });
        if (!upstream.ok) {
          return res.status(502).json({ success: false, message: `Upstream HLS stream returned HTTP ${upstream.status}` });
        }
        const rawPlaylist = await upstream.text();
        const rewritten = rawPlaylist
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            return `/api/cctv/gateway/${encodeURIComponent(cameraId)}/remote-seg?seg=${encodeURIComponent(trimmed)}${stToken ? `&st=${encodeURIComponent(stToken)}` : ''}`;
          })
          .join('\n');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(rewritten);
      } catch (err: any) {
        return res.status(502).json({ success: false, message: err?.message || 'Failed to proxy HLS playlist.' });
      }
    }

    const hlsRes = await cctvGateway.ensureHlsPlaylist({
      shopId: access.shopId,
      camera: cam,
      targetUrl: target.effectiveUrl,
      codecHint: cam.codec,
    });
    if (!hlsRes.ok || !hlsRes.playlistPath) {
      return res.status(hlsRes.errorCode === 'GATEWAY_UNAVAILABLE' ? 503 : 502).json({
        success: false,
        error: hlsRes.errorCode || 'CAMERA_DISCONNECTED',
        message: hlsRes.message || 'Live stream gateway failed.',
      });
    }

    const playlistBody = fs.readFileSync(hlsRes.playlistPath, 'utf8');
    const rewrittenLocal = playlistBody
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const cleanSeg = path.basename(trimmed);
        return `/api/cctv/gateway/${encodeURIComponent(cameraId)}/seg/${encodeURIComponent(cleanSeg)}${stToken ? `?st=${encodeURIComponent(stToken)}` : ''}`;
      })
      .join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(rewrittenLocal);
  }));

  app.get('/api/cctv/gateway/:cameraId/seg/:fileName', asyncHandler(async (req: Request, res: Response) => {
    const cameraId = String(req.params.cameraId || '').trim();
    const access = await resolveCctvMediaAccess(req, cameraId);
    if (!access.ok) {
      return res.status(access.statusCode).json({ success: false, message: access.message });
    }
    const segPath = cctvGateway.getHlsSegmentPath(access.shopId, cameraId, String(req.params.fileName || ''));
    if (!segPath) {
      return res.status(404).json({ success: false, message: 'HLS segment not found.' });
    }
    res.setHeader('Content-Type', segPath.endsWith('.m4s') || segPath.endsWith('.mp4') ? 'video/iso.segment' : 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(segPath);
  }));

  app.get('/api/cctv/gateway/:cameraId/remote-seg', asyncHandler(async (req: Request, res: Response) => {
    const cameraId = String(req.params.cameraId || '').trim();
    const access = await resolveCctvMediaAccess(req, cameraId);
    if (!access.ok) {
      return res.status(access.statusCode).json({ success: false, message: access.message });
    }
    const segRef = String(req.query.seg || '').trim();
    if (!segRef || segRef.includes('..') || segRef.startsWith('/') || /^https?:/i.test(segRef)) {
      return res.status(400).json({ success: false, message: 'Invalid relative segment reference.' });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(access.shopId);
    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) return res.status(404).json({ success: false, message: 'Camera not found.' });
    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });
    if (!target.ok || !target.effectiveUrl) {
      return res.status(400).json({ success: false, message: 'Invalid camera target.' });
    }
    const basePlaylistUrl = new URL(target.effectiveUrl);
    const resolvedSegUrl = new URL(segRef, basePlaylistUrl);
    if (resolvedSegUrl.origin !== basePlaylistUrl.origin) {
      return res.status(403).json({ success: false, message: 'Cross-origin segment redirect blocked.' });
    }
    resolvedSegUrl.username = '';
    resolvedSegUrl.password = '';
    const headers: Record<string, string> = {};
    if (target.username || target.password) {
      headers['Authorization'] = `Basic ${Buffer.from(`${target.username || ''}:${target.password || ''}`).toString('base64')}`;
    }
    const upstream = await fetch(resolvedSegUrl.toString(), { headers, signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return res.status(502).end();
    const arrBuf = await upstream.arrayBuffer();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(arrBuf));
  }));

  app.get('/api/cctv/gateway/:cameraId/proxy', asyncHandler(async (req: Request, res: Response) => {
    const cameraId = String(req.params.cameraId || '').trim();
    const access = await resolveCctvMediaAccess(req, cameraId);
    if (!access.ok) {
      return res.status(access.statusCode).json({ success: false, message: access.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(access.shopId);
    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) return res.status(404).json({ success: false, message: 'Camera not found.' });
    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });
    if (!target.ok || !target.effectiveUrl || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      return res.status(400).json({ success: false, message: target.message || 'HTTP stream required for proxy.' });
    }

    const parsed = new URL(target.effectiveUrl);
    const clean = new URL(parsed.toString());
    clean.username = '';
    clean.password = '';
    const headers: Record<string, string> = {};
    if (target.username || target.password) {
      headers['Authorization'] = `Basic ${Buffer.from(`${target.username || ''}:${target.password || ''}`).toString('base64')}`;
    }
    if (req.headers.range) {
      headers['Range'] = String(req.headers.range);
    }

    const client = clean.protocol === 'https:' ? https : http;
    const proxyReq = client.request(clean, { method: 'GET', headers }, (upRes) => {
      res.status(upRes.statusCode || 200);
      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      for (const h of forwardHeaders) {
        const val = upRes.headers[h];
        if (val) res.setHeader(h, val);
      }
      res.setHeader('Cache-Control', 'no-store');
      upRes.pipe(res);
    });
    proxyReq.setTimeout(15000, () => {
      proxyReq.destroy(new Error('Upstream camera stream timed out'));
    });
    proxyReq.on('error', () => {
      if (!res.headersSent) res.status(502).json({ success: false, message: 'Camera HTTP stream disconnected.' });
    });
    res.on('error', () => {
      proxyReq.destroy();
    });
    req.on('close', () => {
      proxyReq.destroy();
    });
    proxyReq.end();
  }));

  app.post('/api/cctv/gateway/:cameraId/whep', asyncHandler(async (req: Request, res: Response) => {
    const cameraId = String(req.params.cameraId || '').trim();
    const access = await resolveCctvMediaAccess(req, cameraId);
    if (!access.ok) {
      return res.status(access.statusCode).json({ success: false, message: access.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(access.shopId);
    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) return res.status(404).json({ success: false, message: 'Camera not found.' });
    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });
    if (!target.ok || !target.effectiveUrl || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      return res.status(400).json({ success: false, message: 'Valid HTTP/HTTPS WebRTC WHEP URL required.' });
    }
    const sdpOffer = typeof req.body === 'string' ? req.body : String(req.body?.sdp || '');
    if (!sdpOffer) {
      return res.status(400).json({ success: false, message: 'WebRTC SDP offer is required.' });
    }
    const clean = new URL(target.effectiveUrl);
    clean.username = '';
    clean.password = '';
    const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
    if (target.username || target.password) {
      headers['Authorization'] = `Basic ${Buffer.from(`${target.username || ''}:${target.password || ''}`).toString('base64')}`;
    }
    const whepRes = await fetch(clean.toString(), {
      method: 'POST',
      headers,
      body: sdpOffer,
      signal: AbortSignal.timeout(10000),
    });
    const answerSdp = await whepRes.text();
    if (!whepRes.ok) {
      return res.status(502).json({ success: false, message: `WebRTC gateway returned HTTP ${whepRes.status}` });
    }
    return res.json({ success: true, sdp: answerSdp });
  }));

  app.get('/api/cctv/cameras/:cameraId/snapshot', asyncHandler(async (req: Request, res: Response) => {
    const cameraId = String(req.params.cameraId || '').trim();
    const access = await resolveCctvMediaAccess(req, cameraId);
    if (!access.ok) {
      return res.status(access.statusCode).json({ success: false, message: access.message });
    }

    const shopStore = await ensureShopStoreHydratedFromKv(access.shopId);
    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) return res.status(404).json({ success: false, message: 'Camera not found.' });

    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });
    if (!target.ok || !target.effectiveUrl) {
      return res.status(400).json({ success: false, message: target.message || 'Invalid camera configuration.' });
    }

    const snap = await cctvGateway.captureSnapshotJpeg(target.effectiveUrl, target.username, target.password);
    if (!snap.ok || !snap.jpeg) {
      return res.status(502).json({
        success: false,
        error: snap.errorCode || 'CAMERA_DISCONNECTED',
        message: snap.message || 'Could not capture snapshot.',
      });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `inline; filename="${cam.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_snapshot.jpg"`);
    return res.send(snap.jpeg);
  }));

  app.post('/api/cctv/cameras/:cameraId/ptz', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }

    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) return res.status(404).json({ success: false, message: 'Camera not found.' });
    if (!cam.supportsPtz) {
      return res.status(400).json({ success: false, message: 'PTZ controls are not supported/enabled for this camera.' });
    }

    const validActions: CctvPtzAction[] = ['left', 'right', 'up', 'down', 'zoom_in', 'zoom_out', 'stop'];
    const action = String(req.body?.action || '') as CctvPtzAction;
    if (!validActions.includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid PTZ action.' });
    }

    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });
    if (!target.ok || !target.host) {
      return res.status(400).json({ success: false, message: target.message || 'Invalid camera host.' });
    }

    const ptzRes = await cctvGateway.sendPtzCommand({
      host: target.host,
      port: target.port || 80,
      cameraType: cam.cameraType,
      username: target.username,
      password: target.password,
      action,
      speed: Number(req.body?.speed || 0.5),
    });

    if (!ptzRes.ok) {
      return res.status(502).json({ success: false, error: ptzRes.errorCode, message: ptzRes.message });
    }
    return res.json({ success: true, message: ptzRes.message });
  }));

  app.get('/api/cctv/recordings', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }
    const cameraId = req.query.cameraId ? String(req.query.cameraId).trim() : undefined;
    const date = req.query.date ? String(req.query.date).trim() : undefined;
    const fromTime = req.query.fromTime ? String(req.query.fromTime).trim() : undefined;
    const toTime = req.query.toTime ? String(req.query.toTime).trim() : undefined;

    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const nameMap = new Map<string, string>((shopStore.cctvCameras || []).map((c) => [c.id, c.name]));
    return res.json({
      success: true,
      recordings: cctvGateway.listRecordings(actor.shopId, cameraId, nameMap, { date, fromTime, toTime }),
    });
  }));

  app.get('/api/cctv/cameras/:cameraId/recordings', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }
    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const nameMap = new Map<string, string>((shopStore.cctvCameras || []).map((c) => [c.id, c.name]));
    return res.json({
      success: true,
      recordings: cctvGateway.listRecordings(actor.shopId, cameraId, nameMap),
    });
  }));

  app.post('/api/cctv/cameras/:cameraId/recordings/start', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) return res.status(404).json({ success: false, message: 'Camera not found.' });

    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });
    if (!target.ok || !target.effectiveUrl) {
      return res.status(400).json({ success: false, message: target.message || 'Invalid camera stream.' });
    }

    const trigger = ['manual', 'scheduled', 'continuous', 'motion'].includes(String(req.body?.trigger))
      ? (req.body.trigger as 'manual' | 'scheduled' | 'continuous' | 'motion')
      : 'manual';
    const startRes = cctvGateway.startRecording({
      shopId: actor.shopId,
      camera: cam,
      targetUrl: target.effectiveUrl,
      trigger,
    });
    if (!startRes.ok) {
      return res.status(startRes.errorCode === 'GATEWAY_UNAVAILABLE' ? 503 : 500).json({
        success: false,
        error: startRes.errorCode,
        message: startRes.message,
      });
    }
    return res.json({ success: true, recording: startRes.recording });
  }));

  app.post('/api/cctv/cameras/:cameraId/recordings/stop', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const nameMap = new Map<string, string>();
    const active = cctvGateway.listRecordings(actor.shopId, cameraId, nameMap).find((r) => r.status === 'recording');
    const recId = String(req.body?.recordingId || active?.id || '');
    if (!recId) {
      return res.status(404).json({ success: false, message: 'No active recording found for this camera.' });
    }
    const stopRes = await cctvGateway.stopRecording(actor.shopId, recId);
    if (!stopRes.ok) {
      return res.status(404).json({ success: false, message: 'Active recording not found.' });
    }
    return res.json({ success: true, recording: stopRes.recording });
  }));

  app.get('/api/cctv/recordings/:recordingId/file', asyncHandler(async (req: Request, res: Response) => {
    const access = await resolveCctvMediaAccess(req);
    if (!access.ok) {
      return res.status(access.statusCode).json({ success: false, message: access.message });
    }
    const recordingId = String(req.params.recordingId || '').trim();
    const filePath = cctvGateway.resolveRecordingFile(access.shopId, recordingId);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Recording file not found.' });
    }

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (String(req.query.download || '') === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader && /^bytes=\d*-\d*$/.test(String(rangeHeader).trim())) {
      const [startStr, endStr] = String(rangeHeader).replace(/^bytes=/, '').split('-');
      const start = startStr ? parseInt(startStr, 10) : 0;
      const end = endStr ? Math.min(totalSize - 1, parseInt(endStr, 10)) : totalSize - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
        res.status(416).setHeader('Content-Range', `bytes */${totalSize}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', String(totalSize));
    return fs.createReadStream(filePath).pipe(res);
  }));

  app.delete('/api/cctv/recordings/:recordingId', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const recordingId = String(req.params.recordingId || '').trim();
    const deleted = cctvGateway.deleteRecording(actor.shopId, recordingId);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Recording not found.' });
    }
    return res.json({ success: true, deletedId: recordingId });
  }));

  // --- Camera Groups Management ---
  app.post('/api/cctv/groups', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const groupName = String(req.body?.name || '').trim().slice(0, 60);
    if (!groupName) {
      return res.status(400).json({ success: false, message: 'Group name is required.' });
    }
    const existing = Array.isArray(shopStore.cctvGroups) ? shopStore.cctvGroups : [];
    if (!existing.includes(groupName)) {
      shopStore.cctvGroups = [...existing, groupName];
      persistShopStore(actor.shopId, true);
    }
    return res.json({ success: true, groups: deriveCctvGroups(shopStore) });
  }));

  app.delete('/api/cctv/groups/:groupName', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const groupName = decodeURIComponent(String(req.params.groupName || '')).trim();
    shopStore.cctvGroups = (shopStore.cctvGroups || []).filter((g) => g !== groupName);
    shopStore.cctvCameras = (shopStore.cctvCameras || []).map((c) =>
      c.group === groupName ? { ...c, group: c.location || 'Main Shop' } : c
    );
    persistShopStore(actor.shopId, true);
    return res.json({
      success: true,
      groups: deriveCctvGroups(shopStore),
      cameras: shopStore.cctvCameras.map((c) => sanitizeCameraForClient(c, DATA_DIR, cctvGateway.getActiveRecordingCameraIds(actor.shopId))),
    });
  }));

  // --- CCTV Settings & Security PIN ---
  app.put('/api/cctv/settings', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }

    const body = req.body || {};
    const nextSettings = normalizeCctvSystemSettings(body, shopStore.cctvSettings);

    if (typeof body.newPin === 'string' && body.newPin.trim()) {
      const pinClean = body.newPin.trim();
      if (!/^\d{4,8}$/.test(pinClean)) {
        return res.status(400).json({ success: false, message: 'CCTV Lock PIN must be 4 to 8 digits.' });
      }
      const { pinHash, pinSalt } = hashCctvPin(pinClean);
      nextSettings.pinHash = pinHash;
      nextSettings.pinSalt = pinSalt;
      nextSettings.security.pinEnabled = true;
    } else if (body.clearPin === true) {
      delete nextSettings.pinHash;
      delete nextSettings.pinSalt;
      nextSettings.security.pinEnabled = false;
    }

    shopStore.cctvSettings = nextSettings;
    persistShopStore(actor.shopId, true);

    const nameMap = new Map<string, string>((shopStore.cctvCameras || []).map((c) => [c.id, c.name]));
    const safeSettings = sanitizeCctvSettingsForClient(nextSettings);
    return res.json({
      success: true,
      settings: safeSettings,
      storage: cctvGateway.getStorageMetrics(actor.shopId, safeSettings, nameMap),
    });
  }));

  app.post('/api/cctv/pin/verify', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!shopStore.cctvSettings?.pinHash) {
      return res.json({ success: true, unlocked: true, pinEnabled: false });
    }
    const pin = String(req.body?.pin || '').trim();
    const ok = verifyCctvPin(pin, shopStore.cctvSettings);
    if (!ok) {
      return res.status(401).json({ success: false, unlocked: false, message: 'Incorrect CCTV Security PIN.' });
    }
    return res.json({ success: true, unlocked: true, pinEnabled: true });
  }));

  // --- CCTV Storage Management ---
  app.get('/api/cctv/storage', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const nameMap = new Map<string, string>((shopStore.cctvCameras || []).map((c) => [c.id, c.name]));
    const safeSettings = sanitizeCctvSettingsForClient(shopStore.cctvSettings);
    return res.json({
      success: true,
      storage: cctvGateway.getStorageMetrics(actor.shopId, safeSettings, nameMap),
    });
  }));

  app.post('/api/cctv/storage/cleanup', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    if (req.body?.confirmDelete !== true) {
      return res.status(400).json({ success: false, message: 'Explicit confirmation is required before deleting recordings.' });
    }
    const olderThanDays = req.body?.olderThanDays !== undefined ? Number(req.body.olderThanDays) : undefined;
    const recordingIds = Array.isArray(req.body?.recordingIds) ? req.body.recordingIds.map(String) : undefined;
    const cleanupRes = cctvGateway.cleanupOldRecordings(actor.shopId, { olderThanDays, recordingIds });
    const nameMap = new Map<string, string>((shopStore.cctvCameras || []).map((c) => [c.id, c.name]));
    const safeSettings = sanitizeCctvSettingsForClient(shopStore.cctvSettings);
    recordAuditLog(
      'CCTV_STORAGE_CLEANUP',
      actor.actorEmail,
      actor.role,
      `Deleted ${cleanupRes.deletedCount} old CCTV recordings (${Math.round(cleanupRes.freedBytes / 1024)} KB freed)`,
      actor.shopId,
      req.ip
    );
    return res.json({
      success: true,
      ...cleanupRes,
      recordings: cctvGateway.listRecordings(actor.shopId, undefined, nameMap),
      storage: cctvGateway.getStorageMetrics(actor.shopId, safeSettings, nameMap),
    });
  }));

  // --- Genuine Motion Detection & Event Log (Never Simulated) ---
  app.get('/api/cctv/motion-events', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (!canAccessCctv(actor)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    return res.json({
      success: true,
      events: Array.isArray(shopStore.cctvMotionEvents) ? shopStore.cctvMotionEvents : [],
    });
  }));

  app.post('/api/cctv/cameras/:cameraId/motion-check', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const cameraId = String(req.params.cameraId || '').trim();
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied.' });
    }
    const cam = (shopStore.cctvCameras || []).find((c) => c.id === cameraId);
    if (!cam) return res.status(404).json({ success: false, message: 'Camera not found.' });

    const creds = resolveStoredCameraCredentials(cam, shopStore);
    const target = resolveEffectiveCameraTarget({
      cameraType: cam.cameraType,
      ipAddress: cam.ipAddress,
      port: cam.port,
      username: cam.username,
      password: creds.rawPassword,
      streamUrl: creds.rawStreamUrl,
      channelNumber: cam.channelNumber,
      dvrConfig: shopStore.dvrConfig,
      dvrPassword: creds.dvrPass,
    });
    if (!target.ok || !target.effectiveUrl) {
      return res.status(400).json({ success: false, message: target.message || 'Invalid camera stream.' });
    }

    const sensitivity = Number(
      req.body?.sensitivity ?? cam.motionSensitivity ?? shopStore.cctvSettings?.motionDetection?.sensitivity ?? 60
    );
    const analysis = await cctvGateway.detectRealFrameMotion({
      targetUrl: target.effectiveUrl,
      sensitivity,
      username: target.username,
      password: target.password,
    });

    if (!analysis.ok) {
      return res.status(502).json({
        success: false,
        detected: false,
        error: analysis.errorCode,
        message: analysis.message,
      });
    }

    let createdEvent: CctvMotionEvent | undefined;
    if (analysis.detected) {
      let recordingId: string | undefined;
      if (shopStore.cctvSettings?.motionDetection?.recordOnMotion && cam.supportsRecording !== false) {
        const recStart = cctvGateway.startRecording({
          shopId: actor.shopId,
          camera: cam,
          targetUrl: target.effectiveUrl,
          trigger: 'motion',
        });
        if (recStart.ok && recStart.recording) {
          recordingId = recStart.recording.id;
        }
      }
      createdEvent = {
        id: `mot_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        cameraId: cam.id,
        cameraName: cam.name,
        timestamp: new Date().toISOString(),
        confidenceScore: analysis.confidenceScore,
        source: 'ffmpeg-frame-diff',
        recordingId,
        notes: analysis.message,
      };
      const existingEvents = Array.isArray(shopStore.cctvMotionEvents) ? shopStore.cctvMotionEvents : [];
      shopStore.cctvMotionEvents = [createdEvent, ...existingEvents].slice(0, 500);
      persistShopStore(actor.shopId, false);
    }

    return res.json({
      success: true,
      detected: analysis.detected,
      confidenceScore: analysis.confidenceScore,
      message: analysis.message,
      event: createdEvent,
      events: Array.isArray(shopStore.cctvMotionEvents) ? shopStore.cctvMotionEvents : [],
    });
  }));

  app.delete('/api/cctv/motion-events', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    shopStore.cctvMotionEvents = [];
    persistShopStore(actor.shopId, false);
    return res.json({ success: true, events: [] });
  }));

  // --- Recording Schedule Sync ---
  app.post('/api/cctv/schedule/sync', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const settings = sanitizeCctvSettingsForClient(shopStore.cctvSettings);
    const activeIds = cctvGateway.getActiveRecordingCameraIds(actor.shopId);
    const results: Array<{ cameraId: string; cameraName: string; action: string; ok: boolean; message: string }> = [];

    for (const cam of shopStore.cctvCameras || []) {
      const mode = cam.recordingMode || settings.defaultRecordingMode || 'manual';
      const camSched = cam.schedule?.enabled ? cam.schedule : settings.schedule;
      const shouldBeRecording =
        mode === 'continuous' || (mode === 'scheduled' && isScheduleActiveNow(camSched));

      if (shouldBeRecording && !activeIds.has(cam.id)) {
        const creds = resolveStoredCameraCredentials(cam, shopStore);
        const target = resolveEffectiveCameraTarget({
          cameraType: cam.cameraType,
          ipAddress: cam.ipAddress,
          port: cam.port,
          username: cam.username,
          password: creds.rawPassword,
          streamUrl: creds.rawStreamUrl,
          channelNumber: cam.channelNumber,
          dvrConfig: shopStore.dvrConfig,
          dvrPassword: creds.dvrPass,
        });
        if (!target.ok || !target.effectiveUrl) {
          results.push({ cameraId: cam.id, cameraName: cam.name, action: 'skipped', ok: false, message: 'Invalid camera target.' });
          continue;
        }
        const probe = await probeCameraConnection({
          cameraType: cam.cameraType,
          ipAddress: cam.ipAddress,
          port: cam.port,
          username: cam.username,
          password: creds.rawPassword,
          streamUrl: creds.rawStreamUrl,
          channelNumber: cam.channelNumber,
          dvrConfig: shopStore.dvrConfig,
          dvrPassword: creds.dvrPass,
        });
        if (!probe.ok) {
          results.push({ cameraId: cam.id, cameraName: cam.name, action: 'offline', ok: false, message: probe.message });
          continue;
        }
        const startRes = cctvGateway.startRecording({
          shopId: actor.shopId,
          camera: cam,
          targetUrl: target.effectiveUrl,
          trigger: mode === 'continuous' ? 'continuous' : 'scheduled',
        });
        results.push({
          cameraId: cam.id,
          cameraName: cam.name,
          action: startRes.ok ? 'started' : 'failed',
          ok: startRes.ok,
          message: startRes.ok ? `Started ${mode} recording.` : startRes.message || 'Failed to start recording.',
        });
      } else {
        results.push({
          cameraId: cam.id,
          cameraName: cam.name,
          action: 'unchanged',
          ok: true,
          message: activeIds.has(cam.id) ? 'Already recording.' : `Mode: ${mode} (standby).`,
        });
      }
    }

    const activeNow = cctvGateway.getActiveRecordingCameraIds(actor.shopId);
    const cameras = (shopStore.cctvCameras || []).map((c) => sanitizeCameraForClient(c, DATA_DIR, activeNow));
    return res.json({ success: true, results, cameras });
  }));

  // --- Sanitized CCTV Backup & Restore ---
  app.get('/api/cctv/backup/export', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    return res.json({
      success: true,
      backup: {
        softwareName: 'WAQAS POS SOFTWARE — CCTV',
        exportedAt: new Date().toISOString(),
        shopId: actor.shopId,
        groups: deriveCctvGroups(shopStore),
        dvrConfig: sanitizeDvrConfigForClient(shopStore.dvrConfig),
        settings: sanitizeCctvSettingsForClient(shopStore.cctvSettings),
        cameras: (shopStore.cctvCameras || []).map((c) => sanitizeCameraForClient(c, DATA_DIR)),
      },
    });
  }));

  app.post('/api/cctv/backup/import', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    if (!canManageCctv(actor, shopStore)) {
      return res.status(403).json({ success: false, error: 'CCTV_ACCESS_DENIED', message: 'Permission denied (View-Only mode).' });
    }
    const payload = req.body?.backup || req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ success: false, message: 'Invalid CCTV backup JSON.' });
    }

    if (Array.isArray(payload.groups)) {
      shopStore.cctvGroups = Array.from(
        new Set(payload.groups.map((g: any) => String(g || '').trim()).filter(Boolean))
      );
    }
    if (payload.settings && typeof payload.settings === 'object') {
      shopStore.cctvSettings = normalizeCctvSystemSettings(payload.settings, shopStore.cctvSettings);
    }
    if (Array.isArray(payload.cameras)) {
      const existingById = new Map<string, CctvCameraStored>((shopStore.cctvCameras || []).map((c) => [c.id, c]));
      for (const item of payload.cameras) {
        if (!item?.id || !item?.name) continue;
        const prev = existingById.get(String(item.id));
        if (prev) {
          // Restore non-secret metadata while preserving encrypted server credentials
          existingById.set(prev.id, {
            ...prev,
            name: String(item.name).trim(),
            model: item.model ? String(item.model).trim() : prev.model,
            group: item.group ? String(item.group).trim() : prev.group,
            location: String(item.location || prev.location || 'Main Shop').trim(),
            description: item.description !== undefined ? String(item.description) : prev.description,
            recordingMode: item.recordingMode || prev.recordingMode,
            schedule: item.schedule || prev.schedule,
            motionDetectionEnabled:
              typeof item.motionDetectionEnabled === 'boolean' ? item.motionDetectionEnabled : prev.motionDetectionEnabled,
            motionSensitivity:
              typeof item.motionSensitivity === 'number' ? item.motionSensitivity : prev.motionSensitivity,
          });
        } else if (item.ipAddress && isValidHostnameOrIp(String(item.ipAddress))) {
          existingById.set(String(item.id), {
            id: String(item.id),
            name: String(item.name).trim(),
            model: item.model ? String(item.model).trim() : undefined,
            group: item.group ? String(item.group).trim() : String(item.location || 'Main Shop'),
            channelNumber: Math.max(1, Number(item.channelNumber) || 1),
            cameraType: (item.cameraType || 'rtsp') as CctvCameraType,
            ipAddress: String(item.ipAddress).trim(),
            port: Number(item.port) || 554,
            username: String(item.username || ''),
            hasPassword: false,
            status: 'offline',
            location: String(item.location || 'Main Shop').trim(),
            description: item.description ? String(item.description) : undefined,
            resolution: String(item.resolution || '1080p FHD'),
            supportsPtz: Boolean(item.supportsPtz),
            supportsAudio: Boolean(item.supportsAudio),
            recordingMode: item.recordingMode || 'manual',
            schedule: item.schedule,
            motionDetectionEnabled: Boolean(item.motionDetectionEnabled),
            motionSensitivity: typeof item.motionSensitivity === 'number' ? item.motionSensitivity : 60,
          });
        }
      }
      shopStore.cctvCameras = Array.from(existingById.values());
    }

    persistShopStore(actor.shopId, true);
    const activeIds = cctvGateway.getActiveRecordingCameraIds(actor.shopId);
    const cameras = (shopStore.cctvCameras || []).map((c) => sanitizeCameraForClient(c, DATA_DIR, activeIds));
    return res.json({
      success: true,
      cameras,
      groups: deriveCctvGroups(shopStore),
      settings: sanitizeCctvSettingsForClient(shopStore.cctvSettings),
    });
  }));

  // -------------------------------------------------------------
  // 10. GOOGLE ONLINE PRODUCT PRICE SEARCH API (SERVER-SIDE ONLY)
  // -------------------------------------------------------------
  function canStaffUsePriceSearch(perms?: StaffModulePermissions): boolean {
    if (!perms) return false;
    return Boolean(
      perms.products ||
        perms.stock ||
        perms.reports ||
        perms.canAccessReports ||
        perms.newPurchase ||
        perms.oldPurchase ||
        perms.settings ||
        perms.canAccessSettings
    );
  }

  app.get('/api/price-search/config', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !canStaffUsePriceSearch(actor.permissions)) {
      return res.status(403).json({ success: false, message: 'Staff permission required for Online Price Search.' });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    return res.json({
      success: true,
      providerStatus: getPriceSearchProviderStatus(),
      history: Array.isArray(shopStore.priceSearchHistory) ? shopStore.priceSearchHistory : [],
      favourites: Array.isArray(shopStore.priceSearchFavourites) ? shopStore.priceSearchFavourites : [],
      savedComparisons: Array.isArray(shopStore.priceSearchComparisons) ? shopStore.priceSearchComparisons : [],
    });
  }));

  app.post('/api/price-search/query', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !canStaffUsePriceSearch(actor.permissions)) {
      return res.status(403).json({ success: false, message: 'Staff permission required for Online Price Search.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const searchModeRaw = String(body.searchMode || 'name').trim();
    const searchMode: OnlinePriceSearchMode =
      searchModeRaw === 'barcode' || searchModeRaw === 'item_code' ? searchModeRaw : 'name';
    const regionRaw = String(body.region || 'all').trim();
    const region: OnlinePriceRegionFilter =
      regionRaw === 'pakistan' || regionRaw === 'international' ? regionRaw : 'all';

    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 180) : '';
    const barcode = typeof body.barcode === 'string' ? body.barcode.trim().slice(0, 64) : undefined;
    const itemCode = typeof body.itemCode === 'string' ? body.itemCode.trim().slice(0, 64) : undefined;
    const brand = typeof body.brand === 'string' ? body.brand.trim().slice(0, 80) : undefined;
    const model = typeof body.model === 'string' ? body.model.trim().slice(0, 80) : undefined;
    const category = typeof body.category === 'string' ? body.category.trim().slice(0, 80) : undefined;
    const localProductId = typeof body.localProductId === 'string' ? body.localProductId.trim().slice(0, 80) : undefined;
    const forceRefresh = Boolean(body.forceRefresh);

    if (!query && !barcode && !itemCode && !localProductId) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_SEARCH_QUERY',
        message: 'Please enter a product name, barcode, or item code to search online.',
      });
    }

    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const canViewCost = actor.role !== 'STAFF' || Boolean(actor.permissions?.canViewCostAndProfit);

    const localProductMatch = findLocalProductMatch(
      shopStore.products || [],
      {
        localProductId,
        barcode: barcode || (searchMode === 'barcode' ? query : undefined),
        itemCode: itemCode || (searchMode === 'item_code' ? query : undefined),
        query,
      },
      canViewCost
    );

    const effectiveQuery =
      query ||
      (searchMode === 'item_code' && localProductMatch?.name ? localProductMatch.name : '') ||
      barcode ||
      itemCode ||
      localProductMatch?.name ||
      '';

    const searchInput = {
      shopId: actor.shopId,
      query: effectiveQuery,
      searchMode,
      barcode,
      itemCode,
      brand,
      model,
      category,
      region,
      forceRefresh,
      localProductMatch,
    };

    if (!isOnlinePriceSearchCached(searchInput)) {
      const rl = checkPriceSearchRateLimit(actor.shopId);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        return res.status(429).json({
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: rl.retryAfterSeconds,
          message: `Online search rate limit exceeded. Please wait ${rl.retryAfterSeconds}s and try again.`,
        });
      }
    }

    const searchResponse = await executeOnlinePriceSearch(searchInput);

    // Record query into per-shop persistent search history (never modifies POS product prices/stock)
    const historyEntry: OnlinePriceSearchQueryRecord = {
      id: `PSQ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      query: searchResponse.query || effectiveQuery,
      searchMode,
      barcode: barcode || localProductMatch?.barcode,
      itemCode: itemCode || localProductMatch?.sku,
      brand: brand || searchResponse.resolvedMeta?.brand,
      model,
      category: category || localProductMatch?.category || searchResponse.resolvedMeta?.category,
      region,
      searchedAt: searchResponse.searchedAt,
      resultCount: searchResponse.results.length,
      verifiedPricedCount: searchResponse.comparison.verifiedPricedCount,
      lowestPkrPrice: searchResponse.comparison.primaryPkrComparison?.lowestPrice ?? null,
      lowestWebsite: searchResponse.comparison.primaryPkrComparison?.lowestWebsite,
      localProductId: localProductMatch?.id,
      localProductName: localProductMatch?.name,
      cached: searchResponse.cached,
    };

    const existingHistory = Array.isArray(shopStore.priceSearchHistory) ? shopStore.priceSearchHistory : [];
    const dedupedHistory = existingHistory.filter(
      (h) => !(h.query.toLowerCase() === historyEntry.query.toLowerCase() && h.searchMode === historyEntry.searchMode && h.region === historyEntry.region)
    );
    shopStore.priceSearchHistory = [historyEntry, ...dedupedHistory].slice(0, 100);
    persistShopStore(actor.shopId, true);

    return res.json({
      ...searchResponse,
      history: shopStore.priceSearchHistory,
    });
  }));

  app.delete('/api/price-search/history', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !canStaffUsePriceSearch(actor.permissions)) {
      return res.status(403).json({ success: false, message: 'Staff permission required.' });
    }
    const confirmed = req.body?.confirmClear === true || String(req.query?.confirm || '') === 'true';
    if (!confirmed) {
      return res.status(400).json({
        success: false,
        error: 'CONFIRMATION_REQUIRED',
        message: 'Confirmation is required to clear online price search history.',
      });
    }
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    shopStore.priceSearchHistory = [];
    persistShopStore(actor.shopId, true);
    return res.json({ success: true, history: [] });
  }));

  app.post('/api/price-search/favourites', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !canStaffUsePriceSearch(actor.permissions)) {
      return res.status(403).json({ success: false, message: 'Staff permission required.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 180) : '';
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 180) : title;
    if (!title && !query) {
      return res.status(400).json({ success: false, message: 'Favourite item title or query is required.' });
    }
    const modeRaw = String(body.searchMode || 'name');
    const searchMode: OnlinePriceSearchMode =
      modeRaw === 'barcode' || modeRaw === 'item_code' ? modeRaw : 'name';

    const fav: OnlinePriceFavouriteItem = {
      id: typeof body.id === 'string' && body.id.trim() ? body.id.trim().slice(0, 80) : `FAV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: title || query,
      query: query || title,
      searchMode,
      barcode: typeof body.barcode === 'string' ? body.barcode.trim().slice(0, 64) : undefined,
      itemCode: typeof body.itemCode === 'string' ? body.itemCode.trim().slice(0, 64) : undefined,
      brand: typeof body.brand === 'string' ? body.brand.trim().slice(0, 80) : undefined,
      model: typeof body.model === 'string' ? body.model.trim().slice(0, 80) : undefined,
      category: typeof body.category === 'string' ? body.category.trim().slice(0, 80) : undefined,
      websiteName: typeof body.websiteName === 'string' ? body.websiteName.trim().slice(0, 100) : undefined,
      websiteUrl: sanitizeExternalHttpUrl(body.websiteUrl),
      imageUrl: sanitizeExternalHttpUrl(body.imageUrl),
      price: typeof body.price === 'number' && Number.isFinite(body.price) && body.price > 0 ? body.price : null,
      currency: typeof body.currency === 'string' ? body.currency.trim().slice(0, 10) : null,
      localProductId: typeof body.localProductId === 'string' ? body.localProductId.trim().slice(0, 80) : undefined,
      savedAt: new Date().toISOString(),
    };

    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const prev = Array.isArray(shopStore.priceSearchFavourites) ? shopStore.priceSearchFavourites : [];
    const filtered = prev.filter(
      (f) => f.id !== fav.id && !(f.websiteUrl && fav.websiteUrl && f.websiteUrl === fav.websiteUrl)
    );
    shopStore.priceSearchFavourites = [fav, ...filtered].slice(0, 200);
    persistShopStore(actor.shopId, true);

    return res.json({ success: true, favourite: fav, favourites: shopStore.priceSearchFavourites });
  }));

  app.delete('/api/price-search/favourites/:favId', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !canStaffUsePriceSearch(actor.permissions)) {
      return res.status(403).json({ success: false, message: 'Staff permission required.' });
    }
    const favId = decodeURIComponent(String(req.params.favId || ''));
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    shopStore.priceSearchFavourites = (shopStore.priceSearchFavourites || []).filter((f) => f.id !== favId);
    persistShopStore(actor.shopId, true);
    return res.json({ success: true, favourites: shopStore.priceSearchFavourites });
  }));

  app.post('/api/price-search/comparisons', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !canStaffUsePriceSearch(actor.permissions)) {
      return res.status(403).json({ success: false, message: 'Staff permission required.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 180) : '';
    const rawResults = Array.isArray(body.results) ? body.results.slice(0, 30) : [];
    if (!query || rawResults.length === 0) {
      return res.status(400).json({ success: false, message: 'Comparison query and results are required.' });
    }

    const sanitizedResults = rawResults
      .map((r: any) => {
        const safeUrl = sanitizeExternalHttpUrl(r?.websiteUrl);
        if (!safeUrl) return null;
        return {
          ...r,
          websiteUrl: safeUrl,
          imageUrl: sanitizeExternalHttpUrl(r?.imageUrl),
        };
      })
      .filter(Boolean);

    if (sanitizedResults.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid comparison rows to save.' });
    }

    const record: SavedPriceComparisonRecord = {
      id: `PSC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      query,
      searchedAt: typeof body.searchedAt === 'string' ? body.searchedAt : new Date().toISOString(),
      savedAt: new Date().toISOString(),
      localProductId: typeof body.localProductId === 'string' ? body.localProductId : undefined,
      localProductName: typeof body.localProductName === 'string' ? body.localProductName : undefined,
      localSalePrice: typeof body.localSalePrice === 'number' ? body.localSalePrice : undefined,
      lowestPkrPrice: typeof body.lowestPkrPrice === 'number' ? body.lowestPkrPrice : null,
      averagePkrPrice: typeof body.averagePkrPrice === 'number' ? body.averagePkrPrice : null,
      highestPkrPrice: typeof body.highestPkrPrice === 'number' ? body.highestPkrPrice : null,
      websiteCount: Number(body.websiteCount) || sanitizedResults.length,
      results: sanitizedResults,
    };

    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    const prev = Array.isArray(shopStore.priceSearchComparisons) ? shopStore.priceSearchComparisons : [];
    shopStore.priceSearchComparisons = [record, ...prev].slice(0, 100);
    persistShopStore(actor.shopId, true);

    return res.json({ success: true, comparison: record, savedComparisons: shopStore.priceSearchComparisons });
  }));

  app.delete('/api/price-search/comparisons/:compId', asyncHandler(async (req: Request, res: Response) => {
    const actor = await resolveShopActorAsync(req);
    if (!actor.ok) {
      return res.status(actor.statusCode).json({ success: false, error: actor.error, message: actor.message });
    }
    if (actor.role === 'STAFF' && !canStaffUsePriceSearch(actor.permissions)) {
      return res.status(403).json({ success: false, message: 'Staff permission required.' });
    }
    const compId = decodeURIComponent(String(req.params.compId || ''));
    const shopStore = await ensureShopStoreHydratedFromKv(actor.shopId);
    shopStore.priceSearchComparisons = (shopStore.priceSearchComparisons || []).filter((c) => c.id !== compId);
    persistShopStore(actor.shopId, true);
    return res.json({ success: true, savedComparisons: shopStore.priceSearchComparisons });
  }));

  // Catch-all for unmatched /api/* routes: guarantees JSON instead of HTML
  app.all('/api/*', (req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: 'API_ENDPOINT_NOT_FOUND',
      message: `The API route ${req.method} ${req.path} was not found on WAQAS POS Server.`,
      path: req.path,
    });
  });

  // JSON Error Handler for malformed JSON bodies or unexpected runtime errors
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({
        success: false,
        error: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds the 25 MB limit.',
      });
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_JSON_BODY',
        message: 'Request body must be valid JSON.',
      });
    }
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'API_REQUEST_ERROR',
      method: req.method,
      path: req.path,
      message: err?.message || 'Unexpected backend error',
    }));
    if (res.headersSent) return;
    if (req.path.startsWith('/api')) {
      return res.status(err?.statusCode || err?.status || 500).json({
        success: false,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected backend error occurred.',
      });
    }
    return res.status(err?.statusCode || err?.status || 500).send('Internal Server Error');
  });

  cachedApp = app;
  return app;
}
