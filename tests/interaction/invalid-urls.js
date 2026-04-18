#!/usr/bin/env node
// Invalid-URL smoke test.
// Asserts the nginx allowlist + Express 404 handler behave correctly:
//   - known static paths serve HTML 200
//   - the branded 404.html is not directly addressable (internal-only)
//   - unknown paths return 404 + branded page
//   - path traversal attempts do not leak filesystem contents
//   - unknown API routes return the JSON 404 envelope
//   - GET /ws without Upgrade header does not leak framework stack traces
//
// Usage:
//   node tests/interaction/invalid-urls.js [--base-url http://localhost]

const args = process.argv.slice(2);
const baseArgIdx = args.indexOf('--base-url');
const BASE_URL = (baseArgIdx >= 0 ? args[baseArgIdx + 1] : 'http://localhost').replace(/\/$/, '');

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL ${name} — ${detail}`);
  }
}

async function fetchRaw(path, init = {}) {
  const res = await fetch(BASE_URL + path, { redirect: 'manual', ...init });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text };
}

async function section(title, fn) {
  console.log(`\n# ${title}`);
  await fn();
}

(async () => {
  console.log(`Invalid-URL smoke test → ${BASE_URL}`);

  await section('known static paths', async () => {
    for (const p of ['/', '/index.html', '/dashboard.html']) {
      const r = await fetchRaw(p);
      record(`GET ${p} → 200`, r.status === 200, `status=${r.status}`);
      record(`GET ${p} → html`, /<!DOCTYPE html>/i.test(r.body), 'missing DOCTYPE');
    }
  });

  await section('404.html is internal-only', async () => {
    const r = await fetchRaw('/404.html');
    record('GET /404.html → 404', r.status === 404, `status=${r.status}`);
  });

  await section('unknown static paths render branded 404', async () => {
    const unknowns = [
      '/nonexistent',
      '/admin',
      '/wp-admin',
      '/.env',
      '/robots.txt',
      '/foo/bar/baz',
      '/index.php',
    ];
    for (const p of unknowns) {
      const r = await fetchRaw(p);
      record(`GET ${p} → 404`, r.status === 404, `status=${r.status}`);
      record(`GET ${p} → branded body`, /Page Not Found/i.test(r.body), 'missing branded 404 body');
    }
  });

  await section('path traversal is blocked without filesystem leak', async () => {
    const attempts = [
      '/../etc/passwd',
      '/%2e%2e/etc/passwd',
      '/%2e%2e%2fetc%2fpasswd',
      '/..%2f..%2fetc%2fpasswd',
    ];
    for (const p of attempts) {
      const r = await fetchRaw(p);
      record(`GET ${p} blocked (4xx)`, r.status >= 400 && r.status < 500, `status=${r.status}`);
      record(
        `GET ${p} no /etc/passwd leak`,
        !/root:x:0:0/.test(r.body),
        'body contained passwd-shaped content',
      );
    }
  });

  await section('API 404 envelope', async () => {
    const apiUnknowns = ['/api/garbage', '/api/v1/withdraw', '/api/v1/bogus', '/api/v2/anything'];
    for (const p of apiUnknowns) {
      const r = await fetchRaw(p);
      record(`GET ${p} → 404`, r.status === 404, `status=${r.status}`);
      const ct = r.headers.get('content-type') || '';
      record(`GET ${p} → application/json`, /application\/json/i.test(ct), `content-type=${ct}`);
      let parsed = null;
      try {
        parsed = JSON.parse(r.body);
      } catch {
        /* ignore */
      }
      record(
        `GET ${p} → { error, path }`,
        parsed && parsed.error === 'not_found' && typeof parsed.path === 'string',
        `body=${r.body.slice(0, 120)}`,
      );
      record(
        `GET ${p} → no stack trace`,
        !/at\s+\w+\s+\(.+:\d+:\d+\)/.test(r.body),
        'body looked like a JS stack trace',
      );
    }
  });

  await section('known API/infra paths still work', async () => {
    const okPaths = [
      { path: '/api/v1/config', expectJson: true },
      { path: '/health', expectJson: true },
    ];
    for (const { path, expectJson } of okPaths) {
      const r = await fetchRaw(path);
      record(`GET ${path} → 200`, r.status === 200, `status=${r.status}`);
      if (expectJson) {
        try {
          JSON.parse(r.body);
          record(`GET ${path} → valid JSON`, true);
        } catch (e) {
          record(`GET ${path} → valid JSON`, false, String(e));
        }
      }
    }
  });

  await section('GET /ws without Upgrade does not leak', async () => {
    const r = await fetchRaw('/ws');
    record('GET /ws rejected (4xx)', r.status >= 400 && r.status < 500, `status=${r.status}`);
    record(
      'GET /ws no stack trace',
      !/at\s+\w+\s+\(.+:\d+:\d+\)/.test(r.body),
      'body looked like a JS stack trace',
    );
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Runner crashed:', err);
  process.exit(2);
});
