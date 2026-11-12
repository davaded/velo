# Velo Zero-Trust Blind E2EE Relay (Self-Hosted Edge Kit)

Velo 已开箱内置免注册公网盲中继隧道（自动拉起 `cloudflared` 指向本地 `127.0.0.1:6768` 密文中继）。
如果你希望拥有**永久固定域名**（Mac 重启也永不变更 URL、手机终身免重扫），可使用本目录一键部署到你自己的 Cloudflare 免费账户或任意 VPS：

## 方案 A：Cloudflare Workers + Durable Objects（0 元免费额度 · 全球边缘低延迟）

```bash
cd deploy/cloudflare-blind-relay
npx wrangler deploy
```

部署后会输出固定地址（例如 `https://velo-blind-relay.<your-subdomain>.workers.dev`）。
打开 Mac 端 Velo → 右上角手机配对 → 填入 `wss://velo-blind-relay.<your-subdomain>.workers.dev` → 点击 **切换中继**，手机扫一次即可永久跨网连通。

## 方案 B：自有云服务器运行原生 Rust `velo-relay`

```bash
cargo build --release -p velo-cli
./target/release/velo relay --host 0.0.0.0 --port 6768
```

配合 Caddy / Nginx 反代 TLS (`wss://relay.yourdomain.com`) 即可。
