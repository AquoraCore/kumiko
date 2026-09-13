# Self-hosting Kumiko

Run the full Kumiko web app (notes, PDFs, AI, collab) on your own machine or a small VPS. Everything — accounts, notes, PDFs, databases — lives in **one data folder**, so backups and updates are trivial.

> Status: experimental. The desktop app remains the primary experience; the server is the same UI from a browser or phone.

## Quick start (Docker)

```bash
docker run -d --name kumiko -p 4321:4321 -v ./kumiko-data:/data ghcr.io/aquoracore/kumiko
```

Open **http://localhost:4321** and sign up — the first account you create is your login from now on. Data is stored in `./kumiko-data` on the host.

### Docker Compose

```yaml
services:
  kumiko:
    image: ghcr.io/aquoracore/kumiko:latest
    ports:
      - "4321:4321"
    volumes:
      - ./kumiko-data:/data
    restart: unless-stopped
```

`docker compose up -d` and you're done. See the repo's `docker-compose.yml` for the full example with optional env vars.

### Bare Node.js

No Docker needed — Node.js 20+:

```bash
git clone https://github.com/AquoraCore/kumiko.git
cd kumiko
npm ci --omit=dev
DATA_DIR=./kumiko-data PORT=4321 node server/index.js
```

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4321` | HTTP(S) listen port |
| `DATA_DIR` | `/data` (image) | The single folder all state lives in — accounts, notes, vaults, PDFs, the auth secret |
| `AUTH_SECRET` | *(optional)* | JWT signing secret. **If unset, a strong secret is auto-generated and persisted to `<DATA_DIR>/.auth-secret` (mode 0600)** — sessions survive restarts. Set it yourself only if you prefer managing it (e.g. Docker secrets) |
| `ALLOWED_EMAILS` | *(unset = open)* | Comma-separated allowlist — only these accounts may sign up/log in, e.g. `you@example.com,mom@example.com` |
| `MANAGED_AI_PROVIDER` | *(unset)* | `anthropic` or any OpenAI-compatible provider — lets the server hold one AI key for all its users |
| `MANAGED_AI_KEY` | *(unset)* | The API key for the managed provider (never sent to browsers) |
| `MANAGED_AI_MODEL` | provider default | Model id for the managed key (default 100 req/user/day, see `MANAGED_AI_DAILY_LIMIT`) |
| `GOOGLE_CLIENT_ID` | *(unset)* | Google OAuth client id to show a "Sign in with Google" button |

## Expose to the internet (Cloudflare Tunnel)

The easiest safe way to reach your instance from outside — no open ports, free TLS.

```bash
# 1. Install cloudflared, then log in and create a tunnel
cloudflared tunnel login
cloudflared tunnel create kumiko

# 2. Point your hostname at the tunnel
cloudflared tunnel route dns kumiko notes.example.com

# 3. Configure ingress -> your local Kumiko
cat > ~/.cloudflared/config.yml <<EOF
tunnel: kumiko
credentials-file: /home/you/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: notes.example.com
    service: http://localhost:4321
  - service: http_status:404
EOF

# 4. Run it (keep it alive with `cloudflared service install` on a server)
cloudflared tunnel run kumiko
```

Now `https://notes.example.com` serves your Kumiko. With a public URL, set `ALLOWED_EMAILS` (and consider a Google client id) so strangers can't sign up.

## Backup

Everything lives in `DATA_DIR` (the `/data` volume). Copy that folder elsewhere and you have a complete backup — accounts, notes, PDFs, databases, collab room state, even the auth secret:

```bash
docker exec kumiko tar cf - /data | cat > kumiko-backup.tar   # or just copy ./kumiko-data
```

Restoring = putting the folder back and starting the container.

## Update

```bash
docker pull ghcr.io/aquoracore/kumiko
docker rm -f kumiko && docker run -d --name kumiko -p 4321:4321 -v ./kumiko-data:/data ghcr.io/aquoracore/kumiko
# or, with compose:
docker compose pull && docker compose up -d
```

Your data is in the volume, not the image — nothing is lost between updates.

---

## ภาษาไทย (ย่อ)

รันคำสั่ง `docker run -d -p 4321:4321 -v ./kumiko-data:/data ghcr.io/aquoracore/kumiko` แล้วเปิด http://localhost:4321 สมัครบัญชีแรกเป็นของตัวเอง — ข้อมูลทั้งหมด (โน้ต/บัญชี/PDF/ฐานข้อมูล) อยู่ในโฟลเดอร์ `kumiko-data` โฟลเดอร์เดียว copy ออกไปคือ backup สมบูรณ์ อัปเดตด้วย `docker pull` + restart ข้อมูลไม่หาย ถ้าไม่ตั้ง `AUTH_SECRET` เซิร์ฟเวอร์จะ generate ให้และเก็บใน `/data/.auth-secret` (โทเคนไม่ตายตอน restart) จะจำกัดสมาชิกให้ตั้ง `ALLOWED_EMAILS` จะเปิดให้ข้างนอกเข้าถึงได้แนะนำ Cloudflare Tunnel (ดูขั้นตอนเต็มด้านบน) รายละเอียด env ทุกตัวดูตารางด้านบน
