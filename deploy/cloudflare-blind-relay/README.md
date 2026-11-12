# Velo Zero-Trust Blind E2EE Relay & macOS 开机常驻指南

Velo 默认内置免注册临时公网盲中继隧道（自动指向本地 `127.0.0.1:6768` 密文中继）。
当你开启 **macOS 开机无感常驻 (`com.velo.daemon`)** 并绑定 **永久固定域名的私有盲中继** 后，无论重启 Mac、关闭桌面窗口还是手机切换 5G 外网，**手机永久免重扫二维码、秒级直连唤醒**。

---

## 一、 macOS 开机无感常驻 (`LaunchAgent` + 息屏不断连)

```bash
# 安装并立即启动 macOS 用户级开机自启守护服务 + 息屏网络保活 (caffeinate -i)
velo service install

# 查看常驻状态、PID、防休眠断言与日志路径
velo service status

# 重启 / 卸载开机常驻服务
velo service restart
velo service uninstall
```

也可以直接在 Mac 桌面端 `Velo.app` 右上角 **手机配对** 弹窗中一键开关 **「开机自启」** 与 **「息屏不断连」**。

---

## 二、 部署永久固定域名的私有盲中继（二选一）

### 方案 A：Cloudflare Workers + Durable Objects（0 元免费额度 · 推荐搭配自定义域名）

```bash
# 1a. 使用默认 *.workers.dev 固定域名（首次会自动打开浏览器登录 Cloudflare）
./scripts/deploy-cloudflare-relay.sh

# 1b. 绑定你 Cloudflare 账号下的自有域名（国内 5G 直连更稳更快，强烈推荐！）
./scripts/deploy-cloudflare-relay.sh relay.yourdomain.com
```

脚本部署完成后会自动把固定 `wss://...` 地址锁定到本机 `~/.velo/pairing_identity.json` 并同步到连接的 iPhone。

### 方案 B：部署到自有云服务器（如香港/新加坡/国内轻量服务器）

```bash
# 自动上传源码、编译安装 systemd 常驻服务 `velo-blind-relay.service` (监听 127.0.0.1:6768) 并锁定域名
./scripts/deploy-vps-relay.sh <ssh-host> relay.yourdomain.com
```

在服务器上用 Caddy 一行配置反代 TLS 即可：
```caddyfile
relay.yourdomain.com {
    reverse_proxy 127.0.0.1:6768
}
```
