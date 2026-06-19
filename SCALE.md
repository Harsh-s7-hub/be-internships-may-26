# Scale Plan: 10k RPS Design

## Data Model & Indexes
- **Signals Table**: Partitioned by `user_id` (sharding key)
  - Primary index: `id` (auto-increment)
  - Composite index: `(user_id, created_at DESC)` for list queries
  - Unique index: `idempotency_key` (sparse, nullable)
  - For 10k RPS: partition by `user_id MOD N` (8-16 partitions)

## Idempotency Across Instances
- **Database-Level Enforcement**: UNIQUE constraint on `idempotency_key`
- **Write Pattern**: Try insert → on UNIQUE violation → fetch existing row
- **Atomic Operation**: Combined with retry/backoff, guarantees idempotency
- **Caching Layer**: Redis cache with TTL for hot idempotency keys (L1 cache)
- **Result**: No duplicates even with concurrent requests + horizontal scaling

## Rate Limiting Across Instances
- **Replace in-memory with Redis**:
  - Key format: `ratelimit:{userId}:{unixMinute}`
  - Operation: `INCR` + `EXPIRE 60`
  - Atomic check-and-consume at Redis level
  - All instances see same limits instantly
- **Fallback**: If Redis down, allow requests (graceful degradation)
- **Distributed Burst**: Each instance shares same Redis counter

## Observability (Logs/Metrics/Alerts)
- **Request Logging**: userId, endpoint, response code, latency
- **Metrics**:
  - Request rate (RPS)
  - p50, p95, p99 latency
  - Error rate (4xx, 5xx)
  - Rate limit rejections (429)
  - DB connection pool saturation
- **Alerts**:
  - Error rate > 1%
  - p99 latency > 500ms
  - DB pool > 80%
  - Redis latency spikes

## Failure Modes & Recovery

### Database Down
- Retry with exponential backoff (50ms, 100ms, 200ms) + jitter
- Return 503 after 3 attempts
- Circuit breaker: skip retries if DB offline for >30s

### Partial Outages (High Latency)
- Timeout requests at 5s
- Queue writes to Redis (async flush)
- Worker processes queue when DB recovers

### Redis Down
- Rate limit falls back to in-memory (single-instance only)
- Idempotency key lookups skip cache, hit DB directly
- Eventual consistency: accept slightly higher duplicate rate

## 10k RPS Design Sketch

### Architecture
```
Load Balancer (NGINX)
    ↓
  ┌─────────────────────────┐
  │  API Instances (5-10)   │
  │  Fastify + Node.js      │
  └────────┬────────────────┘
           ├─→ Redis (Rate Limit + Cache)
           │
           ├─→ PostgreSQL Primary (writes)
           │    └─→ 2x Read Replicas
           │
           └─→ Message Queue (async writes)
                ├─→ Worker 1
                ├─→ Worker 2
                └─→ Worker 3
```

### Capacity Planning
- **API Instances**: 5 instances × 2k RPS/instance = 10k RPS
- **Database**: PostgreSQL with connection pool (20 conn/instance = 100 connections)
- **Redis**: Single node (handles 100k ops/sec easily)
- **Workers**: 3 workers for async processing (backup)

### Cost Estimate (AWS)
- **EC2 (API)**: 5× t3.medium = ~$0.10/hr = $72/month
- **RDS PostgreSQL**: db.m5.large = ~$0.35/hr = $250/month
- **ElastiCache Redis**: cache.t3.medium = ~$0.04/hr = $30/month
- **Total**: ~$350/month for 10k RPS with high availability

### Query Optimization
- Connection pooling: PgBouncer (max 100 connections)
- Prepared statements to reduce parsing overhead
- Batch inserts (100 signals per flush)
- Read replicas for GET queries

### Deployment
- Blue-green deployments (zero downtime)
- Canary releases (5% → 50% → 100%)
- Auto-scaling: +1 instance if avg CPU > 70%

