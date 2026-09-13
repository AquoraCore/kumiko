# Self-hosting Kumiko

Run the full Kumiko web app (notes, PDFs, AI, collab) on your own machine or a small VPS. Everything — accounts, notes, PDFs, databases — lives in **one data folder**, so backups and updates are trivial.

> Status: experimental. The desktop app remains the primary experience; the server is the same UI from a browser or phone.

## In-app Host Mode (LAN)

No Docker, no Terminal: open the desktop app → **Settings → Host on the network** and flip the switch. Kumiko runs its web server inside the app; phones on the same Wi-Fi scan the QR code and are in immediately.

Two modes:

- **Share this vault (mirror)** — your phone lands directly in the desktop's current vault, no signup. Phones sign in via the QR's one-time pairing token, refreshed every time the host restarts.
- **Family server** — members create their own accounts and each gets a separate vault, just like a normal web deployment.

How it differs from Docker above: the host runs **only while the desktop app is open** (closing the app pauses it; a running host restores itself on the next launch) and it is reachable **only on your local Wi-Fi** — not from the internet. For outside-your-home access, use the Docker deployment with a Cloudflare Tunnel.

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
| `GOOGLE_CLIENT_ID` | *(unset)* | Google OAuth client id to show a "Sign in with Google" button. Google accounts are always treated as email-verified |
| `RESEND_API_KEY` | *(unset = dev-mode)* | Resend API key to send real email (verification codes, password resets). **Unset → dev-mode: every email is printed to the server log instead of sent** — codes/links still work, copy them from the log |
| `EMAIL_FROM` | `Kumiko <no-reply@aquoracore.com>` | The From: header for all outgoing email (must be a sender allowed by your Resend domain) |
| `REQUIRE_EMAIL_VERIFY` | *(unset = off)* | Set to `1` to require email verification on signup: new accounts get a 6-digit code (15 min, max 5 wrong tries) and a JWT only after `POST /auth/verify` succeeds. Default off = signup logs you in immediately, exactly like before |

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

รันคำสั่ง `docker run -d -p 4321:4321 -v ./kumiko-data:/data ghcr.io/aquoracore/kumiko` แล้วเปิด http://localhost:4321 สมัครบัญชีแรกเป็นของตัวเอง — ข้อมูลทั้งหมด (โน้ต/บัญชี/PDF/ฐานข้อมูล) อยู่ในโฟลเดอร์ `kumiko-data` โฟลเดอร์เดียว copy ออกไปคือ backup สมบูรณ์ อัปเดตด้วย `docker pull` + restart ข้อมูลไม่หาย ถ้าไม่ตั้ง `AUTH_SECRET` เซิร์ฟเวอร์จะ generate ให้และเก็บใน `/data/.auth-secret` (โทเคนไม่ตายตอน restart) จะจำกัดสมาชิกให้ตั้ง `ALLOWED_EMAILS` จะเปิดให้ข้างนอกเข้าถึงได้แนะนำ Cloudflare Tunnel (ดูขั้นตอนเต็มด้านบน) ส่วนอีเมล (ยืนยันตัว/ลืมรหัสผ่าน): ไม่ตั้ง `RESEND_API_KEY` = dev-mode อีเมลทุกฉบับจะพิมพ์ออกทาง log ของเซิร์ฟเวอร์แทนการส่งจริง เปิดยืนยันอีเมลตอนสมัครด้วย `REQUIRE_EMAIL_VERIFY=1` รายละเอียด env ทุกตัวดูตารางด้านบน
