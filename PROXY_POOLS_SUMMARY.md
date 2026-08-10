# Proxy Pools - Complete Overview

## Summary

Proxy Pools is a feature in 9Router that allows users to manage multiple proxy configurations for routing AI provider requests through different proxy servers. This helps with IP masking, geographic distribution, and bypassing provider-specific blocks.

## Architecture

### File Structure

```
src/app/(dashboard)/dashboard/proxy-pools/
└── page.js                          # React UI component for managing proxy pools

src/app/api/proxy-pools/
├── route.js                         # GET (list), POST (create) proxy pools
├── [id]/
│   ├── route.js                     # GET, PUT, DELETE proxy pool by ID
│   └── test/
│       └── route.js                 # POST - Test proxy pool connectivity
├── vercel-deploy/
│   └── route.js                     # POST - Deploy relay to Vercel
├── cloudflare-deploy/
│   └── route.js                     # POST - Deploy relay to Cloudflare Workers
└── deno-deploy/
    └── route.js                     # POST - Deploy relay to Deno Deploy

src/lib/db/repos/
└── proxyPoolsRepo.js                # Database CRUD operations

src/lib/network/
├── connectionProxy.js               # Resolve proxy configuration for connections
└── proxyTest.js                     # Test proxy URL connectivity

src/models/index.js                  # Export proxy pool models
```

## Features

### 1. **Proxy Pool Management**
- **Create**: Add HTTP proxy entries with name, URL, no-proxy list
- **Read**: List all pools or get specific pool by ID
- **Update**: Edit pool properties (name, URL, active status, strict mode)
- **Delete**: Remove pools (prevented if bound to connections)

### 2. **Supports Multiple Proxy Types**
- `http` - Standard HTTP/SOCKS proxies
- `vercel` - Deploy edge relay to Vercel
- `cloudflare` - Deploy worker to Cloudflare Workers
- `deno` - Deploy relay to Deno Deploy

### 3. **Deployment Options**

#### **Vercel Relay**
- Deploys an edge function that forwards requests
- Uses X-Forwarded-For headers to mask real IP
- Free tier: 100GB bandwidth/month, 500K edge invocations
- Requires: Vercel API Token

#### **Cloudflare Relay**
- Deploys a Cloudflare Worker as HTTP proxy
- Free tier: 100,000 requests/day
- Requires: Cloudflare Account ID + Workers API Token

#### **Deno Relay**
- Deploys app to Deno Deploy's global edge network
- Free tier: 1M requests & 100GiB/month
- No per-request CPU limits
- Requires: Deno Deploy Organization Token

### 4. **Health Monitoring**
- Individual test button for each pool
- Bulk health check with concurrency limit (10 parallel)
- Auto-disable dead proxies after health check
- Track last tested time and error messages
- Status badges: `active`, `error`, `unknown`

### 5. **Bulk Operations**
- Select multiple pools
- Bulk activate/deactivate
- Bulk delete (with conflict detection)
- Batch import from clipboard (supports multiple formats)

### 6. **Connection Binding**
- Proxy pools can be assigned to provider connections
- Prevents deletion of pools in use
- Shows bound connection count
- Supports round-robin and random selection strategies

## Database Schema

### Table: `proxyPools`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | UUID identifier |
| `isActive` | INTEGER DEFAULT 1 | Active status (0/1) |
| `testStatus` | TEXT | Current test status |
| `data` | TEXT NOT NULL | JSON-encoded extra fields |
| `createdAt` | TEXT NOT NULL | ISO timestamp |
| `updatedAt` | TEXT NOT NULL | ISO timestamp |

### Extra Fields (stored in `data` column)

```json
{
  "name": "Office Proxy",
  "proxyUrl": "http://127.0.0.1:7897",
  "noProxy": "localhost,127.0.0.1",
  "type": "http",
  "strictProxy": false,
  "lastTestedAt": "2024-08-09T10:30:00Z",
  "lastError": null
}
```

### Indexes
- `idx_pp_active` - Filter by isActive
- `idx_pp_status` - Filter by testStatus

## API Endpoints

### `GET /api/proxy-pools`
List all proxy pools.

**Query Params:**
- `isActive` - Filter by active status (`true`/`false`)
- `includeUsage` - Include `boundConnectionCount` field

**Response:**
```json
{
  "proxyPools": [
    {
      "id": "uuid",
      "name": "Office Proxy",
      "proxyUrl": "http://...",
      "noProxy": "",
      "type": "http",
      "isActive": true,
      "testStatus": "active",
      "lastTestedAt": "...",
      "boundConnectionCount": 2
    }
  ]
}
```

### `POST /api/proxy-pools`
Create new proxy pool.

**Body:**
```json
{
  "name": "Office Proxy",
  "proxyUrl": "http://127.0.0.1:7897",
  "noProxy": "localhost",
  "type": "http",
  "isActive": true,
  "strictProxy": false
}
```

**Validation:**
- `name` - Required, trimmed string
- `proxyUrl` - Required, trimmed string
- `noProxy` - Optional, comma-separated hosts
- `type` - Must be one of: `http`, `vercel`, `cloudflare`, `deno`
- `isActive` - Defaults to `true`
- `strictProxy` - If `true`, fail instead of falling back

### `GET /api/proxy-pools/:id`
Get single proxy pool.

**Response:**
```json
{
  "proxyPool": { ... }
}
```

### `PUT /api/proxy-pools/:id`
Update proxy pool.

**Body:** Same as create, all fields optional except name/proxyUrl if updating those.

**Response:**
```json
{
  "proxyPool": { ... updated pool ... }
}
```

**Status Codes:**
- `404` - Not found
- `400` - Validation error

### `DELETE /api/proxy-pools/:id`
Delete proxy pool.

**Validation:** Checks if any connections are bound to this pool.

**Status Codes:**
- `404` - Not found
- `409` - Conflict (pool in use)

**Response on conflict:**
```json
{
  "error": "Proxy pool is currently in use",
  "boundConnectionCount": 2
}
```

### `POST /api/proxy-pools/:id/test`
Test proxy pool connectivity.

**Updates pool with:**
- `testStatus` - "active" or "error"
- `lastTestedAt` - Current timestamp
- `lastError` - Error message if failed
- `isActive` - Auto-set based on test result

**Response:**
```json
{
  "ok": true,
  "status": 200,
  "elapsedMs": 1234,
  "testedAt": "2024-08-09T10:30:00Z"
}
```

### Deployment Endpoints

All deployment endpoints return created proxy pool + deploy URL.

#### `POST /api/proxy-pools/vercel-deploy`
Deploys Vercel relay function.

#### `POST /api/proxy-pools/cloudflare-deploy`
Deploys Cloudflare Worker.

#### `POST /api/proxy-pools/deno-deploy`
Deploys Deno app.

## Proxy Resolution Priority

When a connection needs proxy configuration:

1. **Proxy Pool** (highest priority)
   - If `proxyPoolId` is set and valid
   - Returns unified config with `connectionProxyUrl`, `strictProxy`, etc.

2. **Legacy Proxy** (fallback)
   - Old-style `connectionProxyEnabled` + `connectionProxyUrl`
   
3. **No Proxy** (lowest)
   - No proxy configured

**Special Case: Relay Proxies**
- Vercel/Cloudflare/Deno relays use base URL rewriting (not HTTP_PROXY env vars)
- They pass `x-relay-target` and `x-relay-path` headers to redirect requests

## Usage Patterns

### Basic HTTP Proxy Setup
1. Go to `/dashboard/proxy-pools`
2. Click "Add Proxy Pool"
3. Enter name, proxy URL (e.g., `http://user:pass@127.0.0.1:7897`)
4. Optionally set no-proxy list
5. Save

### Assign to Connection
In provider connection settings:
- Select proxy pool from dropdown
- Or enter `__none__` to explicitly disable

### Batch Import Format
Supported formats (one per line):
```
http://user:pass@127.0.0.1:7897
127.0.0.1:7897:user:pass
socks5://user:pass@remote:1080
```

### Health Check Workflow
1. Select multiple pools
2. Click "Health Check"
3. Review results (alive vs dead)
4. Confirm auto-disabling of dead proxies

## Testing Strategy

- **Individual test**: Quick timeout-based connectivity check
- **Batch test**: Parallel testing with progress tracking
- **Auto-update**: Test result immediately updates pool state
- **Strict mode**: Fail-fast behavior when proxy is unavailable

## Integration Points

### Provider Connections
- Connected via `providerSpecificData.proxyPoolId`
- Resolved during request routing in `resolveConnectionProxyConfig()`
- Used by executor layer to configure outbound requests

### Deployment Scripts
Each deployment type creates a self-contained relay that:
1. Receives forwarded request
2. Reads `x-relay-target` header
3. Forwards to target URL with original method/body
4. Strips relay headers before upstream call
5. Returns response to 9Router client

## Key Constants

```javascript
// In route.js
const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno"];

// In proxyTest.js
const DEFAULT_TEST_URL = "https://google.com/";
const DEFAULT_TIMEOUT_MS = 8000; // max 30000ms

// In proxyPoolsRepo.js
export const SCHEMA_VERSION = 1;
```

## Gotchas

1. **Registry auto-generation**: Don't hand-edit registry files
2. **UUID generation**: Uses `uuid` package for ID generation
3. **JSON serialization**: Extra fields stored in `data` column as JSON
4. **Integer booleans**: SQLite stores boolean as 0/1
5. **Migration safety**: Bump `SCHEMA_VERSION` when changing schema
6. **Delete protection**: Cannot delete pools with active bindings
7. **Relay headers**: Relay proxies require special header handling
8. **Timeout limits**: Max 30s for proxy tests

## Future Enhancements

- [ ] Distributed rotation across deployments
- [ ] Per-connection weight/priority
- [ ] Historical health metrics dashboard
- [ ] Geo-location aware selection
- [ ] Automatic retry with alternative pools
- [ ] Cost tracking per proxy provider
