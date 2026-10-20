import Combine
import Foundation

/// One libmpv player: it decodes and plays (AV1 and Opus in WebM included, with VideoToolbox where the Mac has it)
/// and reports position, duration and state for SwiftUI. `MPVVideoView` draws its frames. Everything here runs on the
/// main actor; mpv's own threads only wake it.
@MainActor
final class MPVPlayer: ObservableObject {
    @Published private(set) var isPaused = true
    /// Seconds.
    @Published private(set) var position: Double = 0
    @Published private(set) var duration: Double = 0
    @Published private(set) var isBuffering = false
    @Published private(set) var isLoaded = false
    @Published private(set) var problem: String?
    @Published private(set) var volume: Double = 100

    /// The mpv handle. Read by the video layer while it draws, also on the main thread.
    nonisolated(unsafe) let handle: OpaquePointer

    init() {
        guard let handle = mpv_create() else { fatalError("libmpv could not create a player") }
        self.handle = handle
        // A player inside an app: no window, no keys, no scripts or user configuration of its own.
        for (name, value) in [
            ("vo", "libmpv"),
            ("hwdec", "auto-safe"),
            ("keep-open", "yes"),
            ("idle", "yes"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("config", "no"),
            ("load-scripts", "no"),
            ("terminal", "no"),
            ("audio-client-name", "Hearthlog"),
            // Seeking in a remote file reads ahead; a little cache keeps it smooth without holding gigabytes.
            ("demuxer-max-bytes", "150MiB"),
        ] {
            mpv_set_option_string(handle, name, value)
        }
        mpv_initialize(handle)
        for (name, format) in [("time-pos", MPV_FORMAT_DOUBLE), ("duration", MPV_FORMAT_DOUBLE), ("pause", MPV_FORMAT_FLAG), ("paused-for-cache", MPV_FORMAT_FLAG), ("volume", MPV_FORMAT_DOUBLE)] {
            mpv_observe_property(handle, 0, name, format)
        }
        mpv_set_wakeup_callback(handle, { context in
            guard let context else { return }
            let player = Unmanaged<MPVPlayer>.fromOpaque(context).takeUnretainedValue()
            Task { @MainActor in player.drainEvents() }
        }, Unmanaged.passUnretained(self).toOpaque())
    }

    deinit {
        mpv_set_wakeup_callback(handle, nil, nil)
        mpv_terminate_destroy(handle)
    }

    // MARK: Playing

    /// Opens `url`, sending `headers` (`"Name: value"`) with every request for it, and starts at `start` seconds.
    func load(_ url: URL, headers: [String] = [], start: Double = 0, autoplay: Bool = true) {
        problem = nil
        isLoaded = false
        // A storage link needs no headers; only a proxied stream carries the site's cookie, and only to the site.
        mpv_set_property_string(handle, "http-header-fields", headers.joined(separator: ","))
        setFlag("pause", !autoplay)
        // `start` applies to the next file; `loadfile`'s own option argument moved between mpv versions.
        mpv_set_property_string(handle, "start", start > 0 ? String(start) : "none")
        command(["loadfile", url.absoluteString, "replace"])
    }

    func play() { setFlag("pause", false) }
    func pause() { setFlag("pause", true) }
    func togglePause() { setFlag("pause", !isPaused) }

    /// `exact` seeks to the frame (slower in a long-GOP AV1 file); otherwise to the nearest keyframe, for scrubbing.
    func seek(to seconds: Double, exact: Bool = true) {
        command(["seek", String(max(0, seconds)), exact ? "absolute+exact" : "absolute+keyframes"])
    }

    func seek(by seconds: Double) {
        command(["seek", String(seconds), "relative"])
    }

    func setVolume(_ value: Double) {
        var volume = min(100, max(0, value))
        mpv_set_property(handle, "volume", MPV_FORMAT_DOUBLE, &volume)
    }

    func stop() {
        command(["stop"])
        isLoaded = false
    }

    // MARK: mpv

    private func setFlag(_ name: String, _ value: Bool) {
        var flag: Int32 = value ? 1 : 0
        mpv_set_property(handle, name, MPV_FORMAT_FLAG, &flag)
    }

    private func command(_ arguments: [String]) {
        var pointers = arguments.map { UnsafePointer(strdup($0)) }
        pointers.append(nil)
        defer { pointers.forEach { free(UnsafeMutablePointer(mutating: $0)) } }
        let status = pointers.withUnsafeMutableBufferPointer { mpv_command(handle, $0.baseAddress) }
        if status < 0 { problem = String(cString: mpv_error_string(status)) }
    }

    private func drainEvents() {
        while let event = mpv_wait_event(handle, 0)?.pointee, event.event_id != MPV_EVENT_NONE {
            switch event.event_id {
            case MPV_EVENT_PROPERTY_CHANGE:
                guard let property = event.data?.assumingMemoryBound(to: mpv_event_property.self).pointee else { break }
                update(property)
            case MPV_EVENT_FILE_LOADED:
                isLoaded = true
                problem = nil
            case MPV_EVENT_END_FILE:
                guard let end = event.data?.assumingMemoryBound(to: mpv_event_end_file.self).pointee else { break }
                if end.error < 0 { problem = "The video can't play: \(String(cString: mpv_error_string(end.error)))." }
            case MPV_EVENT_SHUTDOWN:
                return
            default:
                break
            }
        }
    }

    private func update(_ property: mpv_event_property) {
        let name = String(cString: property.name)
        guard let data = property.data else {
            // The property has no value now (no file, or not known yet).
            if name == "time-pos" { position = 0 }
            if name == "duration" { duration = 0 }
            return
        }
        switch (name, property.format) {
        case ("time-pos", MPV_FORMAT_DOUBLE): position = data.assumingMemoryBound(to: Double.self).pointee
        case ("duration", MPV_FORMAT_DOUBLE): duration = data.assumingMemoryBound(to: Double.self).pointee
        case ("volume", MPV_FORMAT_DOUBLE): volume = data.assumingMemoryBound(to: Double.self).pointee
        case ("pause", MPV_FORMAT_FLAG): isPaused = data.assumingMemoryBound(to: Int32.self).pointee != 0
        case ("paused-for-cache", MPV_FORMAT_FLAG): isBuffering = data.assumingMemoryBound(to: Int32.self).pointee != 0
        default: break
        }
    }
}
