# clean-service

Example service used as a false-positive benchmark for Relivaro. It intentionally uses patterns that look similar to
vulnerable code (template strings in SQL with constants, Math.random for jitter, redirects with validation) but are safe.

## Development

```bash
npm ci
npm test
```

Configuration is read from environment variables documented in `.env.example`.
