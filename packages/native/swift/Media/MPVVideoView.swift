#if os(macOS)
import AppKit
import OpenGL.GL3
import SwiftUI

/// Draws an `MPVPlayer`'s frames: libmpv's render API into a `CAOpenGLLayer`, the way IINA does. mpv says when a new
/// frame is ready and the layer redraws; nothing else asks it to.
struct MPVVideoView: NSViewRepresentable {
    let player: MPVPlayer

    func makeNSView(context: Context) -> MPVVideoNSView { MPVVideoNSView(player: player) }
    func updateNSView(_ view: MPVVideoNSView, context: Context) {}
}

final class MPVVideoNSView: NSView {
    private let player: MPVPlayer

    init(player: MPVPlayer) {
        self.player = player
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .duringViewResize
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func makeBackingLayer() -> CALayer { MPVVideoLayer(player: player) }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        layer?.contentsScale = window?.backingScaleFactor ?? 2
    }
}

final class MPVVideoLayer: CAOpenGLLayer {
    /// Kept alive while the layer is, so mpv outlives the render context made from it.
    private let player: MPVPlayer?
    private var renderContext: OpaquePointer?
    private var glContext: CGLContextObj?

    init(player: MPVPlayer) {
        self.player = player
        super.init()
        isAsynchronous = false
        needsDisplayOnBoundsChange = true
        backgroundColor = NSColor.black.cgColor
    }

    /// Core Animation's copies for presentation draw nothing of their own.
    override init(layer: Any) {
        player = nil
        super.init(layer: layer)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        guard let renderContext else { return }
        if let glContext { CGLSetCurrentContext(glContext) }
        mpv_render_context_set_update_callback(renderContext, nil, nil)
        mpv_render_context_free(renderContext)
    }

    override func copyCGLPixelFormat(forDisplayMask mask: UInt32) -> CGLPixelFormatObj {
        let attributes: [CGLPixelFormatAttribute] = [
            kCGLPFAOpenGLProfile, CGLPixelFormatAttribute(UInt32(kCGLOGLPVersion_3_2_Core.rawValue)),
            kCGLPFAAccelerated,
            kCGLPFADoubleBuffer,
            kCGLPFAAllowOfflineRenderers,
            kCGLPFADisplayMask, CGLPixelFormatAttribute(mask),
            CGLPixelFormatAttribute(0),
        ]
        var format: CGLPixelFormatObj?
        var count: GLint = 0
        CGLChoosePixelFormat(attributes, &format, &count)
        if let format { return format }
        return super.copyCGLPixelFormat(forDisplayMask: mask)
    }

    override func copyCGLContext(forPixelFormat pixelFormat: CGLPixelFormatObj) -> CGLContextObj {
        let context = super.copyCGLContext(forPixelFormat: pixelFormat)
        // Keep vertical sync off: mpv times frames itself, and the layer draws only when it says so.
        var interval: GLint = 0
        CGLSetParameter(context, kCGLCPSwapInterval, &interval)
        CGLSetCurrentContext(context)
        glContext = context
        createRenderContext()
        return context
    }

    private func createRenderContext() {
        guard renderContext == nil, let player else { return }
        var initParams = mpv_opengl_init_params()
        initParams.get_proc_address = { _, name in
            guard let name else { return nil }
            let symbol = CFStringCreateWithCString(kCFAllocatorDefault, name, CFStringBuiltInEncodings.ASCII.rawValue)
            let bundle = CFBundleGetBundleWithIdentifier("com.apple.opengl" as CFString)
            return CFBundleGetFunctionPointerForName(bundle, symbol)
        }
        var context: OpaquePointer?
        "opengl".withCString { api in
            withUnsafeMutablePointer(to: &initParams) { initPointer in
                var params = [
                    mpv_render_param(type: MPV_RENDER_PARAM_API_TYPE, data: UnsafeMutableRawPointer(mutating: api)),
                    mpv_render_param(type: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, data: UnsafeMutableRawPointer(initPointer)),
                    mpv_render_param(),
                ]
                _ = mpv_render_context_create(&context, player.handle, &params)
            }
        }
        guard let context else { return }
        renderContext = context
        mpv_render_context_set_update_callback(context, { raw in
            guard let raw else { return }
            let layer = Unmanaged<MPVVideoLayer>.fromOpaque(raw).takeUnretainedValue()
            DispatchQueue.main.async { [weak layer] in layer?.setNeedsDisplay() }
        }, Unmanaged.passUnretained(self).toOpaque())
    }

    override func canDraw(inCGLContext context: CGLContextObj, pixelFormat: CGLPixelFormatObj, forLayerTime t: CFTimeInterval, displayTime ts: UnsafePointer<CVTimeStamp>?) -> Bool {
        renderContext != nil
    }

    override func draw(inCGLContext context: CGLContextObj, pixelFormat: CGLPixelFormatObj, forLayerTime t: CFTimeInterval, displayTime ts: UnsafePointer<CVTimeStamp>?) {
        guard let renderContext else { return }
        var framebuffer: GLint = 0
        glGetIntegerv(GLenum(GL_DRAW_FRAMEBUFFER_BINDING), &framebuffer)
        var viewport: [GLint] = [0, 0, 0, 0]
        glGetIntegerv(GLenum(GL_VIEWPORT), &viewport)
        var fbo = mpv_opengl_fbo()
        fbo.fbo = Int32(framebuffer)
        fbo.w = Int32(viewport[2])
        fbo.h = Int32(viewport[3])
        var flip: Int32 = 1
        withUnsafeMutablePointer(to: &fbo) { fboPointer in
            withUnsafeMutablePointer(to: &flip) { flipPointer in
                var params = [
                    mpv_render_param(type: MPV_RENDER_PARAM_OPENGL_FBO, data: UnsafeMutableRawPointer(fboPointer)),
                    mpv_render_param(type: MPV_RENDER_PARAM_FLIP_Y, data: UnsafeMutableRawPointer(flipPointer)),
                    mpv_render_param(),
                ]
                _ = mpv_render_context_render(renderContext, &params)
            }
        }
        super.draw(inCGLContext: context, pixelFormat: pixelFormat, forLayerTime: t, displayTime: ts)
        mpv_render_context_report_swap(renderContext)
    }
}
#endif
