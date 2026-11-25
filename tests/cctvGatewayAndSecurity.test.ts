import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CctvPage } from '../src/components/CctvPage.tsx';
import type { CctvCamera, DvrNvrConfig } from '../src/types/pos.ts';

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
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqas-cctv-test-'));
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqas-cctv-media-'));

  // Create genuine short H.264 MP4 + HLS segments using ffmpeg for realistic live streaming & snapshot tests
  const sampleMp4 = path.join(mediaDir, 'live.mp4');
  const sampleM3u8 = path.join(mediaDir, 'live.m3u8');
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=15',
    '-t', '4',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    sampleMp4,
  ], { stdio: 'ignore' });

  execFileSync('ffmpeg', [
    '-y',
    '-i', sampleMp4,
    '-c:v', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '0',
    '-hls_segment_filename', path.join(mediaDir, 'seg_%03d.ts'),
    sampleM3u8,
  ], { stdio: 'ignore' });

  let receivedPtzXml = '';
  const camPort = await getFreePort();
  const camBase = `http://127.0.0.1:${camPort}`;

  const camServer = http.createServer((req, res) => {
    const reqUrl = (req.url || '/').split('?')[0];

    if (reqUrl === '/web-login') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Camera Web Portal</body></html>');
      return;
    }

    // Require Basic Auth on protected endpoints
    const auth = req.headers.authorization || '';
    const expectedAuth = `Basic ${Buffer.from('camadmin:CamSecret#99').toString('base64')}`;
    if (auth !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="IP Camera"' });
      res.end('Unauthorized');
      return;
    }

    if (reqUrl === '/live.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(fs.readFileSync(sampleM3u8));
      return;
    }

    if (/^\/seg_\d+\.ts$/.test(reqUrl)) {
      const segFile = path.join(mediaDir, path.basename(reqUrl));
      if (fs.existsSync(segFile)) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        fs.createReadStream(segFile).pipe(res);
        return;
      }
    }

    if (reqUrl === '/video.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      fs.createReadStream(sampleMp4).pipe(res);
      return;
    }

    if (reqUrl === '/onvif/ptz_service' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedPtzXml = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end('<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><ContinuousMoveResponse/></s:Body></s:Envelope>');
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => camServer.listen(camPort, '127.0.0.1', () => resolve()));

  const SA_GMAIL = 'test-cctv-sa@gmail.com';
  const SA_PASS = 'SuperPass!234';
  const saSalt = crypto.randomBytes(16).toString('hex');
  const saHash = 'scrypt:' + crypto.scryptSync(SA_PASS, saSalt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');

  let serverProc: ChildProcess | null = null;
  try {
    console.log(`1. Starting isolated test server on ${baseUrl}...`);
    serverProc = spawn('npx', ['tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        WAQAS_DATA_DIR: dataDir,
        SUPER_ADMIN_EMAIL: SA_GMAIL,
        SUPER_ADMIN_PASSWORD_SALT: saSalt,
        SUPER_ADMIN_PASSWORD_HASH: saHash,
        WAQAS_ALLOW_LOOPBACK_CAMERAS: '1',
        NODE_ENV: 'production',
      },
      stdio: 'pipe',
    });

    await waitForHealth(baseUrl);

    // Login Super Admin & Create Mart A + Mart B
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
        shopName: 'CCTV Test Mart A',
        ownerName: 'Tariq Owner',
        username: 'cctv_owner_a',
        password: 'OwnerPass!234',
        phone: '03001112233',
        planType: 'MONTHLY',
        subscriptionDays: 30,
      }),
    });
    assert.equal(createMartA.status, 200);
    const martAId = createMartA.data.shop.id as string;

    const ownerLogin = await jsonReq(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ portal: 'shop', identifier: 'cctv_owner_a', password: 'OwnerPass!234' }),
    });
    assert.equal(ownerLogin.status, 200);
    const ownerToken = ownerLogin.data.token as string;

    // Create Cashier (no settings/CCTV permission) + Manager (settings permission)
    const syncStaffRes = await jsonReq(baseUrl, '/api/store/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        action: 'sync_staff',
        sourceDeviceId: 'TEST-PC',
        payload: [
          {
            id: 'staff-cashier',
            name: 'Cashier NoCCTV',
            phone: '03001110000',
            role: 'Cashier',
            salary: 25000,
            joiningDate: '2026-01-01',
            accountStatus: 'active',
            username: 'cashier_nocctv',
            newPassword: 'StaffPass!123',
            permissions: {
              newSale: true,
              oldSale: true,
              settings: false,
              canAccessSettings: false,
            },
          },
          {
            id: 'staff-mgr',
            name: 'Manager WithCCTV',
            phone: '03002220000',
            role: 'Manager',
            salary: 40000,
            joiningDate: '2026-01-01',
            accountStatus: 'active',
            username: 'mgr_cctv',
            newPassword: 'StaffPass!123',
            permissions: {
              newSale: true,
              oldSale: true,
              settings: true,
              canAccessSettings: true,
            },
          },
        ],
      }),
    });
    assert.equal(syncStaffRes.status, 200);

    const cashierLogin = await jsonReq(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ portal: 'shop', identifier: 'cashier_nocctv', password: 'StaffPass!123' }),
    });
    assert.equal(cashierLogin.status, 200);
    const cashierToken = cashierLogin.data.token as string;

    const mgrLogin = await jsonReq(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ portal: 'shop', identifier: 'mgr_cctv', password: 'StaffPass!123' }),
    });
    assert.equal(mgrLogin.status, 200);
    const mgrToken = mgrLogin.data.token as string;

    console.log('2. Verifying RBAC authorization on CCTV routes...');
    const deniedOverview = await jsonReq(baseUrl, '/api/cctv/overview', {
      headers: { Authorization: `Bearer ${cashierToken}` },
    });
    assert.equal(deniedOverview.status, 403);
    assert.equal(deniedOverview.data.error, 'CCTV_ACCESS_DENIED');

    const allowedOverview = await jsonReq(baseUrl, '/api/cctv/overview', {
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    assert.equal(allowedOverview.status, 200);
    assert.equal(allowedOverview.data.gateway.ffmpegAvailable, true);

    console.log('3. Testing input validation, SSRF protection, and error diagnostics...');
    const badIpTest = await jsonReq(baseUrl, '/api/cctv/test-connection', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ cameraType: 'rtsp', ipAddress: '999.999.1.1', port: 554 }),
    });
    assert.equal(badIpTest.data.result.ok, false);
    assert.equal(badIpTest.data.result.errorCode, 'INVALID_IP_OR_URL');

    const metadataSsrfTest = await jsonReq(baseUrl, '/api/cctv/test-connection', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ cameraType: 'ip', streamUrl: 'http://169.254.169.254/latest/meta-data/' }),
    });
    assert.equal(metadataSsrfTest.data.result.ok, false);
    assert.equal(metadataSsrfTest.data.result.errorCode, 'INVALID_IP_OR_URL');

    const badSchemeTest = await jsonReq(baseUrl, '/api/cctv/test-connection', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ cameraType: 'ip', streamUrl: 'javascript:alert(1)' }),
    });
    assert.equal(badSchemeTest.data.result.ok, false);
    assert.equal(badSchemeTest.data.result.errorCode, 'UNSUPPORTED_FORMAT');

    const closedPort = await getFreePort();
    const disconnectedTest = await jsonReq(baseUrl, '/api/cctv/test-connection', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ cameraType: 'ip', ipAddress: '127.0.0.1', port: closedPort }),
    });
    assert.equal(disconnectedTest.data.result.ok, false);
    assert.equal(disconnectedTest.data.result.errorCode, 'CAMERA_DISCONNECTED');

    const wrongPwdTest = await jsonReq(baseUrl, '/api/cctv/test-connection', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        cameraType: 'hls',
        streamUrl: `${camBase}/live.m3u8`,
        username: 'camadmin',
        password: 'WrongPassword!',
      }),
    });
    assert.equal(wrongPwdTest.data.result.ok, false);
    assert.equal(wrongPwdTest.data.result.errorCode, 'AUTH_FAILED');

    const htmlFormatTest = await jsonReq(baseUrl, '/api/cctv/test-connection', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        cameraType: 'ip',
        streamUrl: `${camBase}/web-login`,
      }),
    });
    assert.equal(htmlFormatTest.data.result.ok, false);
    assert.equal(htmlFormatTest.data.result.errorCode, 'UNSUPPORTED_FORMAT');

    console.log('4. Testing genuine HLS/MP4 camera creation, secret redaction & CRUD...');
    const goodTest = await jsonReq(baseUrl, '/api/cctv/test-connection', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        cameraType: 'hls',
        streamUrl: `${camBase}/live.m3u8`,
        username: 'camadmin',
        password: 'CamSecret#99',
        supportsPtz: true,
      }),
    });
    assert.equal(goodTest.data.result.ok, true, `Unexpected probe failure: ${JSON.stringify(goodTest.data.result)}`);
    assert.equal(goodTest.data.result.status, 'online');
    assert.equal(goodTest.data.result.capabilities.playbackProtocol, 'hls');

    const createCamRes = await jsonReq(baseUrl, '/api/cctv/cameras', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        name: 'Cash Counter 1',
        location: 'Cash Counter 01',
        cameraType: 'hls',
        ipAddress: '127.0.0.1',
        port: camPort,
        channelNumber: 1,
        username: 'camadmin',
        password: 'CamSecret#99',
        streamUrl: `http://camadmin:CamSecret%2399@127.0.0.1:${camPort}/live.m3u8`,
        supportsPtz: true,
        description: 'Main cash register view',
      }),
    });
    assert.equal(createCamRes.status, 200);
    const camId = createCamRes.data.camera.id as string;
    assert.equal(createCamRes.data.camera.status, 'online');
    assert.equal(createCamRes.data.camera.hasPassword, true);
    assert.equal(createCamRes.text.includes('CamSecret#99'), false, 'Password must NEVER leak to client!');

    // Verify store/state and backup/export never expose password or encrypted hashes
    const storeState = await jsonReq(baseUrl, '/api/store/state', {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(storeState.text.includes('CamSecret#99'), false);
    assert.equal(storeState.text.includes('passwordEncrypted'), false);
    assert.equal(storeState.text.includes('streamUrlEncrypted'), false);

    const backupRes = await jsonReq(baseUrl, '/api/shop/backup/export', {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(backupRes.text.includes('CamSecret#99'), false);
    assert.equal(backupRes.text.includes('passwordEncrypted'), false);

    // Edit camera WITHOUT re-entering password -> preserved & stays online!
    const editRes = await jsonReq(baseUrl, `/api/cctv/cameras/${camId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        name: 'Cash Counter Main',
        location: 'Cash Counter 01',
        keepExistingPassword: true,
        keepExistingStreamUrl: true,
        supportsPtz: true,
      }),
    });
    assert.equal(editRes.status, 200);
    assert.equal(editRes.data.camera.name, 'Cash Counter Main');
    assert.equal(editRes.data.camera.status, 'online');

    console.log('5. Verifying genuine live stream gateway, segment proxy, snapshot capture, ONVIF PTZ & MP4 recording...');
    const sessionRes = await jsonReq(baseUrl, `/api/cctv/cameras/${camId}/stream-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(sessionRes.status, 200);
    assert.equal(sessionRes.data.protocol, 'hls');
    assert.ok(sessionRes.data.streamPath.includes('st='));

    const m3u8Fetch = await fetch(`${baseUrl}${sessionRes.data.streamPath}`);
    assert.equal(m3u8Fetch.status, 200);
    const playlistBody = await m3u8Fetch.text();
    assert.ok(playlistBody.includes('#EXTM3U'));
    const firstSegLine = playlistBody.split(/\r?\n/).find((l) => l.includes('remote-seg'));
    assert.ok(firstSegLine, 'Playlist must rewrite segments through authenticated gateway');

    const segFetch = await fetch(`${baseUrl}${firstSegLine}`);
    assert.equal(segFetch.status, 200);
    const segBuf = Buffer.from(await segFetch.arrayBuffer());
    assert.ok(segBuf.length > 500, 'HLS segment bytes must be delivered from upstream camera');

    // Create a second MP4 camera with model, group & recordingMode to test FFmpeg transcoding gateway, snapshot JPEG, MP4 recording, motion check & storage
    const mp4CamRes = await jsonReq(baseUrl, '/api/cctv/cameras', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        name: 'Entrance IP Cam',
        model: 'Hikvision DS-2CD1023G0E',
        group: 'Entrance Zone',
        location: 'Main Entrance',
        cameraType: 'ip',
        ipAddress: '127.0.0.1',
        port: camPort,
        username: 'camadmin',
        password: 'CamSecret#99',
        streamUrl: `${camBase}/video.mp4`,
        recordingMode: 'continuous',
        supportsPtz: false,
      }),
    });
    assert.equal(mp4CamRes.status, 200);
    const mp4CamId = mp4CamRes.data.camera.id as string;
    assert.equal(mp4CamRes.data.camera.status, 'online');
    assert.equal(mp4CamRes.data.camera.model, 'Hikvision DS-2CD1023G0E');
    assert.equal(mp4CamRes.data.camera.group, 'Entrance Zone');
    assert.equal(mp4CamRes.data.camera.recordingMode, 'continuous');
    assert.ok(mp4CamRes.data.camera.lastConnectedAt);

    // Offline camera for genuine failure tests (zero fabricated motion/streams)
    const offlineCamRes = await jsonReq(baseUrl, '/api/cctv/cameras', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        name: 'Offline Gate Cam',
        model: 'Dahua IPC-HFW',
        group: 'Entrance Zone',
        location: 'Back Gate',
        cameraType: 'ip',
        ipAddress: '127.0.0.1',
        port: closedPort,
        testOnSave: false,
      }),
    });
    assert.equal(offlineCamRes.status, 200);
    const offlineCamId = offlineCamRes.data.camera.id as string;

    // Camera Groups CRUD
    console.log('6. Verifying camera groups, granular RBAC & staffViewOnly enforcement...');
    const addGrpRes = await jsonReq(baseUrl, '/api/cctv/groups', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: 'Warehouse Wing' }),
    });
    assert.equal(addGrpRes.status, 200);
    assert.ok(addGrpRes.data.groups.includes('Warehouse Wing'));

    // Update staff with granular canViewCctv=true, canManageCctv=false, settings=false
    const syncRbacRes = await jsonReq(baseUrl, '/api/store/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'x-shop-id': martAId },
      body: JSON.stringify({
        action: 'sync_staff',
        sourceDeviceId: 'TEST-PC',
        payload: [
          {
            id: 'staff-viewer',
            name: 'CCTV Guard',
            phone: '03003330000',
            role: 'Guard',
            salary: 28000,
            joiningDate: '2026-01-01',
            accountStatus: 'active',
            username: 'cctv_guard',
            newPassword: 'StaffPass!123',
            permissions: {
              newSale: false,
              oldSale: false,
              settings: false,
              canAccessSettings: false,
              canViewCctv: true,
              canManageCctv: false,
            },
          },
          {
            id: 'staff-mgr',
            name: 'Manager WithCCTV',
            phone: '03002220000',
            role: 'Manager',
            salary: 40000,
            joiningDate: '2026-01-01',
            accountStatus: 'active',
            username: 'mgr_cctv',
            newPassword: 'StaffPass!123',
            permissions: {
              newSale: true,
              oldSale: true,
              settings: true,
              canAccessSettings: true,
              canViewCctv: true,
              canManageCctv: true,
            },
          },
        ],
      }),
    });
    assert.equal(syncRbacRes.status, 200);

    const guardLogin = await jsonReq(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ portal: 'shop', identifier: 'cctv_guard', password: 'StaffPass!123' }),
    });
    assert.equal(guardLogin.status, 200);
    const guardToken = guardLogin.data.token as string;

    const guardOverview = await jsonReq(baseUrl, '/api/cctv/overview', {
      headers: { Authorization: `Bearer ${guardToken}` },
    });
    assert.equal(guardOverview.status, 200);
    assert.equal(guardOverview.data.permissions.canView, true);
    assert.equal(guardOverview.data.permissions.canManage, false);

    // Guard cannot mutate settings/groups/cameras
    const guardMutDenied = await jsonReq(baseUrl, '/api/cctv/groups', {
      method: 'POST',
      headers: { Authorization: `Bearer ${guardToken}` },
      body: JSON.stringify({ name: 'Unauthorized Group' }),
    });
    assert.equal(guardMutDenied.status, 403);

    // Enable staffViewOnly=true + set PIN 4829 as owner -> manager also becomes view-only!
    const saveSettingsRes = await jsonReq(baseUrl, '/api/cctv/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        defaultGridLayout: '3x3',
        motionDetection: { enabled: true, sensitivity: 65, recordOnMotion: false, notifyInApp: true },
        storage: { retentionDays: 14, maxStorageMb: 1024, autoDeleteExpired: false, warningThresholdPercent: 80 },
        security: { staffViewOnly: true },
        newPin: '4829',
      }),
    });
    assert.equal(saveSettingsRes.status, 200);
    assert.equal(saveSettingsRes.data.settings.security.pinEnabled, true);
    assert.equal(saveSettingsRes.data.settings.security.staffViewOnly, true);
    assert.equal(saveSettingsRes.text.includes('4829'), false);
    assert.equal(saveSettingsRes.text.includes('pinHash'), false);
    assert.equal(saveSettingsRes.text.includes('pinSalt'), false);

    // Verify PIN hash never leaks via overview, store/state or backup/export
    const checkOverviewNoPin = await jsonReq(baseUrl, '/api/cctv/overview', {
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    assert.equal(checkOverviewNoPin.status, 200);
    assert.equal(checkOverviewNoPin.data.permissions.canManage, false, 'staffViewOnly must override manager manage access');
    assert.equal(checkOverviewNoPin.text.includes('pinHash'), false);
    assert.equal(checkOverviewNoPin.text.includes('pinSalt'), false);

    // Verify PIN verification endpoint rejects wrong PIN and accepts 4829
    const badPin = await jsonReq(baseUrl, '/api/cctv/pin/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(badPin.status, 401);

    const goodPin = await jsonReq(baseUrl, '/api/cctv/pin/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ pin: '4829' }),
    });
    assert.equal(goodPin.status, 200);

    // Clear PIN cleanly
    const clearPinRes = await jsonReq(baseUrl, '/api/cctv/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ clearPin: true, security: { staffViewOnly: false } }),
    });
    assert.equal(clearPinRes.status, 200);
    assert.equal(clearPinRes.data.settings.security.pinEnabled, false);

    // Snapshot capture returns valid JPEG bytes (FFD8)
    const snapFetch = await fetch(`${baseUrl}/api/cctv/cameras/${mp4CamId}/snapshot`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(snapFetch.status, 200);
    const snapBuf = Buffer.from(await snapFetch.arrayBuffer());
    assert.equal(snapBuf[0], 0xff);
    assert.equal(snapBuf[1], 0xd8);

    // ONVIF PTZ command on PTZ camera
    const ptzRes = await jsonReq(baseUrl, `/api/cctv/cameras/${camId}/ptz`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ action: 'left', speed: 0.6 }),
    });
    assert.equal(ptzRes.status, 200);
    assert.ok(receivedPtzXml.includes('ContinuousMove'));
    assert.ok(receivedPtzXml.includes('camadmin'));

    // PTZ rejected if camera doesn't support PTZ
    const ptzDenied = await jsonReq(baseUrl, `/api/cctv/cameras/${mp4CamId}/ptz`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ action: 'left' }),
    });
    assert.equal(ptzDenied.status, 400);

    // Server recording start -> wait -> stop -> filtered list -> HTTP Range 206 playback -> storage -> cleanup
    console.log('7. Verifying MP4 recording, filtered playback, HTTP Range 206, storage & FFmpeg motion detection...');
    const recStart = await jsonReq(baseUrl, `/api/cctv/cameras/${mp4CamId}/recordings/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ trigger: 'manual' }),
    });
    assert.equal(recStart.status, 200);
    const recId = recStart.data.recording.id as string;
    await new Promise((r) => setTimeout(r, 1400));
    const recStop = await jsonReq(baseUrl, `/api/cctv/cameras/${mp4CamId}/recordings/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ recordingId: recId }),
    });
    assert.equal(recStop.status, 200);
    assert.ok(recStop.data.recording.sizeBytes > 0);
    assert.equal(recStop.data.recording.trigger, 'manual');

    const todayStr = new Date().toISOString().slice(0, 10);
    const filteredRecs = await jsonReq(baseUrl, `/api/cctv/recordings?cameraId=${encodeURIComponent(mp4CamId)}&date=${todayStr}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(filteredRecs.status, 200);
    assert.ok(filteredRecs.data.recordings.some((r: any) => r.id === recId));

    // HTTP Range 206 check
    const rangeRes = await fetch(`${baseUrl}/api/cctv/recordings/${recId}/file`, {
      headers: { Authorization: `Bearer ${ownerToken}`, Range: 'bytes=0-1023' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
    assert.ok((rangeRes.headers.get('content-range') || '').startsWith('bytes 0-1023/'));
    const rangeChunk = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(rangeChunk.length, 1024);

    // Real storage summary
    const storageRes = await jsonReq(baseUrl, '/api/cctv/storage', {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(storageRes.status, 200);
    assert.ok(storageRes.data.storage.usedBytes > 0);
    assert.ok(storageRes.data.storage.totalDiskBytes > 0);
    assert.ok(Array.isArray(storageRes.data.storage.perCamera));

    // Cleanup requires explicit confirmDelete: true
    const cleanupUnconfirmed = await jsonReq(baseUrl, '/api/cctv/storage/cleanup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ olderThanDays: 30, confirmDelete: false }),
    });
    assert.equal(cleanupUnconfirmed.status, 400);

    // Genuine FFmpeg frame-delta motion scan on live camera vs offline camera
    const offlineMotion = await jsonReq(baseUrl, `/api/cctv/cameras/${offlineCamId}/motion-check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ sensitivity: 70 }),
    });
    assert.equal(offlineMotion.status, 502);

    const liveMotion = await jsonReq(baseUrl, `/api/cctv/cameras/${mp4CamId}/motion-check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ sensitivity: 70 }),
    });
    assert.equal(liveMotion.status, 200);
    assert.equal(typeof liveMotion.data.confidenceScore, 'number');
    assert.equal(typeof liveMotion.data.detected, 'boolean');

    const motionListRes = await jsonReq(baseUrl, '/api/cctv/motion-events', {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(motionListRes.status, 200);
    assert.ok(Array.isArray(motionListRes.data.events));
    if (liveMotion.data.detected) {
      assert.ok(motionListRes.data.events.length >= 1);
      assert.equal(motionListRes.data.events[0].source, 'ffmpeg-frame-diff');
    }

    // Clear motion history & sync recording schedule
    const clearMotionRes = await jsonReq(baseUrl, '/api/cctv/motion-events', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(clearMotionRes.status, 200);

    const syncSchedRes = await jsonReq(baseUrl, '/api/cctv/schedule/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(syncSchedRes.status, 200);

    // CCTV Backup Export & Import (secrets strictly redacted)
    const cctvExport = await jsonReq(baseUrl, '/api/cctv/backup/export', {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(cctvExport.status, 200);
    assert.equal(cctvExport.text.includes('CamSecret#99'), false);
    assert.equal(cctvExport.text.includes('pinHash'), false);

    const cctvImport = await jsonReq(baseUrl, '/api/cctv/backup/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ backup: cctvExport.data.backup }),
    });
    assert.equal(cctvImport.status, 200);

    // Delete single recording + delete offline cam + delete custom group
    const recDelRes = await jsonReq(baseUrl, `/api/cctv/recordings/${recId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(recDelRes.status, 200);

    const delGrpRes = await jsonReq(baseUrl, '/api/cctv/groups/Warehouse%20Wing', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(delGrpRes.status, 200);

    // Multi-Shop Isolation: Super Admin POS does not see Mart A's cameras
    const saOverview = await jsonReq(baseUrl, '/api/cctv/overview?shopId=SHOP-SA-POS', {
      headers: { Authorization: `Bearer ${superToken}` },
    });
    assert.equal(saOverview.status, 200);
    assert.equal(saOverview.data.cameras.length, 0);

    // Delete MP4 & Offline Cameras
    await jsonReq(baseUrl, `/api/cctv/cameras/${mp4CamId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    await jsonReq(baseUrl, `/api/cctv/cameras/${offlineCamId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    const refreshAllRes = await jsonReq(baseUrl, '/api/cctv/refresh-all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(refreshAllRes.status, 200);
    assert.equal(refreshAllRes.data.cameras.length, 1);

    console.log('8. Verifying CctvPage React SSR dashboard, all 9 sub-view tabs & zero secret leak...');
    const sampleCams: CctvCamera[] = [createCamRes.data.camera];
    const sampleDvr: DvrNvrConfig = {
      brand: 'Hikvision',
      dvrIp: '192.168.1.100',
      port: 554,
      username: 'admin',
      channelCount: 8,
      connected: true,
    };
    const html = renderToStaticMarkup(
      React.createElement(CctvPage, {
        cameras: sampleCams,
        dvrConfig: sampleDvr,
        activeShopId: martAId,
        userRole: 'SHOP_OWNER',
        canManage: true,
        onSyncCameras: () => {},
        onSyncDvrConfig: () => {},
      })
    );
    assert.ok(html.includes('Live View'));
    assert.ok(html.includes('Cameras &amp; Groups') || html.includes('Cameras & Groups'));
    assert.ok(html.includes('Recordings'));
    assert.ok(html.includes('Playback'));
    assert.ok(html.includes('Motion &amp; Alerts') || html.includes('Motion & Alerts'));
    assert.ok(html.includes('Device Status'));
    assert.ok(html.includes('Storage'));
    assert.ok(html.includes('Settings'));
    assert.ok(html.includes('Cash Counter 1'));
    assert.ok(!html.includes('CamSecret#99'));

    console.log('ALL CCTV Gateway, Dashboard, Grid, Recording, Playback Range, FFmpeg Motion, Storage, PIN & RBAC tests PASSED!');
  } finally {
    camServer.close();
    if (serverProc) {
      serverProc.stdout?.destroy();
      serverProc.stderr?.destroy();
      serverProc.kill('SIGKILL');
      serverProc.unref();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
