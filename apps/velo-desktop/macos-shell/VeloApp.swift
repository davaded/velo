import AVFoundation
import Cocoa
import Speech
import WebKit

private final class MacSpeechRequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ req: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        request = req
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let req = request
        lock.unlock()
        req?.append(buffer)
    }

    func endAudio() {
        lock.lock()
        let req = request
        lock.unlock()
        req?.endAudio()
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var daemonProcess: Process?

    // Native macOS Speech.framework + AVAudioEngine live dictation state
    private var audioEngine: AVAudioEngine?
    private var speechRecognizer: SFSpeechRecognizer?
    private let requestBox = MacSpeechRequestBox()
    private var recognitionTask: SFSpeechRecognitionTask?
    private var isVoiceRecording = false
    private var committedVoiceText = ""
    private var currentSegmentText = ""
    private var didReceiveVoiceFinal = false
    private var lastWaveSentAt: TimeInterval = 0
    private var wavePhase: Double = 0
    private var waveLevels: [Double] = Array(repeating: 0.16, count: 24)

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
        appMenu.addItem(withTitle: "Hide Velo", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Velo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

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

    @objc func reloadWebView() {
        webView?.reload()
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
        } else if message.name == "veloVoice", let action = message.body as? String {
            switch action {
            case "start":
                startNativeVoiceDictation()
            case "stop":
                stopNativeVoiceDictation(deliverTranscript: true)
            case "cancel":
                stopNativeVoiceDictation(deliverTranscript: false)
            default:
                break
            }
        }
    }

    // MARK: - Native macOS Speech.framework Dictation Bridge

    private func startNativeVoiceDictation() {
        if isVoiceRecording { return }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] micGranted in
            guard let self, micGranted else {
                DispatchQueue.main.async {
                    self?.emitVoiceJS("window.__veloOnNativeVoiceResult && window.__veloOnNativeVoiceResult('');")
                }
                return
            }

            SFSpeechRecognizer.requestAuthorization { [weak self] authStatus in
                DispatchQueue.main.async {
                    guard let self else { return }
                    guard authStatus == .authorized,
                          let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) ?? SFSpeechRecognizer(),
                          recognizer.isAvailable
                    else {
                        self.emitVoiceJS("window.__veloOnNativeVoiceFallback && window.__veloOnNativeVoiceFallback();")
                        return
                    }

                    let engine = AVAudioEngine()
                    let inputNode = engine.inputNode
                    let fmt = inputNode.outputFormat(forBus: 0)
                    guard fmt.sampleRate > 0 && fmt.channelCount > 0 else {
                        self.emitVoiceJS("window.__veloOnNativeVoiceFallback && window.__veloOnNativeVoiceFallback();")
                        return
                    }

                    self.committedVoiceText = ""
                    self.currentSegmentText = ""
                    self.didReceiveVoiceFinal = false
                    self.wavePhase = 0
                    self.waveLevels = Array(repeating: 0.18, count: 24)
                    self.speechRecognizer = recognizer
                    self.startSpeechSegment(with: recognizer)

                    let box = self.requestBox
                    inputNode.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buffer, _ in
                        box.append(buffer)
                        let lvl = Self.computeNormalizedLevel(from: buffer)
                        let now = CACurrentMediaTime()
                        DispatchQueue.main.async {
                            guard let self, self.isVoiceRecording else { return }
                            guard now - self.lastWaveSentAt >= 0.045 else { return }
                            self.lastWaveSentAt = now
                            self.wavePhase += 0.55
                            let idle = 0.16 + 0.07 * abs(sin(self.wavePhase))
                            let boosted = min(1.0, max(idle, pow(max(0, lvl), 0.72) * 1.15))
                            if !self.waveLevels.isEmpty { self.waveLevels.removeFirst() }
                            self.waveLevels.append(boosted)
                            let csv = self.waveLevels.map { String(format: "%.3f", $0) }.joined(separator: ",")
                            self.emitVoiceJS("window.__veloOnNativeVoiceLevels && window.__veloOnNativeVoiceLevels([\(csv)]);")
                        }
                    }

                    do {
                        engine.prepare()
                        try engine.start()
                        self.audioEngine = engine
                        self.isVoiceRecording = true
                    } catch {
                        inputNode.removeTap(onBus: 0)
                        self.requestBox.set(nil)
                        self.recognitionTask?.cancel()
                        self.recognitionTask = nil
                        self.speechRecognizer = nil
                        self.emitVoiceJS("window.__veloOnNativeVoiceFallback && window.__veloOnNativeVoiceFallback();")
                    }
                }
            }
        }
    }

    private func startSpeechSegment(with recognizer: SFSpeechRecognizer) {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if #available(macOS 13.0, *) {
            req.addsPunctuation = true
        }
        didReceiveVoiceFinal = false
        requestBox.set(req)

        recognitionTask = recognizer.recognitionTask(with: req) { [weak self] result, error in
            let txt = result?.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let isFinal = result?.isFinal ?? false
            let hasError = (error != nil)
            DispatchQueue.main.async {
                guard let self else { return }
                if !txt.isEmpty {
                    self.currentSegmentText = txt
                }
                if isFinal || hasError {
                    if self.isVoiceRecording, isFinal, let activeRec = self.speechRecognizer, activeRec.isAvailable {
                        if !self.currentSegmentText.isEmpty {
                            self.committedVoiceText += self.currentSegmentText
                            self.currentSegmentText = ""
                        }
                        self.startSpeechSegment(with: activeRec)
                    } else {
                        self.didReceiveVoiceFinal = true
                    }
                }
            }
        }
    }

    private func stopNativeVoiceDictation(deliverTranscript: Bool) {
        let wasRecording = isVoiceRecording
        isVoiceRecording = false

        if let engine = audioEngine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
        requestBox.endAudio()

        if !deliverTranscript || !wasRecording {
            requestBox.set(nil)
            recognitionTask?.cancel()
            recognitionTask = nil
            speechRecognizer = nil
            committedVoiceText = ""
            currentSegmentText = ""
            return
        }

        // Poll lightly on main runloop up to ~950ms for final punctuated segment
        var polls = 0
        func checkReady() {
            if self.didReceiveVoiceFinal || polls >= 19 {
                self.recognitionTask?.finish()
                self.recognitionTask = nil
                self.requestBox.set(nil)
                self.speechRecognizer = nil
                let full = (self.committedVoiceText + self.currentSegmentText)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let jsonData = try? JSONSerialization.data(withJSONObject: [full]),
                   let jsonArr = String(data: jsonData, encoding: .utf8)
                {
                    self.emitVoiceJS("window.__veloOnNativeVoiceResult && window.__veloOnNativeVoiceResult((\(jsonArr))[0]);")
                } else {
                    self.emitVoiceJS("window.__veloOnNativeVoiceResult && window.__veloOnNativeVoiceResult('');")
                }
                return
            }
            polls += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                checkReady()
            }
        }
        checkReady()
    }

    private func emitVoiceJS(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    private static func computeNormalizedLevel(from buffer: AVAudioPCMBuffer) -> Double {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let ch = buffer.floatChannelData?[0] else { return 0.16 }
        var sum: Float = 0
        let step = max(1, frames / 256)
        var count = 0
        var i = 0
        while i < frames {
            let s = ch[i]
            sum += s * s
            count += 1
            i += step
        }
        let rms = sqrt(sum / Float(max(1, count)))
        let db = 20.0 * log10(max(Double(rms), 0.000_02))
        let clamped = max(-52.0, min(-8.0, db))
        return (clamped + 52.0) / 44.0
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureDaemonRunning()
        setupMenu()

        let rect = NSRect(x: 0, y: 0, width: 1360, height: 860)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Velo"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 960, height: 640)
        window.appearance = nil
        window.backgroundColor = NSColor.windowBackgroundColor
        window.center()

        let contentController = WKUserContentController()
        contentController.add(self, name: "windowDrag")
        contentController.add(self, name: "windowTheme")
        contentController.add(self, name: "veloVoice")
        let scriptSource = """
        window.__VELO_MACOS_APP__ = true;
        window.__VELO_NATIVE_VOICE__ = true;
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

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
