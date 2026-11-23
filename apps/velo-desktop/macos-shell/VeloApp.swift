import Cocoa
import UserNotifications
import WebKit

private struct MenuSessionSummary {
    let id: String
    let name: String
    let provider: String
    let status: String
}

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var daemonProcess: Process?
    var statusItem: NSStatusItem!
    private var statusPollTimer: Timer?
    private var allowExplicitQuit = false
    private var cachedMenuSessions: [MenuSessionSummary] = []
    private var caffeinateActive = false
    private var lastMenuBarSignature = ""
    private var lastStatusBySessionId: [String: String] = [:]
    private var didPrimeStatusSnapshot = false

    func isDaemonPortListening() -> Bool {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(6767).bigEndian
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)

        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        close(sock)
        return connected == 0
    }

    func ensureDaemonRunning() {
        if isDaemonPortListening() {
            return
        }

        let bundledBin = Bundle.main.bundlePath + "/Contents/MacOS/velo-daemon"
        let bundledUiDir = Bundle.main.bundlePath + "/Contents/Resources/dist"
        let userHomeBin = NSHomeDirectory() + "/.velo/bin/velo-daemon"
        let daemonBin: String
        if FileManager.default.isExecutableFile(atPath: bundledBin) {
            daemonBin = bundledBin
        } else if FileManager.default.isExecutableFile(atPath: userHomeBin) {
            daemonBin = userHomeBin
        } else {
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: daemonBin)
        proc.arguments = ["--addr", "0.0.0.0:6767", "up", "--foreground"]
        var env = ProcessInfo.processInfo.environment
        if FileManager.default.fileExists(atPath: bundledUiDir + "/index.html") {
            env["VELO_UI_DIR"] = bundledUiDir
        }
        proc.environment = env
        try? proc.run()
        self.daemonProcess = proc

        for _ in 0..<35 {
            if isDaemonPortListening() {
                break
            }
            Thread.sleep(forTimeInterval: 0.08)
        }
    }

    func setupMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Velo", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Show Velo Window", action: #selector(showMainWindow), keyEquivalent: "0")
        appMenu.addItem(withTitle: "Hide Velo", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Velo", action: #selector(explicitQuit), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "Window")
        fileMenu.addItem(withTitle: "Close Window (Keep in Menu Bar)", action: #selector(hideWindowToMenuBar), keyEquivalent: "w")
        fileMenuItem.submenu = fileMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload Window", action: #selector(reloadWebView), keyEquivalent: "r")
        viewMenuItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Persistent macOS Menu Bar Status Item Cockpit

    private func setupStatusBarItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateStatusBarButton(runningCount: 0, waitingCount: 0)
        rebuildStatusBarMenu()

        pollDaemonForMenuBar()
        statusPollTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in
            self?.pollDaemonForMenuBar()
        }
    }

    private func updateStatusBarButton(runningCount: Int, waitingCount: Int) {
        guard let button = statusItem?.button else { return }
        let symbolName = waitingCount > 0 ? "exclamationmark.shield.fill" : "bolt.horizontal.circle.fill"
        if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: "Velo") {
            img.isTemplate = (waitingCount == 0)
            button.image = img
            button.imagePosition = .imageLeading
        }
        let activeTotal = runningCount + waitingCount
        button.title = activeTotal > 0 ? " \(activeTotal)" : ""
    }

    private func pollDaemonForMenuBar() {
        guard let sUrl = URL(string: "http://127.0.0.1:6767/api/sessions") else { return }
        URLSession.shared.dataTask(with: sUrl) { [weak self] data, _, _ in
            guard let self, let data,
                  let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
            else { return }
            let summaries: [MenuSessionSummary] = arr.prefix(8).compactMap { obj in
                guard let id = obj["id"] as? String else { return nil }
                let name = (obj["name"] as? String) ?? "Untitled"
                let prov = (obj["provider"] as? String) ?? "agent"
                let st = (obj["status"] as? String) ?? "completed"
                return MenuSessionSummary(id: id, name: name, provider: prov, status: st)
            }
            let runningCount = arr.filter {
                let st = ($0["status"] as? String) ?? ""
                return st == "running" || st == "starting"
            }.count
            let waitingCount = arr.filter {
                let st = ($0["status"] as? String) ?? ""
                return st == "waiting_permission" || st == "waiting_for_permission"
            }.count

            if let svcUrl = URL(string: "http://127.0.0.1:6767/api/system/service") {
                URLSession.shared.dataTask(with: svcUrl) { [weak self] sData, _, _ in
                    var caff = false
                    if let sData,
                       let sObj = (try? JSONSerialization.jsonObject(with: sData)) as? [String: Any]
                    {
                        caff = (sObj["caffeinate_active"] as? Bool) ?? (sObj["prevent_idle_sleep"] as? Bool) ?? false
                    }
                    let sig = "\(runningCount)|\(waitingCount)|\(caff)|" + summaries.map { "\($0.id):\($0.status):\($0.name)" }.joined(separator: ",")
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.detectAndNotifyTransitions(from: summaries)
                        if sig == self.lastMenuBarSignature { return }
                        self.lastMenuBarSignature = sig
                        self.cachedMenuSessions = summaries
                        self.caffeinateActive = caff
                        self.updateStatusBarButton(runningCount: runningCount, waitingCount: waitingCount)
                        self.rebuildStatusBarMenu()
                    }
                }.resume()
            } else {
                DispatchQueue.main.async {
                    self.cachedMenuSessions = summaries
                    self.updateStatusBarButton(runningCount: runningCount, waitingCount: waitingCount)
                    self.rebuildStatusBarMenu()
                }
            }
        }.resume()
    }

    private func rebuildStatusBarMenu() {
        let menu = NSMenu()
        let running = cachedMenuSessions.filter { $0.status == "running" || $0.status == "starting" }.count
        let waiting = cachedMenuSessions.filter { $0.status.contains("waiting") }.count

        let headerText: String
        if waiting > 0 {
            headerText = "🔐 Velo · \(waiting) 待审批 · \(running) 运行中"
        } else if running > 0 {
            headerText = "⚡ Velo · \(running) 个会话运行中"
        } else {
            headerText = "⚡ Velo 守护进程在线"
        }
        let headerItem = NSMenuItem(title: headerText, action: nil, keyEquivalent: "")
        headerItem.isEnabled = false
        menu.addItem(headerItem)
        menu.addItem(NSMenuItem.separator())

        let showItem = NSMenuItem(title: "打开 Velo 主窗口", action: #selector(showMainWindow), keyEquivalent: "o")
        showItem.target = self
        menu.addItem(showItem)

        let importItem = NSMenuItem(title: "接管本机 Claude / Codex 终端会话…", action: #selector(openCliImportFromMenu), keyEquivalent: "i")
        importItem.target = self
        menu.addItem(importItem)

        let pairItem = NSMenuItem(title: "手机扫码配对…", action: #selector(openPairFromMenu), keyEquivalent: "p")
        pairItem.target = self
        menu.addItem(pairItem)

        let sleepItem = NSMenuItem(title: "防休眠保活 (锁屏/外出不断联)", action: #selector(togglePreventSleep), keyEquivalent: "")
        sleepItem.target = self
        sleepItem.state = caffeinateActive ? .on : .off
        menu.addItem(sleepItem)

        if !cachedMenuSessions.isEmpty {
            menu.addItem(NSMenuItem.separator())
            let secTitle = NSMenuItem(title: "最近会话", action: nil, keyEquivalent: "")
            secTitle.isEnabled = false
            menu.addItem(secTitle)

            for s in cachedMenuSessions.prefix(6) {
                let dot: String
                if s.status.contains("waiting") {
                    dot = "🟡"
                } else if s.status == "running" || s.status == "starting" {
                    dot = "🟢"
                } else {
                    dot = "⚪"
                }
                let shortTitle = s.name.count > 30 ? String(s.name.prefix(30)) + "…" : s.name
                let item = NSMenuItem(
                    title: "\(dot) [\(s.provider.uppercased())] \(shortTitle)",
                    action: #selector(jumpToSessionFromMenu(_:)),
                    keyEquivalent: ""
                )
                item.target = self
                item.representedObject = s.id
                menu.addItem(item)
            }
        }

        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "退出 Velo", action: #selector(explicitQuit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem?.menu = menu
    }

    @objc func showMainWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func hideWindowToMenuBar() {
        window?.orderOut(nil)
    }

    @objc func openCliImportFromMenu() {
        showMainWindow()
        evalWebJS("window.__veloOpenCliImport && window.__veloOpenCliImport();")
    }

    @objc func openPairFromMenu() {
        showMainWindow()
        evalWebJS("window.__veloOpenPairModal && window.__veloOpenPairModal();")
    }

    @objc func jumpToSessionFromMenu(_ sender: NSMenuItem) {
        guard let sid = sender.representedObject as? String else { return }
        showMainWindow()
        if let data = try? JSONSerialization.data(withJSONObject: [sid]),
           let arr = String(data: data, encoding: .utf8)
        {
            evalWebJS("window.__veloSelectSession && window.__veloSelectSession((\(arr))[0]);")
        }
    }

    @objc func togglePreventSleep() {
        let nextVal = !caffeinateActive
        guard let url = URL(string: "http://127.0.0.1:6767/api/system/service") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["prevent_idle_sleep": nextVal])
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            DispatchQueue.main.async {
                self?.caffeinateActive = nextVal
                self?.rebuildStatusBarMenu()
            }
        }.resume()
    }

    @objc func explicitQuit() {
        allowExplicitQuit = true
        NSApp.terminate(nil)
    }

    @objc func reloadWebView() {
        webView?.reload()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowExplicitQuit {
            return true
        }
        // Hide window to Menu Bar instead of terminating so mobile control & background agents stay alive
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            showMainWindow()
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        statusPollTimer?.invalidate()
        return .terminateNow
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "windowDrag", let event = NSApp.currentEvent {
            window.performDrag(with: event)
        } else if message.name == "windowTheme", let mode = message.body as? String {
            switch mode {
            case "light":
                window.appearance = NSAppearance(named: .aqua)
                window.backgroundColor = NSColor(calibratedRed: 0.98, green: 0.98, blue: 0.99, alpha: 1.0)
            case "dark":
                window.appearance = NSAppearance(named: .darkAqua)
                window.backgroundColor = NSColor(calibratedRed: 0.047, green: 0.047, blue: 0.055, alpha: 1.0)
            default:
                window.appearance = nil
            }
        }
    }

    private func evalWebJS(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureDaemonRunning()
        setupMenu()
        setupStatusBarItem()

        let rect = NSRect(x: 0, y: 0, width: 1360, height: 860)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.delegate = self
        window.title = "Velo"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 960, height: 640)
        window.appearance = nil
        window.backgroundColor = NSColor.windowBackgroundColor
        if !window.setFrameUsingName("VeloMainWindow") {
            window.center()
        }
        window.setFrameAutosaveName("VeloMainWindow")

        setupDesktopNotifications()

        let contentController = WKUserContentController()
        contentController.add(self, name: "windowDrag")
        contentController.add(self, name: "windowTheme")
        let scriptSource = """
        window.__VELO_MACOS_APP__ = true;
        window.addEventListener('mousedown', function(e) {
          if (e.button !== 0) return;
          if (e.target && e.target.closest && e.target.closest('button, input, textarea, a, select')) return;
          if (e.target && e.target.closest && e.target.closest('[data-tauri-drag-region]')) {
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.windowDrag) {
              window.webkit.messageHandlers.windowDrag.postMessage('drag');
            }
          }
        });
        """
        let userScript = WKUserScript(source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        contentController.addUserScript(userScript)

        let config = WKWebViewConfiguration()
        config.userContentController = contentController

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window.contentView?.addSubview(webView)

        if let url = URL(string: "http://127.0.0.1:6767/?desktop=1") {
            webView.load(URLRequest(url: url))
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            if response == .OK {
                completionHandler(panel.urls)
            } else {
                completionHandler(nil)
            }
        }
    }

    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        if origin.host == "127.0.0.1" || origin.host == "localhost" {
            decisionHandler(.grant)
        } else {
            decisionHandler(.prompt)
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           (scheme == "http" || scheme == "https"),
           url.host != "127.0.0.1" && url.host != "localhost"
        {
            if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private func setupDesktopNotifications() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func detectAndNotifyTransitions(from summaries: [MenuSessionSummary]) {
        if !didPrimeStatusSnapshot {
            didPrimeStatusSnapshot = true
            for s in summaries {
                lastStatusBySessionId[s.id] = s.status
            }
            return
        }
        let appFocused = NSApp.isActive && (window?.isVisible ?? false) && (window?.isKeyWindow ?? false)
        for s in summaries {
            let prev = lastStatusBySessionId[s.id]
            lastStatusBySessionId[s.id] = s.status
            guard !appFocused else { continue }
            if s.status.contains("waiting") && !(prev?.contains("waiting") ?? false) {
                postDesktopNotification(
                    title: "Velo · 等待权限审批",
                    body: s.name,
                    sessionId: s.id
                )
            } else if (prev == "running" || prev == "starting") && s.status == "completed" {
                postDesktopNotification(
                    title: "Velo · 任务已完成",
                    body: s.name,
                    sessionId: s.id
                )
            } else if (prev == "running" || prev == "starting") && s.status == "failed" {
                postDesktopNotification(
                    title: "Velo · 任务执行异常",
                    body: s.name,
                    sessionId: s.id
                )
            }
        }
    }

    private func postDesktopNotification(title: String, body: String, sessionId: String) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["session_id": sessionId]
        let req = UNNotificationRequest(
            identifier: "velo-\(sessionId)-\(Int(Date().timeIntervalSince1970))",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let sid = response.notification.request.content.userInfo["session_id"] as? String
        DispatchQueue.main.async { [weak self] in
            self?.showMainWindow()
            if let sid,
               let data = try? JSONSerialization.data(withJSONObject: [sid]),
               let arr = String(data: data, encoding: .utf8)
            {
                self?.evalWebJS("window.__veloSelectSession && window.__veloSelectSession((\(arr))[0]);")
            }
        }
        completionHandler()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
