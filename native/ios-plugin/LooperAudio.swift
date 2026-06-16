import Foundation
import AVFoundation
import Capacitor

/// Native low-latency looper engine for iOS + Mac Catalyst.
///
/// The web UI (app.js) calls these methods over the Capacitor bridge; this
/// class owns *all* audio. Loops are kept as mono Float32 layers; the master
/// loop is the clamped sum of all layers, played gaplessly by an
/// AVAudioPlayerNode looping a single buffer. Overdubs are captured from the
/// input tap and summed into a new layer, aligned to the loop phase with
/// hardware latency compensation (the thing the browser can't do).
///
/// First cut — expect to tune `latencyFrames` and the loop-swap on-device.
@objc(LooperAudio)
public class LooperAudio: CAPPlugin {

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var sampleRate: Double = 48000

    private enum Mode { case idle, recording, looping, overdubbing }
    private var mode: Mode = .idle

    // Loop data (guarded by `lock` because the audio tap thread touches it too).
    private let lock = NSLock()
    private var layers: [[Float]] = []
    private var frameCount: Int = 0

    private var baseBuffer: [Float] = []      // accumulates the base recording
    private var overdubLayer: [Float]? = nil  // current overdub being recorded
    private var overdubIndex: Int = 0
    private var overdubAligned = false

    private var latencyFrames: Int = 0
    private var inputChannels: Int = 1
    private var meterTimer: Timer?
    private var peak: Float = 0
    private var tapInstalled = false

    // MARK: - Setup

    @objc func prepare(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        session.requestRecordPermission { [weak self] granted in
            guard let self = self else { return }
            guard granted else { call.reject("Microphone permission denied"); return }
            do {
                try self.configureSession(session)
                // Use the input node's OUTPUT format as the single source of
                // truth — this is the format the tap will actually deliver, so
                // capture and playback rates always match (no garbled audio).
                let hwFormat = self.engine.inputNode.outputFormat(forBus: 0)
                self.sampleRate = hwFormat.sampleRate > 0 ? hwFormat.sampleRate : session.sampleRate
                self.inputChannels = max(Int(hwFormat.channelCount), 1)
                self.engine.attach(self.player)
                let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                         sampleRate: self.sampleRate,
                                         channels: 1, interleaved: false)!
                self.engine.connect(self.player, to: self.engine.mainMixerNode, format: mono)
                self.engine.prepare()
                try self.engine.start()
                self.updateLatency(session)
                call.resolve(["sampleRate": self.sampleRate,
                              "inputChannels": self.inputChannels,
                              "latencyFrames": self.latencyFrames])
            } catch {
                call.reject("prepare failed: \(error.localizedDescription)")
            }
        }
    }

    private func configureSession(_ session: AVAudioSession) throws {
        try session.setCategory(.playAndRecord, mode: .default,
                                options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        try session.setPreferredIOBufferDuration(0.005) // ~5ms; hardware may round
        try session.setActive(true)
    }

    private func updateLatency(_ session: AVAudioSession) {
        let total = session.inputLatency + session.outputLatency + session.ioBufferDuration
        latencyFrames = Int(total * sampleRate)
    }

    // MARK: - Input tap

    private func installTap() {
        guard !tapInstalled else { return }
        // Pass nil so the tap uses the bus's own format (matches `sampleRate`).
        engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: nil) { [weak self] buffer, _ in
            self?.processInput(buffer)
        }
        tapInstalled = true
    }

    private func removeTap() {
        guard tapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
    }

    /// Runs on the audio thread. Keep it lean.
    private func processInput(_ buffer: AVAudioPCMBuffer) {
        guard let chans = buffer.floatChannelData else { return }
        let n = Int(buffer.frameLength)
        let ch = Int(buffer.format.channelCount)

        // Downmix to mono + track peak.
        var mono = [Float](repeating: 0, count: n)
        var localPeak: Float = 0
        for i in 0..<n {
            var s: Float = 0
            for c in 0..<ch { s += chans[c][i] }
            s /= Float(max(ch, 1))
            mono[i] = s
            let a = abs(s)
            if a > localPeak { localPeak = a }
        }
        peak = max(peak, localPeak)

        lock.lock()
        defer { lock.unlock() }
        switch mode {
        case .recording:
            baseBuffer.append(contentsOf: mono)
        case .overdubbing:
            guard frameCount > 0, overdubLayer != nil else { return }
            if !overdubAligned {
                if let phase = currentLoopFrameLocked() {
                    var idx = (phase - latencyFrames) % frameCount
                    if idx < 0 { idx += frameCount }
                    overdubIndex = idx
                    overdubAligned = true
                } else { return }
            }
            overdubLayer!.withUnsafeMutableBufferPointer { ptr in
                var idx = overdubIndex
                for s in mono {
                    ptr[idx] += s
                    idx += 1; if idx >= frameCount { idx = 0 }
                }
                overdubIndex = idx
            }
        default:
            break
        }
    }

    /// Current playback position within the loop, in frames. Caller holds lock.
    private func currentLoopFrameLocked() -> Int? {
        guard frameCount > 0,
              let nodeTime = player.lastRenderTime,
              let pt = player.playerTime(forNodeTime: nodeTime) else { return nil }
        let s = Int(pt.sampleTime)
        return ((s % frameCount) + frameCount) % frameCount
    }

    // MARK: - Playback

    private func buildMasterLocked() -> AVAudioPCMBuffer? {
        guard frameCount > 0,
              let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: sampleRate, channels: 1, interleaved: false),
              let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frameCount))
        else { return nil }
        buf.frameLength = AVAudioFrameCount(frameCount)
        let out = buf.floatChannelData![0]
        for i in 0..<frameCount { out[i] = 0 }
        for layer in layers {
            let m = min(layer.count, frameCount)
            for i in 0..<m { out[i] += layer[i] }
        }
        for i in 0..<frameCount {
            let v = out[i]
            out[i] = v > 1 ? 1 : (v < -1 ? -1 : v)
        }
        return buf
    }

    /// Rebuild the master and (re)start the gapless loop.
    private func restartLoopLocked() {
        guard let master = buildMasterLocked() else { return }
        player.stop()
        player.scheduleBuffer(master, at: nil, options: [.loops, .interrupts], completionHandler: nil)
        player.play()
    }

    // MARK: - Meter

    private func startMeter() {
        DispatchQueue.main.async {
            self.meterTimer?.invalidate()
            self.meterTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                let p = self.peak
                self.peak = 0
                self.notifyListeners("level", data: ["peak": p])
            }
        }
    }

    private func stopMeter() {
        DispatchQueue.main.async {
            self.meterTimer?.invalidate()
            self.meterTimer = nil
            self.notifyListeners("level", data: ["peak": 0])
        }
    }

    // MARK: - Bridge methods

    @objc func startRecord(_ call: CAPPluginCall) {
        lock.lock()
        baseBuffer.removeAll(keepingCapacity: true)
        mode = .recording
        lock.unlock()
        installTap()
        startMeter()
        call.resolve()
    }

    @objc func stopRecord(_ call: CAPPluginCall) {
        removeTap()
        stopMeter()
        lock.lock()
        layers = [baseBuffer]
        frameCount = baseBuffer.count
        baseBuffer.removeAll(keepingCapacity: false)
        mode = .looping
        restartLoopLocked()
        let frames = frameCount
        lock.unlock()
        call.resolve(["frames": frames, "seconds": Double(frames) / sampleRate, "layers": 1])
    }

    @objc func startOverdub(_ call: CAPPluginCall) {
        lock.lock()
        guard frameCount > 0 else { lock.unlock(); call.reject("No base loop"); return }
        overdubLayer = [Float](repeating: 0, count: frameCount)
        overdubIndex = 0
        overdubAligned = false
        mode = .overdubbing
        lock.unlock()
        installTap()
        startMeter()
        call.resolve()
    }

    @objc func finishOverdub(_ call: CAPPluginCall) {
        removeTap()
        stopMeter()
        lock.lock()
        if let l = overdubLayer { layers.append(l) }
        overdubLayer = nil
        mode = .looping
        restartLoopLocked()
        let count = layers.count
        lock.unlock()
        call.resolve(["layers": count])
    }

    @objc func undo(_ call: CAPPluginCall) {
        lock.lock()
        if !layers.isEmpty { layers.removeLast() }
        let count = layers.count
        if count == 0 {
            player.stop()
            frameCount = 0
            mode = .idle
        } else {
            restartLoopLocked()
        }
        lock.unlock()
        call.resolve(["layers": count])
    }

    @objc func clear(_ call: CAPPluginCall) {
        removeTap()
        stopMeter()
        lock.lock()
        player.stop()
        layers.removeAll()
        overdubLayer = nil
        baseBuffer.removeAll()
        frameCount = 0
        mode = .idle
        lock.unlock()
        call.resolve()
    }
}
