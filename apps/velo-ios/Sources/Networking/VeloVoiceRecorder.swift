import AVFoundation
import Foundation
import Speech

private final class ActiveSpeechRequestBox: @unchecked Sendable {
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

@MainActor
public final class VeloVoiceRecorder: ObservableObject {
    public static let barCount: Int = 24

    @Published public private(set) var isRecording: Bool = false
    @Published public private(set) var barLevels: [CGFloat] = Array(repeating: 0.16, count: 24)

    private var audioEngine: AVAudioEngine?
    private var speechRecognizer: SFSpeechRecognizer?
    private let requestBox = ActiveSpeechRequestBox()
    private var recognitionTask: SFSpeechRecognitionTask?

    private var fallbackRecorder: AVAudioRecorder?
    private var fallbackURL: URL?

    private var committedTranscript: String = ""
    private var currentSegmentTranscript: String = ""
    private var didReceiveFinalOrError: Bool = false
    private var lastMeterUpdateAt: TimeInterval = 0
    private var wavePhase: Double = 0

    public init() {}

    public func startRecording() async -> Bool {
        if isRecording { return true }

        let micGranted: Bool
        if #available(iOS 17.0, *) {
            micGranted = await AVAudioApplication.requestRecordPermission()
        } else {
            micGranted = await withCheckedContinuation { cont in
                AVAudioSession.sharedInstance().requestRecordPermission { ok in
                    cont.resume(returning: ok)
                }
            }
        }
        guard micGranted else { return false }

        let speechStatus = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status)
            }
        }

        committedTranscript = ""
        currentSegmentTranscript = ""
        didReceiveFinalOrError = false
        wavePhase = 0
        barLevels = Array(repeating: 0.18, count: Self.barCount)

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .measurement,
                options: [.defaultToSpeaker, .allowBluetooth, .duckOthers]
            )
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            return false
        }

        // Primary path: Apple Neural Engine / Speech.framework live streaming recognition
        // (No concurrent AVAudioRecorder so hardware AudioUnit & sample rate never contend!)
        if speechStatus == .authorized,
           let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) ?? SFSpeechRecognizer(),
           recognizer.isAvailable
        {
            let engine = AVAudioEngine()
            let inputNode = engine.inputNode
            let recordingFormat = inputNode.outputFormat(forBus: 0)

            if recordingFormat.sampleRate > 0 && recordingFormat.channelCount > 0 {
                self.speechRecognizer = recognizer
                startNewRecognitionSegment(with: recognizer)

                let box = self.requestBox
                inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
                    box.append(buffer)
                    let normalized = Self.computeNormalizedLevel(from: buffer)
                    let nowTs = CACurrentMediaTime()
                    Task { @MainActor [weak self] in
                        guard let self, self.isRecording else { return }
                        guard nowTs - self.lastMeterUpdateAt >= 0.042 else { return }
                        self.lastMeterUpdateAt = nowTs
                        self.pushWaveSample(normalized)
                    }
                }

                do {
                    engine.prepare()
                    try engine.start()
                    self.audioEngine = engine
                    self.isRecording = true
                    return true
                } catch {
                    inputNode.removeTap(onBus: 0)
                    self.requestBox.set(nil)
                    self.recognitionTask?.cancel()
                    self.recognitionTask = nil
                    self.speechRecognizer = nil
                }
            }
        }

        // Fallback path when Speech permission is denied/unavailable: record m4a for daemon transcription
        let backupURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("velo-voice-\(UUID().uuidString).m4a")
        let recSettings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        if let rec = try? AVAudioRecorder(url: backupURL, settings: recSettings) {
            rec.isMeteringEnabled = true
            rec.prepareToRecord()
            if rec.record() {
                self.fallbackRecorder = rec
                self.fallbackURL = backupURL
                self.isRecording = true
                startFallbackMeterLoop()
                return true
            }
        }

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return false
    }

    private func startNewRecognitionSegment(with recognizer: SFSpeechRecognizer) {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if #available(iOS 16.0, *) {
            req.addsPunctuation = true
        }
        didReceiveFinalOrError = false
        requestBox.set(req)

        recognitionTask = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            let text = result?.bestTranscription.formattedString
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let isFinal = result?.isFinal ?? false
            let hasError = (error != nil)

            Task { @MainActor [weak self] in
                guard let self else { return }
                if !text.isEmpty {
                    self.currentSegmentTranscript = text
                }
                if isFinal || hasError {
                    if self.isRecording, isFinal, let activeRecognizer = self.speechRecognizer, activeRecognizer.isAvailable {
                        // Seamless continuation if Apple Speech closed a segment during a pause
                        if !self.currentSegmentTranscript.isEmpty {
                            self.committedTranscript = self.joinSegments(self.committedTranscript, self.currentSegmentTranscript)
                            self.currentSegmentTranscript = ""
                        }
                        self.startNewRecognitionSegment(with: activeRecognizer)
                    } else {
                        self.didReceiveFinalOrError = true
                    }
                }
            }
        }
    }

    public func stopAndTranscribe() async -> (text: String?, fallbackAudio: Data?) {
        guard isRecording else { return (nil, nil) }
        isRecording = false

        if let engine = audioEngine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
        requestBox.endAudio()

        fallbackRecorder?.stop()
        fallbackRecorder = nil
        var audioData: Data?
        if let url = fallbackURL {
            audioData = try? Data(contentsOf: url)
            try? FileManager.default.removeItem(at: url)
            fallbackURL = nil
        }

        if recognitionTask != nil {
            // Wait up to ~1.0s after `endAudio()` for final punctuated result, breaking immediately once ready
            for _ in 0..<20 {
                if didReceiveFinalOrError {
                    break
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            recognitionTask?.finish()
            recognitionTask = nil
        }
        requestBox.set(nil)
        speechRecognizer = nil

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        barLevels = Array(repeating: 0.16, count: Self.barCount)

        let combined = joinSegments(committedTranscript, currentSegmentTranscript)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (combined.isEmpty ? nil : combined, audioData)
    }

    public func cancelRecording() {
        isRecording = false
        if let engine = audioEngine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
        requestBox.endAudio()
        requestBox.set(nil)
        recognitionTask?.cancel()
        recognitionTask = nil
        speechRecognizer = nil

        fallbackRecorder?.stop()
        fallbackRecorder = nil
        if let url = fallbackURL {
            try? FileManager.default.removeItem(at: url)
            fallbackURL = nil
        }
        committedTranscript = ""
        currentSegmentTranscript = ""
        barLevels = Array(repeating: 0.16, count: Self.barCount)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func joinSegments(_ lhs: String, _ rhs: String) -> String {
        let a = lhs.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = rhs.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return "\(a)\(b)"
    }

    private func startFallbackMeterLoop() {
        Task { @MainActor [weak self] in
            while let self, self.isRecording, let rec = self.fallbackRecorder {
                rec.updateMeters()
                let db = rec.averagePower(forChannel: 0)
                let clamped = max(-52.0, min(-6.0, Double(db)))
                let norm = CGFloat((clamped + 52.0) / 46.0)
                self.pushWaveSample(norm)
                try? await Task.sleep(nanoseconds: 45_000_000)
            }
        }
    }

    private func pushWaveSample(_ rawLevel: CGFloat) {
        wavePhase += 0.55
        let idlePulse = CGFloat(0.16 + 0.07 * abs(sin(wavePhase)))
        let boosted = min(1.0, max(idlePulse, pow(max(0, rawLevel), 0.72) * 1.15))
        var next = barLevels
        if !next.isEmpty {
            next.removeFirst()
        }
        next.append(boosted)
        barLevels = next
    }

    nonisolated private static func computeNormalizedLevel(from buffer: AVAudioPCMBuffer) -> CGFloat {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let channelData = buffer.floatChannelData?[0] else {
            return 0.16
        }
        var sumSquares: Float = 0
        let step = max(1, frames / 256)
        var count = 0
        var idx = 0
        while idx < frames {
            let s = channelData[idx]
            sumSquares += s * s
            count += 1
            idx += step
        }
        let rms = sqrt(sumSquares / Float(max(1, count)))
        let db = 20.0 * log10(max(rms, 0.000_02))
        let clamped = max(-52.0, min(-8.0, Double(db)))
        return CGFloat((clamped + 52.0) / 44.0)
    }
}
