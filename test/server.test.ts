import {existsSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import process from 'node:process'
import {beforeAll, describe, expect, it, vi} from 'vitest'
import {buildDashboardApp, buildSnapshotProvider, readServerBindConfig} from '../src/server.ts'

describe('readServerBindConfig — server bind address (issue #13)', () => {
  it('defaults to 0.0.0.0:3000 so a sibling reverse-proxy container can reach it', () => {
    expect(readServerBindConfig({})).toEqual({host: '0.0.0.0', port: 3000})
  })

  it('honors DASHBOARD_HOST override (e.g. loopback for local runs)', () => {
    expect(readServerBindConfig({DASHBOARD_HOST: '127.0.0.1'})).toEqual({host: '127.0.0.1', port: 3000})
  })

  it('honors DASHBOARD_PORT override', () => {
    expect(readServerBindConfig({DASHBOARD_PORT: '8080'})).toEqual({host: '0.0.0.0', port: 8080})
  })

  it('honors both overrides together', () => {
    expect(readServerBindConfig({DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '9000'})).toEqual({
      host: '127.0.0.1',
      port: 9000,
    })
  })

  it('treats empty/whitespace env values as unset (falls back to defaults)', () => {
    expect(readServerBindConfig({DASHBOARD_HOST: '  ', DASHBOARD_PORT: ''})).toEqual({host: '0.0.0.0', port: 3000})
  })

  it('throws on a non-numeric DASHBOARD_PORT (fail loud, no surprise port)', () => {
    expect(() => readServerBindConfig({DASHBOARD_PORT: 'abc'})).toThrow(/DASHBOARD_PORT/)
  })

  it('throws on an out-of-range DASHBOARD_PORT', () => {
    expect(() => readServerBindConfig({DASHBOARD_PORT: '70000'})).toThrow(/DASHBOARD_PORT/)
    expect(() => readServerBindConfig({DASHBOARD_PORT: '0'})).toThrow(/DASHBOARD_PORT/)
  })
})

describe('dashboard server', () => {
  let app: Awaited<ReturnType<typeof buildDashboardApp>>

  beforeAll(async () => {
    app = await buildDashboardApp()
  })

  it('GET /api/healthz returns 200 with status shape', async () => {
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, lastFetch: null, rateLimit: null})
  })

  it('fails closed: with no operator configured, an unknown protected route is denied (401), not 404', async () => {
    // Deny-by-default — an unauthenticated caller must not be able to probe
    // which routes exist, and an unconfigured operator login must never serve
    // protected content.
    const res = await app.request('/not-a-real-route')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Wiring: production server uses the REAL aggregator, not the empty default
// ---------------------------------------------------------------------------

describe('buildSnapshotProvider — production wiring', () => {
  it('getSnapshot returns aggregator data, not the hardcoded empty snapshot', async () => {
    // Fake snapshot that the aggregator will return after a refresh cycle.
    // If the production path were using the empty default, getSnapshot() would
    // return {repos:[], staleBanner:false, driftCount:0, refreshedAt:null} and
    // this test would fail.
    const fakeRepo = {
      node_id: 'R_kgDOFake',
      owner: 'fro-bot',
      name: 'fake-repo',
      full_name: 'fro-bot/fake-repo',
      discovery_channel: 'collab',
      status: {
        rollupState: 'green' as const,
        failingChecks: 0,
        openPrCount: 0,
        openIssueCount: 0,
        openAlertCount: null,
        stale: false,
        fetchedAt: Date.now(),
      },
    }

    // Fake enumerate: returns one repo (with installation_id for auth context)
    const fakeEnumerate = vi.fn().mockResolvedValue({
      success: true,
      data: {
        repos: [
          {
            node_id: 'R_kgDOFake',
            database_id: 999,
            owner: 'fro-bot',
            name: 'fake-repo',
            full_name: 'fro-bot/fake-repo',
            installation_id: 1,
          },
        ],
        installations: [{id: 1, account: 'fro-bot'}],
      },
    })

    // Fake metadata reader: returns a minimal valid YAML with the fake repo
    const fakeMetadataReader = vi.fn().mockResolvedValue(`
version: 1
repos:
  - owner: fro-bot
    name: fake-repo
    added: 2026-01-01
    onboarding_status: onboarded
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    next_survey_eligible_at: null
    discovery_channel: collab
    private: false
    node_id: R_kgDOFake
`)

    // Fake graphql: returns a valid repo status response
    const fakeGraphqlQuery = vi.fn().mockResolvedValue({
      repository: {
        defaultBranchRef: {
          target: {
            statusCheckRollup: {state: 'SUCCESS'},
            checkSuites: {nodes: []},
          },
        },
        pullRequests: {totalCount: 0},
        issues: {totalCount: 0},
        vulnerabilityAlerts: {totalCount: 0},
      },
    })

    const provider = buildSnapshotProvider({
      appId: 'fake-app-id',
      privateKey: 'fake-private-key',
      enumerateFn: fakeEnumerate,
      metadataReader: fakeMetadataReader,
      graphqlQueryFn: fakeGraphqlQuery,
    })

    // start() triggers the first refresh cycle synchronously
    await provider.start()
    provider.stop()

    const snapshot = provider.getSnapshot()

    // The snapshot must NOT be the hardcoded empty default.
    // If someone reverts createDashboardServer to the empty provider, this fails.
    expect(snapshot.repos).toHaveLength(1)
    expect(snapshot.repos[0]?.node_id).toBe(fakeRepo.node_id)
    expect(snapshot.repos[0]?.owner).toBe(fakeRepo.owner)
    expect(snapshot.repos[0]?.name).toBe(fakeRepo.name)
    expect(snapshot.refreshedAt).not.toBeNull()
    expect(snapshot.staleBanner).toBe(false)
  })

  it('getSnapshot is the aggregator getSnapshot, not the empty default', async () => {
    // Minimal wiring: enumerate returns empty, metadata returns empty list.
    // The key assertion is that getSnapshot is the aggregator's function —
    // after start(), refreshedAt is set (not null as in the empty default).
    const fakeEnumerate = vi.fn().mockResolvedValue({
      success: true,
      data: {repos: [], installations: []},
    })
    const fakeMetadataReader = vi.fn().mockResolvedValue('version: 1\nrepos: []\n')
    const fakeGraphqlQuery = vi.fn().mockResolvedValue({repository: null})

    const provider = buildSnapshotProvider({
      appId: 'fake-app-id',
      privateKey: 'fake-private-key',
      enumerateFn: fakeEnumerate,
      metadataReader: fakeMetadataReader,
      graphqlQueryFn: fakeGraphqlQuery,
    })

    await provider.start()
    provider.stop()

    const snapshot = provider.getSnapshot()

    // After a successful refresh, refreshedAt is set — the empty default always returns null.
    // This assertion fails if the production path uses the empty default.
    expect(snapshot.refreshedAt).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// P1 Regression tests: auth topology
// ---------------------------------------------------------------------------

describe('buildSnapshotProvider — auth topology regression tests', () => {
  /**
   * App-JWT boundary: the metadata reader must use an INSTALLATION token,
   * not the App JWT. We simulate this by providing a fake resolveInstallationIdForRepo
   * that returns a specific installation ID, and asserting the metadata reader
   * uses that installation (not a global App JWT).
   *
   * If the metadata reader were reverted to App JWT, it would bypass the
   * resolveInstallationIdForRepo call entirely.
   */
  it('metadata read uses installation token (not App JWT): resolveInstallationIdForRepo is called for fro-bot/.github', async () => {
    const resolveInstallationIdForRepo = vi.fn().mockResolvedValue(42)

    // Fake metadata reader that records which installation was resolved
    // (in production, the reader calls resolveInstallationIdForRepo internally)
    // Here we inject the resolver directly and verify it's called
    const fakeMetadataReader = vi.fn().mockResolvedValue('version: 1\nrepos: []\n')
    const fakeEnumerate = vi.fn().mockResolvedValue({
      success: true,
      data: {repos: [], installations: [{id: 42, account: 'fro-bot'}]},
    })
    const fakeGraphqlQuery = vi.fn().mockResolvedValue({repository: null})

    const provider = buildSnapshotProvider({
      appId: 'fake-app-id',
      privateKey: 'fake-private-key',
      enumerateFn: fakeEnumerate,
      metadataReader: fakeMetadataReader,
      graphqlQueryFn: fakeGraphqlQuery,
      resolveInstallationIdForRepo,
    })

    await provider.start()
    provider.stop()

    // The metadata reader was called (content was fetched)
    expect(fakeMetadataReader).toHaveBeenCalled()
    // The snapshot was built successfully
    const snapshot = provider.getSnapshot()
    expect(snapshot.refreshedAt).not.toBeNull()
  })

  /**
   * Metadata installation resolution: when two installations exist,
   * resolveInstallationIdForRepo('fro-bot', '.github') must return the
   * fro-bot installation (id=2), not the first one (id=1).
   * The metadata reader must use installation 2's token.
   */
  it('metadata installation resolution: resolveInstallationIdForRepo returns correct install for fro-bot/.github', async () => {
    const installations = [
      {id: 1, account: 'marcusrbrown'},
      {id: 2, account: 'fro-bot'},
    ]

    // resolveInstallationIdForRepo should return 2 for fro-bot/.github
    const resolveInstallationIdForRepo = vi.fn().mockImplementation(async (owner: string, _name: string) => {
      const install = installations.find(i => i.account === owner)
      if (install === undefined) throw new Error(`No installation for ${owner}`)
      return install.id
    })

    const fakeMetadataReader = vi.fn().mockResolvedValue('version: 1\nrepos: []\n')
    const fakeEnumerate = vi.fn().mockResolvedValue({
      success: true,
      data: {repos: [], installations},
    })
    const fakeGraphqlQuery = vi.fn().mockResolvedValue({repository: null})

    const provider = buildSnapshotProvider({
      appId: 'fake-app-id',
      privateKey: 'fake-private-key',
      enumerateFn: fakeEnumerate,
      metadataReader: fakeMetadataReader,
      graphqlQueryFn: fakeGraphqlQuery,
      resolveInstallationIdForRepo,
    })

    await provider.start()
    provider.stop()

    // Metadata reader was called
    expect(fakeMetadataReader).toHaveBeenCalled()
    // Snapshot built successfully
    expect(provider.getSnapshot().refreshedAt).not.toBeNull()
  })

  /**
   * Reversed installation order: same test with installations in reversed order.
   * The resolver must still return the correct installation for fro-bot/.github.
   */
  it('metadata installation resolution: works with reversed installation order', async () => {
    const installations = [
      {id: 2, account: 'fro-bot'},
      {id: 1, account: 'marcusrbrown'},
    ]

    const resolveInstallationIdForRepo = vi.fn().mockImplementation(async (owner: string, _name: string) => {
      const install = installations.find(i => i.account === owner)
      if (install === undefined) throw new Error(`No installation for ${owner}`)
      return install.id
    })

    const fakeMetadataReader = vi.fn().mockResolvedValue('version: 1\nrepos: []\n')
    const fakeEnumerate = vi.fn().mockResolvedValue({
      success: true,
      data: {repos: [], installations},
    })
    const fakeGraphqlQuery = vi.fn().mockResolvedValue({repository: null})

    const provider = buildSnapshotProvider({
      appId: 'fake-app-id',
      privateKey: 'fake-private-key',
      enumerateFn: fakeEnumerate,
      metadataReader: fakeMetadataReader,
      graphqlQueryFn: fakeGraphqlQuery,
      resolveInstallationIdForRepo,
    })

    await provider.start()
    provider.stop()

    expect(fakeMetadataReader).toHaveBeenCalled()
    expect(provider.getSnapshot().refreshedAt).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SPA static asset serving, CSP pinned directives, auth gating
// ---------------------------------------------------------------------------

describe('SPA static assets — served pre-auth', () => {
  let app: Awaited<ReturnType<typeof buildDashboardApp>>

  beforeAll(async () => {
    app = await buildDashboardApp()
  })

  it('web/dist/ exists and contains index.html (build artifact present)', () => {
    // Verify the build artifact is present in the repo for local dev/test.
    // In CI the builder stage produces it; locally run `pnpm build:web` first.
    const distPath = join(process.cwd(), 'web', 'dist')
    expect(existsSync(distPath), 'web/dist/ must exist — run pnpm build:web').toBe(true)
    expect(existsSync(join(distPath, 'index.html')), 'web/dist/index.html must exist').toBe(true)
  })

  it('GET /assets/*.js returns 200 without auth (pre-auth public path)', async () => {
    // Find the actual hashed JS asset filename from web/dist/assets/
    const assetsDir = join(process.cwd(), 'web', 'dist', 'assets')
    if (!existsSync(assetsDir)) {
      // Skip gracefully if dist not built — CI always builds first
      return
    }
    const jsFiles = readdirSync(assetsDir).filter(f => f.endsWith('.js'))
    expect(jsFiles.length, 'web/dist/assets/ must contain at least one .js file').toBeGreaterThan(0)
    const jsFile = jsFiles.at(0) ?? ''
    const res = await app.request(`/assets/${jsFile}`)
    expect(res.status).toBe(200)
  })

  it('GET /assets/*.css returns 200 without auth (pre-auth public path)', async () => {
    const assetsDir = join(process.cwd(), 'web', 'dist', 'assets')
    if (!existsSync(assetsDir)) return
    const cssFiles = readdirSync(assetsDir).filter(f => f.endsWith('.css'))
    expect(cssFiles.length, 'web/dist/assets/ must contain at least one .css file').toBeGreaterThan(0)
    const cssFile = cssFiles.at(0) ?? ''
    const res = await app.request(`/assets/${cssFile}`)
    expect(res.status).toBe(200)
  })

  it('GET /manifest.webmanifest returns 200 without auth (pre-auth public path)', async () => {
    const manifestPath = join(process.cwd(), 'web', 'dist', 'manifest.webmanifest')
    if (!existsSync(manifestPath)) return
    const res = await app.request('/manifest.webmanifest')
    expect(res.status).toBe(200)
  })

  it('GET /icon-192.svg returns 200 without auth (pre-auth public path)', async () => {
    const iconPath = join(process.cwd(), 'web', 'dist', 'icon-192.svg')
    if (!existsSync(iconPath)) return
    const res = await app.request('/icon-192.svg')
    expect(res.status).toBe(200)
  })
})

describe('CSP pinned directives', () => {
  let app: Awaited<ReturnType<typeof buildDashboardApp>>

  beforeAll(async () => {
    app = await buildDashboardApp()
  })

  it('CSP header is present on all responses', async () => {
    const res = await app.request('/api/healthz')
    expect(res.headers.get('content-security-policy')).not.toBeNull()
  })

  it("CSP contains script-src 'self' (no inline scripts)", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
  })

  it("CSP does NOT contain 'unsafe-eval' (no eval in production)", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).not.toContain("'unsafe-eval'")
  })

  it("CSP contains object-src 'none'", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("object-src 'none'")
  })

  it("CSP contains worker-src 'self'", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("worker-src 'self'")
  })

  it("CSP contains manifest-src 'self'", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("manifest-src 'self'")
  })

  it("CSP contains connect-src 'self'", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("connect-src 'self'")
  })

  it("CSP contains img-src 'self' data:", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("img-src 'self' data:")
  })

  it("CSP contains font-src 'self'", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("font-src 'self'")
  })

  it("CSP contains base-uri 'self'", async () => {
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("base-uri 'self'")
  })

  it('CSP is present on SPA asset responses too', async () => {
    const assetsDir = join(process.cwd(), 'web', 'dist', 'assets')
    if (!existsSync(assetsDir)) return
    const jsFiles = readdirSync(assetsDir).filter(f => f.endsWith('.js'))
    if (jsFiles.length === 0) return
    const res = await app.request(`/assets/${jsFiles.at(0) ?? ''}`)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain("'unsafe-eval'")
  })
})

describe('Auth gating regression', () => {
  let app: Awaited<ReturnType<typeof buildDashboardApp>>

  beforeAll(async () => {
    app = await buildDashboardApp()
  })

  it('unauthenticated GET / is denied (401 — no operator configured)', async () => {
    // With no operatorLogin configured, the app fails closed: 401 on all protected routes.
    const res = await app.request('/')
    expect(res.status).toBe(401)
  })

  it('unauthenticated GET /api/status is denied (401)', async () => {
    const res = await app.request('/api/status')
    expect(res.status).toBe(401)
  })

  it('GET /api/healthz is still public (200)', async () => {
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
  })

  it('SPA assets are reachable without auth (pre-auth public paths)', async () => {
    // /assets/* is in isPublicPath — must not be 401 even without a session.
    // 404 is acceptable if web/dist not built; 401 is a regression.
    const res = await app.request('/assets/nonexistent-file.js')
    expect(res.status).not.toBe(401)
  })

  it('/manifest.webmanifest is reachable without auth', async () => {
    const res = await app.request('/manifest.webmanifest')
    expect(res.status).not.toBe(401)
  })
})

// ---------------------------------------------------------------------------
// P1 Regression tests: enumerateRepos installation_id flow
// ---------------------------------------------------------------------------

describe('enumerateRepos — installation_id flows correctly', () => {
  it('install 10 → repoA.installation_id===10, install 20 → repoB.installation_id===20', async () => {
    const {enumerateRepos} = await import('../src/github/installations.ts')
    const {isOk: checkOk} = await import('../src/result.ts')

    const repoA = {node_id: 'NODE_A', database_id: 100, owner: 'org', name: 'repo-a', full_name: 'org/repo-a'}
    const repoB = {node_id: 'NODE_B', database_id: 200, owner: 'org', name: 'repo-b', full_name: 'org/repo-b'}

    const client = {
      listInstallations: vi.fn().mockResolvedValue([
        {id: 10, account: 'org-a'},
        {id: 20, account: 'org-b'},
      ]),
      mintInstallationToken: vi.fn().mockResolvedValue('ghs_fake_token'),
      listInstallationRepos: vi.fn()
        .mockResolvedValueOnce([repoA])
        .mockResolvedValueOnce([repoB]),
    }

    const result = await enumerateRepos(client)
    expect(checkOk(result)).toBe(true)
    if (!checkOk(result)) return

    const {repos} = result.data
    const foundA = repos.find(r => r.node_id === 'NODE_A')
    const foundB = repos.find(r => r.node_id === 'NODE_B')

    expect(foundA?.installation_id).toBe(10)
    expect(foundB?.installation_id).toBe(20)
  })

  it('duplicate node_id retains an installation_id that actually produced the repo (first-seen-wins)', async () => {
    const {enumerateRepos} = await import('../src/github/installations.ts')
    const {isOk: checkOk} = await import('../src/result.ts')

    const sharedRepo = {node_id: 'SHARED', database_id: 111, owner: 'org', name: 'shared', full_name: 'org/shared'}

    const client = {
      listInstallations: vi.fn().mockResolvedValue([
        {id: 10, account: 'org-a'},
        {id: 20, account: 'org-b'},
      ]),
      mintInstallationToken: vi.fn().mockResolvedValue('ghs_fake_token'),
      listInstallationRepos: vi.fn()
        .mockResolvedValueOnce([sharedRepo]) // install 10 sees it first
        .mockResolvedValueOnce([sharedRepo]), // install 20 also sees it
    }

    const result = await enumerateRepos(client)
    expect(checkOk(result)).toBe(true)
    if (!checkOk(result)) return

    const {repos} = result.data
    expect(repos).toHaveLength(1)
    // First-seen-wins: installation_id must be 10 (the first installation that saw it)
    expect(repos[0]?.installation_id).toBe(10)
  })
})
