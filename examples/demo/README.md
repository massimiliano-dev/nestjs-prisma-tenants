# Demo: three tenants on subdomains

```bash
# from the repository root
docker compose -f examples/demo/compose.yml up --build

curl http://acme.localhost:3000/notes
curl -X POST -H 'content-type: application/json' -d '{"title":"hello"}' http://globex.localhost:3000/notes
curl -H 'X-Tenant-Id: initech' http://127.0.0.1:3000/notes
curl http://hooli.localhost:3000/notes      # 404, unknown tenant
curl http://127.0.0.1:3000/health           # public liveness
```

On first boot `scripts/provision.sh` creates `acme`, `globex` and `initech`, each with its own database and role,
then runs `tenants migrate --all`. Set `ADMIN_TOKEN` to enable `/health/details` (cache and circuit state):

```bash
ADMIN_TOKEN=$(openssl rand -hex 32) docker compose -f examples/demo/compose.yml up --build
curl -H "X-Admin-Token: $ADMIN_TOKEN" http://127.0.0.1:3000/health/details
```

The passwords in `compose.yml` are throwaway demo values. Ports are bound to `127.0.0.1` only. If another
process listens on port 3000 over IPv6, use `127.0.0.1` with a `Host` header instead of `*.localhost`.
